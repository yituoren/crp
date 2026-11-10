// Progress (the website's ProgressView): the matrix of every team × leg with live ranks, then penalties and credits.
// The team column stays put while the legs scroll sideways; each second only the cells that run are re-sent.
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { onTick } = require('../../utils/ticker');
const { legName, startLabel, endLabel } = require('../../utils/types');
const { fmtTime, fmtTimeSec, fmtDurMs, fmtPenMin } = require('../../utils/time');

const W = { time: 56, dur: 64, extra: 76 };

/** Legs with extra info get extra columns at the end of the group; pit stops get "penalty" and "final" */
function extraCols(type) {
  if (type === 'DT') return ['绕道选择'];
  if (type === 'RB') return ['完成人'];
  if (type === 'FF') return ['快进结果'];
  if (type === 'UT' || type === 'YD') return ['施加对象'];
  if (type === 'Union') return ['合作队伍'];
  if (type === 'PS') return ['罚时', '结算'];
  return [];
}

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { empty: false, groups: [], rows: [], gridWidth: 0 },
  lifetimes: {
    attached() {
      this.off = race.subscribe(() => this.render());
      this.offTick = onTick(() => this.tick());
      this.render();
    },
    detached() { this.off && this.off(); this.offTick && this.offTick(); },
  },
  methods: {
    /** Side quest after a main leg, joined into its group */
    branchOf(legs, l) { const i = legs.findIndex((x) => x.id === l.id); const n = legs[i + 1]; return n && n.type === 'SQ' ? n : null; },

    /** Time spent on the side quest (subtracted from the main leg): actual when ended, otherwise until now (or the main leg's end) */
    branchElapsed(teamId, br, mainEndMs) {
      if (!br) return 0;
      const bp = race.progressOf(teamId, br.id); if (!bp || !bp.arrived_at) return 0;
      const s = new Date(bp.arrived_at).getTime();
      const e = bp.completed_at ? new Date(bp.completed_at).getTime() : (mainEndMs || auth.nowMs);
      return Math.max(0, e - s);
    },
    /** A leg's start / end / duration for a team; running legs use the clock */
    cell(teamId, l, br, isPs) {
      const p = race.progressOf(teamId, l.id);
      const done = 'done';
      if (!p || !p.arrived_at) return { start: '-', end: p && p.completed_at ? fmtTime(p.completed_at) : '-', dur: '-', cls: p && p.completed_at ? done : '' };
      const start = race.taskStart(teamId, l.id);
      const startMs = new Date(start).getTime();
      const pen = race.legPenalty(teamId, l.id) * 60000;
      if (p.completed_at) {
        const endMs = new Date(p.completed_at).getTime();
        return { start: fmtTime(start), end: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), dur: fmtDurMs(endMs - startMs - this.branchElapsed(teamId, br, endMs) + pen), cls: done };
      }
      const stop = race.stoppedLabel(teamId, l.id);
      if (stop) return { start: fmtTime(start), end: stop, dur: '-', cls: '' }; // out of the race before finishing: no running time
      if (this.finished) return { start: fmtTime(start), end: '未完成', dur: '-', cls: '' }; // a finished episode no longer runs
      if (race.waitingUntil(teamId, l.id)) return { start: fmtTime(start), end: '等待中', dur: '-', cls: 'arrived' };
      return { start: fmtTime(start), end: '进行中', dur: fmtDurMs(Math.max(0, auth.nowMs - startMs - this.branchElapsed(teamId, br, null)) + pen), cls: 'arrived' };
    },
    branchCell(teamId, br) {
      const bp = br ? race.progressOf(teamId, br.id) : null;
      if (!bp || !bp.arrived_at) return { start: '-', end: '-', dur: '-', cls: '' };
      const stop = bp.completed_at ? null : race.stoppedLabel(teamId, br.id) || (this.finished ? '未完成' : null);
      if (stop) return { start: fmtTime(bp.arrived_at), end: stop, dur: '-', cls: '' };
      const s = new Date(bp.arrived_at).getTime();
      const ms = (bp.completed_at ? new Date(bp.completed_at).getTime() : auth.nowMs) - s + race.legPenalty(teamId, br.id) * 60000;
      return { start: fmtTime(bp.arrived_at), end: bp.completed_at ? fmtTime(bp.completed_at) : '进行中', dur: fmtDurMs(ms), cls: bp.completed_at ? 'done' : 'arrived' };
    },
    extraVal(teamId, l, i) {
      if (l.type === 'PS') {
        const r = race.pitstop.find((x) => x.team_id === teamId);
        if (i === 0) return !r || !r.penalty_minutes ? '-' : fmtPenMin(r.penalty_minutes);
        return r && r.final_time ? fmtTimeSec(r.final_time) : '-';
      }
      const p = race.progressOf(teamId, l.id);
      if (!p) return '-';
      if (l.type === 'DT') return p.detour_choice || '-';
      if (l.type === 'RB') return p.roadblock_by || '-';
      if (l.type === 'FF') return p.ff_result === 'success' ? '成功' : p.ff_result === 'fail' ? '失败' : '-';
      if (p.target_team_id) { const t = race.teamById.get(p.target_team_id); return t ? t.label : '-'; }
      return '-';
    },
    /** All cells of one team's leg group, in column order */
    groupCells(teamId, g) {
      const c = this.cell(teamId, g.leg, g.br, g.leg.type === 'PS');
      const out = [{ text: c.start, cls: c.cls, kind: 'time', hit: race.startDelayed(teamId, g.leg.id) }];
      if (g.br) { const b = this.branchCell(teamId, g.br); out.push({ text: b.start, cls: b.cls, kind: 'time', branch: true }, { text: b.end, cls: b.cls, kind: 'time', branch: true }, { text: b.dur, cls: b.cls, kind: 'dur', branch: true }); }
      out.push({ text: c.end, cls: c.cls, kind: 'time', hit: !!race.uturnOn(teamId, g.leg.id) }, { text: c.dur, cls: c.cls, kind: 'dur' });
      extraCols(g.leg.type).forEach((_, i) => out.push({ text: this.extraVal(teamId, g.leg, i), cls: '', kind: g.leg.type === 'PS' ? (i === 0 ? 'dur' : 'time') : 'extra' }));
      return out.map((x) => ({ text: x.text, cls: `${x.cls} ${x.text === '-' ? 'blank' : 'k-' + x.kind}${x.hit ? ' hit' : ''}${x.branch ? ' branch' : ''}` }));
    },
    lastAgo(teamId, legs) {
      let last = 0;
      for (const l of legs) { const p = race.progressOf(teamId, l.id); if (p) [p.arrived_at, p.completed_at].forEach((t) => { if (t) last = Math.max(last, new Date(t).getTime()); }); }
      if (!last) return '尚无记录';
      if (this.finished) return `最后记录 ${fmtTime(new Date(last).toISOString())}`;
      return `${Math.max(0, Math.floor((auth.nowMs - last) / 60000))} 分钟前`;
    },

    render() {
      const ep = race.currentEpisode();
      if (!race.loaded || !ep) return;
      this.finished = ep.status === 'finished';
      const all = ep.legs;
      const legs = all.filter((l) => l.type !== 'SQ');
      if (!legs.length) { this.setData({ empty: true, groups: [], rows: [] }); return; }
      const groups = legs.map((l) => {
        const br = this.branchOf(all, l);
        const cols = [{ label: startLabel(l.type), w: W.time }];
        if (br) cols.push({ label: '支线开始', w: W.time, branch: true }, { label: '支线结束', w: W.time, branch: true }, { label: '支线用时', w: W.dur, branch: true });
        cols.push({ label: endLabel(l.type), w: W.time }, { label: '用时', w: W.dur });
        extraCols(l.type).forEach((c) => cols.push({ label: c, w: l.type === 'PS' ? W.dur : W.extra }));
        return { leg: l, br, id: l.id, type: l.type, name: legName(l), branchName: br ? legName(br) : '', cols, width: cols.reduce((s, c) => s + c.w, 0) };
      });
      this.groups = groups; this.legs = legs;

      // Teams shown here: a team that stopped in an earlier episode is left out; in the episode where it stopped it still shows
      const order = (id) => race.episodes.findIndex((e) => e.id === id);
      const cur = order(ep.id);
      const visible = race.teams.filter((t) => {
        if (t.status === 'alive') return true;
        const stopLeg = t.status === 'eliminated' ? t.eliminated_leg_id : t.locked_from_leg_id;
        const leg = stopLeg ? race.legById.get(stopLeg) : null;
        return !leg || order(leg.episode_id) >= cur;
      });
      // Standings: pit stop first (server rank: check-in + settled penalty), then by progress depth, ties by the earlier latest record
      const finalRank = new Map(race.pitstop.map((r) => [r.team_id, r.rank]));
      const key = new Map(visible.map((t) => {
        let depth = 0, at = 0;
        legs.forEach((l, i) => {
          const p = race.progressOf(t.id, l.id);
          if (p && p.completed_at && 2 * i + 2 > depth) { depth = 2 * i + 2; at = new Date(p.completed_at).getTime(); }
          if (p && p.arrived_at && 2 * i + 1 > depth) { depth = 2 * i + 1; at = new Date(p.arrived_at).getTime(); }
        });
        return [t.id, { depth, at }];
      }));
      const idx = new Map(race.teams.map((t, i) => [t.id, i]));
      const status = (t) => race.statusIn(t.id, ep.id);
      const ordered = visible.slice().sort((a, b) => {
        const wa = status(a) !== 'alive' ? 1 : 0, wb = status(b) !== 'alive' ? 1 : 0; // teams out of the race here go last, unranked
        if (wa !== wb) return wa - wb;
        const ra = finalRank.get(a.id) || null, rb = finalRank.get(b.id) || null;
        if (ra && rb) return ra - rb;
        if (ra || rb) return ra ? -1 : 1;
        const ka = key.get(a.id), kb = key.get(b.id);
        if (ka.depth !== kb.depth) return kb.depth - ka.depth;
        if (ka.at !== kb.at) return ka.at - kb.at;
        return idx.get(a.id) - idx.get(b.id);
      });
      let n = 0;
      const rows = ordered.map((t) => {
        const st = status(t);
        const rank = st === 'alive' ? ++n : 0;
        return {
          id: t.id, rank, rankCls: rank && rank <= 3 ? `rank-${rank}` : '', name: t.name, stopped: st === 'eliminated' ? '已淘汰' : st === 'withdrawn' ? '已退赛' : '',
          ago: this.lastAgo(t.id, legs), cells: groups.reduce((a, g) => a.concat(this.groupCells(t.id, g)), []),
        };
      });
      this.rowsCache = rows;
      // per column: width, and whether it opens a leg group (draws the divider)
      const colW = [], colFirst = [];
      groups.forEach((g) => g.cols.forEach((c, i) => { colW.push(c.w); colFirst.push(i === 0); }));
      this.setData({
        empty: false, rows, colW, colFirst, gridWidth: groups.reduce((s, g) => s + g.width, 0),
        groups: groups.map((g) => ({ id: g.id, type: g.type, name: g.name, branchName: g.branchName, width: g.width, cols: g.cols })),
      });
    },

    /** Each second: re-send only the texts that changed (running durations, waits ending, "x minutes ago") */
    tick() {
      if (!this.rowsCache || !this.groups) return;
      const patch = {};
      this.rowsCache.forEach((row, r) => {
        const ago = this.lastAgo(row.id, this.legs);
        if (ago !== row.ago) { row.ago = ago; patch[`rows[${r}].ago`] = ago; }
        let c = 0;
        for (const g of this.groups) {
          const p = race.progressOf(row.id, g.leg.id);
          const bp = g.br ? race.progressOf(row.id, g.br.id) : null;
          const live = (p && p.arrived_at && !p.completed_at) || (bp && bp.arrived_at && !bp.completed_at);
          if (live) {
            this.groupCells(row.id, g).forEach((cell, i) => {
              const old = row.cells[c + i];
              if (old.text !== cell.text || old.cls !== cell.cls) { row.cells[c + i] = cell; patch[`rows[${r}].cells[${c + i}]`] = cell; }
            });
          }
          c += g.cols.length;
        }
      });
      if (Object.keys(patch).length) this.setData(patch);
    },
  },
});
