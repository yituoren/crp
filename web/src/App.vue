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

  <!-- 提示条 -->
  <div class="toast-container">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="'toast-' + t.type">{{ t.text }}</div>
  </div>
</template>
