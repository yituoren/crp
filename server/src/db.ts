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
  created_at TEXT NOT NULL
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
  needs_staff INTEGER NOT NULL DEFAULT 1,      -- 是否需要站点人员
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
  target_team_id INTEGER,                     -- 回转/让路的施加对象
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
  applied_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_ep ON currency_ledger(episode_id, created_at);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',         -- info | warning | urgent
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
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

/** 给旧库补列（幂等）。返回 true 表示本次新加了该列。 */
function ensureColumn(table: string, col: string, ddl: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
  if (cols.includes(col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  return true;
}
if (ensureColumn('legs', 'needs_staff', 'INTEGER NOT NULL DEFAULT 1') || ensureColumn('legs', 'record_mode', "TEXT NOT NULL DEFAULT 'full'")) {
  // 老数据按类型套用默认：路线信息不排站点也不记时间；起跑线/终点只记一次
  db.exec("UPDATE legs SET needs_staff = 0, record_mode = 'none' WHERE type = 'RI'");
  db.exec("UPDATE legs SET record_mode = 'single' WHERE type IN ('SL', 'PS')");
}
ensureColumn('progress', 'target_team_id', 'INTEGER');
ensureColumn('episodes', 'started_at', 'TEXT');
ensureColumn('episodes', 'finished_at', 'TEXT');

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

// ---------- 金额：数据库以“分”存整数，接口以“元”收发（最多两位小数） ----------
export function toCents(v: unknown, label = '金额'): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label}无效`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new Error(`${label}最多两位小数`);
  return cents;
}
export const fromCents = (c: number | null | undefined) => (c == null ? 0 : c / 100);

// 旧库金额是“元”整数，一次性乘 100 变成“分”
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
