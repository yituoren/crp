// Types for globally registered components (app.component in main.ts)
import Icon from './components/Icon.vue';
import MSelect from './components/MSelect.vue';

declare module 'vue' {
  export interface GlobalComponents { Icon: typeof Icon; MSelect: typeof MSelect }
}

export {};
