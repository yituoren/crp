import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'crp.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'crew',          -- host | crew
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ann_read_id INTEGER NOT NULL DEFAULT 0     -- last read announcement id (shared across devices)
);
CREATE TABLE IF NOT EXISTS access_list (
  username TEXT PRIMARY KEY,
  added_by TEXT,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                  -- EP1
  name TEXT NOT NULL,
  budget INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | running | finished
  notes TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,                         -- SL RI TI DT RB FO Union Trap PS
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '',
  clue_text TEXT NOT NULL DEFAULT '',
  judge_criteria TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '',
  close_time TEXT NOT NULL DEFAULT '',
  detour_a TEXT NOT NULL DEFAULT '',
  detour_b TEXT NOT NULL DEFAULT '',
  needs_staff INTEGER NOT NULL DEFAULT 1,      -- whether station crew is needed
  record_mode TEXT NOT NULL DEFAULT 'full'     -- none | single | full
);
CREATE INDEX IF NOT EXISTS idx_legs_ep ON legs(episode_id, sort);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_id INTEGER NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                  -- T1
  name TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'alive',       -- alive | eliminated | withdrawn
  currency INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                         -- follow | station
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  leg_id INTEGER REFERENCES legs(id) ON DELETE SET NULL,
  leg_ids TEXT,                               -- leg ids the station covers (JSON array)
  UNIQUE(episode_id, user_id)
);
CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  leg_id INTEGER NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
  arrived_at TEXT,
  completed_at TEXT,
  detour_choice TEXT,
  roadblock_by TEXT,
  ff_result TEXT,                             -- success | fail | null
  target_team_id INTEGER,                     -- target team of a U-Turn / Yield
  note TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(episode_id, team_id, leg_id)
);
CREATE TABLE IF NOT EXISTS penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  applied_by INTEGER,
  applied_at TEXT NOT NULL,
  reverted INTEGER NOT NULL DEFAULT 0,        -- reverted
  reverts_id INTEGER,                         -- which row this one reverts
  leg_id INTEGER                              -- leg (station) where it happened, nullable
);
CREATE TABLE IF NOT EXISTS pitstop_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  checkin_at TEXT,
  rank INTEGER,
  eliminated INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(episode_id, team_id)
);
CREATE TABLE IF NOT EXISTS currency_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  operator_id INTEGER,
  operator_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reverted INTEGER NOT NULL DEFAULT 0,        -- reverted
  reverts_id INTEGER,                         -- which row this one reverts
  leg_id INTEGER                              -- leg where it happened, nullable ("other")
);
CREATE INDEX IF NOT EXISTS idx_ledger_ep ON currency_ledger(episode_id, created_at);
CREATE TABLE IF NOT EXISTS item_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  leg_id INTEGER,
  item_name TEXT NOT NULL,
  delta INTEGER NOT NULL,                     -- +1 gained / -1 used
  kind TEXT NOT NULL DEFAULT 'use',           -- buy | use (revert rows keep the original kind)
  ledger_id INTEGER,                          -- ledger row of the purchase
  operator_id INTEGER,
  operator_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reverted INTEGER NOT NULL DEFAULT 0,
  reverts_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_item_log_team ON item_log(team_id, created_at);
