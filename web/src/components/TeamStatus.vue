<script setup lang="ts">
import type { Team } from '@/types';
defineProps<{ status: Team['status'] }>();
const label: Record<Team['status'], string> = { alive: '存活', eliminated: '已淘汰', withdrawn: '已退赛' };
</script>

<template>
  <span :class="'status-' + status">{{ label[status] }}</span>
</template>
