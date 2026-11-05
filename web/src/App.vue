<script setup lang="ts">
import { useUi } from '@/stores/ui';
import { useRace } from '@/stores/race';
import { fmtDateMinute } from '@/utils/time';
const ui = useUi();
const race = useRace();
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
      <h3>发车提醒</h3>
      <div class="popup-anns">
        <div v-for="a in race.popupAnnouncements" :key="a.id" class="alert alert-info">
          <div class="pre">{{ a.content }}</div>
          <div class="text-xs text-gray mt-1">{{ fmtDateMinute(a.created_at) }}</div>
        </div>
      </div>
      <div class="modal-actions"><button class="btn" @click="race.dismissPopup()">知道了</button></div>
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
