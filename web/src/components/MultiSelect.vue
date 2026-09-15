<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 下拉多选：按钮显示已选摘要，点开后是勾选列表，点击外部关闭
const props = defineProps<{ modelValue: number[]; options: { value: number; label: string }[]; placeholder?: string }>();
const emit = defineEmits<{ 'update:modelValue': [number[]] }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
// 菜单用 fixed 定位挂在按钮下方，不受表格滚动容器裁剪；空间不够时向上弹
const menuStyle = ref<Record<string, string>>({});
function place() {
  const btn = root.value?.querySelector('.ms-btn') as HTMLElement | null;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const menuH = Math.min(240, 8 + props.options.length * 30);
  const below = window.innerHeight - r.bottom;
  const top = below >= menuH + 8 || r.top < menuH ? r.bottom + 4 : r.top - menuH - 4;
  menuStyle.value = { position: 'fixed', top: `${top}px`, left: `${r.left}px`, minWidth: `${r.width}px` };
}
function toggleOpen() { open.value = !open.value; if (open.value) place(); }
const summary = computed(() => {
  const names = props.options.filter((o) => props.modelValue.includes(o.value)).map((o) => o.label);
  if (!names.length) return props.placeholder ?? '请选择';
  return names.length <= 2 ? names.join('、') : `${names[0]} 等 ${names.length} 项`;
});
function toggle(v: number) {
  const next = props.modelValue.includes(v) ? props.modelValue.filter((x) => x !== v) : [...props.modelValue, v];
  emit('update:modelValue', next);
}
function onDocClick(e: MouseEvent) { if (root.value && !root.value.contains(e.target as Node)) open.value = false; }
function onScroll() { if (open.value) place(); }
onMounted(() => { document.addEventListener('click', onDocClick); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onScroll); });
onUnmounted(() => { document.removeEventListener('click', onDocClick); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); });
</script>

<template>
  <div ref="root" class="ms">
    <button type="button" class="ms-btn input-sm" :class="{ 'ms-empty': !modelValue.length }" @click="toggleOpen">
      <span class="ms-text">{{ summary }}</span><span class="ms-caret">▾</span>
    </button>
    <div v-if="open" class="ms-menu" :style="menuStyle">
      <label v-for="o in options" :key="o.value" class="ms-item">
        <input type="checkbox" :checked="modelValue.includes(o.value)" @change="toggle(o.value)" /> {{ o.label }}
      </label>
      <div v-if="!options.length" class="text-xs text-gray" style="padding: 6px 10px">本赛段没有需要站点的环节</div>
    </div>
  </div>
</template>
