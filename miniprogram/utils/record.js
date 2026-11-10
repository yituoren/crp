// Progress actions with confirmation (the website's useRecord composable)
const { api } = require('./api');
const race = require('./race');
const { askTime, toast } = require('./dialogs');
const { endLabel, legName } = require('./types');
const { fmtTime, fmtTimeSec } = require('./time');

async function post(action, teamId, legId, value, at) {
  const ep = race.currentEpisode();
  if (!ep) throw new Error('未选择赛段');
  const d = await api('/progress', { method: 'POST', body: { episodeId: ep.id, teamId, legId, action, value, at: at || undefined } });
  await race.loadProgress();
  return d;
}

/** Record this leg's end time (departure / arrival / check-in / completion); the server chains the start from the previous leg */
async function complete(teamId, legId) {
  const team = (race.teamById.get(teamId) || {}).label || '';
  const leg = race.legById.get(legId);
  const label = leg ? endLabel(leg.type) : '完成';
  const at = await askTime(`记录${label}`, `「${team}」在「${leg ? legName(leg) : ''}」${label}。此操作会实时同步给所有幕后。`);
  if (!at) return;
  try {
    const d = await post('complete', teamId, legId, undefined, at);
    const f = leg && leg.type === 'PS' ? fmtTimeSec : fmtTime;
    toast(d.already ? `已有${label}记录：${f(d.progress.completed_at)}` : `${label}时间已记录：${f(d.progress.completed_at)}`);
  } catch (e) { toast(e.message); }
}

/** Side quest: start = arrive, end = complete; the main leg's clock pauses meanwhile */
async function branch(kind, teamId, legId) {
  const team = (race.teamById.get(teamId) || {}).label || '';
  const leg = race.legById.get(legId);
  const title = kind === 'start' ? '开始支线' : '结束支线';
  const at = await askTime(title, `「${team}」${kind === 'start' ? '进入' : '结束'}支线「${leg ? legName(leg) : ''}」。${kind === 'start' ? '主线计时暂停。' : '主线恢复计时。'}`);
  if (!at) return;
  try {
    const d = await post(kind === 'start' ? 'arrive' : 'complete', teamId, legId, undefined, at);
    toast(`${title}：${fmtTime(kind === 'start' ? d.progress.arrived_at : d.progress.completed_at)}`);
  } catch (e) { toast(e.message); }
}

/** Extra info: detour / roadblock / ff / note / target */
async function setValue(action, teamId, legId, value) {
  try { await post(action, teamId, legId, value); toast('已保存'); } catch (e) { toast(e.message); }
}

module.exports = { complete, branch, setValue };