CREATE TABLE IF NOT EXISTS leg_cutoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_id INTEGER NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_min INTEGER NOT NULL DEFAULT 0,        -- first available: minutes after the team enters the leg
  interval_min INTEGER NOT NULL DEFAULT 0,     -- minutes until it can be used again
  cost INTEGER NOT NULL DEFAULT 0,             -- cost per use in coin mode (stored in cents)
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cutoff_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  leg_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  cutoff_id INTEGER NOT NULL,
  cutoff_name TEXT NOT NULL DEFAULT '',
  used_at TEXT NOT NULL,
  used_by INTEGER,
  used_by_name TEXT NOT NULL DEFAULT '',
  ledger_id INTEGER                            -- ledger row of the charge, reverted together with the use
);
CREATE INDEX IF NOT EXISTS idx_cutoff_uses_ep ON cutoff_uses(episode_id, team_id);
CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,            -- stored in cents; whole coins × 100 in coin mode
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Per-leg shop stock: which event items a leg sells and how many; remaining = quantity minus non-reverted purchases on that leg
CREATE TABLE IF NOT EXISTS leg_shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_id INTEGER NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
  shop_item_id INTEGER NOT NULL,
  quantity INTEGER,                            -- null = unlimited
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(leg_id, shop_item_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',         -- info | warning | urgent
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pinned_at TEXT,                             -- pinned at; null = not pinned
  audience TEXT NOT NULL DEFAULT 'all'        -- audience (reserved)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,                  -- short hash used in routes
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL DEFAULT '',       -- invite code used to join the event
  hosts TEXT NOT NULL DEFAULT '',             -- legacy host list (comma-separated crew IDs)
  team_size INTEGER NOT NULL DEFAULT 2,
  currency_mode TEXT NOT NULL DEFAULT 'yuan', -- yuan | coin
  rb_gap INTEGER NOT NULL DEFAULT 2,
  owner_id INTEGER,                           -- creator: needs no invite code, like an admin
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',                -- optional note on the join request
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by INTEGER
);
CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'crew',          -- per-event role: host | crew (the creator defaults to host)
  UNIQUE(event_id, user_id)
);
CREATE TABLE IF NOT EXISTS ann_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, event_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
`;
db.exec(SCHEMA);

/** Add a column to an existing database (idempotent). Returns true when the column was added just now. */
function ensureColumn(table: string, col: string, ddl: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
  if (cols.includes(col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  return true;
}
if (ensureColumn('legs', 'needs_staff', 'INTEGER NOT NULL DEFAULT 1') || ensureColumn('legs', 'record_mode', "TEXT NOT NULL DEFAULT 'full'")) {
  // Apply type defaults to old rows: Route Info needs no station and no time; Starting Line / finish are recorded once
  db.exec("UPDATE legs SET needs_staff = 0, record_mode = 'none' WHERE type = 'RI'");
  db.exec("UPDATE legs SET record_mode = 'single' WHERE type IN ('SL', 'PS')");
}
// Every leg records both a start and an end time; whether a station is needed depends on the type (only Route Info does not)
ensureColumn('legs', 'cutoff_start', 'INTEGER NOT NULL DEFAULT 0');     // cutoff start time (minutes from the episode start)
ensureColumn('legs', 'cutoff_interval', 'INTEGER NOT NULL DEFAULT 0');  // cutoff interval (minutes)
db.exec("UPDATE legs SET record_mode = 'full' WHERE record_mode != 'full'");
db.exec("UPDATE legs SET needs_staff = CASE WHEN type = 'RI' THEN 0 ELSE 1 END WHERE needs_staff != CASE WHEN type = 'RI' THEN 0 ELSE 1 END");
ensureColumn('progress', 'target_team_id', 'INTEGER');
ensureColumn('episodes', 'started_at', 'TEXT');
ensureColumn('episodes', 'start_at', 'TEXT');            // scheduled start time (null = no automatic start)
ensureColumn('episodes', 'inherit_rank', 'INTEGER NOT NULL DEFAULT 0'); // depart in the order of the previous episode's ranking
ensureColumn('episodes', 'start_gap_min', 'INTEGER NOT NULL DEFAULT 0'); // departure gap (minutes)
ensureColumn('episodes', 'depart_base', 'TEXT');        // departure base time: scheduled start = the set time, manual start = click time; null = no automatic departures
ensureColumn('episodes', 'finished_at', 'TEXT');
ensureColumn('users', 'ann_read_id', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('announcements', 'pinned_at', 'TEXT');
ensureColumn('announcements', 'audience', "TEXT NOT NULL DEFAULT 'all'");
ensureColumn('currency_ledger', 'reverted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('currency_ledger', 'reverts_id', 'INTEGER');
ensureColumn('penalties', 'reverted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('penalties', 'reverts_id', 'INTEGER');
ensureColumn('penalties', 'leg_id', 'INTEGER');
ensureColumn('currency_ledger', 'leg_id', 'INTEGER');
// Shop: ledger rows distinguish "shop purchase / other"; purchases store the item (name snapshot, traceable after the item is deleted); legs can open the shop
ensureColumn('currency_ledger', 'kind', "TEXT NOT NULL DEFAULT 'other'");
ensureColumn('currency_ledger', 'item_id', 'INTEGER');
ensureColumn('currency_ledger', 'item_name', 'TEXT');
ensureColumn('legs', 'shop_open', 'INTEGER NOT NULL DEFAULT 0');
// Shop stock per leg: legs opened before stock lists existed sold every event item without limit; keep that, then shop_open mirrors "has stock rows"
if (get('SELECT 1 FROM legs l WHERE l.shop_open = 1 AND NOT EXISTS (SELECT 1 FROM leg_shop_items s WHERE s.leg_id = l.id) LIMIT 1')) {
  db.exec(`
    INSERT INTO leg_shop_items(leg_id, shop_item_id, quantity, sort, created_at)
      SELECT l.id, i.id, NULL, i.sort, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM legs l JOIN episodes e ON e.id = l.episode_id JOIN shop_items i ON i.event_id = e.event_id
      WHERE l.shop_open = 1 AND NOT EXISTS (SELECT 1 FROM leg_shop_items s WHERE s.leg_id = l.id);
    UPDATE legs SET shop_open = EXISTS (SELECT 1 FROM leg_shop_items s WHERE s.leg_id = legs.id);
  `);
}
// Automatic elimination: leg flag + count; teams record where they were eliminated and from which leg they are locked (no records after elimination / withdrawal)
run("UPDATE legs SET type = 'SQ' WHERE type = 'BR'"); // side quest code BR → SQ
// Items moved to their own log: mirror ledger purchases (kind=shop) as "gained", move uses (kind=use) into the item log and delete them from the ledger
if (!get('SELECT 1 FROM item_log LIMIT 1') && get("SELECT 1 FROM currency_ledger WHERE kind IN ('shop', 'use') LIMIT 1")) {
  db.exec(`
    INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, ledger_id, operator_id, operator_name, created_at, reverted, reverts_id)
      SELECT episode_id, team_id, leg_id, item_name, CASE WHEN reverts_id IS NULL THEN 1 ELSE -1 END, 'buy', id, operator_id, operator_name, created_at, reverted, NULL
      FROM currency_ledger WHERE kind = 'shop' AND item_name IS NOT NULL ORDER BY id;
    UPDATE item_log SET reverts_id = (SELECT b.id FROM item_log b JOIN currency_ledger l ON l.id = item_log.ledger_id WHERE b.ledger_id = l.reverts_id) WHERE delta = -1 AND kind = 'buy';
    INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, ledger_id, operator_id, operator_name, created_at, reverted, reverts_id)
      SELECT episode_id, team_id, leg_id, item_name, CASE WHEN reverts_id IS NULL THEN -1 ELSE 1 END, 'use', NULL, operator_id, operator_name, created_at, reverted, NULL
      FROM currency_ledger WHERE kind = 'use' AND item_name IS NOT NULL ORDER BY id;
    DELETE FROM currency_ledger WHERE kind = 'use';
  `);
}
// Starting Line now has "departure (start) + completion": old rows only had the departure (in completed_at), reuse it as the start time
run("UPDATE progress SET arrived_at = completed_at WHERE arrived_at IS NULL AND completed_at IS NOT NULL AND leg_id IN (SELECT id FROM legs WHERE type = 'SL')");
const addedCanElim = ensureColumn('legs', 'can_eliminate', 'INTEGER NOT NULL DEFAULT 0');
const addedElimCount = ensureColumn('legs', 'eliminate_count', 'INTEGER NOT NULL DEFAULT 1');
if (addedCanElim || addedElimCount) {
  db.exec("UPDATE legs SET can_eliminate = 1, eliminate_count = 2 WHERE type = 'PS'");
}
ensureColumn('teams', 'eliminated_leg_id', 'INTEGER');
ensureColumn('teams', 'locked_from_leg_id', 'INTEGER');
ensureColumn('assignments', 'leg_ids', 'TEXT'); // A station may cover several legs: JSON array, leg_id keeps the first one

// ---------- Multi-event: episodes, teams, announcements and logs hang off an event ----------
ensureColumn('episodes', 'event_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('teams', 'event_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('announcements', 'event_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('audit_logs', 'event_id', 'INTEGER');
ensureColumn('events', 'owner_id', 'INTEGER');
ensureColumn('event_members', 'role', "TEXT NOT NULL DEFAULT 'crew'");
/** Rebuild tables to drop UNIQUE(code): different events may share EP1 / T1. Runs once. */
function rebuildForEvents() {
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'schema_events'").get() as { value: string } | undefined;
  if (flag?.value === 'v1') return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE episodes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        budget INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        event_id INTEGER NOT NULL DEFAULT 1,
        UNIQUE(event_id, code)
      );
      INSERT INTO episodes_new(id, code, name, budget, sort, status, notes, started_at, finished_at, event_id)
        SELECT id, code, name, budget, sort, status, notes, started_at, finished_at, event_id FROM episodes;
      DROP TABLE episodes;
      ALTER TABLE episodes_new RENAME TO episodes;
      CREATE TABLE teams_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        members TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'alive',
        currency INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 0,
        event_id INTEGER NOT NULL DEFAULT 1,
        UNIQUE(event_id, code)
      );
      INSERT INTO teams_new(id, code, name, members, status, currency, sort, event_id)
        SELECT id, code, name, members, status, currency, sort, event_id FROM teams;
      DROP TABLE teams;
      ALTER TABLE teams_new RENAME TO teams;
      INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_events', 'v1');
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
rebuildForEvents();
// The rebuild above recreates episodes / teams with a fixed column list; on a brand-new database it runs in the
// same startup as the ensureColumn calls above and drops those columns again, so re-apply them (idempotent)
ensureColumn('episodes', 'start_at', 'TEXT');
ensureColumn('episodes', 'inherit_rank', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('episodes', 'start_gap_min', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('episodes', 'depart_base', 'TEXT');
ensureColumn('teams', 'eliminated_leg_id', 'INTEGER');
ensureColumn('teams', 'locked_from_leg_id', 'INTEGER');

type Param = string | number | null;
export type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export const now = () => new Date().toISOString();

export function getSetting(key: string, fallback = ''): string {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
}
export function setSetting(key: string, value: string) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// ---------- Money: stored as integer cents, exchanged through the API in yuan (up to 2 decimals) ----------
export function toCents(v: unknown, label = '金额'): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}无效`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new Error(`${label}最多两位小数`);
  return cents;
}
export const fromCents = (c: number | null | undefined) => (c == null ? 0 : c / 100);

// Old databases stored whole yuan; multiply by 100 once to get cents
if (getSetting('currency_unit') !== 'cent') {
  db.exec('BEGIN');
  db.exec('UPDATE teams SET currency = currency * 100');
  db.exec('UPDATE currency_ledger SET delta = delta * 100, balance_after = balance_after * 100');
  db.exec('UPDATE episodes SET budget = budget * 100');
  const init = getSetting('initial_currency');
  if (init) setSetting('initial_currency', String(Math.round(Number(init) * 100)));
  setSetting('currency_unit', 'cent');
  db.exec('COMMIT');
}
