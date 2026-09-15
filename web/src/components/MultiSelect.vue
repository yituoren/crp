<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 下拉多选：按钮显示已选摘要，点开后是勾选列表，点击外部关闭
const props = defineProps<{ modelValue: number[]; options: { value: number; label: string }[]; placeholder?: string }>();
const emit = defineEmits<{ 'update:modelValue': [number[]] }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
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
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div ref="root" class="ms">
    <button type="button" class="ms-btn input-sm" :class="{ 'ms-empty': !modelValue.length }" @click="open = !open">
      <span class="ms-text">{{ summary }}</span><span class="ms-caret">▾</span>
    </button>
    <div v-if="open" class="ms-menu">
      <label v-for="o in options" :key="o.value" class="ms-item">
        <input type="checkbox" :checked="modelValue.includes(o.value)" @change="toggle(o.value)" /> {{ o.label }}
      </label>
      <div v-if="!options.length" class="text-xs text-gray" style="padding: 6px 10px">本赛段没有需要站点的环节</div>
    </div>
  </div>
</template>
