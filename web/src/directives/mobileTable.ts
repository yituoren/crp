import type { Directive } from 'vue';

/**
 * v-mobile-table：给表格每个单元格打上 data-label（取自表头文字），
 * 手机端样式据此把每一行渲染成“标签：值”的卡片（日志类表格用）。
 */
function label(table: HTMLTableElement) {
  const heads = [...table.querySelectorAll<HTMLTableCellElement>('thead th')].map((th) => th.textContent?.trim() ?? '');
  for (const tr of table.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
    [...tr.cells].forEach((td, i) => { if (heads[i] !== undefined) td.dataset.label = heads[i]; });
  }
}
export const mobileTable: Directive<HTMLTableElement> = {
  mounted(el) { el.classList.add('m-cards'); label(el); },
  updated(el) { label(el); },
};
