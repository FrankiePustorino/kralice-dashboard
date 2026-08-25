import express from 'express';
import { readJson, writeJson } from '../lib/store.js';
import { loadLiveModule } from '../lib/botLive.js';
import { run } from '../lib/exec.js';

const router = express.Router();
const defaultChat = () => process.env.DEFAULT_CHAT_ID || 'default';

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// ───────────────────────── SHOPPING ─────────────────────────
const SHOPPING_DEFAULT = () => ({ lists: { default: { name: 'Shopping', items: [] } }, activeLists: {} });

function getActiveListId(state, chatId) {
    const key = String(chatId);
    const id = state.activeLists[key] || 'default';
    if (!state.lists[id]) state.lists[id] = { name: id, items: [] };
    return id;
}

router.get('/shopping', wrap(async (req, res) => {
    const chatId = req.query.chatId || defaultChat();
    const state = readJson('shopping.json', SHOPPING_DEFAULT);
    const activeId = getActiveListId(state, chatId);
    const lists = Object.entries(state.lists).map(([id, l]) => ({
        id, name: l.name, count: (l.items || []).length, active: id === activeId
    }));
    res.json({ chatId, activeListId: activeId, activeList: state.lists[activeId], lists });
}));

router.post('/shopping/add', wrap(async (req, res) => {
    const { chatId = defaultChat(), item, userName = 'Dashboard' } = req.body;
    if (!item) return res.status(400).json({ error: 'item is required' });
    const state = readJson('shopping.json', SHOPPING_DEFAULT);
    const listId = getActiveListId(state, chatId);
    const items = state.lists[listId].items ||= [];
    if (items.find(i => i.name.toLowerCase() === item.toLowerCase())) {
        return res.status(409).json({ error: `Already in list: ${item}` });
    }
    items.push({ name: item, checked: false, addedBy: userName, addedAt: new Date().toISOString() });
    writeJson('shopping.json', state);
    res.json({ ok: true, item });
}));

router.post('/shopping/toggle', wrap(async (req, res) => {
    const { chatId = defaultChat(), item, checked, userName = 'Dashboard' } = req.body;
    const state = readJson('shopping.json', SHOPPING_DEFAULT);
    const listId = getActiveListId(state, chatId);
    const found = (state.lists[listId].items || []).find(i => i.name.toLowerCase().includes(String(item).toLowerCase()));
    if (!found) return res.status(404).json({ error: `Not found: ${item}` });
    found.checked = !!checked;
    if (checked) { found.checkedBy = userName; found.checkedAt = new Date().toISOString(); }
    else { delete found.checkedBy; delete found.checkedAt; }
    writeJson('shopping.json', state);
    res.json({ ok: true, item: found });
}));

router.post('/shopping/delete', wrap(async (req, res) => {
    const { chatId = defaultChat(), item } = req.body;
    const state = readJson('shopping.json', SHOPPING_DEFAULT);
    const listId = getActiveListId(state, chatId);
    const arr = state.lists[listId].items || [];
    const idx = arr.findIndex(i => i.name.toLowerCase().includes(String(item).toLowerCase()));
    if (idx === -1) return res.status(404).json({ error: `Not found: ${item}` });
    const [removed] = arr.splice(idx, 1);
    writeJson('shopping.json', state);
    res.json({ ok: true, removed });
}));

router.post('/shopping/clear', wrap(async (req, res) => {
    const { chatId = defaultChat(), onlyChecked = false } = req.body;
    const state = readJson('shopping.json', SHOPPING_DEFAULT);
    const listId = getActiveListId(state, chatId);
    const before = (state.lists[listId].items || []).length;
    state.lists[listId].items = onlyChecked
        ? (state.lists[listId].items || []).filter(i => !i.checked)
        : [];
    writeJson('shopping.json', state);
    res.json({ ok: true, removed: before - state.lists[listId].items.length });
}));

// ───────────────────────── TODOS ─────────────────────────
const TODOS_DEFAULT = () => ({ tasks: [], nextId: 1 });

router.get('/todos', wrap(async (req, res) => {
    res.json(readJson('todos.json', TODOS_DEFAULT));
}));

router.post('/todos', wrap(async (req, res) => {
    const { text, priority = 'medium', userName = 'Dashboard' } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (!['high', 'medium', 'low'].includes(priority)) return res.status(400).json({ error: 'priority must be high, medium, or low' });
    const state = readJson('todos.json', TODOS_DEFAULT);
    const task = { id: state.nextId++, text, priority, done: false, createdAt: new Date().toISOString(), createdBy: userName, dueDate: null };
    state.tasks.push(task);
    writeJson('todos.json', state);
    res.json({ ok: true, task });
}));

