export type MoneyMode = 'yuan' | 'coin';
let mode: MoneyMode = 'yuan';
/** Set from the event info: cash (yuan, 2 decimals) or coins (integers) */
export function setMoneyMode(m: MoneyMode) { mode = m; }
export const moneyMode = () => mode;
export const moneyUnit = () => (mode === 'coin' ? '币' : '元');
export const moneyLabel = () => (mode === 'coin' ? '货币' : '经费');
/** Money formatting: cash with 2 decimals, coins as integers */
export function fmtMoney(v: number | null | undefined, sign = false): string {
  const n = Number(v ?? 0);
  const s = mode === 'coin' ? String(Math.round(Math.abs(n))) : Math.abs(n).toFixed(2);
  if (sign) return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
  return (n < 0 ? '-' : '') + s;
}
/** Validate a money input: positive; cash up to 2 decimals, coins integers */
export function parseMoney(raw: string | number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (mode === 'coin') return Number.isInteger(n) ? n : null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
  return Math.round(n * 100) / 100;
}
