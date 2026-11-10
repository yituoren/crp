// Leg page (the website's LegDetailView): hosts edit the leg (type, name, sudden death, cutoffs, shop, place and time,
// detour options, texts); everyone else reads it. Then attachments, every team's records on the leg, and cutoff uses.
const { api, apiUrl, serverUrl, authHeader } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { LEG_TYPE_LABEL, legTypeLabel, legName, stockText } = require('../../utils/types');
const { fmtDateTime, fmtDurMs } = require('../../utils/time');
const { fmtMoney, moneyUnit, moneyMode } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

const TYPES = Object.keys(LEG_TYPE_LABEL).filter((t) => t !== 'SL' && t !== 'PS');
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

Page({
  data: {
    ready: false, missing: false, isHost: false, editable: false, isCoin: false, unit: '元',
    leg: null, info: {}, staff: '', form: {}, cutoffs: [], shop: [], dirty: false,
    typeLabels: TYPES.map((t) => LEG_TYPE_LABEL[t]), typeIndex: 0, fixed: false, fixedLabel: '',
    shopLabels: [], attachments: [], canUpload: false, uploading: false,
  },

  onLoad(q) {
    this.episodeId = Number(q.episodeId); this.legId = Number(q.legId);
    // records and assignments follow the leg's episode
    if (this.episodeId && this.episodeId !== race.currentEpisodeId) race.selectEpisode(this.episodeId);
    this.off = race.subscribe(() => this.render());
    this.render();
  },
  onUnload() { this.off && this.off(); },
  onBack() { wx.navigateBack(); },

  render() {
    const ep = race.episodes.find((e) => e.id === this.episodeId);
    const leg = ep && ep.legs.find((l) => l.id === this.legId);
    if (!race.loaded) return;
    if (!leg) { this.setData({ ready: true, missing: true }); return; }
    const isCoin = moneyMode() === 'coin';
    const staff = race.assignments.filter((a) => a.role === 'station' && (a.leg_ids || []).includes(leg.id)).map((a) => a.display_name).join('、') || '未分配';
    const last = race.isLastEpisode(this.episodeId);
    const canUpload = auth.isHost || ((race.myAssignment() || {}).role === 'station' && ((race.myAssignment() || {}).leg_ids || []).includes(leg.id));
    this.setData({
      ready: true, missing: false, isHost: auth.isHost, editable: race.episodes.length > 0 && (auth.isAdmin || ep.status === 'pending'), isCoin, unit: moneyUnit(),
      leg: { id: leg.id, type: leg.type, name: legName(leg), typeLabel: legTypeLabel(leg.type, last) }, staff, canUpload,
      fixed: leg.type === 'SL' || leg.type === 'PS', fixedLabel: `${legTypeLabel(leg.type, last)}（固定）`,
      info: {
        address: leg.address, mapUrl: leg.map_url, open: leg.open_time || leg.close_time ? `${leg.open_time || '-'} ~ ${leg.close_time || '-'}` : '',
        shop: isCoin ? leg.shop.map((s) => ({ id: s.id, text: `${s.name} · ${stockText(s)}`, out: s.remaining === 0 })) : [],
        elim: leg.can_eliminate ? leg.eliminate_count : 0,
        cutoffs: leg.cutoffs.map((c) => `${c.name} · ${fmtDurMs(c.start_min * 60000)} 起 · 每 ${fmtDurMs(c.interval_min * 60000)}${isCoin && c.cost ? ` · ${c.cost} 币` : ''}`),
        detour: leg.type === 'DT' ? `A「${leg.detour_a || '未填写'}」 / B「${leg.detour_b || '未填写'}」` : '',
        description: leg.description, clue: leg.clue_text, judge: leg.judge_criteria,
      },
      attachments: leg.attachments.map((a) => ({ id: a.id, name: a.filename, meta: `${fmtSize(a.size)} · ${fmtDateTime(a.created_at)}`, mime: a.mime, url: a.url })),
      shopLabels: race.shopItems.map((it) => `${it.name}（${fmtMoney(it.price)} ${moneyUnit()}）`),
    });
    // the edit form follows the saved leg until the host changes something
    if (auth.isHost && !this.data.dirty) this.fill(leg);
  },
  fill(l) {
    this.setData({
      form: { type: l.type, name: l.name, description: l.description, address: l.address, map_url: l.map_url, clue_text: l.clue_text, judge_criteria: l.judge_criteria || '', open_time: l.open_time, close_time: l.close_time, detour_a: l.detour_a, detour_b: l.detour_b, can_eliminate: !!l.can_eliminate, eliminate_count: l.eliminate_count ? String(l.eliminate_count) : '' },
      typeIndex: Math.max(0, TYPES.indexOf(l.type)),
      cutoffs: (l.cutoffs || []).map((c) => ({ id: c.id, name: c.name, start: String(c.start_min), interval: String(c.interval_min), cost: c.cost ? String(c.cost) : '' })),
      shop: (l.shop || []).map((s) => ({ itemId: s.item_id, quantity: s.quantity === null ? '' : String(s.quantity), sold: s.sold, index: race.shopItems.findIndex((it) => it.id === s.item_id) })),
      dirty: false,
    });
  },

  // ---- editing (hosts) ----
  touch(patch) { this.setData(Object.assign({ dirty: true }, patch)); },
  onField(e) { this.touch({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  pickType(e) { const i = Number(e.detail.value); this.touch({ typeIndex: i, 'form.type': TYPES[i] }); },
  onElim(e) { this.touch({ 'form.can_eliminate': e.detail.checked, 'form.eliminate_count': e.detail.checked ? this.data.form.eliminate_count : '' }); },
  addCutoff() { this.touch({ cutoffs: this.data.cutoffs.concat([{ id: 0, name: '', start: '0', interval: '0', cost: '' }]) }); },
  removeCutoff(e) { const c = this.data.cutoffs.slice(); c.splice(Number(e.currentTarget.dataset.i), 1); this.touch({ cutoffs: c }); },
  onCutoff(e) { const { i, field } = e.currentTarget.dataset; this.touch({ [`cutoffs[${i}].${field}`]: e.detail.value }); },
  addShopItem() { this.touch({ shop: this.data.shop.concat([{ itemId: '', quantity: '', sold: 0, index: -1 }]) }); },
  removeShopItem(e) { const s = this.data.shop.slice(); s.splice(Number(e.currentTarget.dataset.i), 1); this.touch({ shop: s }); },
  pickShopItem(e) {
    const i = Number(e.currentTarget.dataset.i); const k = Number(e.detail.value); const it = race.shopItems[k];
    // an item can be stocked once per leg
    if (this.data.shop.some((r, j) => j !== i && r.itemId === it.id)) { toast('这件商品已经添加过'); return; }
    this.touch({ [`shop[${i}].itemId`]: it.id, [`shop[${i}].index`]: k });
  },
  onShopQty(e) { this.touch({ [`shop[${Number(e.currentTarget.dataset.i)}].quantity`]: e.detail.value }); },
  async save() {
    const f = this.data.form;
    if (f.can_eliminate && !(Number(f.eliminate_count) >= 1)) { toast('勾选了可淘汰，请填写淘汰队数'); return; }
    const mins = (m) => Math.max(0, Math.round(Number(m) || 0));
    const items = this.data.cutoffs.map((c) => ({ id: c.id || undefined, name: c.name.trim(), start_min: mins(c.start), interval_min: mins(c.interval), cost: Number(c.cost) || 0 }));
    const rows = this.data.shop.filter((r) => r.itemId !== '');
    if (rows.some((r) => r.quantity !== '' && !(Number.isInteger(Number(r.quantity)) && Number(r.quantity) >= 0))) { toast('商品数量必须是非负整数，留空表示不限'); return; }
    const shopItems = rows.map((r) => ({ item_id: r.itemId, quantity: r.quantity === '' ? null : Number(r.quantity) }));
    try {
      await api(`/legs/${this.legId}`, { method: 'PUT', body: Object.assign({}, f, { eliminate_count: f.eliminate_count === '' ? '' : Number(f.eliminate_count) }) });
      if (this.data.editable) await api(`/legs/${this.legId}/cutoffs`, { method: 'PUT', body: { items } });
      if (this.data.editable && this.data.isCoin) await api(`/legs/${this.legId}/shop`, { method: 'PUT', body: { items: shopItems } });
      this.setData({ dirty: false });
      await race.loadEpisodes();
      toast('环节已保存');
    } catch (err) { toast(err.message); }
  },

  copyMap() { const url = this.data.info.mapUrl; if (url) wx.setClipboardData({ data: url, success: () => toast('地图链接已复制') }); },

  // ---- attachments ----
  openAttachment(e) {
    const a = this.data.attachments.find((x) => x.id === e.currentTarget.dataset.id); if (!a) return;
    wx.showLoading({ title: '打开中' });
    wx.downloadFile({
      url: serverUrl(a.url), header: authHeader(),
      success: (r) => {
        wx.hideLoading();
        if (r.statusCode !== 200) { toast('打开失败'); return; }
        if ((a.mime || '').startsWith('image/')) wx.previewImage({ urls: [r.tempFilePath], current: r.tempFilePath });
        else wx.openDocument({ filePath: r.tempFilePath, showMenu: true, fail: () => toast('无法打开此文件') });
      },
      fail: () => { wx.hideLoading(); toast('网络连接失败'); },
    });
  },
  upload() {
    wx.showActionSheet({
      itemList: ['图片（相册或拍照）', 'PDF（从微信聊天选择）'],
      success: (r) => {
        if (r.tapIndex === 0) wx.chooseMedia({ count: 1, mediaType: ['image'], success: (m) => this.send(m.tempFiles[0].tempFilePath, m.tempFiles[0].size) });
        else wx.chooseMessageFile({ count: 1, type: 'file', extension: ['pdf'], success: (m) => this.send(m.tempFiles[0].path, m.tempFiles[0].size) });
      },
    });
  },
  send(path, size) {
    if (size > 10 * 1024 * 1024) { toast('文件过大，请压缩至 10MB 以内'); return; }
    this.setData({ uploading: true });
    wx.uploadFile({
      url: apiUrl(`/legs/${this.legId}/attachments`), filePath: path, name: 'file', header: authHeader(),
      success: async (r) => {
        if (r.statusCode >= 200 && r.statusCode < 300) { await race.loadEpisodes(); toast('上传成功'); }
        else { let msg = '上传失败'; try { msg = JSON.parse(r.data).error || msg; } catch (e) { /* keep */ } toast(msg); }
      },
      fail: () => toast('网络连接失败'),
      complete: () => this.setData({ uploading: false }),
    });
  },
  async removeAttachment(e) {
    const id = e.currentTarget.dataset.id;
    if (!(await confirm('删除附件', '确定删除该附件？', { danger: true }))) return;
    try { await api(`/attachments/${id}`, { method: 'DELETE' }); await race.loadEpisodes(); } catch (err) { toast(err.message); }
  },
});
