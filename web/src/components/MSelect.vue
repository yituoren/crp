<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import LegTag from './LegTag.vue';
import type { LegType } from '@/types';

// Material-style select: a button plus a floating menu; the menu is fixed-positioned so scroll containers do not clip it, and opens upward when short on space
type Val = string | number | null | undefined;
const props = withDefaults(defineProps<{
  modelValue: Val;
  options: { value: string | number; label: string; disabled?: boolean; tag?: string }[];
  placeholder?: string;
  disabled?: boolean;
  sm?: boolean;
  /** Field variant for use next to inputs or inside forms, aligned with inputs; the default is a Gemini-style borderless grey pill */
  outlined?: boolean;
  /** Search filter chip (Gmail style): thin outline, highlighted when a value is set */
  chip?: boolean;
  title?: string;
}>(), { placeholder: '请选择', disabled: false, sm: false, outlined: false, chip: false });
const emit = defineEmits<{ 'update:modelValue': [string | number]; change: [string | number] }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
const selected = computed(() => props.options.find((o) => String(o.value) === String(props.modelValue ?? '')));
const label = computed(() => selected.value?.label ?? props.placeholder);
const isEmpty = computed(() => !selected.value);

const sheet = () => window.innerWidth <= 760; // phones: the menu becomes a bottom sheet
function place() {
  if (sheet()) { menuStyle.value = {}; return; }
  const btn = root.value?.querySelector('.sel-btn') as HTMLElement | null;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const menuH = Math.min(280, 16 + props.options.length * 36);
  const below = window.innerHeight - r.bottom;
  const top = below >= menuH + 8 || r.top < menuH ? r.bottom + 4 : r.top - menuH - 4;
  menuStyle.value = { position: 'fixed', top: `${top}px`, left: `${r.left}px`, minWidth: `${Math.max(r.width, 120)}px` };
  // measure the menu after render and shift it left when it overflows the right edge
  nextTick(() => { const w = menu.value?.offsetWidth ?? 0; const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); if (left !== r.left) menuStyle.value = { ...menuStyle.value, left: `${left}px` }; });
}
function toggleOpen() { if (props.disabled) return; open.value = !open.value; if (open.value) place(); }
function pick(o: { value: string | number; disabled?: boolean }) {
  if (o.disabled) return;
  open.value = false;
  if (String(o.value) === String(props.modelValue ?? '')) return;
  emit('update:modelValue', o.value);
  emit('change', o.value);
}
const menu = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) { const t = e.target as Node; if (root.value && !root.value.contains(t) && !menu.value?.contains(t)) open.value = false; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false; }
function onScroll() { if (open.value) place(); }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', onScroll); });
onUnmounted(() => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); });
</script>

<template>
  <div ref="root" class="sel" :class="{ 'sel-sm': sm, 'sel-open': open, 'sel-disabled': disabled, 'sel-outlined': outlined, 'sel-chip': chip, 'sel-chip-on': chip && String(modelValue ?? '') !== '' }" :title="title">
    <button type="button" class="sel-btn" :class="{ 'sel-empty': isEmpty }" :disabled="disabled" @click="toggleOpen">
      <span class="sel-text"><LegTag v-if="selected?.tag" :type="selected.tag as LegType" /> {{ label }}</span><Icon name="expand_more" :size="sm ? 18 : 20" class="sel-caret" />
    </button>
    <Teleport to="body"><div v-if="open && sheet()" class="sel-sheet-scrim" @click="open = false"></div><div v-if="open" ref="menu" class="sel-menu" :class="{ 'sel-sheet': sheet() }" :style="sheet() ? { position: 'fixed' } : menuStyle" role="listbox">
      <button v-for="o in options" :key="String(o.value)" type="button" class="sel-item" :class="{ active: String(o.value) === String(modelValue ?? ''), disabled: o.disabled }" role="option" :aria-selected="String(o.value) === String(modelValue ?? '')" @click="pick(o)">
        <span class="sel-item-check"><Icon v-if="String(o.value) === String(modelValue ?? '')" name="check" size="18" /></span><LegTag v-if="o.tag" :type="o.tag as LegType" /> {{ o.label }}
      </button>
      <div v-if="!options.length" class="text-xs text-gray" style="padding: 8px 12px">无可选项</div>
    </div></Teleport>
  </div>
</template>
