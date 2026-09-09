import { Hono } from 'hono';
import { all, get, run, tx, now } from '../db.js';
import { hostOnly, canRecordProgress, type Env } from '../auth.js';
import { audit, body, str, int, intParam, isoOrNull, notify, bad, notFound, forbidden } from '../util.js';

export const progressRoutes = new Hono<Env>();

export function listProgress(episodeId: number) {
  return all('SELECT * FROM progress WHERE episode_id = ? ORDER BY id', episodeId);
}
export function listPenalties(episodeId: number) {
  return all(
    `SELECT p.*, t.name AS team_name FROM penalties p JOIN teams t ON t.id = p.team_id WHERE p.episode_id = ? ORDER BY p.id`,
    episodeId,
  );
}

progressRoutes.get('/episodes/:id/progress', (c) => {
  const episodeId = intParam(c, 'id');
  return c.json({ progress: listProgress(episodeId), penalties: listPenalties(episodeId), pitstop: pitstopRows(episodeId) });
});

/**
 * 记录动作。action:
 *  arrive | complete | undo_arrive | undo_complete | detour | roadblock | ff | note
 */
progressRoutes.post('/progress', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId), teamId = int(b.teamId), legId = int(b.legId);
  const action = String(b.action ?? '');
  if (!episodeId || !teamId || !legId) throw bad('缺少赛段/队伍/环节');
  const leg = get('SELECT * FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId);
  if (!leg) throw notFound('环节不存在');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw notFound('队伍不存在');
  if (!canRecordProgress(user, episodeId, teamId, legId)) throw forbidden('你没有该队伍/站点的记录权限');
  if (team.status !== 'alive' && user.role !== 'host') throw forbidden('该队伍已淘汰，只有主办可以修改记录');
  if (['undo_arrive', 'undo_complete'].includes(action) && user.role !== 'host') throw forbidden('撤销记录仅主办可操作');

  const before = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  const t = now();
  const cur = before ?? {
    arrived_at: null, completed_at: null, detour_choice: null, roadblock_by: null, ff_result: null, note: '',
  };
  const next = { ...cur };
  let already = false; // 幂等：重复点击/断网重试不报错，保留第一次的时间
  switch (action) {
    case 'arrive':
      if (cur.arrived_at) already = true;
      else next.arrived_at = t;
      break;
    case 'complete':
      if (cur.completed_at) already = true;
      else {
        next.completed_at = t;
        if (!next.arrived_at) next.arrived_at = t;
      }
      break;
    case 'undo_arrive':
      next.arrived_at = null;
      next.completed_at = null;
      break;
    case 'undo_complete':
      next.completed_at = null;
      break;
    case 'detour':
      next.detour_choice = str(b.value, 100) || null;
      break;
    case 'roadblock':
      next.roadblock_by = str(b.value, 100) || null;
      break;
    case 'ff':
      next.ff_result = ['success', 'fail'].includes(b.value) ? b.value : null;
      break;
    case 'note':
      next.note = str(b.value, 1000);
      break;
    default:
      throw bad('未知动作');
  }
  if (!already) {
    upsertProgress(episodeId, teamId, legId, next, user.id);
    audit(user, `progress:${action}`, 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
    notify('progress', episodeId);
  }
  const progress = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  return c.json({ progress, already });
});

function upsertProgress(episodeId: number, teamId: number, legId: number, p: any, userId: number) {
  run(
    `INSERT INTO progress(episode_id, team_id, leg_id, arrived_at, completed_at, detour_choice, roadblock_by, ff_result, note, recorded_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(episode_id, team_id, leg_id) DO UPDATE SET
       arrived_at = excluded.arrived_at, completed_at = excluded.completed_at, detour_choice = excluded.detour_choice,
       roadblock_by = excluded.roadblock_by, ff_result = excluded.ff_result, note = excluded.note,
       recorded_by = excluded.recorded_by, updated_at = excluded.updated_at`,
    episodeId, teamId, legId, p.arrived_at, p.completed_at, p.detour_choice, p.roadblock_by, p.ff_result, p.note ?? '', userId, now(),
  );
}

/** 主办手工修正 */
progressRoutes.put('/progress/:episodeId/:teamId/:legId', hostOnly, async (c) => {
  const episodeId = intParam(c, 'episodeId'), teamId = intParam(c, 'teamId'), legId = intParam(c, 'legId');
  if (!get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId)) throw notFound('环节不存在');
  const b = await body(c);
  const before = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  const next = {
    arrived_at: isoOrNull(b.arrivedAt),
    completed_at: isoOrNull(b.completedAt),
    detour_choice: str(b.detourChoice, 100) || null,
    roadblock_by: str(b.roadblockBy, 100) || null,
    ff_result: ['success', 'fail'].includes(b.ffResult) ? b.ffResult : null,
    note: str(b.note, 1000),
  };
  if (next.completed_at && !next.arrived_at) next.arrived_at = next.completed_at;
  upsertProgress(episodeId, teamId, legId, next, c.get('user').id);
  audit(c.get('user'), 'progress:edit', 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
  notify('progress', episodeId);
  return c.json({ ok: true });
});