router.post('/todos/:id/done', wrap(async (req, res) => {
    const state = readJson('todos.json', TODOS_DEFAULT);
    const task = state.tasks.find(t => t.id === Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    task.done = true; task.doneAt = new Date().toISOString(); task.doneBy = req.body.userName || 'Dashboard';
    writeJson('todos.json', state);
    res.json({ ok: true, task });
}));

router.post('/todos/:id/reopen', wrap(async (req, res) => {
    const state = readJson('todos.json', TODOS_DEFAULT);
    const task = state.tasks.find(t => t.id === Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    task.done = false; delete task.doneAt; delete task.doneBy;
    writeJson('todos.json', state);
    res.json({ ok: true, task });
}));

router.post('/todos/:id/priority', wrap(async (req, res) => {
    const { priority } = req.body;
    if (!['high', 'medium', 'low'].includes(priority)) return res.status(400).json({ error: 'priority must be high, medium, or low' });
    const state = readJson('todos.json', TODOS_DEFAULT);
    const task = state.tasks.find(t => t.id === Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    task.priority = priority;
    writeJson('todos.json', state);
    res.json({ ok: true, task });
}));

router.delete('/todos/:id', wrap(async (req, res) => {
    const state = readJson('todos.json', TODOS_DEFAULT);
    const idx = state.tasks.findIndex(t => t.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'task not found' });
    const [removed] = state.tasks.splice(idx, 1);
    writeJson('todos.json', state);
    res.json({ ok: true, removed });
}));

router.post('/todos/clear-done', wrap(async (req, res) => {
    const state = readJson('todos.json', TODOS_DEFAULT);
    const before = state.tasks.length;
    state.tasks = state.tasks.filter(t => !t.done);
    writeJson('todos.json', state);
    res.json({ ok: true, removed: before - state.tasks.length });
}));

// ───────────────────────── REMINDERS ─────────────────────────
// Read/write only. Changing `active` here updates reminders.json, but the
// running bot only re-arms cron jobs via its own rehydrateReminders() /
// setReminderActive() calls — it does not watch this file. Toggling a
// reminder from the dashboard takes effect after the next `pm2 restart
// kralice-bot` (use the PM2 tab). This is called out in the UI too.
const REMINDERS_DEFAULT = () => ({ reminders: [], nextId: 1 });

router.get('/reminders', wrap(async (req, res) => {
    res.json(readJson('reminders.json', REMINDERS_DEFAULT));
}));

router.post('/reminders/:id/active', wrap(async (req, res) => {
    const { active } = req.body;
    const state = readJson('reminders.json', REMINDERS_DEFAULT);
    const r = state.reminders.find(r => r.id === Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'reminder not found' });
    r.active = !!active;
    writeJson('reminders.json', state);
    res.json({ ok: true, reminder: r, note: 'Restart the bot (PM2 tab) for this to take effect.' });
}));

router.delete('/reminders/:id', wrap(async (req, res) => {
    const state = readJson('reminders.json', REMINDERS_DEFAULT);
    const idx = state.reminders.findIndex(r => r.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'reminder not found' });
    const [removed] = state.reminders.splice(idx, 1);
    writeJson('reminders.json', state);
    res.json({ ok: true, removed, note: 'Restart the bot (PM2 tab) for this to take effect.' });
}));

// ───────────────────────── POLLS ─────────────────────────
const POLLS_DEFAULT = () => ({ polls: [], nextId: 1 });

router.get('/polls', wrap(async (req, res) => {
    const chatId = req.query.chatId;
    const state = readJson('polls.json', POLLS_DEFAULT);
    const polls = chatId ? state.polls.filter(p => p.chat === String(chatId)) : state.polls;
    res.json({ polls });
}));

router.post('/polls/:id/close', wrap(async (req, res) => {
    const state = readJson('polls.json', POLLS_DEFAULT);
    const poll = state.polls.find(p => p.id === Number(req.params.id));
    if (!poll) return res.status(404).json({ error: 'poll not found' });
    poll.active = false;
    writeJson('polls.json', state);
    res.json({ ok: true, poll });
}));

router.delete('/polls/:id', wrap(async (req, res) => {
    const state = readJson('polls.json', POLLS_DEFAULT);
    const idx = state.polls.findIndex(p => p.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'poll not found' });
    const [removed] = state.polls.splice(idx, 1);
    writeJson('polls.json', state);
    res.json({ ok: true, removed });
}));

// ───────────────────────── WEATHER (live, via bot's own module) ─────────────────────────
router.get('/weather', wrap(async (req, res) => {
    const { fetchMeteo } = await loadLiveModule('weather');
    const query = req.query.city || '';
    const lang = req.query.lang === 'it' ? 'it' : 'en';
    const weather = await fetchMeteo(query, lang, 2, 1500, () => {});
    res.json(weather);
}));

export default router;
