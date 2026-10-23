import { ref } from 'vue';

/**
 * 卡片拖动换序（HTML5 拖放，电脑端）：把 bind(i) 展开到每张卡片上，松手时回调新的顺序索引数组。
 * canDrag(i) 返回 false 的项不能拖也不能被放到它的位置上（比如固定的起跑线 / 中继站）。
 */
export function useDragSort(opts: { count: () => number; canDrag?: (i: number) => boolean; onReorder: (order: number[]) => void | Promise<void> }) {
  const from = ref<number | null>(null);
  const over = ref<number | null>(null);
  const can = (i: number) => (opts.canDrag ? opts.canDrag(i) : true);
  function finish(target: number) {
    const f = from.value;
    from.value = null; over.value = null;
    if (f === null || f === target || !can(f) || !can(target)) return;
    const order = Array.from({ length: opts.count() }, (_, i) => i);
    order.splice(f, 1);
    order.splice(target, 0, f);
    void opts.onReorder(order);
  }
  function bind(i: number) {
    return {
      draggable: can(i),
      class: { dragging: from.value === i, 'drag-over': over.value === i && from.value !== null && from.value !== i && can(i) },
      onDragstart: (e: DragEvent) => { if (!can(i)) { e.preventDefault(); return; } from.value = i; e.dataTransfer?.setData('text/plain', String(i)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
      onDragover: (e: DragEvent) => { if (from.value === null || !can(i)) return; e.preventDefault(); over.value = i; if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; },
      onDragleave: () => { if (over.value === i) over.value = null; },
      onDrop: (e: DragEvent) => { e.preventDefault(); finish(i); },
      onDragend: () => { from.value = null; over.value = null; },
    };
  }
  return { bind, from, over };
}
