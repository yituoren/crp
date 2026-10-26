import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles.css';
import './mobile.css';
import { mobileTable } from './directives/mobileTable';
import Icon from './components/Icon.vue';
import MSelect from './components/MSelect.vue';

createApp(App).use(createPinia()).use(router).component('Icon', Icon).component('MSelect', MSelect).directive('mobile-table', mobileTable).mount('#app');

// With "desktop site" enabled, phone browsers ignore the viewport and lay out at about 980px, so everything looks tiny.
// When the layout width is clearly larger than the device width, re-declare the viewport and tell the user to turn desktop mode off.
function checkDesktopMode() {
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const device = Math.min(screen.width, screen.height);
  if (!touch || !device || device > 600) return;
  if (window.innerWidth <= device * 1.25) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5, viewport-fit=cover');
  setTimeout(() => {
    if (window.innerWidth <= device * 1.25) return;
    const tip = document.createElement('div');
    tip.className = 'desktop-mode-tip';
    tip.innerHTML = '当前浏览器以“桌面版网站”模式打开，页面会显得很小。请在浏览器菜单里关闭“桌面版网站”后刷新。<button type="button">知道了</button>';
    tip.querySelector('button')!.addEventListener('click', () => tip.remove());
    document.body.appendChild(tip);
  }, 300);
}
checkDesktopMode();
