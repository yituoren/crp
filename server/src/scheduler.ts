import { all, get, now } from './db.js';
import { withEvent, type EventRow } from './auth.js';
import { notify } from './util.js';
import { SYSTEM_USER, departurePlan, recordDeparture, startBlockedReason, startEpisodeNow, type EpisodeRow } from './episodeStart.js';

/** Runs every second: start episodes whose scheduled time has come; record departures that are due in running episodes */
function tick() {
  const t = now();
  // Every episode may start once the previous one has started. Continuous episodes start when their first team is due to depart
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE continuous_wait_min IS NOT NULL AND status = 'pending'")) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    withEvent(ev, () => {
      if (startBlockedReason(ep)) return;
      const first = departurePlan(ep)[0];
      if (first && first.at <= t) startEpisodeNow(ep, SYSTEM_USER, first.at);
    });
  }
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE start_at IS NOT NULL AND continuous_wait_min IS NULL AND status = 'pending' AND start_at <= ?", t)) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    withEvent(ev, () => { if (!startBlockedReason(ep)) startEpisodeNow(ep, SYSTEM_USER, ep.start_at!); });
  }
  for (const ep of all<EpisodeRow>("SELECT * FROM episodes WHERE depart_base IS NOT NULL AND status = 'running'")) {
    const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', ep.event_id);
    if (!ev) continue;
    let changed = false;
    withEvent(ev, () => { for (const d of departurePlan(ep)) if (d.at <= t && recordDeparture(ep, d.teamId, d.at)) changed = true; });
    if (changed) notify('progress', ep.id);
  }
}

export function startScheduler(intervalMs = 1000) {
  const safeTick = () => { try { tick(); } catch (e) { console.error('[scheduler]', e); } };
  safeTick();
  return setInterval(safeTick, intervalMs);
}
