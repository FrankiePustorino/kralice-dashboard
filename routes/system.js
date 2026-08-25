import express from 'express';
import os from 'os';
import { readFileSync } from 'fs';
import { run } from '../lib/exec.js';

const router = express.Router();

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
};

// ── CPU: two /proc/stat snapshots ~250ms apart to compute real utilization,
// since a single reading only gives cumulative counters since boot. ──
function readProcStat() {
    const text = readFileSync('/proc/stat', 'utf8');
    return text.split('\n')
        .filter(l => l.startsWith('cpu'))
        .map(l => {
            const parts = l.trim().split(/\s+/);
            const nums = parts.slice(1).map(Number);
            const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
            const idleAll = idle + iowait;
            const total = user + nice + system + idleAll + irq + softirq + steal;
            return { label: parts[0], idle: idleAll, total };
        });
}

async function getCpuUsage() {
    const a = readProcStat();
    await new Promise(r => setTimeout(r, 250));
    const b = readProcStat();
    const percents = a.map((coreA, i) => {
        const coreB = b[i];
        if (!coreB) return null;
        const totalDiff = coreB.total - coreA.total;
        const idleDiff = coreB.idle - coreA.idle;
        return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
    });
    return {
        overallPercent: percents[0] ?? 0,
        perCore: percents.slice(1).filter(p => p !== null)
    };
}

// ── Memory: /proc/meminfo for MemAvailable (accounts for reclaimable cache,
// unlike os.freemem() which reports raw free and looks misleadingly "full"). ──
function getMemory() {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const kv = {};
    text.split('\n').forEach(line => {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) kv[m[1]] = Number(m[2]) * 1024; // kB -> bytes
    });
    const totalBytes = kv.MemTotal ?? os.totalmem();
    const availableBytes = kv.MemAvailable ?? os.freemem();
    const usedBytes = totalBytes - availableBytes;
    const swapTotalBytes = kv.SwapTotal ?? 0;
    const swapFreeBytes = kv.SwapFree ?? 0;
    const swapUsedBytes = swapTotalBytes - swapFreeBytes;
    return {
        totalBytes, usedBytes, availableBytes,
        percent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
        swapTotalBytes, swapUsedBytes,
        swapPercent: swapTotalBytes ? (swapUsedBytes / swapTotalBytes) * 100 : 0
    };
}

// ── Disks: df in POSIX/portable mode (bytes, not human-rounded), skipping
// virtual filesystems that aren't real storage. ──
async function getDisks() {
    const result = await run('df', ['-P', '-B1']);
    if (!result.ok) return [];
    const SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue', 'shm']);
    return result.stdout.split('\n').slice(1)
        .map(l => l.trim().split(/\s+/))
        .filter(cols => cols.length >= 6 && !SKIP_FS.has(cols[0]))
        .map(cols => {
            const [fs, total, used, avail, , mount] = cols;
            const totalBytes = Number(total), usedBytes = Number(used);
            return {
                fs, mount,
                totalBytes, usedBytes, availBytes: Number(avail),
                percent: totalBytes ? (usedBytes / totalBytes) * 100 : 0
            };
        })
        .filter(d => d.totalBytes > 0);
}

// ── GPU: nvidia-smi only (most common on home servers). Returns
// available:false rather than erroring when there's no NVIDIA GPU/driver. ──
async function getGpu() {
    const result = await run('nvidia-smi', [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits'
    ]);
    if (!result.ok) {
        return { available: false, reason: 'nvidia-smi not found or no NVIDIA GPU present.' };
    }
    const devices = result.stdout.split('\n').filter(Boolean).map(line => {
        const [name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
        return {
            name,
            utilizationPercent: Number(util),
            memoryUsedMB: Number(memUsed),
            memoryTotalMB: Number(memTotal),
            temperatureC: Number(temp)
        };
    });
    return { available: devices.length > 0, devices };
}

router.get('/stats', wrap(async (req, res) => {
    const [cpu, disks, gpu] = await Promise.all([getCpuUsage(), getDisks(), getGpu()]);
    res.json({
        hostname: os.hostname(),
        uptimeHours: Math.round(os.uptime() / 3600 * 10) / 10,
        cpu,
        memory: getMemory(),
        disks,
        gpu
    });
}));

export default router;
