import express from 'express';
import Docker from 'dockerode';

const router = express.Router();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        // dockerode throws ENOENT/EACCES if the socket isn't reachable — surface that clearly
        res.status(500).json({ error: e.message, hint: e.code === 'EACCES'
            ? 'The dashboard process needs access to /var/run/docker.sock (add its user to the docker group).'
            : undefined });
    }
};

// GET /api/docker/containers — all containers (running + stopped)
router.get('/containers', wrap(async (req, res) => {
    const containers = await docker.listContainers({ all: true });
    const simplified = containers.map(c => ({
        id: c.Id.slice(0, 12),
        names: c.Names.map(n => n.replace(/^\//, '')),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports?.map(p => `${p.PublicPort ? p.PublicPort + ':' : ''}${p.PrivatePort}/${p.Type}`) || []
    }));
    res.json({ containers: simplified });
}));

router.get('/containers/:id', wrap(async (req, res) => {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    res.json({
        id: info.Id.slice(0, 12),
        name: info.Name.replace(/^\//, ''),
        state: info.State,
        restartCount: info.RestartCount,
        image: info.Config?.Image,
        env: info.Config?.Env,
        mounts: info.Mounts?.map(m => ({ source: m.Source, dest: m.Destination, mode: m.Mode }))
    });
}));

router.post('/containers/:id/restart', wrap(async (req, res) => {
    const container = docker.getContainer(req.params.id);
    await container.restart();
    res.json({ ok: true, id: req.params.id, action: 'restart' });
}));

router.post('/containers/:id/start', wrap(async (req, res) => {
    await docker.getContainer(req.params.id).start();
    res.json({ ok: true, id: req.params.id, action: 'start' });
}));

router.post('/containers/:id/stop', wrap(async (req, res) => {
    await docker.getContainer(req.params.id).stop();
    res.json({ ok: true, id: req.params.id, action: 'stop' });
}));

// GET /api/docker/containers/:id/logs?lines=200
router.get('/containers/:id/logs', wrap(async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || Number(process.env.DEFAULT_LOG_LINES) || 200, 2000);
    const container = docker.getContainer(req.params.id);
    const buffer = await container.logs({ stdout: true, stderr: true, tail: lines, timestamps: true });
    // Docker multiplexes stdout/stderr into one buffer with an 8-byte header per frame when the
    // container wasn't started with a TTY; strip that so log lines are readable.
    const text = demuxDockerLog(buffer);
    res.json({ id: req.params.id, lines: text.split('\n').filter(Boolean) });
}));

// GET /api/docker/info — daemon-level health (version, containers running/stopped, images)
router.get('/info', wrap(async (req, res) => {
    const info = await docker.info();
    res.json({
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        containersPaused: info.ContainersPaused,
        images: info.Images,
        serverVersion: info.ServerVersion,
        driver: info.Driver,
        memTotal: info.MemTotal
    });
}));

function demuxDockerLog(buffer) {
    // Each frame: 1 byte stream type, 3 bytes padding, 4 bytes big-endian length, then payload.
    // If the buffer doesn't look framed (e.g. TTY-attached containers), just return it as-is.
    let out = '';
    let offset = 0;
    try {
        while (offset < buffer.length) {
            const header = buffer.slice(offset, offset + 8);
            if (header.length < 8) break;
            const length = header.readUInt32BE(4);
            const payload = buffer.slice(offset + 8, offset + 8 + length);
            out += payload.toString('utf8');
            offset += 8 + length;
        }
        if (out) return out;
    } catch (e) { /* fall through to raw */ }
    return buffer.toString('utf8');
}

export default router;
