import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { authMiddleware } from './middleware/auth.js';
import botRouter from './routes/bot.js';
import pm2Router from './routes/pm2.js';
import dockerRouter from './routes/docker.js';
import systemdRouter from './routes/systemd.js';
import logsRouter from './routes/logs.js';
import systemRouter from './routes/system.js';
import storageRouter from './routes/storage.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', authMiddleware);
app.use('/api/bot', botRouter);
app.use('/api/pm2', pm2Router);
app.use('/api/docker', dockerRouter);
app.use('/api/systemd', systemdRouter);
app.use('/api/logs', logsRouter);
app.use('/api/system', systemRouter);
app.use('/api/storage', storageRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 4200;
app.listen(PORT, () => {
    console.log(`[DASHBOARD] Kralice Dashboard listening on port ${PORT}`);
    console.log(`[DASHBOARD] BOT_DIR = ${process.env.BOT_DIR || '(not set!)'}`);
    console.log(`[DASHBOARD] Auth: ${process.env.DASHBOARD_TOKEN ? 'token required' : '⚠️  OPEN — no DASHBOARD_TOKEN set'}`);
});
