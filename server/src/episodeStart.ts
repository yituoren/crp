import { all, get, run, tx, now } from './db.js';
import { audit, notify } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap } from './routes/teams.js';
import { chainAfterComplete, emptyProgress, finalRanking, upsertProgress } from './progressCore.js';

export const SYSTEM_USER: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };

export type EpisodeRow = { id: number; event_id: number; code: string; sort: number; status: string; budget: number; started_at: string | null; start_at: string | null; inherit_rank: number; start_gap_min: number };

/** 开始赛段：状态改为进行中，记录开始时间，并给每支存活队伍发放本赛段经费（只发一次）。返回发了经费的队伍名 */
export function startEpisodeNow(ep: EpisodeRow, user: AuthUser, t: string): string[] {
  const issued: string[] = [];
  const labels = teamLabelMap();
  tx(() => {
    run("UPDATE episodes SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", t, ep.id);
    if (!ep.started_at && ep.budget > 0) {
      for (const team of all("SELECT id, name, currency FROM teams WHERE status = 'alive' AND event_id = ? ORDER BY sort, id", ep.event_id)) {
        const balance = team.currency + ep.budget;
        run('UPDATE teams SET currency = ? WHERE id = ?', balance, team.id);
        run(
          'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at) VALUES (?,?,?,?,?,?,?,?)',
          ep.id, team.id, ep.budget, balance, `${ep.code} 补充经费`, user.id, user.displayName, t,
        );
        issued.push(labels.get(team.id) ?? team.name);
      }
    }
  });
  audit(user, 'start', 'episode', ep.id, { status: ep.status, started_at: ep.started_at }, { issuedBudgetTo: issued, at: t });
  notify('episodes'); notify('teams'); notify('ledger', ep.id);
  return issued;
}

/** 上一个赛段（按顺序） */
export function previousEpisode(ep: EpisodeRow) {
  return get<EpisodeRow>('SELECT * FROM episodes WHERE event_id = ? AND (sort < ? OR (sort = ? AND id < ?)) ORDER BY sort DESC, id DESC LIMIT 1', ep.event_id, ep.sort, ep.sort, ep.id) ?? null;
}

/**
 * 发车计划：每支存活队伍的出发时间。
 *  - 继承上一赛段名次且设了发车间隔：按名次先后，第 k 名在开始时间 + (k-1)×间隔 出发
 *  - 否则所有队伍在开始时间一起出发
 */
export function departurePlan(ep: EpisodeRow): { teamId: number; at: string }[] {
  if (!ep.start_at) return [];
  const alive = all<{ id: number }>("SELECT id FROM teams WHERE event_id = ? AND status = 'alive' ORDER BY sort, id", ep.event_id).map((t) => t.id);
  const base = new Date(ep.start_at).getTime();
  const prev = ep.inherit_rank ? previousEpisode(ep) : null;
  if (!prev || ep.start_gap_min <= 0) return alive.map((teamId) => ({ teamId, at: ep.start_at! }));
  const order = finalRanking(prev.id).filter((id) => alive.includes(id));
  for (const id of alive) if (!order.includes(id)) order.push(id);
  return order.map((teamId, i) => ({ teamId, at: new Date(base + i * ep.start_gap_min * 60000).toISOString() }));
}

/** 自动发车：到点后给该队记录本赛段第一个环节的开始。起跑线 = 记录“出发”（完成）并联动下一环节；其他环节 = 记录开始时间。已有记录的不动 */
export function recordDeparture(ep: EpisodeRow, teamId: number, at: string): boolean {
  const first = get<{ id: number; sort: number; type: string }>("SELECT id, sort, type FROM legs WHERE episode_id = ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", ep.id);
  if (!first) return false;
  const cur = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ep.id, teamId, first.id) ?? emptyProgress();
  if (first.type === 'SL') {
    if (cur.completed_at) return false;
    tx(() => {
      upsertProgress(ep.id, teamId, first.id, { ...cur, completed_at: at }, SYSTEM_USER.id);
      chainAfterComplete(ep.id, teamId, first.sort, at, SYSTEM_USER.id, first.type);
    });
  } else {
    if (cur.arrived_at) return false;
    upsertProgress(ep.id, teamId, first.id, { ...cur, arrived_at: at }, SYSTEM_USER.id);
  }
  audit(SYSTEM_USER, 'progress:auto_start', 'progress', `${ep.id}/${teamId}/${first.id}`, cur, { at });
  return true;
}
