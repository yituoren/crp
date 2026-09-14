import { all, get, run, tx, now, getSetting, setSetting } from './db.js';

const DEFAULT_HOSTS = (process.env.HOST_USERNAMES ?? '阳秋,云缨,云影').split(',').map((s) => s.trim()).filter(Boolean);

export function seed() {
  if (!getSetting('event_name')) setSetting('event_name', process.env.EVENT_NAME ?? 'BJ20 全明星赛');
  if (!getSetting('hosts')) setSetting('hosts', DEFAULT_HOSTS.join(','));

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
        const legs: [string, string, number, string][] = [['SL', '起跑线', 1, 'single'], ['RI', '路线信息 1', 0, 'none'], ['TI', '任务点 1', 1, 'full'], ['PS', '中继站', 1, 'single']];
        legs.forEach(([type, name, staff, mode], j) => run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,?,?)', epId, j + 1, type, name, staff, mode));
      }
    });
  }

  if (!get('SELECT 1 FROM teams LIMIT 1')) {
    tx(() => {
      for (let i = 1; i <= 12; i++) run('INSERT INTO teams(code, name, members, status, currency, sort) VALUES (?,?,?,?,?,?)', `T${i}`, `队伍${i}`, '', 'alive', 0, i);
    });
  }
  return { hosts, episodes: all('SELECT code FROM episodes').length, teams: all('SELECT id FROM teams').length };
}
