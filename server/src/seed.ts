import { all, get, run, tx, now, getSetting, setSetting } from './db.js';

const DEFAULT_HOSTS = (process.env.HOST_USERNAMES ?? '阳秋,云缨,云影').split(',').map((s) => s.trim()).filter(Boolean);

export function seed() {
  if (!getSetting('event_name')) setSetting('event_name', process.env.EVENT_NAME ?? 'BJ20 全明星赛');
  if (!getSetting('hosts')) setSetting('hosts', DEFAULT_HOSTS.join(','));
  if (!getSetting('team_size')) setSetting('team_size', '2');
  if (!getSetting('currency_mode')) setSetting('currency_mode', 'yuan'); // yuan: 经费(元, 两位小数) | coin: 货币(币, 整数)

  const hosts = getSetting('hosts').split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of hosts) {
    run('INSERT OR IGNORE INTO access_list(username, added_by, added_at) VALUES (?,?,?)', h, 'system', now());
    // 已注册的主办名单成员保证是主办角色
    run("UPDATE users SET role = 'host' WHERE username = ? AND role != 'admin'", h);
  }

  if (!get('SELECT 1 FROM episodes LIMIT 1')) {
    tx(() => {
      for (let i = 1; i <= 5; i++) {
        const r = run('INSERT INTO episodes(code, name, budget, sort, status, notes) VALUES (?,?,?,?,?,?)', `EP${i}`, `第 ${i} 赛段`, 0, i, 'pending', '');
        const epId = Number(r.lastInsertRowid);
        const legs: [string, string, number, string][] = [
          ...(i === 1 ? [['SL', '起跑线', 1, 'single'] as [string, string, number, string]] : []),
          ['RI', '路线信息 1', 0, 'none'], ['TI', '任务点 1', 1, 'full'], ['PS', '中继站', 1, 'single'],
        ];
        legs.forEach(([type, name, staff, mode], j) => run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,?,?)', epId, j + 1, type, name, staff, mode));
      }
    });
  }

  if (!get('SELECT 1 FROM teams LIMIT 1')) {
    tx(() => {
      for (let i = 1; i <= 12; i++) run('INSERT INTO teams(code, name, members, status, currency, sort) VALUES (?,?,?,?,?,?)', `T${i}`, String(i).padStart(2, '0'), '[]', 'alive', 0, i);
    });
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
      const eps = all('SELECT id FROM episodes ORDER BY sort, id');
      eps.forEach((ep, idx) => {
        const legs = all('SELECT id, type, sort FROM legs WHERE episode_id = ? ORDER BY sort, id', ep.id);
        if (!legs.some((l) => l.type === 'PS')) {
          run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,1,?)', ep.id, (legs.at(-1)?.sort ?? 0) + 1, 'PS', '中继站', 'single');
        }
        if (idx === 0 && !legs.some((l) => l.type === 'SL')) {
          run('UPDATE legs SET sort = sort + 1 WHERE episode_id = ?', ep.id);
          run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,1,?)', ep.id, 1, 'SL', '起跑线', 'single');
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
  return { hosts, episodes: all('SELECT code FROM episodes').length, teams: all('SELECT id FROM teams').length };
}
