import { all, get, now } from './db.js';
import { withEvent, type EventRow } from './auth.js';
import { notify } from './util.js';
import { SYSTEM_USER, departurePlan, previousEpisode, recordDeparture, startEpisodeNow, type EpisodeRow } from './episodeStart.js';

/** Runs every few seconds: start episodes whose scheduled time has come; record departures that are due in running episodes */
function tick() {
  const t = now();
  // Continuous episodes start when their first team is due to depart; the previous episode may still be running
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE continuous_wait_min IS NOT NULL AND status = 'pending'")) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    withEvent(ev, () => {
      const prev = previousEpisode(ep);
      if (!prev || prev.status === 'pending' || continuousStartBlocked(ep, prev)) return;
      const first = departurePlan(ep)[0];
      if (first && first.at <= t) startEpisodeNow(ep, SYSTEM_USER, first.at);
    });
  }
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE start_at IS NOT NULL AND continuous_wait_min IS NULL AND status = 'pending' AND start_at <= ?", t)) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    if (get("SELECT 1 FROM episodes WHERE event_id = ? AND status = 'running' AND id != ?", ep.event_id, ep.id)) continue; // the previous episode is still running: wait until a host finishes it
    withEvent(ev, () => startEpisodeNow(ep, SYSTEM_USER, ep.start_at!));
  }
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE depart_base IS NOT NULL AND status = 'running'")) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    let changed = false;
    withEvent(ev, () => { for (const d of departurePlan(ep)) if (d.at <= t && recordDeparture(ep, d.teamId, d.at)) changed = true; });
    if (changed) notify('progress', ep.id);
  }
}

/** A continuous episode may overlap only its previous episode: every earlier episode must be finished and nothing else running */
export function continuousStartBlocked(ep: EpisodeRow, prev: EpisodeRow): string | null {
  const other = get<{ code: string }>("SELECT code FROM episodes WHERE event_id = ? AND id NOT IN (?, ?) AND status = 'running'", ep.event_id, ep.id, prev.id);
  if (other) return `${other.code} 仍在进行中`;
  const unfinished = get<{ code: string }>("SELECT code FROM episodes WHERE event_id = ? AND (sort < ? OR (sort = ? AND id < ?)) AND status != 'finished' ORDER BY sort, id LIMIT 1", ep.event_id, prev.sort, prev.sort, prev.id);
  return unfinished ? `${unfinished.code} 还没有结束` : null;
}

export function startScheduler(intervalMs = 5000) {
  const safeTick = () => { try { tick(); } catch (e) { console.error('[scheduler]', e); } };
  safeTick();
  return setInterval(safeTick, intervalMs);
}
