# Kralice Dashboard

A single ops dashboard for kraliceserver: run bot commands (shopping list, to-do,
reminders, polls, weather), restart the `kralice-bot` PM2 process, watch host
resource usage (CPU / RAM / storage / GPU), watch/restart Docker containers,
control the `radarr` and `sonarr` systemd services, and see an aggregated
error log across all of them.

It does **not** re-implement the bot's Telegram command parsing. It works by:
- reading/writing the exact same JSON files the bot uses (`shopping.json`,
  `todos.json`, `polls.json`, `reminders.json`) directly from `BOT_DIR`
- dynamically importing `modules/weather.js` from the bot itself for live
  weather data, so the geocoding logic isn't duplicated
- shelling out to `/proc/stat` + `/proc/meminfo` + `df` + `nvidia-smi` for
  host resource stats, and to `pm2`, the Docker socket, `systemctl`, and
  `journalctl` for everything else infrastructure-related

## 1. Install

On kraliceserver, next to (not inside) the bot's own directory:

```bash
git clone <this> kralice-dashboard   # or just copy the folder over
cd kralice-dashboard
npm install
cp .env.example .env
```

Edit `.env`:
- `BOT_DIR` — absolute path to the bot's install directory (same folder as its
  `index.js`, containing `modules/` and the `*.json` state files)
- `DASHBOARD_TOKEN` — set this to something long and random
  (`openssl rand -hex 32`). Without it, every `/api/*` route is open to
  anyone who can reach the dashboard's port.
- `SYSTEMD_ALLOWED_SERVICES` — leave as `radarr,sonarr` unless you want to add more

## 2. Run it under PM2 too

```bash
pm2 start server.js --name kralice-dashboard
pm2 save
```

## 3. Docker socket access

The dashboard talks to Docker over `/var/run/docker.sock`. Add the user PM2
runs as to the `docker` group:

```bash
sudo usermod -aG docker $(whoami)
# log out/in (or `newgrp docker`) for the group change to apply
```

If you'd rather not grant docker-group access (it's root-equivalent), point
`DOCKER_SOCKET` at a read-only proxy like `docker-socket-proxy` instead.

## 4. Passwordless sudo for Radarr/Sonarr restart

