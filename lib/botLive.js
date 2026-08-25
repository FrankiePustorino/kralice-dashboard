// Dynamically imports the bot's own modules/worldcup.js and modules/weather.js
// so the dashboard reuses the exact same live-fetch logic (season resolution,
// day-range scans, Open-Meteo calls) instead of re-implementing it. These two
// modules only touch external APIs plus their own *.json cache files, so
// importing them here is safe (no cron jobs, no Telegram client needed).
//
// Cache-busted on every call so edits to the bot's modules are picked up
// without restarting the dashboard, and so each call re-reads any on-disk
// state the module caches internally (e.g. worldcup.json's season cache).

import path from 'path';

function botDir() {
    const dir = process.env.BOT_DIR;
    if (!dir) throw new Error('BOT_DIR is not set in .env — point it at the Kralice bot install directory.');
    return dir;
}

export async function loadLiveModule(name) {
    const modPath = path.join(botDir(), 'modules', `${name}.js`);
    return import(`file://${modPath}?t=${Date.now()}`);
}
