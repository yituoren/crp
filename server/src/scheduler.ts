import { all, get, now } from './db.js';
import { withEvent, type EventRow } from './auth.js';
import { notify } from './util.js';
import { SYSTEM_USER, departurePlan, recordDeparture, startEpisodeNow, type EpisodeRow } from './episodeStart.js';

/** 每几秒检查一次：到了自动开始时间的赛段开始；进行中赛段里到了出发时间的队伍自动记录出发 */
function tick() {
  const t = now();
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE start_at IS NOT NULL AND status = 'pending' AND start_at <= ?", t)) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    if (get("SELECT 1 FROM episodes WHERE event_id = ? AND status = 'running' AND id != ?", ep.event_id, ep.id)) continue; // 上一赛段还没结束：等主办结束后再开始
    withEvent(ev, () => startEpisodeNow(ep, SYSTEM_USER, ep.start_at!));
  }
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE start_at IS NOT NULL AND status = 'running'")) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    let changed = false;
    withEvent(ev, () => { for (const d of departurePlan(ep)) if (d.at <= t && recordDeparture(ep, d.teamId, d.at)) changed = true; });
    if (changed) notify('progress', ep.id);
  }
}

export function startScheduler(intervalMs = 5000) {
  const safeTick = () => { try { tick(); } catch (e) { console.error('[scheduler]', e); } };
  safeTick();
  return setInterval(safeTick, intervalMs);
}
