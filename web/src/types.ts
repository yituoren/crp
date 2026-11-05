export type Role = 'admin' | 'host' | 'crew';
export const ROLE_LABEL: Record<Role, string> = { admin: '管理员', host: '主办', crew: '幕后' };
export interface User { id: number; username: string; displayName: string; role: Role; disabled?: number; createdAt?: string | null }
export interface EventInfo { id: number; hash: string; name: string; teamSize: number; currencyMode: 'yuan' | 'coin'; rbGap: number; inviteCode?: string; ownerId: number | null; myRole: 'admin' | 'host' | 'crew' }
export interface EventSummary { id: number; hash: string; name: string; joined: boolean; pending: boolean; role: 'admin' | 'host' | 'crew'; ownerName: string; memberCount: number; episodeCount: number; status: 'pending' | 'running' | 'finished'; createdAt: string }

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FF', 'Union', 'Shuffle', 'UT', 'YD', 'SB', 'FO', 'Trap', 'SQ', 'PS'] as const;
export type LegType = (typeof LEG_TYPES)[number];
export type RecordMode = 'none' | 'single' | 'full';
/** Display text of a type code: SL shows as Starting Line, others as their code */
export const typeCode = (t: LegType): string => (t === 'SL' ? 'Starting Line' : t);
export const LEG_TYPE_LABEL: Record<LegType, string> = {
  SL: '起跑线', RI: '路线信息', TI: '任务点', DT: '绕道', RB: '路障', FF: '快进/捷径', Union: '联合', Shuffle: '洗牌', UT: '回转点', YD: '让路点', SB: '减速带', FO: '对抗', Trap: '陷阱', SQ: '支线', PS: '中继站',
};
export const TYPE_DEFAULTS: Record<LegType, { staff: boolean; mode: RecordMode }> = {
  SL: { staff: true, mode: 'full' }, RI: { staff: false, mode: 'full' }, TI: { staff: true, mode: 'full' }, DT: { staff: true, mode: 'full' },
  RB: { staff: true, mode: 'full' }, FF: { staff: true, mode: 'full' }, Union: { staff: true, mode: 'full' }, Shuffle: { staff: true, mode: 'full' }, UT: { staff: true, mode: 'full' },
  YD: { staff: true, mode: 'full' }, SB: { staff: true, mode: 'full' }, FO: { staff: true, mode: 'full' }, Trap: { staff: true, mode: 'full' }, SQ: { staff: true, mode: 'full' }, PS: { staff: true, mode: 'full' },
};
/** Each leg records one manual "end" time, named by type: Route Info = arrival, Pit Stop = check-in, others = completion */
export const END_LABEL: Partial<Record<LegType, string>> = { RI: '到达', PS: '签到', SQ: '结束' };
/** Label of the start column: "departure" for the Starting Line (recorded by the departure plan), "start" otherwise */
export const startLabel = (t: LegType) => (t === 'SL' ? '出发' : '开始');
export const endLabel = (t: LegType) => END_LABEL[t] ?? '完成';
/** Whether the leg has a start time */
export const hasStart = (_t: LegType) => true; // every leg has a start and an end time (the Starting Line's start is the departure)
/** Route Info and Pit Stop names are destinations: RI shows an arrow, PS shows the name as is */
export const isDestinationLeg = (t: LegType) => t === 'RI' || t === 'PS';
/** Type label: the pit stop of the last episode is called "finish" */
export const legTypeLabel = (t: LegType, lastEpisode: boolean) => (t === 'PS' && lastEpisode ? '终点' : LEG_TYPE_LABEL[t]);
export const legName = (l: { type: LegType; name: string }) => (l.type === 'RI' ? `→ ${l.name}` : l.name);
export const RECORD_MODE_LABEL: Record<RecordMode, string> = { none: '不记录时间', single: '只记一次（出发/打卡/签到）', full: '记开始与完成' };

