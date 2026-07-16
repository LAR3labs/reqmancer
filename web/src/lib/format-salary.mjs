// Pure JS implementation of formatSalary — no TypeScript types so it can be
// imported directly by both inbox.ts (which re-exports it) and by
// test-salary-format.mjs (which can't import .ts without a runner).
// Same single-source-of-truth pattern as clean-chips.mjs.

// Currency symbols for the handful of codes the scanners actually emit; anything
// else keeps its ISO code as a suffix ("120000-160000 CHF" → "120k–160k CHF").
const CURRENCY_SYMBOL = { USD: "$", EUR: "€", GBP: "£" };

/** One number of annual comp → compact display ("240570" → "241k"). Values under
 *  1000 (hourly rates, malformed data) keep their original token verbatim — not
 *  String(Number): "85.50" must stay "85.50", not become "85.5" — rather than
 *  rounding to "0k"; values at 1M+ scale to "M" with one decimal, trailing .0
 *  dropped ("1200000" → "1.2M") rather than stacking up as an unreadable "1200k".
 *  @param {number} n
 *  @param {string} token the raw matched digits, preserved below 1000
 *  @returns {string}
 */
function compactAmount(n, token) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : token;
}

/** Format the pipeline row's raw compensation cell (canonical `min-max CUR` /
 *  `value CUR` — see formatCompensation in scan.mjs) into a compact display
 *  string ("240570-297000 USD" → "$241k–$297k"). A non-empty cell that doesn't
 *  parse (hand-pasted rows aren't canonical) passes through verbatim — showing
 *  the user's own text beats hiding it. Empty/absent → null (caller shows N/A).
 *  @param {string | undefined} compensation
 *  @returns {string | null}
 */
export function formatSalary(compensation) {
  const raw = compensation?.trim();
  if (!raw) return null;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*([A-Za-z]{3})?$/);
  if (!m) return raw;
  let lo = Number(m[1]);
  let hi = m[2] ? Number(m[2]) : null;
  // Raw tokens travel with their parsed values so the sub-1000 verbatim branch
  // can render exactly what the row said ("85.50", leading zeroes and all).
  let loTok = m[1];
  let hiTok = m[2] ?? "";
  // Hand-typed rows sometimes reverse the bounds ("160000-120000") — render the
  // range ascending regardless, because "$160k–$120k" reads as a data bug.
  if (hi != null && hi < lo) {
    [lo, hi] = [hi, lo];
    [loTok, hiTok] = [hiTok, loTok];
  }
  const code = (m[3] || "").toUpperCase();
  const symbol = CURRENCY_SYMBOL[code];
  const prefix = symbol ?? "";
  const range =
    hi != null && hi !== lo
      ? `${prefix}${compactAmount(lo, loTok)}–${prefix}${compactAmount(hi, hiTok)}`
      : `${prefix}${compactAmount(lo, loTok)}`;
  return symbol || !code ? range : `${range} ${code}`;
}
