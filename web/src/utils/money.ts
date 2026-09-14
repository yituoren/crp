/** 人民币显示：固定两位小数 */
export function fmtMoney(v: number | null | undefined, sign = false): string {
  const n = Number(v ?? 0);
  const s = Math.abs(n).toFixed(2);
  if (sign) return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
  return (n < 0 ? '-' : '') + s;
}
/** 校验金额输入：正数，最多两位小数 */
export function parseMoney(raw: string | number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
  return Math.round(n * 100) / 100;
}
