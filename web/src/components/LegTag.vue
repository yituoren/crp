<script setup lang="ts">
import { LEG_TYPE_LABEL, type LegType } from '@/types';
defineProps<{ type: LegType; full?: boolean }>();
</script>

<template>
  <span class="tag" :class="'tag-' + type" :title="LEG_TYPE_LABEL[type]">{{ type }}<template v-if="full"> · {{ LEG_TYPE_LABEL[type] }}</template></span>
</template>
