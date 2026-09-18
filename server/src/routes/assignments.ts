import { Hono } from 'hono';
import { all, get, run, tx } from '../db.js';
import { hostOnly, parseLegIds, type Env } from '../auth.js';
import { audit, body, int, intParam, notify, bad, notFound } from '../util.js';
import { teamLabelMap } from './teams.js';
import { episodeInEvent } from './episodes.js';

export const assignmentRoutes = new Hono<Env>();

export function listAssignments(episodeId: number) {
  const labels = teamLabelMap();
  const legs = new Map(all('SELECT id, name, sort FROM legs WHERE episode_id = ?', episodeId).map((l) => [l.id, l]));
  return all<any>(
    `SELECT a.id, a.episode_id, a.user_id, a.role, a.team_id, a.leg_id, a.leg_ids,
            u.username, u.display_name AS display_name,
            t.name AS team_name
     FROM assignments a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN teams t ON t.id = a.team_id
     WHERE a.episode_id = ?
     ORDER BY a.role, u.username`,
    episodeId,
  ).map((r): any => {
    const legIds = parseLegIds(r).filter((id) => legs.has(id)).sort((x, y) => (legs.get(x)!.sort - legs.get(y)!.sort));
    return { ...r, team_name: r.team_id ? (labels.get(r.team_id) ?? r.team_name) : r.team_name, leg_ids: legIds, leg_names: legIds.map((id) => legs.get(id)!.name) };
  });
}

assignmentRoutes.get('/episodes/:id/assignments', (c) => {
  const episodeId = intParam(c, 'id');
  episodeInEvent(c, episodeId);
  return c.json({ assignments: listAssignments(episodeId) });
});

/** 整体替换某赛段的排班。items: [{ userId, role: 'follow'|'station'|'live'|'crew', teamId?, legIds?: number[] }] */
assignmentRoutes.put('/episodes/:id/assignments', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id');
  episodeInEvent(c, episodeId);
  const { items } = await body(c);
  if (!Array.isArray(items)) throw bad('items 必须是数组');
  const before = listAssignments(episodeId);
  tx(() => {
    for (const it of items) {
      const userId = int(it.userId);
      if (!userId) continue;
      if (it.role === 'follow') {
        const teamId = int(it.teamId);
        if (!teamId) throw bad('跟队必须选择队伍');
        run(
          `INSERT INTO assignments(episode_id, user_id, role, team_id, leg_id, leg_ids) VALUES (?,?,?,?,NULL,NULL)
           ON CONFLICT(episode_id, user_id) DO UPDATE SET role = excluded.role, team_id = excluded.team_id, leg_id = NULL, leg_ids = NULL`,
          episodeId, userId, 'follow', teamId,
        );
      } else if (it.role === 'station') {
        const ids: number[] = [...new Set<number>((Array.isArray(it.legIds) ? it.legIds : [it.legId]).map((x: unknown) => int(x)).filter((n: number) => n > 0))];
        if (!ids.length) throw bad('站点至少要选择一个环节');
        for (const id of ids) if (!get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', id, episodeId)) throw bad('环节不属于本赛段');
        run(
          `INSERT INTO assignments(episode_id, user_id, role, team_id, leg_id, leg_ids) VALUES (?,?,?,NULL,?,?)
           ON CONFLICT(episode_id, user_id) DO UPDATE SET role = excluded.role, team_id = NULL, leg_id = excluded.leg_id, leg_ids = excluded.leg_ids`,
          episodeId, userId, 'station', ids[0]!, JSON.stringify(ids),
        );
      } else if (it.role === 'live') {
        // 直播员：整个赛段跟进所有数据，只读，不绑定队伍或环节
        run(
          `INSERT INTO assignments(episode_id, user_id, role, team_id, leg_id, leg_ids) VALUES (?,?,?,NULL,NULL,NULL)
           ON CONFLICT(episode_id, user_id) DO UPDATE SET role = excluded.role, team_id = NULL, leg_id = NULL, leg_ids = NULL`,
          episodeId, userId, 'live',
        );
      } else {
        run('DELETE FROM assignments WHERE episode_id = ? AND user_id = ?', episodeId, userId);
      }
    }
  });
  audit(c.get('user'), 'update', 'assignments', episodeId, before, items);
  notify('assignments', episodeId);
  return c.json({ assignments: listAssignments(episodeId) });
});

/** 复制上一赛段的排班 */
assignmentRoutes.post('/episodes/:id/assignments/copy-from/:from', hostOnly, (c) => {
  const to = intParam(c, 'id');
  const from = intParam(c, 'from');
  const rows = all('SELECT user_id, role, team_id, leg_id FROM assignments WHERE episode_id = ?', from);
  tx(() => {
    run('DELETE FROM assignments WHERE episode_id = ?', to);
    for (const r of rows) {
      // 站点绑定的环节属于原赛段，复制时保留跟队与直播员；站点降级为普通幕后
      if (r.role === 'follow') run('INSERT INTO assignments(episode_id, user_id, role, team_id, leg_id) VALUES (?,?,?,?,NULL)', to, r.user_id, 'follow', r.team_id);
      if (r.role === 'live') run('INSERT INTO assignments(episode_id, user_id, role, team_id, leg_id) VALUES (?,?,?,NULL,NULL)', to, r.user_id, 'live');
    }
  });
  audit(c.get('user'), 'copy', 'assignments', to, undefined, { from });
  notify('assignments', to);
  return c.json({ assignments: listAssignments(to) });
});
