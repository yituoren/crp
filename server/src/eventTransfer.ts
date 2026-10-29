// Export one event to a self-contained file and import it back as a new event.
// File format: gzip-compressed JSON, `format: 'crp-event-v1'`, attachment files embedded as base64.
// Accounts are not exported; rows reference them by username and are re-linked on import when the
// username exists on the importing server (otherwise the reference is cleared, or the row dropped
// where an account is required, such as schedule assignments).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { all, get, run, tx, now, UPLOAD_DIR } from './db.js';
import { joinEvent, type AuthUser } from './auth.js';
import { HttpError } from './util.js';

export const EVENT_FILE_FORMAT = 'crp-event-v1';
const bad = (msg: string) => new HttpError(400, msg);

type Row = Record<string, any>;
type Dump = {
  format: string;
  exportedAt: string;
  event: Row;
  users: Record<string, string>; // exported user id -> username
  tables: Record<string, Row[]>;
  files: Record<string, string>; // attachment path -> base64 content
};

/** Columns that point at accounts, per table */
const USER_COLS: Record<string, string[]> = {
  attachments: ['uploaded_by'],
  assignments: ['user_id'],
  progress: ['recorded_by'],
  penalties: ['applied_by'],
  currency_ledger: ['operator_id'],
  item_log: ['operator_id'],
  cutoff_uses: ['used_by'],
  event_members: ['user_id'],
};

function selectEventTables(eventId: number): Record<string, Row[]> {
  const ep = 'SELECT id FROM episodes WHERE event_id = ?';
  const tm = 'SELECT id FROM teams WHERE event_id = ?';
  const lg = `SELECT id FROM legs WHERE episode_id IN (${ep})`;
  return {
    shop_items: all('SELECT * FROM shop_items WHERE event_id = ? ORDER BY id', eventId),
    episodes: all('SELECT * FROM episodes WHERE event_id = ? ORDER BY id', eventId),
    legs: all(`SELECT * FROM legs WHERE episode_id IN (${ep}) ORDER BY id`, eventId),
    leg_cutoffs: all(`SELECT * FROM leg_cutoffs WHERE leg_id IN (${lg}) ORDER BY id`, eventId),
    leg_shop_items: all(`SELECT * FROM leg_shop_items WHERE leg_id IN (${lg}) ORDER BY id`, eventId),
    attachments: all(`SELECT * FROM attachments WHERE leg_id IN (${lg}) ORDER BY id`, eventId),
    teams: all('SELECT * FROM teams WHERE event_id = ? ORDER BY id', eventId),
    assignments: all(`SELECT * FROM assignments WHERE episode_id IN (${ep}) ORDER BY id`, eventId),
    progress: all(`SELECT * FROM progress WHERE episode_id IN (${ep}) ORDER BY id`, eventId),
    penalties: all(`SELECT * FROM penalties WHERE episode_id IN (${ep}) ORDER BY id`, eventId),
    pitstop_results: all(`SELECT * FROM pitstop_results WHERE episode_id IN (${ep}) ORDER BY id`, eventId),
    currency_ledger: all(`SELECT * FROM currency_ledger WHERE team_id IN (${tm}) ORDER BY id`, eventId),
    item_log: all(`SELECT * FROM item_log WHERE team_id IN (${tm}) ORDER BY id`, eventId),
    cutoff_uses: all(`SELECT * FROM cutoff_uses WHERE team_id IN (${tm}) ORDER BY id`, eventId),
    announcements: all('SELECT * FROM announcements WHERE event_id = ? ORDER BY id', eventId),
    event_members: all('SELECT * FROM event_members WHERE event_id = ?', eventId),
  };
}

/** Build the gzip file for one event */
export function exportEvent(eventId: number): Buffer {
  const event = get<Row>('SELECT * FROM events WHERE id = ?', eventId);
  if (!event) throw new HttpError(404, '比赛不存在');
  const tables = selectEventTables(eventId);
  const userIds = new Set<number>();
  if (event.owner_id) userIds.add(event.owner_id);
  for (const [t, cols] of Object.entries(USER_COLS)) for (const r of tables[t]) for (const c of cols) if (r[c]) userIds.add(r[c]);
  const users: Record<string, string> = {};
  for (const id of userIds) {
    const u = get<{ username: string }>('SELECT username FROM users WHERE id = ?', id);
    if (u) users[id] = u.username;
  }
  const files: Record<string, string> = {};
  for (const a of tables.attachments) {
    try { files[a.path] = fs.readFileSync(path.join(UPLOAD_DIR, a.path)).toString('base64'); } catch { /* missing file: row exported without content */ }
  }
  const dump: Dump = { format: EVENT_FILE_FORMAT, exportedAt: now(), event, users, tables, files };
  return zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
}

