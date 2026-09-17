export type Role = 'admin' | 'host' | 'crew';
export const ROLE_LABEL: Record<Role, string> = { admin: '管理员', host: '主办', crew: '幕后' };
export interface User { id: number; username: string; displayName: string; role: Role; disabled?: number }
export interface EventInfo { name: string; hosts: string[]; teamSize: number; currencyMode: 'yuan' | 'coin' }

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FF', 'Union', 'Shuffle', 'UT', 'YD', 'SB', 'FO', 'Trap', 'PS'] as const;
export type LegType = (typeof LEG_TYPES)[number];
export type RecordMode = 'none' | 'single' | 'full';
/** 类型缩写的显示文字：SL 显示为 Starting Line，其余用缩写 */
export const typeCode = (t: LegType): string => (t === 'SL' ? 'Starting Line' : t);
export const LEG_TYPE_LABEL: Record<LegType, string> = {
  SL: '起跑线', RI: '路线信息', TI: '任务点', DT: '绕道', RB: '路障', FF: '快进/捷径', Union: '联合', Shuffle: '洗牌', UT: '回转点', YD: '让路点', SB: '减速带', FO: '对抗', Trap: '陷阱', PS: '中继站',
};
export const TYPE_DEFAULTS: Record<LegType, { staff: boolean; mode: RecordMode }> = {
  SL: { staff: true, mode: 'full' }, RI: { staff: false, mode: 'full' }, TI: { staff: true, mode: 'full' }, DT: { staff: true, mode: 'full' },
  RB: { staff: true, mode: 'full' }, FF: { staff: true, mode: 'full' }, Union: { staff: true, mode: 'full' }, Shuffle: { staff: true, mode: 'full' }, UT: { staff: true, mode: 'full' },
  YD: { staff: true, mode: 'full' }, SB: { staff: true, mode: 'full' }, FO: { staff: true, mode: 'full' }, Trap: { staff: true, mode: 'full' }, PS: { staff: true, mode: 'full' },
};
/** 每个环节只手动记一次“结束”时间，按类型叫法不同：起跑线=出发，路线信息=到达，中继站=签到，其余=完成 */
export const END_LABEL: Partial<Record<LegType, string>> = { SL: '出发', RI: '到达', PS: '签到' };
export const endLabel = (t: LegType) => END_LABEL[t] ?? '完成';
/** 首个环节（起跑线）没有开始时间 */
export const hasStart = (t: LegType) => t !== 'SL';
/** 路线信息和中继站的“名称”栏填的是目的地：RI 显示时自动加箭头，PS 直接显示 */
export const isDestinationLeg = (t: LegType) => t === 'RI' || t === 'PS';
/** 类型名：中继站在最后一个赛段里叫“终点” */
export const legTypeLabel = (t: LegType, lastEpisode: boolean) => (t === 'PS' && lastEpisode ? '终点' : LEG_TYPE_LABEL[t]);
export const legName = (l: { type: LegType; name: string }) => (l.type === 'RI' ? `→ ${l.name}` : l.name);
export const RECORD_MODE_LABEL: Record<RecordMode, string> = { none: '不记录时间', single: '只记一次（出发/打卡/签到）', full: '记开始与完成' };

export interface Attachment { id: number; leg_id: number; filename: string; mime: string; size: number; url: string; created_at: string }
export interface Leg {
  id: number; episode_id: number; sort: number; type: LegType; name: string; description: string; address: string; map_url: string;
  clue_text: string; judge_criteria: string; open_time: string; close_time: string; detour_a: string; detour_b: string; needs_staff: number; record_mode: RecordMode; cutoff_start: number; cutoff_interval: number; attachments: Attachment[];
}
export interface Episode { id: number; code: string; name: string; budget: number; sort: number; status: 'pending' | 'running' | 'finished'; notes: string; started_at: string | null; finished_at: string | null; legs: Leg[] }
export interface Team { id: number; code: string; name: string; members: string[]; label: string; status: 'alive' | 'eliminated' | 'withdrawn'; currency: number; sort: number }
export interface Assignment { id: number; episode_id: number; user_id: number; role: 'follow' | 'station' | 'live'; team_id: number | null; leg_id: number | null; leg_ids: number[]; leg_names: string[]; username: string; display_name: string; team_name: string | null }
export interface Progress {
  id: number; episode_id: number; team_id: number; leg_id: number; arrived_at: string | null; completed_at: string | null;
  detour_choice: string | null; roadblock_by: string | null; ff_result: 'success' | 'fail' | null; target_team_id: number | null; note: string; recorded_by: number | null; updated_at: string;
}
export interface Penalty { id: number; episode_id: number; team_id: number; team_name: string; minutes: number; reason: string; applied_at: string; applied_by: number | null; applied_by_name: string | null; reverted: number; reverts_id: number | null; leg_id: number | null; leg_name: string | null }
export interface PitstopRow {
  team_id: number; team_code: string; team_name: string; team_status: Team['status']; checkin_at: string | null; checkin_source: 'manual' | 'progress' | null;
  penalty_minutes: number; final_time: string | null; rank: number | null; eliminated: boolean; note: string;
}
export interface LedgerEntry { id: number; episode_id: number | null; episode_code: string | null; team_id: number; team_name: string; team_code: string; delta: number; balance_after: number; reason: string; operator_id: number | null; operator_name: string; created_at: string; reverted: number; reverts_id: number | null; leg_id: number | null; leg_name: string | null }
export interface Announcement { id: number; content: string; level: 'info' | 'warning' | 'urgent'; created_by: string; created_at: string; pinned_at: string | null; audience: string }
