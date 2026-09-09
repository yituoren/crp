<script setup lang="ts">
import { useRace } from '@/stores/race';
const race = useRace();
const statusIcon: Record<string, string> = { pending: '', running: '🟢', finished: '✔' };
</script>

<template>
  <div class="ep-selector">
    <button v-for="ep in race.episodes" :key="ep.id" class="ep-btn" :class="{ active: ep.id === race.currentEpisode?.id }" @click="race.selectEpisode(ep.id)">
      {{ ep.code }}<span v-if="statusIcon[ep.status]" class="sub">{{ statusIcon[ep.status] }}</span>
    </button>
  </div>
</template>