// ---------- 罚时 ----------
progressRoutes.post('/episodes/:id/penalties', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id');
  const b = await body(c);
  const teamId = int(b.teamId), minutes = int(b.minutes);
  if (!teamId || !minutes) throw bad('缺少队伍或罚时分钟数');
  const r = run(
    'INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at) VALUES (?,?,?,?,?,?)',
    episodeId, teamId, minutes, str(b.reason, 200), c.get('user').id, now(),
  );
  audit(c.get('user'), 'create', 'penalty', Number(r.lastInsertRowid), undefined, { episodeId, teamId, minutes, reason: b.reason });
  notify('progress', episodeId);
  return c.json({ id: Number(r.lastInsertRowid) });
});

progressRoutes.delete('/penalties/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM penalties WHERE id = ?', id);
  if (!before) throw notFound('罚时记录不存在');
  run('DELETE FROM penalties WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'penalty', id, before);
  notify('progress', before.episode_id);
  return c.json({ ok: true });
});

// ---------- 终点结算 ----------
export function pitstopRows(episodeId: number) {
  const psLeg = get('SELECT id FROM legs WHERE episode_id = ? AND type = ? ORDER BY sort DESC LIMIT 1', episodeId, 'PS');
  const teams = all('SELECT id, code, name, status FROM teams ORDER BY sort, id');
  const results = new Map(all('SELECT * FROM pitstop_results WHERE episode_id = ?', episodeId).map((r) => [r.team_id, r]));
  const penalties = new Map<number, number>();
  for (const p of all('SELECT team_id, SUM(minutes) AS m FROM penalties WHERE episode_id = ? GROUP BY team_id', episodeId)) penalties.set(p.team_id, p.m);
  const psProgress = new Map<number, string | null>();
  if (psLeg) for (const p of all('SELECT team_id, completed_at FROM progress WHERE episode_id = ? AND leg_id = ?', episodeId, psLeg.id)) psProgress.set(p.team_id, p.completed_at);
  return teams.map((t) => {
    const r = results.get(t.id);
    const checkin = r?.checkin_at ?? psProgress.get(t.id) ?? null;
    const pen = penalties.get(t.id) ?? 0;
    const finalMs = checkin ? new Date(checkin).getTime() + pen * 60000 : null;
    return {
      team_id: t.id, team_code: t.code, team_name: t.name, team_status: t.status,
      checkin_at: checkin, checkin_source: r?.checkin_at ? 'manual' : psProgress.get(t.id) ? 'progress' : null,
      penalty_minutes: pen, final_time: finalMs ? new Date(finalMs).toISOString() : null,
      rank: r?.rank ?? null, eliminated: !!r?.eliminated, note: r?.note ?? '',
    };
  });
}

progressRoutes.get('/episodes/:id/pitstop', (c) => c.json({ pitstop: pitstopRows(intParam(c, 'id')) }));

progressRoutes.post('/episodes/:id/pitstop/auto', hostOnly, (c) => {
  const episodeId = intParam(c, 'id');
  const rows = pitstopRows(episodeId);
  const ranked = rows.filter((r) => r.final_time && r.team_status !== 'withdrawn').sort((a, b) => a.final_time!.localeCompare(b.final_time!));
  tx(() => {
    ranked.forEach((r, i) => {
      run(
        `INSERT INTO pitstop_results(episode_id, team_id, checkin_at, rank, eliminated, note) VALUES (?,?,?,?,0,'')
         ON CONFLICT(episode_id, team_id) DO UPDATE SET rank = excluded.rank`,
        episodeId, r.team_id, r.checkin_at, i + 1,
      );
    });
  });
  audit(c.get('user'), 'auto_rank', 'pitstop', episodeId, undefined, ranked.map((r) => r.team_code));
  notify('pitstop', episodeId);
  notify('progress', episodeId);
  return c.json({ pitstop: pitstopRows(episodeId) });
});

progressRoutes.put('/episodes/:id/pitstop/:teamId', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id'), teamId = intParam(c, 'teamId');
  const b = await body(c);
  const before = get('SELECT * FROM pitstop_results WHERE episode_id = ? AND team_id = ?', episodeId, teamId);
  const checkin = b.checkinAt === undefined ? (before?.checkin_at ?? null) : isoOrNull(b.checkinAt);
  const rank = b.rank === undefined ? (before?.rank ?? null) : (b.rank === null || b.rank === '' ? null : int(b.rank));
  const eliminated = b.eliminated === undefined ? !!before?.eliminated : !!b.eliminated;
  const note = b.note === undefined ? (before?.note ?? '') : str(b.note, 300);
  tx(() => {
    run(
      `INSERT INTO pitstop_results(episode_id, team_id, checkin_at, rank, eliminated, note) VALUES (?,?,?,?,?,?)
       ON CONFLICT(episode_id, team_id) DO UPDATE SET checkin_at = excluded.checkin_at, rank = excluded.rank, eliminated = excluded.eliminated, note = excluded.note`,
      episodeId, teamId, checkin, rank, eliminated ? 1 : 0, note,
    );
    if (b.eliminated !== undefined) run('UPDATE teams SET status = ? WHERE id = ?', eliminated ? 'eliminated' : 'alive', teamId);
  });
  audit(c.get('user'), 'update', 'pitstop', `${episodeId}/${teamId}`, before, { checkin, rank, eliminated, note });
  notify('pitstop', episodeId);
  notify('progress', episodeId);
  if (b.eliminated !== undefined) notify('teams');
  return c.json({ pitstop: pitstopRows(episodeId) });
});
