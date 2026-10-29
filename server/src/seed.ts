import { all, get, run, tx, now, getSetting, setSetting } from './db.js';

const DEFAULT_HOSTS = (process.env.HOST_USERNAMES ?? '阳秋,云缨,云影').split(',').map((s) => s.trim()).filter(Boolean);

const randomHash = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function seed() {
  // ---- Events ----
  // Legacy single-event databases (episodes / teams / settings from before multi-event) become event 1.
  // A fresh database starts with no events at all; events are created from the home page.
  const legacy = !!(get('SELECT 1 FROM episodes LIMIT 1') || get('SELECT 1 FROM teams LIMIT 1') || getSetting('event_name'));
  if (legacy && !get('SELECT 1 FROM events LIMIT 1')) {
    const name = getSetting('event_name') || process.env.EVENT_NAME || 'CRP';
    const hosts = (getSetting('hosts') || DEFAULT_HOSTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean).join(',');
    const teamSize = Math.max(1, Number(getSetting('team_size', '2')) || 2);
    const currency = getSetting('currency_mode', 'yuan') === 'coin' ? 'coin' : 'yuan';
    const rbGap = Math.max(0, Number(getSetting('rb_gap', '2')) || 0);
    tx(() => {
      run('INSERT INTO events(id, hash, name, invite_code, hosts, team_size, currency_mode, rb_gap, created_at) VALUES (1,?,?,?,?,?,?,?,?)',
        randomHash(), name, randomHash(), hosts, teamSize, currency, rbGap, now());
      // existing accounts join the migrated event so nothing breaks after the upgrade
      for (const u of all('SELECT id FROM users')) run('INSERT OR IGNORE INTO event_members(event_id, user_id, joined_at) VALUES (1, ?, ?)', u.id, now());
    });
  }
  // the old global host role is gone: hosts are decided by per-event member roles
  run("UPDATE users SET role = 'crew' WHERE role = 'host'");
  // One-off: convert the legacy host list into member roles (listed accounts become host members), then clear the list
  if (getSetting('event_roles') !== 'v1') {
    tx(() => {
      for (const ev of all('SELECT id, hosts FROM events')) {
        for (const name of String(ev.hosts ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
          const u = get('SELECT id FROM users WHERE username = ?', name);
          if (!u) continue;
          run("INSERT INTO event_members(event_id, user_id, joined_at, role) VALUES (?,?,?,'host') ON CONFLICT(event_id, user_id) DO UPDATE SET role = 'host'", ev.id, u.id, now());
        }
        run("UPDATE events SET hosts = '' WHERE id = ?", ev.id);
      }
    });
    setSetting('event_roles', 'v1');
  }
  // move the old read position (users.ann_read_id) into the per-event ann_reads table (event 1 only)
  for (const u of all('SELECT id, ann_read_id FROM users WHERE ann_read_id > 0')) {
    run('INSERT OR IGNORE INTO ann_reads(user_id, event_id, last_read_id) VALUES (?,1,?)', u.id, u.ann_read_id);
    run('UPDATE users SET ann_read_id = 0 WHERE id = ?', u.id);
  }

  // One-off: fix type codes — Fast Forward FO → FF, Face Off PK → FO (Fast Forward first to avoid a clash)
  if (getSetting('leg_types') !== 'v2') {
    tx(() => {
      run("UPDATE legs SET type = 'FF' WHERE type = 'FO'");
      run("UPDATE legs SET type = 'FO' WHERE type = 'PK'");
    });
    setSetting('leg_types', 'v2');
  }
  // One-off: rename default team names "队伍N" to two-digit numbers "NN"
  if (getSetting('team_names') !== 'v1') {
    for (const t of all('SELECT id, name FROM teams')) {
      const m = /^队伍(\d+)$/.exec(t.name);
      if (m) run('UPDATE teams SET name = ? WHERE id = ?', String(m[1]).padStart(2, '0'), t.id);
    }
    setSetting('team_names', 'v1');
  }
  // One-off cleanup: every episode must end with a Pit Stop; only the first episode keeps a Starting Line
  if (getSetting('legs_structure') !== 'v1') {
    tx(() => {
      const eps = all('SELECT id, event_id FROM episodes ORDER BY event_id, sort, id');
      const firstOf = new Map<number, number>();
      for (const e of eps) if (!firstOf.has(e.event_id)) firstOf.set(e.event_id, e.id);
      eps.forEach((ep) => {
        const idx = firstOf.get(ep.event_id) === ep.id ? 0 : 1;
        const legs = all('SELECT id, type, sort FROM legs WHERE episode_id = ? ORDER BY sort, id', ep.id);
        if (!legs.some((l) => l.type === 'PS')) {
          run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,1,?)', ep.id, (legs.at(-1)?.sort ?? 0) + 1, 'PS', '中继站', 'full');
        }
        if (idx === 0 && !legs.some((l) => l.type === 'SL')) {
          run('UPDATE legs SET sort = sort + 1 WHERE episode_id = ?', ep.id);
          run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,1,?)', ep.id, 1, 'SL', '起跑线', 'full');
        }
        if (idx > 0) {
          // Starting Lines outside the first episode: delete when unrecorded, otherwise turn into a Task to keep the data
          for (const l of legs.filter((x) => x.type === 'SL')) {
            const used = get('SELECT 1 FROM progress WHERE leg_id = ? LIMIT 1', l.id);
            if (used) run("UPDATE legs SET type = 'TI', record_mode = 'full' WHERE id = ?", l.id);
            else run('DELETE FROM legs WHERE id = ?', l.id);
          }
        }
        // reorder: SL first, PS last
        const cur = all('SELECT id, type FROM legs WHERE episode_id = ? ORDER BY sort, id', ep.id);
        const order = [...cur.filter((l) => l.type === 'SL'), ...cur.filter((l) => l.type !== 'SL' && l.type !== 'PS'), ...cur.filter((l) => l.type === 'PS')];
        order.forEach((l, i) => run('UPDATE legs SET sort = ? WHERE id = ?', i + 1, l.id));
      });
    });
    setSetting('legs_structure', 'v1');
  }
  return { events: all('SELECT id FROM events').length, episodes: all('SELECT code FROM episodes').length, teams: all('SELECT id FROM teams').length };
}
