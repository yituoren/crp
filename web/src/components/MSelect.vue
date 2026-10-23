<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

// Material 风格下拉：按钮 + 浮动菜单，菜单 fixed 定位不受滚动容器裁剪；空间不够时向上弹
type Val = string | number | null | undefined;
const props = withDefaults(defineProps<{
  modelValue: Val;
  options: { value: string | number; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  sm?: boolean;
  /** 描边字段样式：放在文本输入框旁边或表单里时用，与输入框对齐；默认是 Gemini 式的无边框灰色胶囊 */
  outlined?: boolean;
  /** 搜索筛选条（Gmail 式）：细边框圆角矩形，选中后高亮 */
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

function place() {
  const btn = root.value?.querySelector('.sel-btn') as HTMLElement | null;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const menuH = Math.min(280, 16 + props.options.length * 36);
  const below = window.innerHeight - r.bottom;
  const top = below >= menuH + 8 || r.top < menuH ? r.bottom + 4 : r.top - menuH - 4;
  menuStyle.value = { position: 'fixed', top: `${top}px`, left: `${r.left}px`, minWidth: `${Math.max(r.width, 120)}px` };
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
      <span class="sel-text">{{ label }}</span><Icon name="expand_more" :size="sm ? 18 : 20" class="sel-caret" />
    </button>
    <Teleport to="body"><div v-if="open" ref="menu" class="sel-menu" :style="menuStyle" role="listbox">
      <button v-for="o in options" :key="String(o.value)" type="button" class="sel-item" :class="{ active: String(o.value) === String(modelValue ?? ''), disabled: o.disabled }" role="option" :aria-selected="String(o.value) === String(modelValue ?? '')" @click="pick(o)">
        <span class="sel-item-check"><Icon v-if="String(o.value) === String(modelValue ?? '')" name="check" size="18" /></span>{{ o.label }}
      </button>
      <div v-if="!options.length" class="text-xs text-gray" style="padding: 8px 12px">无可选项</div>
    </div></Teleport>
  </div>
</template>
