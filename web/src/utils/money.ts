export type MoneyMode = 'yuan' | 'coin';
let mode: MoneyMode = 'yuan';
/** 由登录信息设置：经费(元, 两位小数) 或 货币(币, 整数) */
export function setMoneyMode(m: MoneyMode) { mode = m; }
export const moneyMode = () => mode;
export const moneyUnit = () => (mode === 'coin' ? '币' : '元');
export const moneyLabel = () => (mode === 'coin' ? '货币' : '经费');
/** 金额显示：经费固定两位小数，货币整数 */
export function fmtMoney(v: number | null | undefined, sign = false): string {
  const n = Number(v ?? 0);
  const s = mode === 'coin' ? String(Math.round(Math.abs(n))) : Math.abs(n).toFixed(2);
  if (sign) return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
  return (n < 0 ? '-' : '') + s;
}
/** 校验金额输入：正数；经费最多两位小数，货币必须整数 */
export function parseMoney(raw: string | number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (mode === 'coin') return Number.isInteger(n) ? n : null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
  return Math.round(n * 100) / 100;
}