`systemctl status` and `journalctl -u` work fine unprivileged. `systemctl
restart/stop/start` do not, so the dashboard calls them through `sudo -n`
(the `-n` means it will fail loudly instead of hanging on a password prompt
if this isn't configured).

Run `sudo visudo -f /etc/sudoers.d/kralice-dashboard` and add
(replace `francesco` with whatever user runs the dashboard process):

```
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl restart radarr
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl stop radarr
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl start radarr
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl restart sonarr
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl stop sonarr
francesco ALL=(root) NOPASSWD: /usr/bin/systemctl start sonarr
```

Confirm the exact path to `systemctl` first with `which systemctl` — it's
`/usr/bin/systemctl` on most Debian/Ubuntu systems (Czech Republic, so
presumably yours too, but check).

This is deliberately scoped to only these six exact commands — not a
blanket `NOPASSWD: /usr/bin/systemctl *`, which would let anyone who
compromises the dashboard process control every service on the box.

## 5. Storage tab (SMART disk health)

The Storage tab shows per-disk health via `smartctl` (from `smartmontools`) —
model, serial, physical location, power-on time, and wear: **TBW** (total
bytes written) plus reported endurance-used percentage for SSDs, and
power-on hours plus reallocated/pending sector counts for HDDs. TBW is an
SSD-specific NAND-wear metric and doesn't have a meaningful HDD equivalent,
so HDD cards show the mechanical health signals instead.

Install smartmontools if it isn't already there:

```bash
sudo apt install smartmontools
```

`smartctl -a` needs root for basically every NVMe drive and many SATA drives
behind USB/RAID bridges, so — like the Radarr/Sonarr controls — the dashboard
shells out through `sudo -n`. Add a sudoers rule for it:

```bash
sudo visudo -f /etc/sudoers.d/kralice-dashboard-smart
```

Two options, depending on how much you want to lock this down:

**Option A — scoped to your exact disks (recommended):** set `STORAGE_DEVICES`
in `.env` (see below) to a fixed list, confirm the paths with `lsblk -d`, and
grant sudo only for those:

```
user ALL=(root) NOPASSWD: /usr/sbin/smartctl -a -j /dev/sda
user ALL=(root) NOPASSWD: /usr/sbin/smartctl -a -j /dev/nvme0n1
```

**Option B — any disk, unscoped:** `smartctl -a` is read-only (it doesn't
write to the drive or change system state), so a wildcard rule is lower-risk
than the systemctl one above, but it does let the dashboard process read
SMART data — including serial numbers — from *any* block device on the box:

```
user ALL=(root) NOPASSWD: /usr/sbin/smartctl *
```

Confirm the exact path with `which smartctl` first (`/usr/sbin/smartctl` on
most Debian/Ubuntu systems).

Edit `.env` to configure the tab:

- `STORAGE_DEVICES` — optional comma list of device names to show, e.g.
  `sda,nvme0n1`. Leave unset to auto-detect every physical disk via `lsblk`.
- `STORAGE_LOCATIONS` — optional `device:label` pairs for where each disk
  physically lives, since there's no reliable zero-dependency way to read
  drive-bay position from software, e.g.
  `sda:Bay 1 (front),sdb:Bay 2 (front),nvme0n1:M.2 slot 1`. Falls back to the
  disk's mountpoint(s) if not set.
- `STORAGE_RATED_TBW_GB` — optional `device:GB` pairs giving each SSD's
  datasheet-rated endurance, e.g. `sda:600000,nvme0n1:1200000` for 600TB- and
  1200TB-rated drives. Used to compute "% of rated life used" for drives that
  don't report a wear percentage themselves. NVMe drives and most modern SATA
  SSDs report this on their own and don't need it configured.

## 6. What each tab does

- **Bot** — Shopping / To-Do / Reminders / Polls read and write the bot's
  JSON files directly. Weather calls the bot's own live-data module.
  **Reminder enable/disable/delete takes effect only after the bot's PM2
  process restarts** — the running bot doesn't watch the file for changes,
  it only re-arms cron jobs on its own `addReminder` / `setReminderActive` /
  boot-time rehydrate calls.
- **System** — host CPU (overall + per-core, from two `/proc/stat` samples
  ~250ms apart), RAM/swap (from `/proc/meminfo`'s `MemAvailable`, which
  accounts for reclaimable cache — more honest than raw "free"), storage
  (`df`, real filesystems only), and GPU (`nvidia-smi`, if present — shows
  "no GPU detected" otherwise rather than erroring). Auto-refreshes every 5s
  while the tab is open.
- **Storage** — per-disk SMART health via `smartctl`: model, serial, physical
  location, power-on time, and wear (TBW + endurance-used % for SSDs;
  reallocated/pending sector counts for HDDs). See section 5 above.
- **PM2** — process table (status, restarts, memory, CPU), one-click
  restart, and a combined out+error log tail.
- **Docker** — container list with start/stop/restart, plus a per-container
  log viewer.
- **Radarr / Sonarr** — status, start/stop/restart, and `journalctl` tail
  for each.
- **Error Log** — pulls a recent window of lines from PM2's error log,
  every running container's logs, and both `arr` services' journals, and
  keeps only lines matching an error-ish pattern (`error`, `fail`,
  `exception`, `fatal`, `panic`, `❌`, etc). Grouped by source rather than
  merged into one timeline, since PM2/Docker/journalctl timestamp formats
  don't reconcile cleanly.

## Known limitations (by design, not oversights)

- **Reminders need a bot restart to take effect** (see above).
- **GPU monitoring is NVIDIA-only** (via `nvidia-smi`). AMD/Intel GPUs will
  show as "no GPU detected" — there's no equivalent zero-dependency CLI
  that's as universally present, so it wasn't wired up.
- **Error log is a keyword-filtered tail, not full-text search** — it looks
  at the last N lines per source (configurable via `DEFAULT_LOG_LINES`),
  not the entire log history.
- **Concurrent writes**: if the bot and dashboard write to the same JSON
  file in the same instant, last write wins — same as the bot's own
  file-based storage already assumes. Fine for a single-user home setup;
  would need real locking (or a database) if this ever became multi-writer.
- The dashboard doesn't send anything through Telegram — it edits state
  directly, so there's no "message from Dashboard" trail in your chats the
  way there is when you type a command yourself.
- **Disk bay/slot location isn't auto-detected** — there's no reliable
  zero-dependency way to read physical drive-bay position from software, so
  it's configured manually via `STORAGE_LOCATIONS` (falls back to mountpoint
  if unset).
- **SSD wear reporting varies by vendor** — NVMe drives report a standard
  `percentage_used` field, but SATA SSDs scatter the equivalent across
  differently-named SMART attributes (or omit it entirely on cheaper drives).
  The dashboard checks the common attribute names and falls back to raw TBW
  vs. a configured `STORAGE_RATED_TBW_GB` when no vendor wear-percentage is
  available; if neither is present, only raw bytes-written is shown.
