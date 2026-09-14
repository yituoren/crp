import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime } from '@/utils/time';

/** 进度记录动作（带确认） */
export function useRecord() {
  const race = useRace();
  const ui = useUi();

  async function post(action: string, teamId: number, legId: number, value?: string) {
    const ep = race.currentEpisode;
    if (!ep) throw new Error('未选择赛段');
    const d = await api('/progress', { method: 'POST', body: { episodeId: ep.id, teamId, legId, action, value } });
    await race.loadProgress();
    return d;
  }

  async function arrive(teamId: number, legId: number) {
    const team = race.teamById.get(teamId)?.name ?? '';
    const leg = race.legById.get(legId)?.name ?? '';
    if (!(await ui.confirm('记录到达', `为「${team}」记录到达「${leg}」的时间（以服务器当前时间为准）？\n此操作会实时同步给所有幕后。`))) return;
    try {
      const d = await post('arrive', teamId, legId);
      ui.toast(d.already ? `已有到达记录：${fmtTime(d.progress.arrived_at)}` : `✅ 到达时间已记录：${fmtTime(d.progress.arrived_at)}`);
    } catch (e) { ui.error(e); }
  }
  async function complete(teamId: number, legId: number) {
    const team = race.teamById.get(teamId)?.name ?? '';
    const leg = race.legById.get(legId)?.name ?? '';
    if (!(await ui.confirm('记录完成', `确认「${team}」已完成「${leg}」？将记录服务器当前时间为完成时间。`))) return;
    try {
      const d = await post('complete', teamId, legId);
      ui.toast(d.already ? `已有完成记录：${fmtTime(d.progress.completed_at)}` : `✅ 完成时间已记录：${fmtTime(d.progress.completed_at)}`);
    } catch (e) { ui.error(e); }
  }
  async function single(teamId: number, legId: number, label: string) {
    const team = race.teamById.get(teamId)?.name ?? '';
    const leg = race.legById.get(legId)?.name ?? '';
    if (!(await ui.confirm(`记录${label}`, `为「${team}」记录在「${leg}」的${label}时间（以服务器当前时间为准）？`))) return;
    try {
      const d = await post('single', teamId, legId);
      ui.toast(d.already ? `已有${label}记录：${fmtTime(d.progress.completed_at)}` : `✅ ${label}时间已记录：${fmtTime(d.progress.completed_at)}`);
    } catch (e) { ui.error(e); }
  }
  async function undo(kind: 'undo_arrive' | 'undo_complete', teamId: number, legId: number) {
    if (!(await ui.confirm('撤销记录', kind === 'undo_arrive' ? '撤销到达记录（完成记录也会一并清除）？' : '撤销完成记录？', { danger: true }))) return;
    try { await post(kind, teamId, legId); ui.toast('已撤销'); } catch (e) { ui.error(e); }
  }
  async function setValue(action: 'detour' | 'roadblock' | 'ff' | 'note' | 'target', teamId: number, legId: number, value: string) {
    try { await post(action, teamId, legId, value); ui.toast('已保存'); } catch (e) { ui.error(e); }
  }
  return { arrive, complete, single, undo, setValue };
}
