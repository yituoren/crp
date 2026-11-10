// Money: cash (yuan, 2 decimals) or coins (integers), set from the event info (web/src/utils/money.ts)
let mode = 'yuan';
function setMoneyMode(m) { mode = m === 'coin' ? 'coin' : 'yuan'; }
const moneyMode = () => mode;
const moneyUnit = () => (mode === 'coin' ? '币' : '元');
const moneyLabel = () => (mode === 'coin' ? '货币' : '经费');
function fmtMoney(v, sign) {
  const n = Number(v || 0);
  const s = mode === 'coin' ? String(Math.round(Math.abs(n))) : Math.abs(n).toFixed(2);
  if (sign) return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
  return (n < 0 ? '-' : '') + s;
}
/** A money input: positive; cash up to 2 decimals, coins integers; null when invalid */
function parseMoney(raw) {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return null;
  if (mode === 'coin') return Number.isInteger(n) ? n : null;
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
  return Math.round(n * 100) / 100;
}

module.exports = { setMoneyMode, moneyMode, moneyUnit, moneyLabel, fmtMoney, parseMoney };
