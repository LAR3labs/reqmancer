// Pure JS implementation of cleanChips — no TypeScript types so it can be
// imported directly by both explore.ts (which re-exports it) and by
// clean-chips.test.mjs (which can't import .ts without a runner).
// This is the single source of truth for the chip-cleaning logic.

/**
 * Upper bound on a keyword list — a sanity rail against a pathological paste
 * (a whole spreadsheet column, a JSON blob), NOT a limit on how many keywords a
 * search may use.
 *
 * It was 16, which is smaller than the config it has to carry:
 *
 * 1. `templates/portals.example.yml` ships **37** `title_filter.positive`
 *    keywords, so the project's own default could not survive a round-trip
 *    through the Explorer. seedExploreFilters() read 37 and handed the scanner
 *    16, with nothing shown to the user. The CLI reads the same portals.yml and
 *    uses all 37 — so `scan` and the web Explorer silently ran different
 *    searches off one config file.
 *
 * 2. Worse, the cap applied to a MERGE. filter-builder's commit() cleans
 *    `[...existing, ...pasted]`, so on any list already over the cap, adding a
 *    single chip kept the first 16 entries, dropped the other 21, and did not
 *    append the new chip either — a keystroke that deletes data.
 *
 * The bound stays because unbounded is not a property worth having on a value
 * that gets serialized into a YAML file and passed to a scanner; it is just
 * sized to bound the process rather than the user.
 */
export const CHIP_CAP = 512;

// Sanity bound for policy lists. Not a product limit — a guard so an unbounded
// list (a crafted ?noloc= URL, a runaway assistant patch) can't blow up the
// O(list × postings) substring matching downstream. Sized at ~4x the largest
// realistic policy (a 32-country block list): headroom to grow without anyone
// thinking about it, while still tripping early enough to surface a runaway.
// Cost is not the binding constraint — 128 keywords over ~30k postings is a few
// million cheap substring checks — so the bound is chosen to never truncate a
// GENUINE list, which is the whole point of cleanFilterList.
const MAX_FILTER_LIST = 128;

/**
 * Trim, drop empties, de-dupe case-insensitively, bound at MAX_FILTER_LIST.
 *
 * Use this for lists that came from the user's own portals.yml — a location
 * block list is a POLICY, and silently truncating it turns "don't show me roles
 * in Japan" into a role in Japan on screen. The core (scan.mjs
 * ::normalizeKeywordList) has never capped, so capping here also broke parity
 * between an in-app scan and `node scan.mjs`.
 *
 * Why the bound is here and not a cleanChips() call at the untrusted edge:
 * /api/explore parses the UI's filters with merge=false, so `incoming` REPLACES
 * the base rather than being added to it. Any tight cap there would re-truncate
 * the user's own policy on the main request path — the exact bug this all
 * fixes. A bound sized to never truncate a real list protects every caller
 * without that regression.
 */
// Shared loop. `limit` is enforced INSIDE it so each caller's bound is a real
// early exit rather than a slice after the whole input has been cleaned.
function cleanList(v, limit) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const k = item.trim();
    if (!k) continue;
    if (!/[\p{L}\p{N}]/u.test(k)) continue; // drop punctuation-only junk (e.g. a stray "*")
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= limit) break;
  }
  return out;
}

export function cleanFilterList(v) {
  return cleanList(v, MAX_FILTER_LIST);
}

/** cleanList bounded at CHIP_CAP (512). For UNTRUSTED/ad-hoc chip input (the
 *  assistant's patch path, URL params), where an unbounded list is a DoS-ish
 *  footgun. portals.yml-derived policy lists go through cleanFilterList. */
export function cleanChips(v) {
  return cleanList(v, CHIP_CAP);
}
