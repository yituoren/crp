import { defineStore } from 'pinia';
import { ref } from 'vue';

interface ToastItem { id: number; text: string; type: 'success' | 'error' | 'info' }
interface ConfirmState { title: string; message: string; okText: string; danger: boolean; resolve: (v: boolean) => void }
interface TimeState { title: string; message: string; value: string; resolve: (v: string | null) => void }

export const useUi = defineStore('ui', () => {
  const toasts = ref<ToastItem[]>([]);
  const confirmState = ref<ConfirmState | null>(null);
  const timeState = ref<TimeState | null>(null);
  const online = ref(true);
  let seq = 0;

  function toast(text: string, type: ToastItem['type'] = 'success') {
    const id = ++seq;
    toasts.value.push({ id, text, type });
    setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 2800);
  }
  function error(e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  }
  function confirm(title: string, message: string, opts: { okText?: string; danger?: boolean } = {}) {
    return new Promise<boolean>((resolve) => {
      confirmState.value = { title, message, okText: opts.okText ?? '确认', danger: opts.danger ?? false, resolve };
    });
  }
  function closeConfirm(v: boolean) {
    confirmState.value?.resolve(v);
    confirmState.value = null;
  }
  /** 弹出时间表单，返回 datetime-local 字符串；取消返回 null */
  function askTime(title: string, message: string, defaultValue: string) {
    return new Promise<string | null>((resolve) => { timeState.value = { title, message, value: defaultValue, resolve }; });
  }
  function closeTime(ok: boolean) {
    timeState.value?.resolve(ok ? timeState.value.value : null);
    timeState.value = null;
  }
  return { toasts, confirmState, timeState, online, toast, error, confirm, closeConfirm, askTime, closeTime };
});
