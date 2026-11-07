import type { LegType } from '@/types';

/**
 * Progress table export (.xlsx). The progress page builds the model (same columns and cell texts as the
 * on-screen matrix, plus a current-rank column per leg); this module only turns it into a styled workbook.
 * Durations are real time values with a data bar per column (in the leg's colour); ranks carry a 3-sign icon (green = front).
 * ExcelJS is loaded on demand so it stays out of the main bundle.
 */
export interface ExportGroup { title: string; type: LegType; subs: { label: string; branch?: boolean }[] }
/** kind picks the background (same palette as the page, --mx-* in styles.css); state only colours the text */
export interface ExportCell { text: string; kind: 'time' | 'dur' | 'extra' | 'rank' | 'blank'; state?: 'done' | 'arrived'; hit?: boolean; ms?: number }
export interface ExportRow { label: string; groups: ExportCell[][] }
export interface ExportModel { title: string; groups: ExportGroup[]; rows: ExportRow[] }

/** Leg tag colours come from the stylesheet (.tag-XX), so the export matches the page without a second colour table */
function tagColors(type: LegType): { bg: string; fg: string } {
  const el = document.createElement('span');
  el.className = `tag tag-${type}`;
  el.style.position = 'absolute'; el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const res = { bg: argb(cs.backgroundColor), fg: argb(cs.color) };
  el.remove();
  return res;
}
function argb(css: string): string {
  if (css.startsWith('#')) css = hexToRgb(css);
  const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [0, 0, 0];
  return 'FF' + m.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Column-kind backgrounds are read from the page's --mx-* variables so both stay in sync */
function cssVar(name: string): string { return argb(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#ffffff'); }
function hexToRgb(hex: string) { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; }
// Text colours for record state, as on the page: done = green, running = amber
const DONE_FG = 'FF137333';
const ARRIVED_FG = 'FFB06000';
const HIT_FG = 'FFD93025'; // start time of a leg hit by a twist card
const HEAD_BG = 'FFF1F3F4';
const SUB_FG = 'FF5F6368';
const LINE = 'FFDADCE0';
/** Duration cells hold the time (days); shown like the page: "x m" under an hour, otherwise "x h x m" */
const DUR_FMT = '[<0.0416666666666667][m]" m";[h]" h "m" m"';
/** An ARGB colour mixed toward white (keeps the bar light enough to read the text on it) */
function tint(argbHex: string, keep: number): string {
  return 'FF' + [2, 4, 6].map((i) => Math.round(255 - (255 - parseInt(argbHex.slice(i, i + 2), 16)) * keep).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Spreadsheet column letters for a 1-based index */
function colName(n: number): string { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

export async function exportProgressXlsx(model: ExportModel, fileName: string) {
  const ExcelJS = (await import('exceljs')).default;
  const arrivedFill = cssVar('--mx-arrived');
  const fills = { time: cssVar('--mx-time'), dur: cssVar('--mx-dur'), extra: cssVar('--mx-extra'), rank: cssVar('--mx-rank'), blank: cssVar('--mx-blank'), team: cssVar('--mx-team') };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(model.title.slice(0, 31) || '进度结算', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  const font = { name: 'Microsoft YaHei', size: 10 };
  const thin = { style: 'thin' as const, color: { argb: LINE } };
  const thick = { style: 'medium' as const, color: { argb: 'FFBDC1C6' } };

  // Header rows: team column spans both rows; each leg group is merged over its sub columns
  const teamHead = ws.getCell(1, 1);
  teamHead.value = '队伍';
  ws.mergeCells(1, 1, 2, 1);
  let col = 2;
  const groupStart: number[] = [];
  const groupFg: string[] = [];
  for (const g of model.groups) {
    groupStart.push(col);
    const c = ws.getCell(1, col);
    c.value = g.title;
    const { bg, fg } = tagColors(g.type);
    groupFg.push(fg);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    c.font = { ...font, bold: true, color: { argb: fg } };
    if (g.subs.length > 1) ws.mergeCells(1, col, 1, col + g.subs.length - 1);
    g.subs.forEach((s, i) => {
      const sc = ws.getCell(2, col + i);
      sc.value = s.label;
      sc.font = { ...font, bold: true, color: { argb: SUB_FG }, size: s.branch ? 9 : 10 };
      sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    });
    col += g.subs.length;
  }
  const lastCol = col - 1;
  teamHead.font = { ...font, bold: true, color: { argb: SUB_FG } };
  teamHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };

  // columns that get a data bar (durations) or rank icons, with the leg group they belong to
  const barCols = new Map<number, number>(), rankCols = new Set<number>();
  model.rows.forEach((r, ri) => {
    const row = ri + 3;
    const tc = ws.getCell(row, 1);
    tc.value = r.label;
    tc.font = { ...font, bold: true };
    tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fills.team } };
    r.groups.forEach((cells, gi) => {
      cells.forEach((cell, i) => {
        const c = ws.getCell(row, groupStart[gi]! + i);
        // numbers (ranks, durations) stay numeric so the sheet can be sorted and charted
        if (cell.ms !== undefined) {
          c.value = Math.max(0, cell.ms) / 86400000;
          c.numFmt = DUR_FMT;
          barCols.set(groupStart[gi]! + i, gi);
        } else c.value = /^\d+$/.test(cell.text) ? Number(cell.text) : cell.text;
        if (i === cells.length - 1) rankCols.add(groupStart[gi]! + i); // the rank closes every group
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cell.state === 'arrived' && cell.kind !== 'blank' ? arrivedFill : fills[cell.kind] } };
        const fg = cell.hit ? HIT_FG : cell.state === 'done' ? DONE_FG : cell.state === 'arrived' ? ARRIVED_FG : 'FF202124';
        c.font = { ...font, bold: !!cell.hit, color: { argb: fg } };
      });
    });
  });

  // Alignment, borders (a heavier line before each leg group, like the page), widths
  const lastRow = model.rows.length + 2;
  const starts = new Set(groupStart);
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= lastCol; c++) {
      const cell = ws.getCell(r, c);
      cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
      cell.border = { top: thin, bottom: thin, right: c === 1 ? thick : thin, left: starts.has(c) ? thick : thin };
    }
  }
  ws.getColumn(1).width = Math.max(14, ...model.rows.map((r) => [...r.label].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2));
  for (let c = 2; c <= lastCol; c++) ws.getColumn(c).width = 9;
  ws.getRow(1).height = 22;

  // Conditional formats over the team rows: duration bars from zero to the column's longest; rank signs by thirds
  if (model.rows.length) {
    let priority = 1;
    const range = (c: number) => `${colName(c)}3:${colName(c)}${lastRow}`;
    // solid bars: ExcelJS writes gradient bars with an empty extension id, which Excel may ask to repair
    for (const [c, gi] of barCols) {
      ws.addConditionalFormatting({ ref: range(c), rules: [{ type: 'dataBar', priority: priority++, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: tint(groupFg[gi]!, 0.45) } } as never] });
    }
    for (const c of rankCols) {
      ws.addConditionalFormatting({ ref: range(c), rules: [{ type: 'iconSet', priority: priority++, iconSet: '3Signs', reverse: true, showValue: true, cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }] }] });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
