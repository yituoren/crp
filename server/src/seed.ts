import { all, get, run, tx, now, getSetting, setSetting } from './db.js';

const DEFAULT_HOSTS = (process.env.HOST_USERNAMES ?? '阳秋,云缨,云影').split(',').map((s) => s.trim()).filter(Boolean);

const randomHash = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function seed() {
  // ---- 比赛 ----
  // 首次升级到多比赛：把原来的全局设置变成 1 号比赛（开发用），再建一个空白的测试赛；不提供页面上的创建/删除通道
  if (!get('SELECT 1 FROM events LIMIT 1')) {
    const name = getSetting('event_name') || process.env.EVENT_NAME || 'BJ20 全明星赛';
    const hosts = (getSetting('hosts') || DEFAULT_HOSTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean).join(',');
    const teamSize = Math.max(1, Number(getSetting('team_size', '2')) || 2);
    const currency = getSetting('currency_mode', 'yuan') === 'coin' ? 'coin' : 'yuan';
    const rbGap = Math.max(0, Number(getSetting('rb_gap', '2')) || 0);
    tx(() => {
      run('INSERT INTO events(id, hash, name, invite_code, hosts, team_size, currency_mode, rb_gap, created_at) VALUES (1,?,?,?,?,?,?,?,?)',
        randomHash(), name, 'dev', hosts, teamSize, currency, rbGap, now());
      run('INSERT INTO events(hash, name, invite_code, hosts, team_size, currency_mode, rb_gap, created_at) VALUES (?,?,?,?,?,?,?,?)',
        randomHash(), '测试赛', 'test', hosts, 2, 'yuan', 2, now());
      // 已注册的账号默认都加入开发用比赛，保持升级前后可用
      for (const u of all('SELECT id FROM users')) run('INSERT OR IGNORE INTO event_members(event_id, user_id, joined_at) VALUES (1, ?, ?)', u.id, now());
    });
  }
  // 旧的“主办即全局 host 角色”不再使用：主办由各比赛的主办名单决定
  run("UPDATE users SET role = 'crew' WHERE role = 'host'");
  // 旧的公告已读位置（users.ann_read_id）搬到按比赛存的 ann_reads（只对 1 号比赛）
  for (const u of all('SELECT id, ann_read_id FROM users WHERE ann_read_id > 0')) {
    run('INSERT OR IGNORE INTO ann_reads(user_id, event_id, last_read_id) VALUES (?,1,?)', u.id, u.ann_read_id);
    run('UPDATE users SET ann_read_id = 0 WHERE id = ?', u.id);
  }

  if (!get('SELECT 1 FROM episodes WHERE event_id = 1 LIMIT 1')) {
    tx(() => {
      for (let i = 1; i <= 5; i++) {
        const r = run('INSERT INTO episodes(code, name, budget, sort, status, notes, event_id) VALUES (?,?,?,?,?,?,1)', `EP${i}`, `第 ${i} 赛段`, 0, i, 'pending', '');
        const epId = Number(r.lastInsertRowid);
        const legs: [string, string, number, string][] = [
          ...(i === 1 ? [['SL', '起跑线', 1, 'full'] as [string, string, number, string]] : []),
          ['RI', '路线信息 1', 0, 'full'], ['TI', '任务点 1', 1, 'full'], ['PS', '中继站', 1, 'full'],
        ];
        legs.forEach(([type, name, staff, mode], j) => run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,?,?)', epId, j + 1, type, name, staff, mode));
      }
    });
  }

  if (!get('SELECT 1 FROM teams WHERE event_id = 1 LIMIT 1')) {
    tx(() => {
      for (let i = 1; i <= 12; i++) run('INSERT INTO teams(code, name, members, status, currency, sort, event_id) VALUES (?,?,?,?,?,?,1)', `T${i}`, String(i).padStart(2, '0'), '[]', 'alive', 0, i);
    });
  }
  // 一次性：类型缩写更正——快进由 FO 改为 FF，对抗由 PK 改为 FO（先改快进再改对抗，避免混淆）
  if (getSetting('leg_types') !== 'v2') {
    tx(() => {
      run("UPDATE legs SET type = 'FF' WHERE type = 'FO'");
      run("UPDATE legs SET type = 'FO' WHERE type = 'PK'");
    });
    setSetting('leg_types', 'v2');
  }
  // 一次性：把默认队名“队伍N”改成两位编号“NN”
  if (getSetting('team_names') !== 'v1') {
    for (const t of all('SELECT id, name FROM teams')) {
      const m = /^队伍(\d+)$/.exec(t.name);
      if (m) run('UPDATE teams SET name = ? WHERE id = ?', String(m[1]).padStart(2, '0'), t.id);
    }
    setSetting('team_names', 'v1');
  }
  // 一次性规范旧数据：每个赛段末尾必须有中继站；只有第一个赛段保留 Starting Line
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
          // 非首赛段的 Starting Line：没有记录的直接删除，有记录的改为任务点保留数据
          for (const l of legs.filter((x) => x.type === 'SL')) {
            const used = get('SELECT 1 FROM progress WHERE leg_id = ? LIMIT 1', l.id);
            if (used) run("UPDATE legs SET type = 'TI', record_mode = 'full' WHERE id = ?", l.id);
            else run('DELETE FROM legs WHERE id = ?', l.id);
          }
        }
        // 重新排序：SL 第一、PS 最后
        const cur = all('SELECT id, type FROM legs WHERE episode_id = ? ORDER BY sort, id', ep.id);
        const order = [...cur.filter((l) => l.type === 'SL'), ...cur.filter((l) => l.type !== 'SL' && l.type !== 'PS'), ...cur.filter((l) => l.type === 'PS')];
        order.forEach((l, i) => run('UPDATE legs SET sort = ? WHERE id = ?', i + 1, l.id));
      });
    });
    setSetting('legs_structure', 'v1');
  }
  return { events: all('SELECT id FROM events').length, episodes: all('SELECT code FROM episodes').length, teams: all('SELECT id FROM teams').length };
}
