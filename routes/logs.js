import express from 'express';
import os from 'os';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import Docker from 'dockerode';
import { run } from '../lib/exec.js';

const router = express.Router();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const ERROR_PATTERN = /error|fail(ed|ure)?|exception|fatal|❌|panic|traceback/i;

function tailLines(filePath, n) {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-n);
}

function demuxDockerLog(buffer) {
    let out = '';
    let offset = 0;
    try {
        while (offset < buffer.length) {
            const header = buffer.slice(offset, offset + 8);
            if (header.length < 8) break;
            const length = header.readUInt32BE(4);
            out += buffer.slice(offset + 8, offset + 8 + length).toString('utf8');
            offset += 8 + length;
        }
        if (out) return out;
    } catch (e) { /* fall through */ }
    return buffer.toString('utf8');
}

// GET /api/logs/errors?lines=300
// Best-effort aggregation: pulls a window of recent lines from every known
// source, keeps only lines that look like errors, and returns them grouped
// by source (not merged into one global timeline — timestamp formats differ
// too much across pm2/docker/journalctl to sort reliably).
router.get('/errors', async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 300, 1000);
    const groups = [];

    // ── PM2 (kralice-bot) ──
    try {
        const pm2Dir = process.env.PM2_LOG_DIR || path.join(os.homedir(), '.pm2', 'logs');
        const name = process.env.PM2_APP_NAME || 'kralice-bot';
        const errFile = tailLines(path.join(pm2Dir, `${name}-error.log`), lines);
        const outFile = tailLines(path.join(pm2Dir, `${name}-out.log`), lines);
        const matched = [...errFile, ...outFile].filter(l => ERROR_PATTERN.test(l));
        groups.push({ source: 'pm2', target: name, matches: matched.length, lines: matched.slice(-100) });
    } catch (e) {
        groups.push({ source: 'pm2', error: e.message });
    }

    // ── Docker containers ──
    try {
        const containers = await docker.listContainers({ all: false }); // only running containers have live logs worth checking
        for (const c of containers) {
            const name = c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
            try {
                const buffer = await docker.getContainer(c.Id).logs({ stdout: true, stderr: true, tail: lines, timestamps: true });
                const text = demuxDockerLog(buffer);
                const matched = text.split('\n').filter(l => l && ERROR_PATTERN.test(l));
                if (matched.length > 0) {
                    groups.push({ source: 'docker', target: name, matches: matched.length, lines: matched.slice(-50) });
                }
            } catch (e) {
                groups.push({ source: 'docker', target: name, error: e.message });
            }
        }
    } catch (e) {
        groups.push({ source: 'docker', error: e.message });
    }

    // ── systemd (radarr/sonarr, or whatever is whitelisted) ──
    const services = (process.env.SYSTEMD_ALLOWED_SERVICES || 'radarr,sonarr').split(',').map(s => s.trim()).filter(Boolean);
    for (const svc of services) {
        const result = await run('journalctl', ['-u', svc, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
        if (result.ok || result.stdout) {
            const matched = result.stdout.split('\n').filter(l => l && ERROR_PATTERN.test(l));
            groups.push({ source: 'systemd', target: svc, matches: matched.length, lines: matched.slice(-50) });
        } else {
            groups.push({ source: 'systemd', target: svc, error: result.stderr });
        }
    }

    res.json({ generatedAt: new Date().toISOString(), groups });
});

export default router;
