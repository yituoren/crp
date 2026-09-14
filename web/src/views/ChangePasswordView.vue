<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { useUi } from '@/stores/ui';

const ui = useUi();
const router = useRouter();
const form = reactive({ oldPassword: '', newPassword: '', newPassword2: '' });
const msg = ref('');

async function submit() {
  msg.value = '';
  if (form.newPassword !== form.newPassword2) { msg.value = '两次新密码不一致'; return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: { oldPassword: form.oldPassword, newPassword: form.newPassword } });
    ui.toast('密码修改成功');
    router.replace('/');
  } catch (e) { msg.value = e instanceof Error ? e.message : String(e); }
}
</script>

<template>
  <div class="card" style="max-width: 420px; margin: 0 auto">
    <div class="card-header">修改密码</div>
    <form @submit.prevent="submit">
      <div class="form-group"><label>当前密码</label><input v-model="form.oldPassword" type="password" autocomplete="current-password" /></div>
      <div class="form-group"><label>新密码</label><input v-model="form.newPassword" type="password" autocomplete="new-password" /></div>
      <div class="form-group"><label>确认新密码</label><input v-model="form.newPassword2" type="password" autocomplete="new-password" /></div>
      <button class="btn btn-block" type="submit">修改密码</button>
      <div class="form-error">{{ msg }}</div>
    </form>
  </div>
</template>
