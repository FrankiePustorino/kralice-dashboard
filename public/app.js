// ── Token / auth ──────────────────────────────────────────────
const TOKEN_KEY = 'kralice_dashboard_token';
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

document.getElementById('tokenBtn').addEventListener('click', () => {
    const current = getToken();
    const next = prompt('Dashboard token (leave blank to clear):', current);
    if (next !== null) setToken(next.trim());
});

// ── Fetch helper ──────────────────────────────────────────────
async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers['x-dashboard-token'] = token;
    const res = await fetch(path, { ...opts, headers });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
        const msg = body?.error || `${res.status} ${res.statusText}`;
        throw new Error(msg);
    }
    return body;
}

function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Nav ───────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
        onViewShown(btn.dataset.view);
    });
});

document.querySelectorAll('.sub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.subview').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`sub-${btn.dataset.sub}`).classList.add('active');
    });
});

let currentView = 'bot';
function onViewShown(view) {
    currentView = view;
    if (view === 'system') loadSystem();
    if (view === 'storage') loadStorage();
    if (view === 'pm2') loadPm2();
    if (view === 'docker') loadDocker();
    if (view === 'arr') loadArr();
    if (view === 'errors') loadErrors();
}

// ── Status strip ─────────────────────────────────────────────
async function refreshStatusStrip() {
    setDot('dot-bot', 'muted');
    setDot('dot-docker', 'muted');
    setDot('dot-radarr', 'muted');
    setDot('dot-sonarr', 'muted');

    api('/api/pm2/status').then(({ processes }) => {
        const name = processes.find(p => p.name); // just take whichever matches; app name is server-side default
        const bot = processes.find(p => p.name && p.name.includes('kralice')) || processes[0];
        setDot('dot-bot', bot?.status === 'online' ? 'active' : 'error');
    }).catch(() => setDot('dot-bot', 'error'));

    api('/api/docker/info').then(() => setDot('dot-docker', 'active')).catch(() => setDot('dot-docker', 'error'));

    api('/api/systemd/services').then(({ services }) => {
        const r = services.find(s => s.service === 'radarr');
        const s = services.find(s => s.service === 'sonarr');
        setDot('dot-radarr', r?.active === 'active' ? 'active' : 'error');
        setDot('dot-sonarr', s?.active === 'active' ? 'active' : 'error');
    }).catch(() => { setDot('dot-radarr', 'error'); setDot('dot-sonarr', 'error'); });
}

function setDot(id, state) {
    const el = document.getElementById(id);
    el.className = 'dot' + (state === 'active' ? ' active' : state === 'warn' ? ' warn' : state === 'error' ? ' error' : '');
}

refreshStatusStrip();
setInterval(refreshStatusStrip, 30000);

