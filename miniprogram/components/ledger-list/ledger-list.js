// Money ledger as log cards (the website's ledger tables): teamId filters one team, limit keeps the latest rows.
// Only original rows are shown (reverted ones dimmed); the author or a host reverts a row.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { legName } = require('../../utils/types');
const { fmtDateTime } = require('../../utils/time');
const { fmtMoney, moneyUnit } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { teamId: { type: Number, value: 0 }, limit: { type: Number, value: 0 } },
  data: { rows: [], unit: '元' },
  observers: { 'teamId, limit': function () { this.render(); } },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const { teamId, limit } = this.data;
      let list = race.ledger.filter((l) => !l.reverts_id && (!teamId || l.team_id === teamId));
      if (limit) list = list.slice(0, limit);
      const rows = list.map((l) => {
        const leg = l.leg_id ? race.legById.get(l.leg_id) : null;
        const by = race.ledger.find((x) => x.reverts_id === l.id);
        return {
          id: l.id, time: fmtDateTime(l.created_at), team: l.team_name, legType: leg ? leg.type : '', legName: leg ? legName(leg) : (l.leg_name || '其他'),
          delta: l.kind === 'use' ? '—' : fmtMoney(l.delta, true), deltaCls: l.kind === 'use' ? '' : l.delta > 0 ? 'pos' : 'neg', balance: fmtMoney(l.balance_after),
          by: l.operator_name, reason: l.reason || '-', reverted: !!l.reverted, revertedBy: by ? by.operator_name : '', canRevert: !l.reverted && race.canRevert(l.operator_id, l.team_id),
        };
      });
      this.setData({ rows, unit: moneyUnit(), showTeam: !teamId });
    },
    revert(e) {
      const l = race.ledger.find((x) => x.id === e.currentTarget.dataset.id); if (!l) return;
      const msg = l.kind === 'use' ? `撤销「${l.team_name}」的这次使用（${l.reason}）？物品会回到背包。` : `撤销「${l.team_name}」的这笔 ${fmtMoney(l.delta, true)} ${moneyUnit()}（${l.reason || '手动调整'}）？会写入一条反向流水，余额相应恢复。`;
      confirm(l.kind === 'use' ? '撤销使用' : '撤销经费变动', msg, { danger: true, okText: '撤销' }).then(async (ok) => {
        if (!ok) return;
        try { await api(`/ledger/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger(), race.loadProgress()]); toast('已撤销'); } catch (err) { toast(err.message); }
      });
    },
  },
});
