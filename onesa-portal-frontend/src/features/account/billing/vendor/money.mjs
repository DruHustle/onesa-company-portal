// Stripe charge units, not payout rules or Intl's ISO fraction defaults.
// Source: https://docs.stripe.com/currencies (verified 2026-11-08).
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
// Keep display support explicit; an unverified currency must not be silently rescaled.
const TWO_DECIMAL = new Set(['usd', 'aed', 'ars', 'aud', 'brl', 'cad', 'chf', 'cop', 'czk', 'dkk', 'eur', 'gbp', 'hkd',
  'huf', 'idr', 'ils', 'inr', 'mxn', 'myr', 'nok', 'nzd', 'php', 'pln', 'ron', 'rub', 'sek', 'sgd', 'thb', 'twd', 'zar']);
const WHOLE_WITH_TWO_API_DECIMALS = new Set(['isk', 'ugx']);

export function formatStripeMoney(minor, currency, locale) {
  if (!Number.isSafeInteger(minor) || minor < 0 || typeof currency !== 'string') return null;
  const code = currency.toLowerCase();
  const zero = ZERO_DECIMAL.has(code), special = WHOLE_WITH_TWO_API_DECIMALS.has(code);
  if (!zero && !special && !TWO_DECIMAL.has(code)) return null;
  const units = BigInt(minor), divisor = zero ? 1n : 100n;
  if (special && units % 100n !== 0n) return null;
  const digits = zero || special ? 0 : 2;
  const decimal = (units / divisor).toString() + (digits ? '.' + (units % divisor).toString().padStart(2, '0') : '');
  try {
    // Modern Intl accepts an exact decimal string; no floating-point division loses a minor unit.
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code.toUpperCase(),
      minimumFractionDigits: digits, maximumFractionDigits: digits }).format(decimal);
  } catch { return null; }
}
