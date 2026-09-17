<script setup lang="ts">
import { computed } from 'vue';
import { useRace } from '@/stores/race';
import { legTypeLabel, typeCode, type LegType } from '@/types';
const props = defineProps<{ type: LegType; full?: boolean; episodeId?: number }>();
const race = useRace();
const label = computed(() => legTypeLabel(props.type, race.isLastEpisode(props.episodeId)));
</script>

<template>
  <span class="tag" :class="'tag-' + type" :title="label">{{ typeCode(type) }}<template v-if="full"> · {{ label }}</template></span>
</template>
