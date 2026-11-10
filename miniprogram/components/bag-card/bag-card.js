// Bag (the website's BagCard): a team's items as tiles; pick several and use them, one use record per item.
// Cards that need a target ask for a team (directed twist cards always, other items per their "needs a target" setting);
// 盗窃 also asks which card was drawn from the target; 锦囊 cards take a typed id. The item log follows.
// plain: no card around it (inside the money page's sheet), and a shorter log.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { isTipItem, twistKind, isDirectedTwist } = require('../../utils/types');
const { confirm, toast } = require('../../utils/dialogs');

const isSteal = (name) => name.includes('盗窃');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { teamId: { type: Number, value: 0 }, title: { type: String, value: '本队背包' }, plain: { type: Boolean, value: false }, flat: { type: Boolean, value: false } },
  data: { items: [], canUse: false, picked: [], status: '', busy: false, picking: false, fields: [] },
  observers: { teamId() { this.selected = []; this.render(); } },
  lifetimes: {
    attached() { this.selected = []; this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const team = race.teamById.get(this.data.teamId);
      const items = (team && team.inventory) || [];
      this.selected = this.selected.filter((n) => items.some((i) => i.name === n));
      const canUse = race.canAdjustCurrencyFor(this.data.teamId) && !race.episodePending();
      this.setData({
        items: items.map((i) => ({ name: i.name, count: i.count, on: this.selected.includes(i.name) })), canUse,
        status: this.selected.length ? `已选 ${this.selected.length} 件` : canUse ? '点选物品后使用' : '', hasPicked: this.selected.length > 0,
      });
    },
    toggle(e) {
      if (!this.data.canUse) return;
      const n = e.currentTarget.dataset.name;
      const i = this.selected.indexOf(n);
      if (i >= 0) this.selected.splice(i, 1); else this.selected.push(n);
      this.render();
    },
    // directed twist cards always ask for a target team, other twist cards with logic never do; other items follow the setting
    needsTarget(name) {
      const item = race.shopItems.find((i) => i.name === name);
      return !isTipItem(name) && (isDirectedTwist(name) || (!twistKind(name) && !!(item && item.needs_target)));
    },
    /** A directed card cannot pick a team this kind of card has already been played on in this episode */
    taken(name, teamId) {
      if (!isDirectedTwist(name)) return false;
      const kind = twistKind(name);
      if (kind) return race.effects.some((e) => e.kind === kind && e.target_team_id === teamId && ['pending', 'queued', 'hit'].includes(e.status));
      const ep = race.currentEpisode();
      return race.itemLog.some((l) => l.item_name === name && l.kind === 'use' && !l.reverted && !l.reverts_id && l.target_team_id === teamId && l.episode_id === (ep && ep.id));
    },
    async useSelected() {
      const names = this.selected.slice(); const team = race.teamById.get(this.data.teamId);
      if (!names.length || !team) return;
      const fields = [];
      names.forEach((n) => {
        if (this.needsTarget(n)) {
          const teams = race.teams.filter((t) => t.status === 'alive' && t.id !== team.id && !this.taken(n, t.id));
          fields.push({ name: n, type: 'team', ids: teams.map((t) => t.id), labels: teams.map((t) => t.label), index: -1, steal: isSteal(n), stealLabels: [], stealValues: [], stealIndex: -1 });
        } else if (isTipItem(n)) fields.push({ name: n, type: 'tip', value: '' });
      });
      if (fields.length) { this.setData({ picking: true, fields, pickHead: `「${team.label}」使用：${names.join('、')}。每件物品记一条使用记录，用掉的从背包里消失。` }); return; }
      if (!(await confirm('使用物品', `「${team.label}」使用：${names.join('、')}。每件物品记一条使用记录，用掉的从背包里消失。`))) return;
      this.submit(names, {});
    },
    pickTarget(e) {
      const f = Number(e.currentTarget.dataset.f); const i = Number(e.detail.value);
      const field = this.data.fields[f];
      const patch = { [`fields[${f}].index`]: i, [`fields[${f}].stealIndex`]: -1 };
      if (field.steal) {
        // 盗窃: the card drawn offline from the target's bag ('-' = nothing taken)
        const target = race.teamById.get(field.ids[i]);
        const inv = (target && target.inventory) || [];
        patch[`fields[${f}].stealLabels`] = ['未拿到（对方无牌或被挡下）'].concat(inv.map((x) => `${x.name} ×${x.count}`));
        patch[`fields[${f}].stealValues`] = ['-'].concat(inv.map((x) => x.name));
      }
      this.setData(patch);
    },
    pickSteal(e) { this.setData({ [`fields[${Number(e.currentTarget.dataset.f)}].stealIndex`]: Number(e.detail.value) }); },
    onTip(e) { this.setData({ [`fields[${Number(e.currentTarget.dataset.f)}].value`]: e.detail.value }); },
    closePick() { this.setData({ picking: false }); },
    noop() {},
    confirmPick() {
      const picks = {};
      for (const f of this.data.fields) {
        if (f.type === 'tip') { if (!f.value.trim()) { toast(`请填写「${f.name}」的锦囊 id`); return; } picks[f.name] = { tipCode: f.value.trim() }; continue; }
        if (f.index < 0) { toast(`请选择「${f.name}」的对象`); return; }
        if (f.steal && f.stealIndex < 0) { toast(`请选择「${f.name}」拿到的卡`); return; }
        picks[f.name] = Object.assign({ targetTeamId: f.ids[f.index] }, f.steal && f.stealValues[f.stealIndex] !== '-' ? { stealItem: f.stealValues[f.stealIndex] } : {});
      }
      this.setData({ picking: false });
      this.submit(this.selected.slice(), picks);
    },
    async submit(names, picks) {
      this.setData({ busy: true });
      const ep = race.currentEpisode();
      try {
        for (const name of names) {
          await api('/items/use', { method: 'POST', body: Object.assign({ episodeId: ep ? ep.id : null, teamId: this.data.teamId, itemName: name }, picks[name] || {}) });
        }
        this.selected = [];
        await Promise.all([race.loadTeams(), race.loadLedger()]);
        toast(`已使用 ${names.length} 件物品`);
      } catch (e) {
        toast(e.message);
        await Promise.all([race.loadTeams(), race.loadLedger()]);
      } finally { this.setData({ busy: false }); }
    },
  },
});
