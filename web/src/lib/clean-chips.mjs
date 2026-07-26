// Pure JS implementation of cleanChips — no TypeScript types so it can be
// imported directly by both explore.ts (which re-exports it) and by
// test-clean-chips.mjs (which can't import .ts without a runner).
// This is the single source of truth for the chip-cleaning logic.

const CHIP_CAP = 16;

/**
 * Trim, drop empties, de-dupe case-insensitively. NO length cap.
 *
 * Use this for lists that came from the user's own portals.yml — a location
 * block list is a POLICY, and silently truncating it turns "don't show me roles
 * in Japan" into a role in Japan on screen. The core (scan.mjs
 * ::normalizeKeywordList) has never capped, so capping here also broke parity
 * between an in-app scan and `node scan.mjs`.
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
  }
  return out;
}

/** cleanFilterList + a hard cap. For UNTRUSTED/ad-hoc chip input (the assistant's
 *  patch path, URL params) where an unbounded list is a DoS-ish footgun. Never
 *  use this on portals.yml-derived policy lists — see cleanFilterList. */
export function cleanChips(v) {
  return cleanFilterList(v).slice(0, CHIP_CAP);
}