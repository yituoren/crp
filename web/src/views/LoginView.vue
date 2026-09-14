<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';

const auth = useAuth();
const router = useRouter();
const route = useRoute();
const mode = ref<'login' | 'register'>('login');
const form = reactive({ username: '', password: '', password2: '' });
const msg = ref('');
const busy = ref(false);

async function submit() {
  msg.value = '';
  if (!form.username.trim() || !form.password) { msg.value = '请填写完整信息'; return; }
  if (mode.value === 'register' && form.password !== form.password2) { msg.value = '两次密码不一致'; return; }
  busy.value = true;
  try {
    if (mode.value === 'login') await auth.login(form.username.trim(), form.password);
    else await auth.register(form.username.trim(), form.password);
    router.replace(String(route.query.redirect ?? '/'));
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-box">
      <h2>{{ auth.event.name }}<br /><span style="font-size: 15px; font-weight: 500; color: var(--gray-500)">幕后指挥系统</span></h2>
      <form @submit.prevent="submit">
        <div class="form-group">
          <label>幕后ID</label>
          <input v-model="form.username" autocomplete="username" :placeholder="mode === 'login' ? '请输入你的幕后ID' : 'ID需在主办准入名单中'" />
        </div>
        <div class="form-group">
          <label>{{ mode === 'login' ? '密码' : '设置密码' }}</label>
          <input v-model="form.password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" placeholder="密码" />
        </div>
        <div v-if="mode === 'register'" class="form-group">
          <label>确认密码</label>
          <input v-model="form.password2" type="password" autocomplete="new-password" placeholder="再次输入密码" />
        </div>
        <button class="btn btn-block btn-lg" type="submit" :disabled="busy">{{ mode === 'login' ? '登 录' : '注 册' }}</button>
        <div class="form-error">{{ msg }}</div>
      </form>
      <div style="text-align: center; font-size: 14px">
        <a v-if="mode === 'login'" href="#" @click.prevent="mode = 'register'; msg = ''">还没有账号？立即注册</a>
        <a v-else href="#" @click.prevent="mode = 'login'; msg = ''">已有账号？去登录</a>
      </div>
      <p class="info-text mt-2" style="text-align: center">注册需要主办先把你的ID加入准入名单。忘记密码请联系主办重置。</p>
    </div>
  </div>
</template>