export interface Attachment { id: number; leg_id: number; filename: string; mime: string; size: number; url: string; created_at: string }
export interface Leg {
  id: number; episode_id: number; sort: number; type: LegType; name: string; description: string; address: string; map_url: string;
  clue_text: string; judge_criteria: string | null; open_time: string; close_time: string; detour_a: string; detour_b: string; needs_staff: number; record_mode: RecordMode; cutoff_start: number; cutoff_interval: number; shop_open: number; can_eliminate: number; eliminate_count: number; attachments: Attachment[]; cutoffs: Cutoff[]; shop: LegShopItem[]; tips: LegTip[];
}
export interface Episode { id: number; code: string; name: string; budget: number; sort: number; status: 'pending' | 'running' | 'finished'; notes: string; started_at: string | null; finished_at: string | null; start_at: string | null; inherit_rank: number; start_gap_min: number; continuous_wait_min: number | null; legs: Leg[] }
/** label: "number short name" when a short name is set, otherwise full_label ("number A&B") */
export interface Team { id: number; code: string; name: string; members: string[]; short_name: string; label: string; full_label: string; status: 'alive' | 'eliminated' | 'withdrawn'; currency: number; sort: number; rbCounts: Record<string, number>; inventory: { name: string; count: number }[]; eliminated_leg_id: number | null; locked_from_leg_id: number | null }
export interface Assignment { id: number; episode_id: number; user_id: number; role: 'follow' | 'station' | 'live'; team_id: number | null; leg_id: number | null; leg_ids: number[]; leg_names: string[]; username: string; display_name: string; team_name: string | null }
export interface Progress {
  id: number; episode_id: number; team_id: number; leg_id: number; arrived_at: string | null; completed_at: string | null;
  detour_choice: string | null; roadblock_by: string | null; ff_result: 'success' | 'fail' | null; target_team_id: number | null; note: string; recorded_by: number | null; updated_at: string;
}
export interface Penalty { id: number; episode_id: number; team_id: number; team_name: string; minutes: number; reason: string; applied_at: string; applied_by: number | null; applied_by_name: string | null; reverted: number; reverts_id: number | null; leg_id: number | null; leg_name: string | null; kind: 'shop' | 'other'; item_id: number | null; item_name: string | null }
export interface Cutoff { id: number; name: string; start_min: number; interval_min: number; cost: number }
/** A leg's 锦囊 tip: tip text is null for crew who may not see it (only hosts and the leg's station do) */
export interface LegTip { id: number; code: string; tip: string | null }
/** The 锦囊 card ("xx的锦囊卡") is recognised by name */
export const isTipItem = (name: string) => name.includes('锦囊');
/** A twist card effect on one team (see server/src/twist.ts); options = answers the target can still give */
export interface TwistEffect {
  id: number; episode_id: number; item_name: string; source_team_id: number; target_team_id: number | null; leg_id: number | null;
  mode: 'delay_start' | 'hold'; status: 'pending' | 'hit' | 'shielded' | 'reflected' | 'void' | 'cancelled'; wait_min: number;
  wait_from: string | null; wait_until: string | null; reflected_from_id: number | null; decided: number; note: string;
  source_name: string; target_name: string | null; options: { shield: boolean; reflect: boolean };
}
export interface CutoffUse { id: number; episode_id: number; leg_id: number; team_id: number; cutoff_id: number; cutoff_name: string; used_at: string; used_by: number | null; used_by_name: string; ledger_id: number | null }
export interface ShopItem { id: number; name: string; price: number; sort: number; needs_target: number }
/** One item a leg's shop sells: quantity null = unlimited; remaining = quantity minus purchases on this leg */
export interface LegShopItem { id: number; item_id: number; name: string; price: number; quantity: number | null; sold: number; remaining: number | null }
/** "已售 n · 剩 m" / "已售 n · 售罄" / "已售 n · 不限" */
export function stockText(s: LegShopItem) { return `已售 ${s.sold} · ${s.remaining === null ? '不限' : s.remaining === 0 ? '售罄' : `剩 ${s.remaining}`}`; }
export interface PitstopRow {
  team_id: number; team_code: string; team_name: string; team_status: Team['status']; checkin_at: string | null; checkin_source: 'manual' | 'progress' | null;
  penalty_minutes: number; final_time: string | null; rank: number | null; eliminated: boolean; note: string;
}
export interface LedgerEntry { id: number; episode_id: number | null; episode_code: string | null; team_id: number; team_name: string; team_code: string; delta: number; balance_after: number; reason: string; operator_id: number | null; operator_name: string; created_at: string; reverted: number; reverts_id: number | null; leg_id: number | null; leg_name: string | null; kind?: 'shop' | 'cutoff' | 'other' | 'use'; item_name?: string | null }
export interface ItemLogEntry { id: number; episode_id: number | null; team_id: number; team_name: string; leg_id: number | null; leg_name: string | null; item_name: string; delta: number; kind: 'buy' | 'use'; ledger_id: number | null; operator_id: number | null; operator_name: string; created_at: string; reverted: number; reverts_id: number | null; target_team_id: number | null; target_name: string | null; tip_id: number | null; target_label: string | null; tip_text: string | null }
export interface Announcement { effect_id: number | null; id: number; content: string; level: 'info' | 'warning' | 'urgent'; created_by: string; created_at: string; pinned_at: string | null; audience: string; author_id: number | null }