// ═══════════════════════════ SYSTEM RESOURCES ═══════════════════════════
function meterClass(pct) {
    return pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '';
}
function meterRow(label, pct, sublabel) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    return `<div class="meter-row">
        <div class="meter-label"><span>${esc(label)}</span><strong>${sublabel ?? p + '%'}</strong></div>
        <div class="meter-track"><div class="meter-fill ${meterClass(p)}" style="width:${p}%"></div></div>
    </div>`;
}
function fmtBytes(bytes) {
    if (bytes == null) return '—';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 ** 2))} MB`;
}

async function loadSystem() {
    document.getElementById('systemUpdatedLine').textContent = 'Refreshing…';
    try {
        const data = await api('/api/system/stats');
        document.getElementById('systemUpdatedLine').textContent = `Host: ${data.hostname || '—'} · uptime ${data.uptimeHours ?? '—'}h · as of ${new Date().toLocaleTimeString()}`;

        // CPU
        const cpuCard = document.getElementById('cpuCard');
        const overall = data.cpu.overallPercent;
        const loadStr = data.cpu.loadavg?.map(n => n.toFixed(2)).join(' / ') ?? '—';
        cpuCard.innerHTML = meterRow('Overall', overall) +
            `<div class="section-note" style="margin-top:8px">Load average (1m / 5m / 15m): ${esc(loadStr)}</div>` +
            (data.cpu.perCore?.length
                ? `<div class="cpu-grid" style="margin-top:14px">${data.cpu.perCore.map((c, i) => meterRow(`core ${i}`, c)).join('')}</div>`
                : '');

        // Memory
        const memCard = document.getElementById('memCard');
        const m = data.memory;
        memCard.innerHTML = meterRow('RAM', m.percent, `${fmtBytes(m.usedBytes)} / ${fmtBytes(m.totalBytes)}`) +
            (m.swapTotalBytes ? meterRow('Swap', m.swapPercent, `${fmtBytes(m.swapUsedBytes)} / ${fmtBytes(m.swapTotalBytes)}`) : '');

        // Disks
        const diskCard = document.getElementById('diskCard');
        diskCard.innerHTML = (data.disks && data.disks.length)
            ? data.disks.map(d => meterRow(d.mount, d.percent, `${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)}`)).join('')
            : '<div class="empty">No mounted filesystems reported.</div>';

        // GPU
        const gpuCard = document.getElementById('gpuCard');
        if (!data.gpu || !data.gpu.available) {
            gpuCard.innerHTML = `<div class="empty">${esc(data.gpu?.reason || 'No GPU detected (nvidia-smi not found).')}</div>`;
        } else {
            gpuCard.innerHTML = data.gpu.devices.map(g => `
                <div style="margin-bottom:16px">
                    <div class="section-note" style="margin-bottom:6px">${esc(g.name)}${g.temperatureC != null ? ` — ${g.temperatureC}°C` : ''}</div>
                    ${meterRow('Utilization', g.utilizationPercent ?? 0)}
                    ${g.memoryTotalMB ? meterRow('VRAM', (g.memoryUsedMB / g.memoryTotalMB) * 100, `${g.memoryUsedMB} / ${g.memoryTotalMB} MB`) : ''}
                </div>`).join('');
        }
    } catch (e) {
        document.getElementById('systemUpdatedLine').textContent = 'Error loading system stats.';
        ['cpuCard', 'memCard', 'diskCard', 'gpuCard'].forEach(id => document.getElementById(id).innerHTML = `<div class="empty">${esc(e.message)}</div>`);
    }
}
setInterval(() => { if (currentView === 'system') loadSystem(); }, 5000);

// ═══════════════════════════ STORAGE (SMART / disk health) ═══════════════════════════
// TBW is conventionally quoted in decimal terabytes (10^12 bytes), same convention
// drive datasheets use — deliberately not TiB here, to match what's on the box.
function fmtTB(bytes) {
    if (bytes == null) return null;
    return `${(bytes / 1000 ** 4).toFixed(2)} TB`;
}
function fmtPowerOn(hours) {
    if (hours == null) return '—';
    const years = hours / 8760;
    return `${hours.toLocaleString()} h${years >= 0.1 ? ` (~${years.toFixed(1)} yr)` : ''}`;
}

function diskCardHtml(d) {
    if (d.error) {
        return `<div class="card">
            <div class="row between"><strong>${esc(d.device)}</strong><span class="badge error">error</span></div>
            <div class="section-note" style="margin-top:8px">${esc(d.error)}</div>
            ${d.hint ? `<div class="section-note">${esc(d.hint)}</div>` : ''}
        </div>`;
    }

    const healthBadge = d.healthPassed === true ? `<span class="badge active">SMART OK</span>`
        : d.healthPassed === false ? `<span class="badge error">SMART FAIL</span>`
        : `<span class="badge">SMART unknown</span>`;

    const isSSD = d.type !== 'HDD';
    let wearBlock;
    if (isSSD) {
        const meter = d.wearPercentUsed != null ? meterRow('Endurance used', d.wearPercentUsed, `${Math.round(d.wearPercentUsed)}%`) : '';
        const written = fmtTB(d.totalBytesWritten);
        const rated = fmtTB(d.ratedTBWBytes);
        wearBlock = meter + `<div class="section-note" style="margin-top:${meter ? '4px' : '0'}">Total written: ${written ? esc(written) : '—'}${rated ? ` of ${esc(rated)} rated` : ''}</div>`;
    } else {
        wearBlock = `<div class="section-note">HDDs don't wear by total bytes written the way NAND does — power-on hours and reallocated/pending sector counts are the more meaningful signals here.</div>`;
    }

    const sectorLine = (d.reallocatedSectors != null || d.pendingSectors != null)
        ? `<div class="section-note" style="margin-top:6px">Reallocated sectors: ${d.reallocatedSectors ?? '—'} · Pending: ${d.pendingSectors ?? '—'}</div>`
        : '';

    return `<div class="card">
        <div class="row between">
            <strong>${esc(d.model)}</strong>
            <span class="badge">${esc(d.type)}</span>
        </div>
        <div class="section-note" style="margin-top:2px">${esc(d.device)}${d.serial ? ` · S/N ${esc(d.serial)}` : ''}${d.capacityBytes ? ` · ${esc(fmtTB(d.capacityBytes))}` : ''}</div>
        <div class="row" style="margin:10px 0 12px">${healthBadge}${d.temperatureC != null ? `<span class="badge">${d.temperatureC}°C</span>` : ''}</div>
        <div class="section-note"><strong style="color:var(--text)">Location:</strong> ${esc(d.location || 'not configured — see STORAGE_LOCATIONS in README')}</div>
        <div class="section-note"><strong style="color:var(--text)">Power-on time:</strong> ${esc(fmtPowerOn(d.powerOnHours))}</div>
        <div style="margin-top:10px">${wearBlock}</div>
        ${sectorLine}
    </div>`;
}

