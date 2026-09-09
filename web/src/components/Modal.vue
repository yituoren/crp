<script setup lang="ts">
defineProps<{ title?: string; small?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" :class="{ 'modal-sm': small }">
      <div class="flex-between mb-2">
        <h3 style="margin: 0">{{ title }}</h3>
        <button class="btn btn-outline btn-sm" @click="emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
