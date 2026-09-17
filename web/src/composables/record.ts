import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime, fmtTimeSec, toLocalInput, fromLocalInput } from '@/utils/time';
import { endLabel, legName } from '@/types';

/** 进度记录动作（带确认） */
export function useRecord() {
  const race = useRace();
  const ui = useUi();
  const auth = useAuth();

  async function post(action: string, teamId: number, legId: number, value?: string, at?: string | null) {
    const ep = race.currentEpisode;
    if (!ep) throw new Error('未选择赛段');
    const d = await api('/progress', { method: 'POST', body: { episodeId: ep.id, teamId, legId, action, value, at: at ?? undefined } });
    await race.loadProgress();
    return d;
  }

  /** 弹时间表单（默认服务器当前时间），返回 ISO；取消返回 null */
  async function pickTime(title: string, message: string): Promise<string | null> {
    const v = await ui.askTime(title, message, toLocalInput(auth.serverNow().toISOString()));
    if (v === null) return null;
    const iso = fromLocalInput(v);
    if (!iso) { ui.toast('时间格式无效', 'error'); return null; }
    return iso;
  }

  /** 记录本环节的结束时间（出发/到达/签到/完成）；开始时间由服务端自动接上一个环节 */
  async function complete(teamId: number, legId: number) {
    const team = race.teamById.get(teamId)?.label ?? '';
    const leg = race.legById.get(legId);
    const label = leg ? endLabel(leg.type) : '完成';
    const at = await pickTime(`记录${label}`, `「${team}」在「${leg ? legName(leg) : ''}」${label}。此操作会实时同步给所有幕后。`);
    if (!at) return;
    try {
      const d = await post('complete', teamId, legId, undefined, at);
      const f = leg?.type === 'PS' ? fmtTimeSec : fmtTime;
      ui.toast(d.already ? `已有${label}记录：${f(d.progress.completed_at)}` : `${label}时间已记录：${f(d.progress.completed_at)}`);
    } catch (e) { ui.error(e); }
  }
  async function undo(kind: 'undo_arrive' | 'undo_complete', teamId: number, legId: number) {
    if (!(await ui.confirm('撤销记录', kind === 'undo_arrive' ? '撤销开始记录（完成记录也会一并清除）？' : '撤销完成记录？', { danger: true }))) return;
    try { await post(kind, teamId, legId); ui.toast('已撤销'); } catch (e) { ui.error(e); }
  }
  async function setValue(action: 'detour' | 'roadblock' | 'ff' | 'note' | 'target', teamId: number, legId: number, value: string) {
    try { await post(action, teamId, legId, value); ui.toast('已保存'); } catch (e) { ui.error(e); }
  }
  return { complete, undo, setValue };
}
