// Reads and writes the SAME JSON files the Kralice bot itself uses
// (shopping.json, todos.json, recipes.json, polls.json, reminders.json —
// all living directly in BOT_DIR, matching modules/storage.js in the bot).
//
// We deliberately do NOT import the bot's own modules for this part: those
// modules cache state in memory at import time, which is fine inside the
// bot's own long-lived process but would go stale inside a second
// long-lived dashboard process reading/writing the same files. Re-reading
// the file fresh on every request keeps the dashboard honest, at the cost
// of a small (pre-existing, file-based) race if the bot and dashboard write
// at the exact same instant. Good enough for a single-user home dashboard.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

function botDir() {
    const dir = process.env.BOT_DIR;
    if (!dir) throw new Error('BOT_DIR is not set in .env — point it at the Kralice bot install directory.');
    return dir;
}

export function readJson(filename, fallback) {
    const p = path.join(botDir(), filename);
    if (!existsSync(p)) return typeof fallback === 'function' ? fallback() : fallback;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
        throw new Error(`Failed to read/parse ${filename}: ${e.message}`);
    }
}

export function writeJson(filename, data) {
    const p = path.join(botDir(), filename);
    writeFileSync(p, JSON.stringify(data, null, 2));
}