async function loadStorage() {
    const container = document.getElementById('storageContainer');
    document.getElementById('storageUpdatedLine').textContent = 'Reading SMART data…';
    try {
        const { disks } = await api('/api/storage/disks');
        document.getElementById('storageUpdatedLine').textContent = `${disks.length} disk(s) · as of ${new Date().toLocaleTimeString()}`;
        container.innerHTML = disks.length
            ? `<div class="disk-grid">${disks.map(diskCardHtml).join('')}</div>`
            : '<div class="empty">No physical disks detected.</div>';
    } catch (e) {
        document.getElementById('storageUpdatedLine').textContent = 'Error loading storage stats.';
        container.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
}
document.getElementById('storageRefreshBtn').addEventListener('click', loadStorage);

// ═══════════════════════════ BOT: SHOPPING ═══════════════════════════
async function loadShopping() {
    const chatId = document.getElementById('shopChatId').value.trim() || undefined;
    const card = document.getElementById('shopListCard');
    try {
        const data = await api(`/api/bot/shopping${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`);
        const items = data.activeList?.items || [];
        if (items.length === 0) {
            card.innerHTML = `<div class="empty">List "${esc(data.activeList?.name || data.activeListId)}" is empty.</div>`;
            return;
        }
        card.innerHTML = items.map(i => `
            <div class="row between" style="padding:6px 0; border-bottom:1px solid var(--border)">
                <label class="row" style="gap:8px; cursor:pointer">
                    <input type="checkbox" ${i.checked ? 'checked' : ''} data-item="${esc(i.name)}" class="shop-toggle">
                    <span class="item-name ${i.checked ? 'checked' : ''}">${esc(i.name)}</span>
                </label>
                <button class="btn small danger shop-delete" data-item="${esc(i.name)}">Remove</button>
            </div>`).join('');
        card.querySelectorAll('.shop-toggle').forEach(cb => cb.addEventListener('change', async () => {
            try {
                await api('/api/bot/shopping/toggle', { method: 'POST', body: JSON.stringify({ chatId, item: cb.dataset.item, checked: cb.checked }) });
                loadShopping();
            } catch (e) { toast(e.message, 'error'); }
        }));
        card.querySelectorAll('.shop-delete').forEach(b => b.addEventListener('click', async () => {
            try { await api('/api/bot/shopping/delete', { method: 'POST', body: JSON.stringify({ chatId, item: b.dataset.item }) }); loadShopping(); }
            catch (e) { toast(e.message, 'error'); }
        }));
    } catch (e) {
        card.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
}

document.getElementById('shopAddBtn').addEventListener('click', async () => {
    const chatId = document.getElementById('shopChatId').value.trim() || undefined;
    const item = document.getElementById('shopItem').value.trim();
    if (!item) return;
    try {
        await api('/api/bot/shopping/add', { method: 'POST', body: JSON.stringify({ chatId, item }) });
        document.getElementById('shopItem').value = '';
        loadShopping();
    } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('shopClearCheckedBtn').addEventListener('click', async () => {
    const chatId = document.getElementById('shopChatId').value.trim() || undefined;
    try { await api('/api/bot/shopping/clear', { method: 'POST', body: JSON.stringify({ chatId, onlyChecked: true }) }); loadShopping(); }
    catch (e) { toast(e.message, 'error'); }
});
document.getElementById('shopClearBtn').addEventListener('click', async () => {
    if (!confirm('Clear the whole list?')) return;
    const chatId = document.getElementById('shopChatId').value.trim() || undefined;
    try { await api('/api/bot/shopping/clear', { method: 'POST', body: JSON.stringify({ chatId, onlyChecked: false }) }); loadShopping(); }
    catch (e) { toast(e.message, 'error'); }
});
document.getElementById('shopChatId').addEventListener('change', loadShopping);

// ═══════════════════════════ BOT: TODOS ═══════════════════════════
async function loadTodos() {
    const card = document.getElementById('todoListCard');
    try {
        const data = await api('/api/bot/todos');
        if (data.tasks.length === 0) { card.innerHTML = '<div class="empty">No tasks.</div>'; return; }
        const rows = data.tasks.slice().sort((a, b) => a.done - b.done).map(t => `
            <tr>
                <td><span class="badge ${t.priority}">${t.priority}</span></td>
                <td>${t.done ? `<s>${esc(t.text)}</s>` : esc(t.text)}</td>
                <td>
                    ${t.done
                        ? `<button class="btn small todo-reopen" data-id="${t.id}">Reopen</button>`
                        : `<button class="btn small primary todo-done" data-id="${t.id}">Done</button>`}
                    <button class="btn small danger todo-delete" data-id="${t.id}">Delete</button>
                </td>
            </tr>`).join('');
        card.innerHTML = `<table><thead><tr><th>Priority</th><th>Task</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
        card.querySelectorAll('.todo-done').forEach(b => b.addEventListener('click', () => todoAction(b.dataset.id, 'done')));
        card.querySelectorAll('.todo-reopen').forEach(b => b.addEventListener('click', () => todoAction(b.dataset.id, 'reopen')));
        card.querySelectorAll('.todo-delete').forEach(b => b.addEventListener('click', () => todoAction(b.dataset.id, 'delete')));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function todoAction(id, action) {
    try {
        if (action === 'delete') await api(`/api/bot/todos/${id}`, { method: 'DELETE' });
        else await api(`/api/bot/todos/${id}/${action}`, { method: 'POST' });
        loadTodos();
    } catch (e) { toast(e.message, 'error'); }
}
document.getElementById('todoAddBtn').addEventListener('click', async () => {
    const text = document.getElementById('todoText').value.trim();
    const priority = document.getElementById('todoPriority').value;
    if (!text) return;
    try { await api('/api/bot/todos', { method: 'POST', body: JSON.stringify({ text, priority }) }); document.getElementById('todoText').value = ''; loadTodos(); }
    catch (e) { toast(e.message, 'error'); }
});
document.getElementById('todoClearDoneBtn').addEventListener('click', async () => {
    try { await api('/api/bot/todos/clear-done', { method: 'POST' }); loadTodos(); } catch (e) { toast(e.message, 'error'); }
});

// ═══════════════════════════ BOT: REMINDERS ═══════════════════════════
async function loadReminders() {
    const card = document.getElementById('reminderListCard');
    try {
        const data = await api('/api/bot/reminders');
        if (data.reminders.length === 0) { card.innerHTML = '<div class="empty">No reminders.</div>'; return; }
        const rows = data.reminders.map(r => `
            <tr>
                <td><span class="badge ${r.active ? 'active' : 'stopped'}">${r.active ? 'active' : 'off'}</span></td>
                <td>${esc(r.pattern)} @ ${esc(r.time)}</td>
                <td>${esc(r.text)}</td>
                <td>
                    <button class="btn small rem-toggle" data-id="${r.id}" data-active="${r.active}">${r.active ? 'Disable' : 'Enable'}</button>
                    <button class="btn small danger rem-delete" data-id="${r.id}">Delete</button>
                </td>
            </tr>`).join('');
        card.innerHTML = `<table><thead><tr><th>State</th><th>Schedule</th><th>Text</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
        card.querySelectorAll('.rem-toggle').forEach(b => b.addEventListener('click', async () => {
            try {
                await api(`/api/bot/reminders/${b.dataset.id}/active`, { method: 'POST', body: JSON.stringify({ active: b.dataset.active !== 'true' }) });
                toast('Saved — restart the bot for it to take effect.');
                loadReminders();
            } catch (e) { toast(e.message, 'error'); }
        }));
        card.querySelectorAll('.rem-delete').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Delete this reminder?')) return;
            try { await api(`/api/bot/reminders/${b.dataset.id}`, { method: 'DELETE' }); toast('Deleted — restart the bot for it to take effect.'); loadReminders(); }
            catch (e) { toast(e.message, 'error'); }
        }));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ═══════════════════════════ BOT: POLLS ═══════════════════════════
async function loadPolls() {
    const card = document.getElementById('pollListCard');
    try {
        const data = await api('/api/bot/polls');
        if (data.polls.length === 0) { card.innerHTML = '<div class="empty">No polls.</div>'; return; }
        card.innerHTML = data.polls.map(p => {
            const total = Object.keys(p.votes).length;
            const opts = p.options.map((opt, i) => {
                const count = Object.values(p.votes).filter(v => v === i).length;
                const pct = total ? Math.round(count / total * 100) : 0;
                return `<div style="margin:4px 0"><span>${esc(opt)}</span> — ${count} vote(s) (${pct}%)</div>`;
            }).join('');
            return `<div class="card" style="background:var(--panel-raised)">
                <div class="row between">
                    <strong>#${p.id} ${esc(p.question)}</strong>
                    <span class="badge ${p.active ? 'active' : 'stopped'}">${p.active ? 'open' : 'closed'}</span>
                </div>
                ${opts}
                <div class="row" style="margin-top:8px">
                    ${p.active ? `<button class="btn small poll-close" data-id="${p.id}">Close</button>` : ''}
                    <button class="btn small danger poll-delete" data-id="${p.id}">Delete</button>
                </div>
            </div>`;
        }).join('');
        card.querySelectorAll('.poll-close').forEach(b => b.addEventListener('click', async () => {
            try { await api(`/api/bot/polls/${b.dataset.id}/close`, { method: 'POST' }); loadPolls(); } catch (e) { toast(e.message, 'error'); }
        }));
        card.querySelectorAll('.poll-delete').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Delete this poll?')) return;
            try { await api(`/api/bot/polls/${b.dataset.id}`, { method: 'DELETE' }); loadPolls(); } catch (e) { toast(e.message, 'error'); }
        }));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ═══════════════════════════ BOT: WEATHER ═══════════════════════════
document.getElementById('weatherBtn').addEventListener('click', async () => {
    const city = document.getElementById('weatherCity').value.trim();
    const lang = document.getElementById('weatherLang').value;
    const card = document.getElementById('weatherResultCard');
    card.innerHTML = '<div class="empty">Checking…</div>';
    try {
        const w = await api(`/api/bot/weather?city=${encodeURIComponent(city)}&lang=${lang}`);
        card.innerHTML = w.error ? `<div class="empty">${esc(w.error)}</div>` : `<div style="font-size:16px">${w.emoji} <strong>${esc(w.name)}</strong> — ${esc(w.desc)}, ${w.temp}°C</div>`;
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
});

// ═══════════════════════════ PM2 ═══════════════════════════
async function loadPm2() {
    const card = document.getElementById('pm2TableCard');
    try {
        const { processes } = await api('/api/pm2/status');
        if (processes.length === 0) { card.innerHTML = '<div class="empty">No PM2 processes found.</div>'; return; }
        const rows = processes.map(p => `
            <tr>
                <td>${esc(p.name)}</td>
                <td><span class="badge ${p.status === 'online' ? 'active' : 'error'}">${esc(p.status)}</span></td>
                <td>${p.restarts}</td>
                <td>${p.memory ? Math.round(p.memory / 1024 / 1024) + ' MB' : '—'}</td>
                <td>${p.cpu ?? '—'}%</td>
                <td><button class="btn small primary pm2-restart" data-name="${esc(p.name)}">Restart</button></td>
            </tr>`).join('');
        card.innerHTML = `<table><thead><tr><th>Name</th><th>Status</th><th>Restarts</th><th>Memory</th><th>CPU</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
        card.querySelectorAll('.pm2-restart').forEach(b => b.addEventListener('click', async () => {
            if (!confirm(`Restart ${b.dataset.name}?`)) return;
            try { await api('/api/pm2/restart', { method: 'POST', body: JSON.stringify({ name: b.dataset.name }) }); toast(`Restarted ${b.dataset.name}`); loadPm2(); }
            catch (e) { toast(e.message, 'error'); }
        }));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
document.getElementById('pm2LogRefreshBtn').addEventListener('click', async () => {
    const type = document.getElementById('pm2LogType').value;
    const box = document.getElementById('pm2LogBox');
    box.textContent = 'Loading…';
    try {
        const data = await api(`/api/pm2/logs?type=${type}&lines=200`);
        const lines = [...(data.error || []).map(l => `[ERR] ${l}`), ...(data.out || []).map(l => `${l}`)];
        box.innerHTML = lines.length ? lines.map(l => `<div class="line${l.startsWith('[ERR]') ? ' err' : ''}">${esc(l)}</div>`).join('') : 'No log lines.';
    } catch (e) { box.textContent = e.message; }
});

// ═══════════════════════════ DOCKER ═══════════════════════════
async function loadDocker() {
    const card = document.getElementById('dockerTableCard');
    const infoLine = document.getElementById('dockerInfoLine');
    const select = document.getElementById('dockerLogContainer');
    try {
        const info = await api('/api/docker/info');
        infoLine.textContent = `Docker ${info.serverVersion} — ${info.containersRunning} running, ${info.containersStopped} stopped, ${info.images} images`;
    } catch (e) { infoLine.textContent = `Docker daemon unreachable: ${e.message}`; }

    try {
        const { containers } = await api('/api/docker/containers');
        if (containers.length === 0) { card.innerHTML = '<div class="empty">No containers found.</div>'; return; }
        const rows = containers.map(c => `
            <tr>
                <td>${esc(c.names.join(', '))}</td>
                <td>${esc(c.image)}</td>
                <td><span class="badge ${c.state === 'running' ? 'active' : 'stopped'}">${esc(c.state)}</span></td>
                <td class="subtitle" style="margin:0">${esc(c.status)}</td>
                <td>
                    ${c.state === 'running'
                        ? `<button class="btn small docker-restart" data-id="${c.id}">Restart</button><button class="btn small danger docker-stop" data-id="${c.id}">Stop</button>`
                        : `<button class="btn small primary docker-start" data-id="${c.id}">Start</button>`}
                </td>
            </tr>`).join('');
        card.innerHTML = `<table><thead><tr><th>Name</th><th>Image</th><th>State</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
        card.querySelectorAll('.docker-restart').forEach(b => b.addEventListener('click', () => dockerAction(b.dataset.id, 'restart')));
        card.querySelectorAll('.docker-stop').forEach(b => b.addEventListener('click', () => dockerAction(b.dataset.id, 'stop')));
        card.querySelectorAll('.docker-start').forEach(b => b.addEventListener('click', () => dockerAction(b.dataset.id, 'start')));

        select.innerHTML = '<option value="">Select a container…</option>' + containers.map(c => `<option value="${c.id}">${esc(c.names[0])}</option>`).join('');
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function dockerAction(id, action) {
    try { await api(`/api/docker/containers/${id}/${action}`, { method: 'POST' }); toast(`${action} ok`); loadDocker(); }
    catch (e) { toast(e.message, 'error'); }
}
document.getElementById('dockerLogRefreshBtn').addEventListener('click', async () => {
    const id = document.getElementById('dockerLogContainer').value;
    const box = document.getElementById('dockerLogBox');
    if (!id) { box.textContent = 'Select a container first.'; return; }
    box.textContent = 'Loading…';
    try {
        const { lines } = await api(`/api/docker/containers/${id}/logs?lines=200`);
        box.innerHTML = lines.length ? lines.map(l => `<div class="line${/error|fail|exception/i.test(l) ? ' err' : ''}">${esc(l)}</div>`).join('') : 'No log lines.';
    } catch (e) { box.textContent = e.message; }
});

// ═══════════════════════════ RADARR / SONARR ═══════════════════════════
async function loadArr() {
    const card = document.getElementById('arrCard');
    try {
        const { services } = await api('/api/systemd/services');
        card.innerHTML = services.map(s => `
            <div class="row between" style="padding:10px 0; border-bottom:1px solid var(--border)">
                <span class="row" style="gap:10px"><span class="badge ${s.active === 'active' ? 'active' : 'error'}">${esc(s.active)}</span><strong>${esc(s.service)}</strong></span>
                <span class="row">
                    <button class="btn small primary arr-restart" data-svc="${s.service}">Restart</button>
                    <button class="btn small arr-start" data-svc="${s.service}">Start</button>
                    <button class="btn small danger arr-stop" data-svc="${s.service}">Stop</button>
                </span>
            </div>`).join('');
        card.querySelectorAll('.arr-restart').forEach(b => b.addEventListener('click', () => arrAction(b.dataset.svc, 'restart')));
        card.querySelectorAll('.arr-start').forEach(b => b.addEventListener('click', () => arrAction(b.dataset.svc, 'start')));
        card.querySelectorAll('.arr-stop').forEach(b => b.addEventListener('click', () => arrAction(b.dataset.svc, 'stop')));
    } catch (e) { card.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function arrAction(svc, action) {
    if (action !== 'restart' || confirm(`${action} ${svc}?`)) {
        try {
            const r = await api(`/api/systemd/${svc}/${action}`, { method: 'POST' });
            toast(`${svc}: ${action} ok`);
            loadArr();
        } catch (e) { toast(e.message + (e.hint ? ` — ${e.hint}` : ''), 'error'); }
    }
}
document.getElementById('arrLogRefreshBtn').addEventListener('click', async () => {
    const svc = document.getElementById('arrLogService').value;
    const box = document.getElementById('arrLogBox');
    box.textContent = 'Loading…';
    try {
        const { lines } = await api(`/api/systemd/${svc}/logs?lines=200`);
        box.innerHTML = lines.length ? lines.map(l => `<div class="line${/error|fail|exception/i.test(l) ? ' err' : ''}">${esc(l)}</div>`).join('') : 'No log lines.';
    } catch (e) { box.textContent = e.message; }
});

// ═══════════════════════════ ERROR LOG ═══════════════════════════
async function loadErrors() {
    const container = document.getElementById('errorsContainer');
    container.innerHTML = '<div class="empty">Scanning pm2, docker, and systemd logs…</div>';
    try {
        const data = await api('/api/logs/errors?lines=300');
        document.getElementById('errorsGeneratedAt').textContent = `as of ${new Date(data.generatedAt).toLocaleTimeString()}`;
        if (data.groups.length === 0) { container.innerHTML = '<div class="empty">Nothing to show.</div>'; return; }
        container.innerHTML = data.groups.map((g, idx) => {
            const count = g.matches ?? 0;
            const bodyId = `errgroup-${idx}`;
            const body = g.error
                ? `<div class="empty">${esc(g.error)}</div>`
                : (g.lines.length ? g.lines.map(l => `<div class="line err">${esc(l)}</div>`).join('') : '<div class="empty">No error-looking lines in the recent window.</div>');
            return `<div class="card">
                <div class="group-header" data-target="${bodyId}">
                    <span class="badge">${esc(g.source)}</span>
                    <strong>${esc(g.target || '')}</strong>
                    <span class="count-pill ${count === 0 ? 'zero' : ''}">${count} match${count === 1 ? '' : 'es'}</span>
                </div>
                <div class="log-box" id="${bodyId}" style="display:${count > 0 ? 'block' : 'none'}">${body}</div>
            </div>`;
        }).join('');
        container.querySelectorAll('.group-header').forEach(h => h.addEventListener('click', () => {
            const el = document.getElementById(h.dataset.target);
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }));
    } catch (e) { container.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ── Initial load ──────────────────────────────────────────────
loadShopping();
loadTodos();
loadReminders();
loadPolls();