/** Parse an uploaded event file (gzip JSON; plain JSON is accepted too) */
export function parseEventFile(buf: Buffer): Dump {
  let text: string;
  try { text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'); } catch { throw bad('文件无法解压，不是本系统导出的比赛文件'); }
  let d: Dump;
  try { d = JSON.parse(text); } catch { throw bad('文件内容损坏，不是本系统导出的比赛文件'); }
  if (!d || d.format !== EVENT_FILE_FORMAT || !d.event || !d.tables) throw bad('不是本系统导出的比赛文件');
  return d;
}

const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join(''); };

/** Insert a row, letting SQLite assign the id; only columns that exist in the current schema are written */
function insert(table: string, row: Row, cols: Set<string>): number {
  const keys = Object.keys(row).filter((k) => k !== 'id' && cols.has(k));
  const r = run(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k] ?? null));
  return Number(r.lastInsertRowid);
}
const columnsOf = (table: string) => new Set(all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name));

/** Create a new event from a parsed file; the importer becomes its owner and host. Returns the new event id and hash. */
export function importEvent(d: Dump, me: AuthUser): { id: number; hash: string; skippedUsers: string[] } {
  const t = (name: string): Row[] => (Array.isArray(d.tables[name]) ? d.tables[name] : []);
  // Exported user id -> local user id (by username)
  const userMap = new Map<number, number>();
  const missing = new Set<string>();
  for (const [oldId, username] of Object.entries(d.users ?? {})) {
    const u = get<{ id: number }>('SELECT id FROM users WHERE username = ?', username);
    if (u) userMap.set(Number(oldId), u.id); else missing.add(username);
  }
  const mapUser = (v: any) => (v ? userMap.get(Number(v)) ?? null : null);

  let hash = randomHex(4);
  while (get('SELECT 1 FROM events WHERE hash = ?', hash)) hash = randomHex(4);
  let invite = String(d.event.invite_code ?? '');
  while (!invite || get('SELECT 1 FROM events WHERE invite_code = ?', invite)) invite = randomCode();

  const newFiles: { path: string; data: string }[] = [];
  const result = tx(() => {
    const ev = d.event;
    const evId = Number(run(
      'INSERT INTO events(hash, name, invite_code, hosts, team_size, currency_mode, rb_gap, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      hash, String(ev.name ?? '导入的比赛').slice(0, 50), invite, '', Number(ev.team_size) || 2, ev.currency_mode === 'coin' ? 'coin' : 'yuan',
      Number.isFinite(Number(ev.rb_gap)) ? Number(ev.rb_gap) : 2, me.id, now(),
    ).lastInsertRowid);

    const maps: Record<string, Map<number, number>> = {};
    const idMap = (name: string) => (maps[name] ??= new Map());
    const ref = (name: string, v: any) => (v ? idMap(name).get(Number(v)) ?? null : null);
    const copy = (table: string, fix: (r: Row) => Row | null) => {
      const cols = columnsOf(table);
      for (const r of t(table)) {
        const row = fix({ ...r });
        if (!row) continue;
        idMap(table).set(Number(r.id), insert(table, row, cols));
      }
    };
    /** Second pass for references to rows of the same or a later table (reverts_id, ledger_id) */
    const relink = (table: string, col: string, target: string) => {
      for (const r of t(table)) {
        if (!r[col]) continue;
        const id = idMap(table).get(Number(r.id));
        if (id) run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, ref(target, r[col]), id);
      }
    };
    const nowIso = new Date().toISOString();

    copy('shop_items', (r) => ({ ...r, event_id: evId }));
    // A pending episode whose scheduled start has passed would auto-start immediately: drop the stale schedule
    copy('episodes', (r) => ({ ...r, event_id: evId, start_at: r.status === 'pending' && r.start_at && r.start_at <= nowIso ? null : r.start_at }));
    copy('legs', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id) }));
    copy('leg_cutoffs', (r) => ({ ...r, leg_id: ref('legs', r.leg_id) }));
    copy('leg_shop_items', (r) => { const leg = ref('legs', r.leg_id), item = ref('shop_items', r.shop_item_id); return leg && item ? { ...r, leg_id: leg, shop_item_id: item } : null; });
    // Files from before per-leg stock: an open shop sold every item without limit
    if (!d.tables.leg_shop_items) {
      run(`INSERT INTO leg_shop_items(leg_id, shop_item_id, quantity, sort, created_at)
             SELECT l.id, i.id, NULL, i.sort, ? FROM legs l JOIN episodes e ON e.id = l.episode_id JOIN shop_items i ON i.event_id = e.event_id
             WHERE e.event_id = ? AND l.shop_open = 1`, now(), evId);
    }
    run('UPDATE legs SET shop_open = EXISTS (SELECT 1 FROM leg_shop_items s WHERE s.leg_id = legs.id) WHERE episode_id IN (SELECT id FROM episodes WHERE event_id = ?)', evId);
    copy('attachments', (r) => {
      const leg = ref('legs', r.leg_id);
      const data = d.files?.[r.path];
      if (!leg || !data) return null;
      const ext = path.extname(String(r.path)).replace(/[^.\w]/g, '');
      const stored = `${leg}-${Date.now()}-${randomHex(3)}${ext}`;
      newFiles.push({ path: stored, data });
      return { ...r, leg_id: leg, path: stored, uploaded_by: mapUser(r.uploaded_by) };
    });
    copy('teams', (r) => ({ ...r, event_id: evId, eliminated_leg_id: ref('legs', r.eliminated_leg_id), locked_from_leg_id: ref('legs', r.locked_from_leg_id) }));
    copy('assignments', (r) => {
      const user = mapUser(r.user_id);
      if (!user) return null;
      let legIds = r.leg_ids;
      try { if (legIds) legIds = JSON.stringify((JSON.parse(legIds) as number[]).map((id) => ref('legs', id)).filter(Boolean)); } catch { legIds = null; }
      return { ...r, episode_id: ref('episodes', r.episode_id), user_id: user, team_id: ref('teams', r.team_id), leg_id: ref('legs', r.leg_id), leg_ids: legIds };
    });
    copy('progress', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id), leg_id: ref('legs', r.leg_id), target_team_id: ref('teams', r.target_team_id), recorded_by: mapUser(r.recorded_by) }));
    // leg_id 0 means "other" and stays 0
    copy('penalties', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id), leg_id: r.leg_id ? ref('legs', r.leg_id) : r.leg_id, applied_by: mapUser(r.applied_by), reverts_id: null }));
    copy('pitstop_results', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id) }));
    copy('currency_ledger', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id), leg_id: r.leg_id ? ref('legs', r.leg_id) : r.leg_id, item_id: ref('shop_items', r.item_id), operator_id: mapUser(r.operator_id), reverts_id: null }));
    copy('item_log', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id), leg_id: r.leg_id ? ref('legs', r.leg_id) : r.leg_id, ledger_id: ref('currency_ledger', r.ledger_id), operator_id: mapUser(r.operator_id), reverts_id: null }));
    copy('cutoff_uses', (r) => ({ ...r, episode_id: ref('episodes', r.episode_id), team_id: ref('teams', r.team_id), leg_id: ref('legs', r.leg_id), cutoff_id: ref('leg_cutoffs', r.cutoff_id) ?? 0, ledger_id: ref('currency_ledger', r.ledger_id), used_by: mapUser(r.used_by) }));
    copy('announcements', (r) => ({ ...r, event_id: evId, pinned_at: r.pinned_at }));
    relink('penalties', 'reverts_id', 'penalties');
    relink('currency_ledger', 'reverts_id', 'currency_ledger');
    relink('item_log', 'reverts_id', 'item_log');

    // Members whose accounts exist here keep their role; the importer is always a host
    for (const m of t('event_members')) {
      const user = mapUser(m.user_id);
      if (user && user !== me.id) run('INSERT OR IGNORE INTO event_members(event_id, user_id, joined_at, role) VALUES (?,?,?,?)', evId, user, m.joined_at ?? now(), m.role === 'host' ? 'host' : 'crew');
    }
    joinEvent(me.id, evId, 'host');
    return { id: evId, hash };
  });
  // Files are written after the transaction commits; a failure here only loses that file's content
  for (const f of newFiles) { try { fs.writeFileSync(path.join(UPLOAD_DIR, f.path), Buffer.from(f.data, 'base64')); } catch (e) { console.error('[import] file write failed', f.path, e); } }
  return { ...result, skippedUsers: [...missing].sort() };
}
