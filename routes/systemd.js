import express from 'express';
import { run } from '../lib/exec.js';

const router = express.Router();

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
};

function allowedServices() {
    return (process.env.SYSTEMD_ALLOWED_SERVICES || 'radarr,sonarr')
        .split(',').map(s => s.trim()).filter(Boolean);
}

function checkAllowed(service, res) {
    if (!allowedServices().includes(service)) {
        res.status(403).json({ error: `Service "${service}" is not in SYSTEMD_ALLOWED_SERVICES.` });
        return false;
    }
    return true;
}

// GET /api/systemd/services — the whitelist itself, with a quick status pass on each
router.get('/services', wrap(async (req, res) => {
    const services = allowedServices();
    const results = [];
    for (const svc of services) {
        const r = await run('systemctl', ['is-active', svc]);
        results.push({ service: svc, active: r.stdout.trim() });
    }
    res.json({ services: results });
}));

// GET /api/systemd/:service/status
router.get('/:service/status', wrap(async (req, res) => {
    const { service } = req.params;
    if (!checkAllowed(service, res)) return;
    const result = await run('systemctl', ['status', service, '--no-pager', '-l']);
    // systemctl status exits 3 for "inactive/failed", which is a normal, valid result here
    res.json({ service, active: result.ok || result.code === 3, output: result.stdout || result.stderr });
}));

// POST /api/systemd/:service/restart
router.post('/:service/restart', wrap(async (req, res) => {
    const { service } = req.params;
    if (!checkAllowed(service, res)) return;
    // Requires passwordless sudo scoped to exactly this command — see README.
    const result = await run('sudo', ['-n', 'systemctl', 'restart', service]);
    if (!result.ok) {
        return res.status(500).json({
            error: `Failed to restart ${service}`,
            stderr: result.stderr,
            hint: result.stderr.includes('password') || result.stderr.includes('sudo:')
                ? 'The dashboard needs a passwordless sudoers rule for this exact command — see README.md.'
                : undefined
        });
    }
    res.json({ ok: true, service, action: 'restart' });
}));

router.post('/:service/stop', wrap(async (req, res) => {
    const { service } = req.params;
    if (!checkAllowed(service, res)) return;
    const result = await run('sudo', ['-n', 'systemctl', 'stop', service]);
    if (!result.ok) return res.status(500).json({ error: `Failed to stop ${service}`, stderr: result.stderr });
    res.json({ ok: true, service, action: 'stop' });
}));

router.post('/:service/start', wrap(async (req, res) => {
    const { service } = req.params;
    if (!checkAllowed(service, res)) return;
    const result = await run('sudo', ['-n', 'systemctl', 'start', service]);
    if (!result.ok) return res.status(500).json({ error: `Failed to start ${service}`, stderr: result.stderr });
    res.json({ ok: true, service, action: 'start' });
}));

// GET /api/systemd/:service/logs?lines=200
router.get('/:service/logs', wrap(async (req, res) => {
    const { service } = req.params;
    if (!checkAllowed(service, res)) return;
    const lines = Math.min(Number(req.query.lines) || Number(process.env.DEFAULT_LOG_LINES) || 200, 2000);
    const result = await run('journalctl', ['-u', service, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
    if (!result.ok && !result.stdout) return res.status(500).json({ error: `journalctl failed for ${service}`, stderr: result.stderr });
    res.json({ service, lines: result.stdout.split('\n').filter(Boolean) });
}));

export default router;
