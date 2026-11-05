<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '@/api';
import { useUi } from '@/stores/ui';
import { useRace } from '@/stores/race';
import { fmtDateMinute } from '@/utils/time';
const ui = useUi();
const race = useRace();
/** A hit notice whose team can still shield or reflect: the pop-up asks before it can be closed */
const effectOf = (effectId: number | null) => (effectId ? race.effects.find((e) => e.id === effectId) ?? null : null);
const asks = (effectId: number | null) => { const e = effectOf(effectId); return !!e && (e.options.shield || e.options.reflect); };
const undecided = computed(() => race.popupAnnouncements.some((a) => asks(a.effect_id)));
const answering = ref(false);
async function answer(effectId: number, ans: 'shield' | 'reflect' | 'accept') {
  const text = { shield: '使用护盾挡下这次作用', reflect: '使用反弹，把作用转给使用者', accept: '不使用护盾或反弹，原地等待' }[ans];
  if (!(await ui.confirm('确认', `${text}？`))) return;
  answering.value = true;
  try { await api(`/effects/${effectId}/answer`, { method: 'POST', body: { answer: ans } }); await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger()]); }
  catch (e) { ui.error(e); } finally { answering.value = false; }
}
</script>

<template>
  <router-view />

  <!-- Confirm dialog -->
  <div v-if="ui.confirmState" class="modal-overlay modal-overlay-top" @click.self="ui.closeConfirm(false)">
    <div class="modal modal-sm">
      <h3>{{ ui.confirmState.title }}</h3>
      <p class="text-gray" style="white-space: pre-wrap; line-height: 1.6">{{ ui.confirmState.message }}</p>
      <div class="modal-actions">
        <button v-if="!ui.confirmState.alert" class="btn btn-text" @click="ui.closeConfirm(false)">取消</button>
        <button class="btn" :class="ui.confirmState.danger ? 'btn-danger' : ''" @click="ui.closeConfirm(true)">{{ ui.confirmState.okText }}</button>
      </div>
    </div>
  </div>

  <!-- System departure notices pop up for the team's follow until acknowledged -->
  <div v-if="race.popupAnnouncements.length" class="modal-overlay">
    <div class="modal modal-sm">
      <h3>系统提醒</h3>
      <div class="popup-anns">
        <div v-for="a in race.popupAnnouncements" :key="a.id" class="alert" :class="a.effect_id ? 'alert-warning' : 'alert-info'">
          <div class="pre">{{ a.content }}</div>
          <div class="text-xs text-gray mt-1">{{ fmtDateMinute(a.created_at) }}</div>
          <div v-if="asks(a.effect_id)" class="popup-answer">
            <span class="text-sm">背包里有可用的卡，是否使用？</span>
            <button v-if="effectOf(a.effect_id)?.options.shield" class="btn btn-tonal btn-sm" :disabled="answering" @click="answer(a.effect_id!, 'shield')">使用护盾</button>
            <button v-if="effectOf(a.effect_id)?.options.reflect" class="btn btn-tonal btn-sm" :disabled="answering" @click="answer(a.effect_id!, 'reflect')">使用反弹</button>
            <button class="btn btn-text btn-sm" :disabled="answering" @click="answer(a.effect_id!, 'accept')">不使用</button>
          </div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn" :disabled="undecided" :title="undecided ? '先选择是否使用护盾 / 反弹' : ''" @click="race.dismissPopup()">知道了</button></div>
    </div>
  </div>

  <!-- Record-time form -->
  <div v-if="ui.timeState" class="modal-overlay" @click.self="ui.closeTime(false)">
    <div class="modal modal-sm">
      <h3>{{ ui.timeState.title }}</h3>
      <p class="text-gray" style="white-space: pre-wrap; line-height: 1.6">{{ ui.timeState.message }}</p>
      <div class="form-group">
        <label>记录时间（默认为服务器当前时间，可修改）</label>
        <input v-model="ui.timeState.value" type="datetime-local" step="1" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-text" @click="ui.closeTime(false)">取消</button>
        <button class="btn" @click="ui.closeTime(true)">确认记录</button>
      </div>
    </div>
  </div>

  <!-- Toasts -->
  <div class="toast-container">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="'toast-' + t.type">{{ t.text }}</div>
  </div>
</template>
