# CRP · City Run Project backstage

Backstage web app for running a *City Run* (Amazing-Race-style) fan event. Hosts build the race (episodes, legs, teams, schedule), crews record team progress and money on their phones, and everyone sees the same live data.

- **Web**: Vue 3 + Vite + TypeScript (`web/`), hand-written Material 3 styles, separate phone layout under 760 px
- **Server**: Node.js + Hono + `node:sqlite` (`server/`), Socket.IO for live invalidation, bcrypt + JWT cookie auth
- **Data**: one SQLite file plus an uploads folder (`DATA_DIR`, default `server/data/`)

Documentation:

- [User manual (中文)](docs/user-manual.md) — how hosts, follows, stations and admins use the system
- [API reference](docs/api.md) — every HTTP endpoint with roles and payloads

## Features at a glance

- Multiple events on one server. Each event has a short hash (`/e/<hash>/…`), an invite code, members with per-event roles (host / crew) and a global admin role.
- Episodes made of typed legs (starting line, route info, task, detour, roadblock, fast forward, union, shuffle, U-turn, yield, speed bump, face-off, trap, side quest, pit stop). The first episode starts with a Starting Line and every episode ends with a Pit Stop.
- Scheduled episode start with optional rank-based staggered departures; manual start and reset kept for testing.
- Per-team progress with automatic chaining (a leg's start = previous leg's end), prerequisites, side quests that pause the main leg, mutual union partners, automatic elimination per leg, withdrawals and a unified lock rule (finished episode or eliminated team → admin only).
- Money in two modes: cash (yuan, 2 decimals) or coins (integers). Coin mode adds a shop, per-team bags with a separate item log, fixed transport fares and cutoff costs.
- Cutoffs (timed hints) per leg with countdowns; penalties and time credits; live standings computed on the fly.
- Live board of team positions, announcements with read tracking, audit log, JSON backup/restore.
- Phone layout: top app bar, bottom navigation, drawer, bottom-sheet dialogs and menus, card-style logs.

## Development

Node.js ≥ 22.13.

```bash
npm install
npm run dev          # API on http://localhost:3000, web on http://localhost:5173 (proxies /api and /socket.io)
npm run typecheck    # server + web
npm run build        # builds web into server/public and compiles the server
```

A fresh database starts empty: no events, no accounts. Create a global admin from the command line (it writes to `server/data`), then create events from the home page:

```bash
npm run create-admin --workspace=server -- <username> <password>
```

If you install packages through a mirror such as npmmirror, run `npm run lock:fix` before committing so `package-lock.json` points at the official registry; npm ≥ 11.10 refuses mismatched "remote" packages on the server.

## Deployment

Tested on Ubuntu 22.04 / Debian 12 / Debian 13:

```bash
git clone https://github.com/yituoren/crp.git /opt/crp
bash /opt/crp/deploy/install.sh
```

The script installs Node 22 and sqlite3, adds 2 GB of swap on small instances, creates the `crp` user, builds, registers the `crp` systemd service on port 80 and adds a daily 04:00 backup.

```bash
systemctl status crp                 # status
journalctl -u crp -f                 # live logs
bash /opt/crp/deploy/update.sh       # pull (Gitee mirror first, then GitHub), rebuild, restart
bash /opt/crp/deploy/backup.sh       # backup now into /opt/crp/backups
bash /opt/crp/deploy/create-admin.sh <username> <password>
```

GitHub is often unreachable from mainland servers, so `.github/workflows/sync-gitee.yml` mirrors every push to `gitee.com/yituoren/crp` (secret `GITEE_SSH_KEY`, whose public key is in the Gitee account's SSH keys) and `update.sh` pulls from Gitee first. To be sure the server builds exactly what you pushed, pass the commit hash from your machine; the script then waits for a source that has that commit and refuses to build anything else:

```bash
ssh root@<server> "bash /opt/crp/deploy/update.sh $(git rev-parse main)"
```

All state lives in `/opt/crp/data/` (`crp.db`, `uploads/`, `jwt-secret.txt`); copy that folder to migrate. `docker compose up -d --build` is an alternative that also listens on port 80 with data in `./data`.

### Domain and HTTPS

The installer serves plain HTTP from Node on port 80. To add a domain, put Nginx in front:

```bash
bash /opt/crp/deploy/setup-nginx.sh example.cn                  # Nginx on port 80, app moved to 127.0.0.1:3000
bash /opt/crp/deploy/setup-nginx.sh example.cn --https [email]  # Let's Encrypt certificate, HTTPS on 443
```

The first form only moves the app behind Nginx (a systemd drop-in sets `HOST=127.0.0.1` and `PORT=3000`, so `update.sh` keeps it). The `--https` form needs the domain resolving to the server, port 80 reachable (on mainland servers this means an approved ICP filing) and port 443 open in the cloud firewall. `www.example.cn` and `http://` redirect to `https://example.cn`; `http://<server IP>` keeps working. Certbot's timer renews the certificate and a deploy hook reloads Nginx. Socket.IO WebSockets and 10 MB uploads pass through the proxy; the session cookie is marked `Secure` when Nginx reports HTTPS.


## Repository layout

```
server/src
  index.ts            bootstrap, route mounting, static files, scheduler start
  db.ts               SQLite schema, migrations (ensureColumn), helpers
  auth.ts             session cookie, roles, per-event permission helpers
  util.ts             audit log, notify (Socket.IO), validation helpers
  elimination.ts      automatic elimination and lock points
  episodeStart.ts     episode start, departure plan, auto departures
  scheduler.ts        5-second tick for scheduled starts and departures
  progressCore.ts     progress upsert, chaining, final ranking
  routes/             auth events episodes teams assignments progress ledger announcements admin dashboard
web/src
  views/              pages (home, account, today, announcements, episodes, leg detail, schedule, teams, currency, progress, admin)
  components/         layouts, dialogs, selects, cards, tables
  stores/             auth, race (event data), ui (toasts, confirms)
  styles.css          desktop styles; mobile.css phone overrides
  directives/         v-mobile-table (card layout for tables on phones)
deploy/               install.sh update.sh backup.sh create-admin.sh setup-nginx.sh crp.service
docs/                 user-manual.md (中文), api.md, templates/cards (clue card artwork)
```

Clue-card artwork lives in `docs/templates/cards/`, one 700 × 494 sRGB PNG per leg type named by its code (`StartingLine RI TI DT RB FF Union FO SB SQ Trap Shuffle`; the Starting Line card uses its full name instead of `SL`). Leg type tag colours are sampled from these cards; types without artwork (U-Turn, Yield) use colours chosen not to clash, and Pit Stop is near-black.
