export type Role = 'host' | 'crew';
export interface User { id: number; username: string; displayName: string; role: Role; disabled?: number }
export interface EventInfo { name: string; initialCurrency: number; hosts: string[] }

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FO', 'Union', 'Trap', 'PS'] as const;
export type LegType = (typeof LEG_TYPES)[number];
export const LEG_TYPE_LABEL: Record<LegType, string> = {
  SL: '起跑线', RI: '路线信息', TI: '任务点', DT: '绕道', RB: '路障', FO: '快进', Union: '交叉', Trap: '陷阱', PS: '终点',
};

export interface Attachment { id: number; leg_id: number; filename: string; mime: string; size: number; url: string; created_at: string }
export interface Leg {
  id: number; episode_id: number; sort: number; type: LegType; name: string; description: string; address: string; map_url: string;
  clue_text: string; judge_criteria: string; open_time: string; close_time: string; detour_a: string; detour_b: string; attachments: Attachment[];
}
export interface Episode { id: number; code: string; name: string; budget: number; sort: number; status: 'pending' | 'running' | 'finished'; notes: string; legs: Leg[] }
export interface Team { id: number; code: string; name: string; members: string; status: 'alive' | 'eliminated' | 'withdrawn'; currency: number; sort: number }
export interface Assignment { id: number; episode_id: number; user_id: number; role: 'follow' | 'station'; team_id: number | null; leg_id: number | null; username: string; display_name: string; team_name: string | null; leg_name: string | null }
export interface Progress {
  id: number; episode_id: number; team_id: number; leg_id: number; arrived_at: string | null; completed_at: string | null;
  detour_choice: string | null; roadblock_by: string | null; ff_result: 'success' | 'fail' | null; note: string; recorded_by: number | null; updated_at: string;
}
export interface Penalty { id: number; episode_id: number; team_id: number; team_name: string; minutes: number; reason: string; applied_at: string }
export interface PitstopRow {
  team_id: number; team_code: string; team_name: string; team_status: Team['status']; checkin_at: string | null; checkin_source: 'manual' | 'progress' | null;
  penalty_minutes: number; final_time: string | null; rank: number | null; eliminated: boolean; note: string;
}
export interface LedgerEntry { id: number; episode_id: number | null; episode_code: string | null; team_id: number; team_name: string; team_code: string; delta: number; balance_after: number; reason: string; operator_name: string; created_at: string }
export interface Announcement { id: number; content: string; level: 'info' | 'warning' | 'urgent'; created_by: string; created_at: string }
