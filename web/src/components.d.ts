// 全局注册的组件类型（main.ts 里 app.component 注册）
import Icon from './components/Icon.vue';
import MSelect from './components/MSelect.vue';

declare module 'vue' {
  export interface GlobalComponents { Icon: typeof Icon; MSelect: typeof MSelect }
}

export {};
