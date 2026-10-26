<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import LegTag from './LegTag.vue';
import type { LegType } from '@/types';

// Multi-select: the button shows a summary, opens a checklist, closes on outside click
const props = defineProps<{ modelValue: number[]; options: { value: number; label: string; tag?: string }[]; placeholder?: string }>();
const emit = defineEmits<{ 'update:modelValue': [number[]] }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
// The menu is fixed-positioned under the button so table scroll containers do not clip it; opens upward when short on space
const menuStyle = ref<Record<string, string>>({});
const sheet = () => window.innerWidth <= 760;
function place() {
  if (sheet()) { menuStyle.value = {}; return; }
  const btn = root.value?.querySelector('.ms-btn') as HTMLElement | null;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const menuH = Math.min(240, 8 + props.options.length * 30);
  const below = window.innerHeight - r.bottom;
  const top = below >= menuH + 8 || r.top < menuH ? r.bottom + 4 : r.top - menuH - 4;
  menuStyle.value = { position: 'fixed', top: `${top}px`, left: `${r.left}px`, minWidth: `${r.width}px` };
  nextTick(() => { const w = menu.value?.offsetWidth ?? 0; const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); if (left !== r.left) menuStyle.value = { ...menuStyle.value, left: `${left}px` }; });
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
const menu = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) { const t = e.target as Node; if (root.value && !root.value.contains(t) && !menu.value?.contains(t)) open.value = false; }
function onScroll() { if (open.value) place(); }
onMounted(() => { document.addEventListener('click', onDocClick); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onScroll); });
onUnmounted(() => { document.removeEventListener('click', onDocClick); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); });
</script>

<template>
  <div ref="root" class="ms">
    <button type="button" class="ms-btn input-sm" :class="{ 'ms-empty': !modelValue.length }" @click="toggleOpen">
      <span class="ms-text">{{ summary }}</span><span class="ms-caret"><Icon name="expand_more" size="18" /></span>
    </button>
    <Teleport to="body"><div v-if="open && sheet()" class="sel-sheet-scrim" @click="open = false"></div><div v-if="open" ref="menu" class="ms-menu" :class="{ 'sel-sheet': sheet() }" :style="sheet() ? { position: 'fixed' } : menuStyle">
      <button v-for="o in options" :key="o.value" type="button" class="ms-item" :class="{ on: modelValue.includes(o.value) }" @click="toggle(o.value)">
        <span class="ms-check"><Icon v-if="modelValue.includes(o.value)" name="check" size="14" /></span><LegTag v-if="o.tag" :type="o.tag as LegType" /> {{ o.label }}
      </button>
      <div v-if="!options.length" class="text-xs text-gray" style="padding: 6px 10px">本赛段没有需要站点的环节</div>
    </div></Teleport>
  </div>
</template>
