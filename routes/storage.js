import express from 'express';
import { run } from '../lib/exec.js';

const router = express.Router();

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
};

// ── Parse "sda:label,nvme0n1:label" style env vars into a lookup map. ──
function parsePairs(envVal) {
    return (envVal || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .reduce((acc, pair) => {
            const idx = pair.indexOf(':');
            if (idx === -1) return acc;
            const dev = pair.slice(0, idx).trim();
            const val = pair.slice(idx + 1).trim();
            if (dev && val) acc[dev] = val;
            return acc;
        }, {});
}

function locationMap() {
    return parsePairs(process.env.STORAGE_LOCATIONS); // e.g. "sda:Bay 1 (front),nvme0n1:M.2 slot 1"
}

function ratedTbwMap() {
    // Values in GB (decimal), e.g. "sda:600000,nvme0n1:1200000" for a 600TB- and 1200TB-rated drive.
    const raw = parsePairs(process.env.STORAGE_RATED_TBW_GB);
    const out = {};
    for (const [dev, gb] of Object.entries(raw)) {
        const n = Number(gb);
        if (Number.isFinite(n) && n > 0) out[dev] = n * 1000 ** 3; // GB -> bytes
    }
    return out;
}

// ── Discover physical disks via lsblk. -l (list) avoids the ASCII tree-drawing
// characters lsblk normally prefixes child device names with. PKNAME + MOUNTPOINT
// let us fold each partition's mountpoint back onto its parent disk. ──
async function listPhysicalDisks() {
    const result = await run('lsblk', ['-l', '-n', '-o', 'NAME,TYPE,MOUNTPOINT,SIZE,PKNAME']);
    if (!result.ok) return [];
    const rows = result.stdout.split('\n')
        .map(l => l.trim()).filter(Boolean)
        .map(l => l.split(/\s+/));

    const mountsByParent = {};
    rows.forEach(cols => {
        const [name, , mountpoint, , pkname] = cols;
        const parent = pkname || null;
        if (parent && mountpoint) (mountsByParent[parent] ||= []).push(mountpoint);
        // A disk can itself be mounted directly with no partition table (rare, but possible).
        if (cols[1] === 'disk' && mountpoint) (mountsByParent[name] ||= []).push(mountpoint);
    });

    return rows
        .filter(cols => cols[1] === 'disk')
        .map(cols => ({ name: cols[0], size: cols[3] || null, mountpoints: mountsByParent[cols[0]] || [] }));
}

function findAttr(attrs, names) {
    return attrs.find(a => names.includes(a.name));
}

// ── Turn one smartctl -j payload into the shape the dashboard renders.
// SSD "wear" isn't reported consistently: NVMe drives expose percentage_used
// directly, SATA SSDs scatter it across vendor-specific attribute names, and
// plenty of drives (especially older/cheaper ones) don't expose it at all —
// in which case we fall back to raw bytes-written only. ──
function parseSmartJson(dev, name, d, mountpoints) {
    const nvmeLog = d.nvme_smart_health_information_log;
    const isNvme = !!nvmeLog;
    const isSSD = isNvme || d.rotation_rate === 0;
    const attrs = d.ata_smart_attributes?.table || [];

    const model = d.model_name || d.model_family || 'Unknown model';
    const serial = d.serial_number || null;
    const firmware = d.firmware_version || null;
    const capacityBytes = d.user_capacity?.bytes ?? null;
    const healthPassed = d.smart_status?.passed ?? null;
    const powerOnHours = d.power_on_time?.hours ?? nvmeLog?.power_on_hours ?? null;
    const temperatureC = d.temperature?.current ?? nvmeLog?.temperature ?? null;

    let totalBytesWritten = null;
    let wearPercentUsed = null;

    if (isNvme) {
        // NVMe spec: Data Units Written is a count of 512,000-byte units.
        totalBytesWritten = nvmeLog.data_units_written != null ? nvmeLog.data_units_written * 512000 : null;
        wearPercentUsed = nvmeLog.percentage_used ?? null;
    } else if (isSSD) {
        const writeAttr = findAttr(attrs, ['Total_LBAs_Written', 'Host_Writes_32MiB', 'Lifetime_Writes_GiB']);
        if (writeAttr) {
            const raw = writeAttr.raw?.value ?? 0;
            if (writeAttr.name === 'Total_LBAs_Written') totalBytesWritten = raw * 512;
            else if (writeAttr.name === 'Host_Writes_32MiB') totalBytesWritten = raw * 32 * 1024 * 1024;
            else if (writeAttr.name === 'Lifetime_Writes_GiB') totalBytesWritten = raw * 1024 ** 3;
        }
        const lifeAttr = findAttr(attrs, ['SSD_Life_Left', 'Media_Wearout_Indicator', 'Percent_Lifetime_Remain']);
        if (lifeAttr) {
            // These normalized attributes are usually "remaining life", except
            // Percent_Lifetime_Remain which some vendors report as "used" already.
            wearPercentUsed = lifeAttr.name === 'Percent_Lifetime_Remain' ? lifeAttr.value : (100 - lifeAttr.value);
        }
    }

    const reallocatedSectors = findAttr(attrs, ['Reallocated_Sector_Ct'])?.raw?.value ?? null;
    const pendingSectors = findAttr(attrs, ['Current_Pending_Sector'])?.raw?.value ?? null;

    return {
        device: dev, name, mountpoints,
        type: isSSD ? (isNvme ? 'NVMe SSD' : 'SATA SSD') : 'HDD',
        model, serial, firmware, capacityBytes,
        healthPassed, powerOnHours, temperatureC,
        totalBytesWritten, wearPercentUsed,
        reallocatedSectors, pendingSectors
    };
}

// smartctl -a -j needs root for basically every NVMe drive and many SATA
// drives behind USB/RAID bridges, hence sudo -n here — same pattern as the
// systemd routes. See README for the sudoers rule. Exit codes: smartctl sets
// individual bits for "a SMART attribute failed" etc even on an otherwise
// successful read, so we parse stdout regardless of exit code and only treat
// "no stdout at all" as a hard failure.
async function smartForDevice(name, mountpoints) {
    const dev = `/dev/${name}`;
    const result = await run('sudo', ['-n', 'smartctl', '-a', '-j', dev]);
    if (!result.stdout) {
        return {
            device: dev, name, mountpoints,
            error: result.stderr || 'smartctl returned no data for this device',
            hint: /password|sudo:/i.test(result.stderr || '')
                ? 'The dashboard needs a passwordless sudoers rule for smartctl — see README.md.'
                : undefined
        };
    }
    let data;
    try { data = JSON.parse(result.stdout); }
    catch (e) { return { device: dev, name, mountpoints, error: 'Could not parse smartctl JSON output' }; }
    return parseSmartJson(dev, name, data, mountpoints);
}

// GET /api/storage/disks
router.get('/disks', wrap(async (req, res) => {
    const configured = (process.env.STORAGE_DEVICES || '').split(',').map(s => s.trim()).filter(Boolean);
    const targets = configured.length
        ? configured.map(name => ({ name, mountpoints: [] }))
        : await listPhysicalDisks();

    const locations = locationMap();
    const ratedTbw = ratedTbwMap();

    const disks = await Promise.all(targets.map(async t => {
        const d = await smartForDevice(t.name, t.mountpoints);
        const location = locations[t.name] || (t.mountpoints?.length ? t.mountpoints.join(', ') : null);
        const ratedTBWBytes = ratedTbw[t.name] ?? null;
        if (!d.error) {
            if (d.wearPercentUsed == null && ratedTBWBytes && d.totalBytesWritten != null) {
                d.wearPercentUsed = Math.min(100, (d.totalBytesWritten / ratedTBWBytes) * 100);
            }
            d.ratedTBWBytes = ratedTBWBytes;
        }
        return { ...d, location };
    }));

    res.json({ disks });
}));

export default router;
