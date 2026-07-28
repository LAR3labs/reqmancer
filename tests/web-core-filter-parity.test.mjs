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
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

console.log('\nWeb ↔ core location-filter parity');

try {
  const core = readFileSync(join(ROOT, 'scan.mjs'), 'utf8');
  const web = readFileSync(join(ROOT, 'web/src/lib/explore.ts'), 'utf8');
  const portalsTs = readFileSync(join(ROOT, 'web/src/lib/core/portals.ts'), 'utf8');

  // ── The bare-remote tier exists on both sides ────────────────────────────
  if (/BARE_REMOTE_RE/.test(core)) pass('scan.mjs defines the bare-remote pattern');
  else fail('scan.mjs is missing BARE_REMOTE_RE');

  if (/BARE_REMOTE_RE/.test(web)) pass('explore.ts mirrors the bare-remote pattern');
  else fail('explore.ts is missing BARE_REMOTE_RE — AI/Deep candidates would use the stricter policy');

  if (/allow_bare_remote/.test(core)) pass('scan.mjs reads location_filter.allow_bare_remote');
  else fail('scan.mjs does not read allow_bare_remote');

  if (/allowBareRemote/.test(web)) pass('explore.ts carries allowBareRemote through the filter type');
  else fail('explore.ts does not carry allowBareRemote');

  // ── The flag reaches the scanner subprocess ──────────────────────────────
  // serializePortals writes the ephemeral config the in-app Scan runs against.
  // A scalar can't ride the keyword-list helper, so it needs its own line.
  if (/allow_bare_remote/.test(portalsTs)) {
    pass('serializePortals emits allow_bare_remote into the ephemeral config');
  } else {
    fail('serializePortals drops allow_bare_remote — the in-app Scan would enforce a STRICTER policy than node scan.mjs');
  }

  if (/lf\.allow_bare_remote/.test(portalsTs)) pass('seedExploreFilters reads the flag from the real portals.yml');
  else fail('seedExploreFilters never reads allow_bare_remote from portals.yml');

  // ── The flag survives the client → server round-trip ─────────────────────
  const patchFn = web.slice(web.indexOf('export function parseExplorePatch'));
  if (/allowBareRemote/.test(patchFn.slice(0, 2000))) {
    pass('parseExplorePatch preserves allowBareRemote across the round-trip');
  } else {
    fail('parseExplorePatch drops allowBareRemote — every client request would reset it');
  }

  // ── Tier ORDER must match ────────────────────────────────────────────────
  // Both implementations must apply: always_allow → block → bare-remote → allow.
  // If bare-remote were checked BEFORE block, a blocked region could slip past.
  const order = (src) => {
    const idx = (re) => src.search(re);
    return { block: idx(/block\.(?:length|some)/), bare: idx(/BARE_REMOTE_RE\.test/) };
  };
  for (const [label, src] of [['scan.mjs', core], ['explore.ts', web]]) {
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
