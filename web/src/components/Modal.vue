<script setup lang="ts">
defineProps<{ title?: string; small?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" :class="{ 'modal-sm': small }">
      <h3 class="modal-title">{{ title }}</h3>
      <slot />
    </div>
  </div>
  </Teleport>
</template>
