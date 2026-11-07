import type { LegType } from '@/types';

/**
 * Progress table export (.xlsx). The progress page builds the model (same columns and cell texts as the
 * on-screen matrix, plus a current-rank column per leg); this module only turns it into a workbook in the
 * traditional style: leg-coloured headers, plain black-on-white body, durations as real time values with a
 * gradient data bar per column in the leg's colour, and ranks prefixed with an arrow for the change since
 * the previous leg. ExcelJS and JSZip are loaded on demand so they stay out of the main bundle.
 */
export interface ExportGroup { title: string; type: LegType; subs: { label: string; branch?: boolean }[] }
/** hit = a start moved by a twist card or a settlement (red text); ms = a duration (written as a time value with a data bar) */
export interface ExportCell { text: string; hit?: boolean; ms?: number }
/** The last cell of every group is the current rank on that leg */
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
function hexToRgb(hex: string) { const h = hex.replace('#', ''); return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; }
/** An ARGB colour mixed toward white */
function tint(argbHex: string, keep: number): string {
  return 'FF' + [2, 4, 6].map((i) => Math.round(255 - (255 - parseInt(argbHex.slice(i, i + 2), 16)) * keep).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Spreadsheet column letters for a 1-based index */
function colName(n: number): string { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

const HIT_FG = 'FFD93025'; // start time moved by a twist card or a settlement
const HEAD_BG = 'FFF1F3F4';
const SUB_FG = 'FF5F6368';
const LINE = 'FFDADCE0';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Duration cells hold the time (days); shown like the page: "x m" under an hour, otherwise "x h x m" */
const DUR_FMT = '[<0.0416666666666667][m]" m";[h]" h "m" m"';
/** Arrow for the rank change since the previous leg (rich text: palette colours in number formats differ between apps) */
const RANK_ARROW = { up: { text: '↑', argb: 'FF188038' }, down: { text: '↓', argb: 'FFD93025' }, same: { text: '→', argb: 'FF80868B' } };

export async function exportProgressXlsx(model: ExportModel, fileName: string) {
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import('exceljs'), import('jszip')]);
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

  // Body: black on white. Duration columns are collected for their data bars (with the group, for the colour)
  const barCols = new Map<number, number>();
  model.rows.forEach((r, ri) => {
    const row = ri + 3;
    const tc = ws.getCell(row, 1);
    tc.value = r.label;
    tc.font = { ...font, bold: true };
    let prevRank: number | null = null;
    r.groups.forEach((cells, gi) => {
      cells.forEach((cell, i) => {
        const c = ws.getCell(row, groupStart[gi]! + i);
        c.font = { ...font, color: { argb: cell.hit ? HIT_FG : 'FF000000' } };
        if (cell.ms !== undefined) {
          c.value = Math.max(0, cell.ms) / 86400000;
          c.numFmt = DUR_FMT;
          barCols.set(groupStart[gi]! + i, gi);
        } else if (i === cells.length - 1 && /^\d+$/.test(cell.text)) {
          // current rank: lower is better, so a smaller number than on the previous leg is a rise
          const rank = Number(cell.text);
          const arrow = prevRank === null ? null : RANK_ARROW[rank < prevRank ? 'up' : rank > prevRank ? 'down' : 'same'];
          c.value = arrow ? { richText: [{ text: `${arrow.text} `, font: { ...font, bold: true, color: { argb: arrow.argb } } }, { text: String(rank), font: { ...font, color: { argb: 'FF000000' } } }] } : rank;
          prevRank = rank;
        } else c.value = /^\d+$/.test(cell.text) ? Number(cell.text) : cell.text;
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

  const buf = await wb.xlsx.writeBuffer();
  const bars = [...barCols].map(([c, gi]) => ({ ref: `${colName(c)}3:${colName(c)}${lastRow}`, color: tint(groupFg[gi]!, 0.75) }));
  const blob = model.rows.length && bars.length ? await addDataBars(JSZip, buf, bars) : new Blob([buf], { type: XLSX_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Gradient data bars from zero to the column's longest, written the way Excel itself does (a 2007 rule plus its 2010
 * extension with the colours). ExcelJS writes the extension without colours or ids, which Excel shows as white / grey bars.
 */
async function addDataBars(JSZip: typeof import('jszip'), buf: ArrayBuffer, bars: { ref: string; color: string }[]): Promise<Blob> {
  const zip = await JSZip.loadAsync(buf);
  const path = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(path)!.async('string');
  const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
  const rules = bars.map((b, i) => ({ ...b, id: `{${crypto.randomUUID().toUpperCase()}}`, priority: i + 1 }));
  const main = rules.map((b) =>
    `<conditionalFormatting sqref="${b.ref}"><cfRule type="dataBar" priority="${b.priority}"><dataBar><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="${b.color}"/></dataBar>`
    + `<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="${X14}"><x14:id>${b.id}</x14:id></ext></extLst></cfRule></conditionalFormatting>`).join('');
  const ext = `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${X14}"><x14:conditionalFormattings>${rules.map((b) =>
    `<x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:cfRule type="dataBar" id="${b.id}">`
    + `<x14:dataBar minLength="0" maxLength="100" border="1" negativeBarBorderColorSameAsPositive="0"><x14:cfvo type="num"><xm:f>0</xm:f></x14:cfvo><x14:cfvo type="max"/>`
    + `<x14:borderColor rgb="${b.color}"/><x14:negativeFillColor rgb="FFFF0000"/><x14:negativeBorderColor rgb="FFFF0000"/><x14:axisColor rgb="FF000000"/></x14:dataBar>`
    + `</x14:cfRule><xm:sqref>${b.ref}</xm:sqref></x14:conditionalFormatting>`).join('')}</x14:conditionalFormattings></ext></extLst>`;
  // schema order: conditional formats come before validations / hyperlinks / print settings; the extension list is last
  const at = xml.search(/<(dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter)[\s>/]|<\/worksheet>/);
  xml = xml.slice(0, at) + main + xml.slice(at);
  xml = xml.replace('</worksheet>', `${ext}</worksheet>`);
  zip.file(path, xml);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: XLSX_TYPE });
}
