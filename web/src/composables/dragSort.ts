import { ref } from 'vue';

/**
 * Drag-to-reorder for cards: spread bind(i) onto each card; on drop the callback receives the new index order.
 * - desktop: native HTML5 drag and drop
 * - phones: long-press about 0.35 s to start dragging, release over the target card; swiping before that scrolls as usual
 * Items where canDrag(i) is false can neither be dragged nor dropped onto (e.g. the fixed Starting Line / Pit Stop).
 */
export function useDragSort(opts: { count: () => number; canDrag?: (i: number) => boolean; onReorder: (order: number[]) => void | Promise<void> }) {
  const from = ref<number | null>(null);
  const over = ref<number | null>(null);
  const can = (i: number) => (opts.canDrag ? opts.canDrag(i) : true);
  function finish(target: number | null) {
    const f = from.value;
    from.value = null; over.value = null;
    if (f === null || target === null || f === target || !can(f) || !can(target)) return;
    const order = Array.from({ length: opts.count() }, (_, i) => i);
    order.splice(f, 1);
    order.splice(target, 0, f);
    void opts.onReorder(order);
  }

  // ---- Long-press drag on phones ----
  let pressTimer: number | undefined;
  let startX = 0, startY = 0;
  let touchActive = false;
  const LONG_PRESS = 350, MOVE_TOLERANCE = 8;
  function indexAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest('[data-drag-index]') as HTMLElement | null;
    if (!el) return null;
    const i = Number(el.dataset.dragIndex);
    return Number.isFinite(i) ? i : null;
  }
  function clearPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = undefined; } }
  function onDocTouchMove(e: TouchEvent) {
    const t = e.touches[0]; if (!t) return;
    if (!touchActive) {
      // long press not reached yet: moving past the threshold counts as scrolling, cancel it
      if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) { clearPress(); detach(); }
      return;
    }
    e.preventDefault(); // no page scrolling while dragging
    const i = indexAt(t.clientX, t.clientY);
    over.value = i !== null && can(i) ? i : null;
  }
  function onDocTouchEnd(e: TouchEvent) {
    clearPress();
    if (touchActive) {
      const t = e.changedTouches[0];
      const i = t ? indexAt(t.clientX, t.clientY) : null;
      touchActive = false;
      finish(i ?? over.value);
    }
    detach();
  }
  function detach() {
    document.removeEventListener('touchmove', onDocTouchMove);
    document.removeEventListener('touchend', onDocTouchEnd);
    document.removeEventListener('touchcancel', onDocTouchEnd);
    touchActive = false;
  }
  function onTouchStart(i: number, e: TouchEvent) {
    if (!can(i) || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    startX = t.clientX; startY = t.clientY;
    clearPress();
    pressTimer = window.setTimeout(() => {
      touchActive = true; from.value = i; over.value = i;
      try { navigator.vibrate?.(20); } catch { /* ignore */ }
    }, LONG_PRESS);
    document.addEventListener('touchmove', onDocTouchMove, { passive: false });
    document.addEventListener('touchend', onDocTouchEnd);
    document.addEventListener('touchcancel', onDocTouchEnd);
  }

  function bind(i: number) {
    return {
      draggable: can(i),
      'data-drag-index': i,
      class: { dragging: from.value === i, 'drag-over': over.value === i && from.value !== null && from.value !== i && can(i) },
      onDragstart: (e: DragEvent) => { if (!can(i)) { e.preventDefault(); return; } from.value = i; e.dataTransfer?.setData('text/plain', String(i)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
      onDragover: (e: DragEvent) => { if (from.value === null || !can(i)) return; e.preventDefault(); over.value = i; if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; },
      onDragleave: () => { if (over.value === i) over.value = null; },
      onDrop: (e: DragEvent) => { e.preventDefault(); finish(i); },
      onDragend: () => { from.value = null; over.value = null; },
      onTouchstart: (e: TouchEvent) => onTouchStart(i, e),
      onContextmenu: (e: Event) => { if (touchActive || pressTimer) e.preventDefault(); }, // no context menu during a long press
    };
  }
  return { bind, from, over };
}
