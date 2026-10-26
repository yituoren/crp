import type { Directive } from 'vue';

/**
 * v-mobile-table: stamps every cell with data-label taken from the header text so the phone
 * stylesheet can render each row as a "label: value" card (used for log tables).
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
