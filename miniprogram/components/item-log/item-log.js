// Item log as log cards (the website's ItemLogTable): gains (mirrored from purchases) and uses, separate from the money ledger.
// Uses can be reverted (the item returns to the bag); purchases are reverted in the ledger, steals with their use.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { legName } = require('../../utils/types');
const { fmtDateTime } = require('../../utils/time');
const { confirm, toast } = require('../../utils/dialogs');

const KIND = { buy: '购买', use: '使用', steal: '盗得', stolen: '被盗' };

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { teamId: { type: Number, value: 0 }, limit: { type: Number, value: 0 } },
  data: { rows: [] },
  observers: { 'teamId, limit': function () { this.render(); } },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const { teamId, limit } = this.data;
      let list = race.itemLog.filter((l) => !l.reverts_id && (!teamId || l.team_id === teamId));
      if (limit) list = list.slice(0, limit);
      const rows = list.map((l) => {
        const leg = l.leg_id ? race.legById.get(l.leg_id) : null;
        const by = race.itemLog.find((x) => x.reverts_id === l.id);
        return {
          id: l.id, time: fmtDateTime(l.created_at), team: l.team_name, legType: leg ? leg.type : '', legName: leg ? legName(leg) : (l.leg_name || '其他'),
          item: l.item_name, kind: KIND[l.kind], target: [l.target_name, l.target_label].filter(Boolean).join(' · '), by: l.operator_name,
          reverted: !!l.reverted, revertedBy: by ? by.operator_name : '',
          note: l.reverted ? '' : l.kind === 'buy' ? '在经费流水处撤销' : l.kind === 'steal' || l.kind === 'stolen' ? '随盗窃撤销' : '',
          canRevert: !l.reverted && l.kind === 'use' && race.canRevert(l.operator_id, l.team_id),
        };
      });
      this.setData({ rows, showTeam: !teamId });
    },
    revert(e) {
      const l = race.itemLog.find((x) => x.id === e.currentTarget.dataset.id); if (!l) return;
      confirm('撤销使用', `撤销「${l.team_name}」这次使用「${l.item_name}」？物品会回到背包。`, { danger: true, okText: '撤销' }).then(async (ok) => {
        if (!ok) return;
        try { await api(`/item-log/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger()]); toast('已撤销'); } catch (err) { toast(err.message); }
      });
    },
  },
});
