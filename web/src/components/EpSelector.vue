<script setup lang="ts">
import { useRace } from '@/stores/race';
const race = useRace();
// running: green dot; finished: the whole tab turns grey, no symbol

</script>

<template>
  <div class="ep-selector">
    <button v-for="ep in race.episodes" :key="ep.id" class="ep-btn" :class="{ active: ep.id === race.currentEpisode?.id, done: ep.status === 'finished' }" @click="race.selectEpisode(ep.id)">
      {{ ep.code }}<span v-if="ep.status === 'running'" class="ep-dot"></span>
    </button>
    <div v-if="$slots.right" class="ep-selector-right"><slot name="right" /></div>
  </div>
</template>
