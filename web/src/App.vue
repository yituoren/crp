<script setup lang="ts">
import { useUi } from '@/stores/ui';
const ui = useUi();
</script>

<template>
  <router-view />

  <!-- 确认对话框 -->
  <div v-if="ui.confirmState" class="modal-overlay" @click.self="ui.closeConfirm(false)">
    <div class="modal modal-sm">
      <h3>{{ ui.confirmState.title }}</h3>
      <p class="text-gray" style="white-space: pre-wrap; line-height: 1.6">{{ ui.confirmState.message }}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" @click="ui.closeConfirm(false)">取消</button>
        <button class="btn" :class="ui.confirmState.danger ? 'btn-danger' : ''" @click="ui.closeConfirm(true)">{{ ui.confirmState.okText }}</button>
      </div>
    </div>
  </div>

  <!-- 记录时间表单 -->
  <div v-if="ui.timeState" class="modal-overlay" @click.self="ui.closeTime(false)">
    <div class="modal modal-sm">
      <h3>{{ ui.timeState.title }}</h3>
      <p class="text-gray" style="white-space: pre-wrap; line-height: 1.6">{{ ui.timeState.message }}</p>
      <div class="form-group">
        <label>记录时间（默认为服务器当前时间，可修改）</label>
        <input v-model="ui.timeState.value" type="datetime-local" step="1" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" @click="ui.closeTime(false)">取消</button>
        <button class="btn" @click="ui.closeTime(true)">确认记录</button>
      </div>
    </div>
  </div>

  <!-- 提示条 -->
  <div class="toast-container">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="'toast-' + t.type">{{ t.text }}</div>
  </div>
</template>
