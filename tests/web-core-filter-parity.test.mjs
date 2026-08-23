// tests/web-core-filter-parity.test.mjs — the core scanner and the web Explorer
// implement the SAME location policy in two languages. This file guards the seam.
//
// Why it exists: `allow_bare_remote` was added to scan.mjs and portals.yml and
// worked perfectly from the terminal — while all THREE Explore buttons silently
// enforced the stricter old policy. The web path re-implements the filter in
// TypeScript (explore.ts::buildLocationMatcher, for AI/Deep candidates parsed in
// the browser) and separately serializes an EPHEMERAL portals.yml for the
// scanner subprocess (core/portals.ts::serializePortals). A scalar flag rides
// neither the keyword-list loop nor the list serializer, so it vanished at both
// hops with no error anywhere.
//
// Source-level assertions on purpose: the web half is TypeScript and this suite
// is plain ESM, so importing it isn't possible without a TS runner. Checking the
// source still catches the whole drift class — a flag added on one side and
// forgotten on the other.
//
// But the assertions are scoped to FUNCTION BODIES with comments stripped, not
// to whole files. A file-wide grep for `allow_bare_remote` passes on the
// paragraph of prose above the code that explains the flag, so deleting the
// scalar write would have left this suite green — a parity guard that cannot
// fail is worse than none.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Drop block and line comments so prose about a flag can't satisfy a check. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The executable body of a top-level function, comments removed.
 *
 * These source files keep top-level functions at column 0. Match the closing
 * brace at the same indentation so an inner block cannot truncate the check.
 * Throws when the function is gone or no closing brace exists.
 */
function fnBody(src, name) {
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`function ${name} has no top-level closing brace`);
  return stripComments(src.slice(start, end + 2));
}

console.log('\nWeb ↔ core location-filter parity');

try {
  const core = readFileSync(join(ROOT, 'scan.mjs'), 'utf8');
  const web = readFileSync(join(ROOT, 'web/src/lib/explore.ts'), 'utf8');
  const portalsTs = readFileSync(join(ROOT, 'web/src/lib/core/portals.ts'), 'utf8');

  // ── The bare-remote tier exists on both sides ────────────────────────────
  // The DECLARATION, not a mention: both files name BARE_REMOTE_RE in comments
  // that explain the tier, and those would satisfy a bare identifier match.
  const declaresPattern = (src) => /const BARE_REMOTE_RE\s*=/.test(stripComments(src));
  if (declaresPattern(core)) pass('scan.mjs defines the bare-remote pattern');
  else fail('scan.mjs is missing BARE_REMOTE_RE');

  if (declaresPattern(web)) pass('explore.ts mirrors the bare-remote pattern');
  else fail('explore.ts is missing BARE_REMOTE_RE — AI/Deep candidates would use the stricter policy');

  if (/allow_bare_remote/.test(fnBody(core, 'buildLocationFilter'))) pass('scan.mjs reads location_filter.allow_bare_remote');
  else fail('scan.mjs does not read allow_bare_remote');

  if (/allowBareRemote/.test(stripComments(web))) pass('explore.ts carries allowBareRemote through the filter type');
  else fail('explore.ts does not carry allowBareRemote');

  // ── The flag reaches the scanner subprocess ──────────────────────────────
  // serializePortals writes the ephemeral config the in-app Scan runs against.
  // A scalar can't ride the keyword-list helper, so it needs its own line.
  if (/allow_bare_remote/.test(fnBody(portalsTs, 'serializePortals'))) {
    pass('serializePortals emits allow_bare_remote into the ephemeral config');
  } else {
    fail('serializePortals drops allow_bare_remote — the in-app Scan would enforce a STRICTER policy than node scan.mjs');
  }

  if (/allow_bare_remote/.test(fnBody(portalsTs, 'seedExploreFilters'))) pass('seedExploreFilters reads the flag from the real portals.yml');
  else fail('seedExploreFilters never reads allow_bare_remote from portals.yml');

  // ── The flag survives the client → server round-trip ─────────────────────
  if (/allowBareRemote/.test(fnBody(web, 'parseExplorePatch'))) {
    pass('parseExplorePatch preserves allowBareRemote across the round-trip');
  } else {
    fail('parseExplorePatch drops allowBareRemote — every client request would reset it');
  }

  // ── ...and survives the URL codec ────────────────────────────────────────
  // The provider rewrites /explore?<filtersToParams(f)> after every scan, so a
  // flag the codec doesn't carry is lost on the next load and on shared links —
  // silently re-imposing the strict policy the round-trip fix just removed.
  if (/allowBareRemote/.test(fnBody(web, 'filtersToParams'))) pass('filtersToParams writes allowBareRemote to the URL');
  else fail('filtersToParams drops allowBareRemote — the post-scan URL rewrite would reset it on reload');

  if (/allowBareRemote/.test(fnBody(web, 'paramsToFilters'))) pass('paramsToFilters reads allowBareRemote back from the URL');
  else fail('paramsToFilters never reads allowBareRemote — a shared link loses the flag');

  // ── Tier ORDER must match ────────────────────────────────────────────────
  // Both implementations must apply: always_allow → block → bare-remote → allow.
  // If bare-remote were checked BEFORE block, a blocked region could slip past.
  // Scoped to the matcher bodies: over a whole file, an unrelated `block.length`
  // or a commented-out line could satisfy the ordering on its own.
  const order = (src) => {
    const idx = (re) => src.search(re);
    return { block: idx(/block\.(?:length|some)/), bare: idx(/BARE_REMOTE_RE\.test/) };
  };
  for (const [label, src] of [
    ['scan.mjs', fnBody(core, 'buildLocationFilter')],
    ['explore.ts', fnBody(web, 'buildLocationMatcher')],
  ]) {
    const o = order(src);
    if (o.block !== -1 && o.bare !== -1 && o.block < o.bare) {
      pass(`${label} checks the block list BEFORE the bare-remote tier`);
    } else {
      fail(`${label} tier order is wrong (block=${o.block}, bare=${o.bare}) — a blocked region could pass`);
    }
  }
} catch (err) {
  fail(`web/core filter parity test threw — ${err.message}`);
}
