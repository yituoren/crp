export type Role = 'admin' | 'host' | 'crew';
export const ROLE_LABEL: Record<Role, string> = { admin: '管理员', host: '主办', crew: '幕后' };
export interface User { id: number; username: string; displayName: string; role: Role; disabled?: number }
export interface EventInfo { name: string; hosts: string[] }

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FO', 'Union', 'UT', 'YD', 'SB', 'PK', 'Trap', 'PS'] as const;
export type LegType = (typeof LEG_TYPES)[number];
export type RecordMode = 'none' | 'single' | 'full';
export const LEG_TYPE_LABEL: Record<LegType, string> = {
  SL: '起跑线', RI: '路线信息', TI: '任务点', DT: '绕道', RB: '路障', FO: '快进/捷径', Union: '联合', UT: '回转点', YD: '让路点', SB: '减速带', PK: '对抗/PK', Trap: '陷阱', PS: '中继站/终点',
};
export const LEG_TYPE_HINT: Record<LegType, string> = {
  SL: '赛段出发点，记录出发时间',
  RI: '只指路，不设任务；默认不排站点、不记时间',
  TI: '普通任务，记到达与完成',
  DT: '二选一任务，记选了哪边',
  RB: '只能一人完成，记完成人',
  FO: '全赛程仅一队可用，成功直达终点',
  Union: '两队合并共同完成',
  UT: '回转别队，记打卡与施加对象',
  YD: '让路别队，记打卡与施加对象',
  SB: '给上段末位队伍的额外任务',
  PK: '队伍之间对抗或垫底 PK',
  Trap: '主办自定义的陷阱环节',
  PS: '赛段终点，记签到时间并结算名次',
};
export const TYPE_DEFAULTS: Record<LegType, { staff: boolean; mode: RecordMode }> = {
  SL: { staff: true, mode: 'single' }, RI: { staff: false, mode: 'none' }, TI: { staff: true, mode: 'full' }, DT: { staff: true, mode: 'full' },
  RB: { staff: true, mode: 'full' }, FO: { staff: true, mode: 'full' }, Union: { staff: true, mode: 'full' }, UT: { staff: true, mode: 'single' },
  YD: { staff: true, mode: 'single' }, SB: { staff: true, mode: 'full' }, PK: { staff: true, mode: 'full' }, Trap: { staff: true, mode: 'full' }, PS: { staff: true, mode: 'single' },
};
/** single 模式下按钮/列的文案 */
export const SINGLE_LABEL: Partial<Record<LegType, string>> = { SL: '出发', PS: '签到', UT: '打卡', YD: '打卡' };
export const singleLabel = (t: LegType) => SINGLE_LABEL[t] ?? '打卡';
export const RECORD_MODE_LABEL: Record<RecordMode, string> = { none: '不记录时间', single: '只记一次（出发/打卡/签到）', full: '记到达与完成' };

export interface Attachment { id: number; leg_id: number; filename: string; mime: string; size: number; url: string; created_at: string }
export interface Leg {
  id: number; episode_id: number; sort: number; type: LegType; name: string; description: string; address: string; map_url: string;
  clue_text: string; judge_criteria: string; open_time: string; close_time: string; detour_a: string; detour_b: string; needs_staff: number; record_mode: RecordMode; attachments: Attachment[];
}
export interface Episode { id: number; code: string; name: string; budget: number; sort: number; status: 'pending' | 'running' | 'finished'; notes: string; started_at: string | null; finished_at: string | null; legs: Leg[] }
export interface Team { id: number; code: string; name: string; members: string; status: 'alive' | 'eliminated' | 'withdrawn'; currency: number; sort: number }
export interface Assignment { id: number; episode_id: number; user_id: number; role: 'follow' | 'station'; team_id: number | null; leg_id: number | null; username: string; display_name: string; team_name: string | null; leg_name: string | null }
export interface Progress {
  id: number; episode_id: number; team_id: number; leg_id: number; arrived_at: string | null; completed_at: string | null;
  detour_choice: string | null; roadblock_by: string | null; ff_result: 'success' | 'fail' | null; target_team_id: number | null; note: string; recorded_by: number | null; updated_at: string;
}
export interface Penalty { id: number; episode_id: number; team_id: number; team_name: string; minutes: number; reason: string; applied_at: string; applied_by_name: string | null }
export interface PitstopRow {
  team_id: number; team_code: string; team_name: string; team_status: Team['status']; checkin_at: string | null; checkin_source: 'manual' | 'progress' | null;
  penalty_minutes: number; final_time: string | null; rank: number | null; eliminated: boolean; note: string;
}
export interface LedgerEntry { id: number; episode_id: number | null; episode_code: string | null; team_id: number; team_name: string; team_code: string; delta: number; balance_after: number; reason: string; operator_name: string; created_at: string }
export interface Announcement { id: number; content: string; level: 'info' | 'warning' | 'urgent'; created_by: string; created_at: string }
