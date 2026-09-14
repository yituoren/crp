import { Hono } from 'hono';
import { all, get } from '../db.js';
import type { Env } from '../auth.js';
import { intParam } from '../util.js';
import { pitstopRows } from './progress.js';

export const dashboardRoutes = new Hono<Env>();



dashboardRoutes.get('/dashboard/:episodeId', (c) => {
  const episodeId = intParam(c, 'episodeId');
  const episode = get('SELECT * FROM episodes WHERE id = ?', episodeId);
  const legs = all('SELECT id, sort, type, name, record_mode, needs_staff FROM legs WHERE episode_id = ? ORDER BY sort, id', episodeId);
  const teams = all('SELECT id, code, name, status, currency FROM teams ORDER BY sort, id');
  const progress = all('SELECT * FROM progress WHERE episode_id = ?', episodeId);
  const legIndex = new Map(legs.map((l, i) => [l.id, i]));
  const nowMs = Date.now();

  const byTeam = new Map<number, any[]>();
  for (const p of progress) {
    if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []);
    byTeam.get(p.team_id)!.push(p);
  }

  const teamRows: any[] = teams.map((t) => {
    const ps = byTeam.get(t.id) ?? [];
    let current: any = null; // 最靠后的有到达记录的环节
    let lastActivity: string | null = null;
    for (const p of ps) {
      const stamp = p.completed_at ?? p.arrived_at;
      if (stamp && (!lastActivity || stamp > lastActivity)) lastActivity = stamp;
      if (p.arrived_at && (!current || (legIndex.get(p.leg_id) ?? -1) > (legIndex.get(current.leg_id) ?? -1))) current = p;
    }
    const currentLeg = current ? legs[legIndex.get(current.leg_id)!] : null;
    const staleMin = lastActivity ? Math.floor((nowMs - new Date(lastActivity).getTime()) / 60000) : null;
    const finished = currentLeg?.type === 'PS' && !!current?.completed_at;
    return {
      ...t,
      currentLeg: currentLeg ? { id: currentLeg.id, name: currentLeg.name, type: currentLeg.type, arrived: current.arrived_at, completed: current.completed_at } : null,
      lastActivity,
      staleMinutes: staleMin,
      finished,
    };
  });

  const alerts: { level: string; text: string; teamId?: number }[] = [];
  for (const t of teamRows) {
    if (t.status === 'alive' && episode && episode.budget > 0 && t.currency < 0) alerts.push({ level: 'urgent', text: `${t.name} 货币余额为负（${t.currency}）`, teamId: t.id });
  }

  return c.json({
    episode,
    legs,
    teams: teamRows,
    progress,
    pitstop: pitstopRows(episodeId),
    alerts,
    serverTime: new Date().toISOString(),
  });
});
