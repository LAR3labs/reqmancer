// Pure JS implementation of cleanChips — no TypeScript types so it can be
// imported directly by both explore.ts (which re-exports it) and by
// test-clean-chips.mjs (which can't import .ts without a runner).
// This is the single source of truth for the chip-cleaning logic.

const CHIP_CAP = 16;

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
 * the base rather than being added to it. Capping incoming at 16 there would
 * re-truncate the user's own policy on the main request path — the exact bug
 * this all fixes. A high bound protects every caller without that regression.
 */
export function cleanFilterList(v) {
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
    if (out.length >= MAX_FILTER_LIST) break;
  }
  return out;
}

/** cleanFilterList + a hard cap. For UNTRUSTED/ad-hoc chip input (the assistant's
 *  patch path, URL params) where an unbounded list is a DoS-ish footgun. Never
 *  use this on portals.yml-derived policy lists — see cleanFilterList. */
export function cleanChips(v) {
  return cleanFilterList(v).slice(0, CHIP_CAP);
}