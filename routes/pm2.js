import express from 'express';
import os from 'os';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { run } from '../lib/exec.js';

const router = express.Router();

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
};

function pm2LogDir() {
    return process.env.PM2_LOG_DIR || path.join(os.homedir(), '.pm2', 'logs');
}

function tailLines(filePath, n) {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n);
}

// GET /api/pm2/status — full `pm2 jlist` output, or just the tracked app if PM2_APP_NAME is set
router.get('/status', wrap(async (req, res) => {
    const result = await run('pm2', ['jlist']);
    if (!result.ok) return res.status(500).json({ error: 'pm2 jlist failed', stderr: result.stderr });
    let processes;
    try { processes = JSON.parse(result.stdout); } catch (e) {
        return res.status(500).json({ error: 'Could not parse pm2 output', raw: result.stdout });
    }
    const simplified = processes.map(p => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env?.status,
        restarts: p.pm2_env?.restart_time,
        uptime: p.pm2_env?.pm_uptime,
        cpu: p.monit?.cpu,
        memory: p.monit?.memory,
        version: p.pm2_env?.version
    }));
    res.json({ processes: simplified });
}));

// POST /api/pm2/restart  { name? }  — defaults to PM2_APP_NAME (the bot)
router.post('/restart', wrap(async (req, res) => {
    const name = req.body?.name || process.env.PM2_APP_NAME;
    if (!name) return res.status(400).json({ error: 'No app name given and PM2_APP_NAME is unset' });
    const result = await run('pm2', ['restart', name]);
    if (!result.ok) return res.status(500).json({ error: `pm2 restart ${name} failed`, stderr: result.stderr });
    res.json({ ok: true, name, output: result.stdout });
}));

router.post('/stop', wrap(async (req, res) => {
    const name = req.body?.name || process.env.PM2_APP_NAME;
    const result = await run('pm2', ['stop', name]);
    if (!result.ok) return res.status(500).json({ error: `pm2 stop ${name} failed`, stderr: result.stderr });
    res.json({ ok: true, name, output: result.stdout });
}));

router.post('/start', wrap(async (req, res) => {
    const name = req.body?.name || process.env.PM2_APP_NAME;
    const result = await run('pm2', ['start', name]);
    if (!result.ok) return res.status(500).json({ error: `pm2 start ${name} failed`, stderr: result.stderr });
    res.json({ ok: true, name, output: result.stdout });
}));

// GET /api/pm2/logs?name=kralice-bot&lines=200&type=error|out|both
router.get('/logs', wrap(async (req, res) => {
    const name = req.query.name || process.env.PM2_APP_NAME;
    const lines = Math.min(Number(req.query.lines) || Number(process.env.DEFAULT_LOG_LINES) || 200, 2000);
    const type = req.query.type || 'both';
    const dir = pm2LogDir();
    const out = type !== 'error' ? tailLines(path.join(dir, `${name}-out.log`), lines) : [];
    const err = type !== 'out' ? tailLines(path.join(dir, `${name}-error.log`), lines) : [];
    res.json({ name, out, error: err });
}));

export default router;
