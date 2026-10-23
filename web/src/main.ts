import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles.css';
import Icon from './components/Icon.vue';
import MSelect from './components/MSelect.vue';

createApp(App).use(createPinia()).use(router).component('Icon', Icon).component('MSelect', MSelect).mount('#app');
