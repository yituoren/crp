// Leg types and labels, the same as the website (web/src/types.ts)
const LEG_TYPE_LABEL = {
  SL: '起跑线', RI: '路线信息', TI: '任务点', DT: '绕道', RB: '路障', FF: '快进/捷径', Union: '联合', Shuffle: '洗牌', UT: '回转点', YD: '让路点', SB: '减速带', FO: '对抗', Trap: '陷阱', SQ: '支线', PS: '中继站',
};
/** Display text of a type code: SL shows as Starting Line, others as their code */
const typeCode = (t) => (t === 'SL' ? 'Starting Line' : t);
/** Each leg records one manual "end" time, named by type: Route Info = arrival, Pit Stop = check-in, others = completion */
const END_LABEL = { RI: '到达', PS: '签到', SQ: '结束' };
const endLabel = (t) => END_LABEL[t] || '完成';
/** Label of the start column: "departure" for the Starting Line, "start" otherwise */
const startLabel = (t) => (t === 'SL' ? '出发' : '开始');
/** Type label: the pit stop of the last episode is called "finish" */
const legTypeLabel = (t, lastEpisode) => (t === 'PS' && lastEpisode ? '终点' : LEG_TYPE_LABEL[t]);
/** Route Info names are destinations: shown with an arrow */
const legName = (l) => (l.type === 'RI' ? `→ ${l.name}` : l.name);
/** The 锦囊 card is recognised by name */
const isTipItem = (name) => name.includes('锦囊');
/** Twist cards with built-in logic, recognised by name (same rules as server/src/twist.ts) */
function twistKind(name) {
  if (name.includes('飞弹')) return 'missile';
  if (name.includes('回转')) return 'uturn';
  if (name.includes('让路')) return 'yield';
  if (name.includes('让行')) return 'yield_next';
  if (name.includes('决斗')) return 'duel';
  return null;
}
/** Cards whose target team is picked on use */
const isDirectedTwist = (name) => ['uturn', 'yield', 'duel'].includes(twistKind(name) || '') || ['盗窃', '验牌'].some((k) => name.includes(k));
/** "已售 n · 剩 m" / "已售 n · 售罄" / "已售 n · 不限" */
const stockText = (s) => `已售 ${s.sold} · ${s.remaining === null ? '不限' : s.remaining === 0 ? '售罄' : `剩 ${s.remaining}`}`;

module.exports = { LEG_TYPE_LABEL, typeCode, endLabel, startLabel, legTypeLabel, legName, isTipItem, twistKind, isDirectedTwist, stockText };
