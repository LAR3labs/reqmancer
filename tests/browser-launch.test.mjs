// tests/browser-launch.test.mjs — the shared outbound-browser configuration.
//
// Pure/offline assertions only: no browser is launched here (that would make the
// suite depend on a Chrome install and add seconds to every CI run). The live
// fingerprint check is a manual smoke test — see the module header.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nbrowser-launch.mjs — shared stealth launch config');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'browser-launch.mjs')).href);
  const {
    buildUserAgent,
    jitteredDelayMs,
    STEALTH_ARGS,
    STEALTH_CONTEXT_DEFAULTS,
    STEALTH_INIT_SCRIPT,
    launchStealthBrowser,
    launchPersistentStealthContext,
    newStealthContext,
    newStealthPage,
  } = mod;

  // ── Exported surface ─────────────────────────────────────────────────────
  const fns = { launchStealthBrowser, launchPersistentStealthContext, newStealthContext, newStealthPage };
  const missing = Object.entries(fns).filter(([, v]) => typeof v !== 'function').map(([k]) => k);
  if (missing.length === 0) pass('exports all four launch/context helpers');
  else fail(`missing or non-function exports: ${missing.join(', ')}`);

  // ── The load-bearing flag ────────────────────────────────────────────────
  if (STEALTH_ARGS.includes('--disable-blink-features=AutomationControlled')) {
    pass('STEALTH_ARGS disables the AutomationControlled blink feature');
  } else {
    fail('STEALTH_ARGS is missing --disable-blink-features=AutomationControlled');
  }

  // No flag may weaken the browser's security model — stealth is about looking
  // ordinary, never about disabling protections.
  const unsafe = STEALTH_ARGS.filter((a) => /disable-web-security|allow-running-insecure|ignore-certificate/i.test(a));
  if (unsafe.length === 0) pass('STEALTH_ARGS contains no security-weakening flags');
  else fail(`STEALTH_ARGS weakens security: ${unsafe.join(', ')}`);

  // ── User agent ───────────────────────────────────────────────────────────
  const ua = buildUserAgent('150.0.7871.186');
  if (/Chrome\/150\.0\.0\.0/.test(ua)) pass('buildUserAgent() uses the launched binary’s major version');
  else fail(`buildUserAgent("150.0.7871.186") → ${ua}`);

  if (!/headless/i.test(buildUserAgent('150.0.0.0'))) pass('buildUserAgent() never emits "Headless"');
  else fail('buildUserAgent() leaked "Headless" into the UA');

  if (/^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua)) {
    pass('buildUserAgent() emits a well-formed desktop Chrome UA');
  } else {
    fail(`buildUserAgent() shape is off: ${ua}`);
  }

  // A garbage/empty version must still yield a usable modern UA, never
  // "Chrome/undefined" (which is a louder bot signal than any real UA).
  const fallbackUa = buildUserAgent('');
  if (/Chrome\/\d+\.0\.0\.0/.test(fallbackUa) && !/undefined|NaN/.test(fallbackUa)) {
    pass('buildUserAgent() falls back to a pinned major for an empty version');
  } else {
    fail(`buildUserAgent("") → ${fallbackUa}`);
  }

  // ── Persistent mode must set its own UA ──────────────────────────────────
  // Regression guard. Persistent contexts have no Browser handle, so the UA
  // cannot be derived from browser.version() the way newStealthContext does it.
  // When launchPersistentStealthContext omitted `userAgent`, the context
  // inherited Chrome's default and shipped "HeadlessChrome/…" in every request
  // header — the exact signal this module exists to remove.
  const srcMod = (await import('node:fs')).readFileSync(join(ROOT, 'browser-launch.mjs'), 'utf8');
  const persistBody = srcMod.slice(srcMod.indexOf('export async function launchPersistentStealthContext'));
  if (/userAgent:\s*buildUserAgent\(/.test(persistBody.slice(0, 1500))) {
    pass('launchPersistentStealthContext sets an explicit userAgent (no HeadlessChrome leak)');
  } else {
    fail('launchPersistentStealthContext does not set userAgent — a persistent headless context would leak "HeadlessChrome"');
  }

  if (/DEFAULT_PROFILE_DIR/.test(srcMod) && /career-ops-web/.test(srcMod)) {
    pass('persistent profile lives under .career-ops-web/ (gitignored)');
  } else {
    fail('persistent profile dir is not the gitignored .career-ops-web/ path');
  }

  // The profile holds cookies for every scanned site — it must never be committable.
  const ignore = (await import('node:fs')).readFileSync(join(ROOT, '.gitignore'), 'utf8');
  if (/browser-profile/.test(ignore)) pass('.gitignore excludes the browser profile directory');
  else fail('.gitignore does NOT exclude the browser profile — it holds cookies for every scanned site');

  // ── Context defaults ─────────────────────────────────────────────────────
  const d = STEALTH_CONTEXT_DEFAULTS;
  if (d.viewport && d.viewport.width >= 1280 && d.viewport.height >= 720) {
    pass('context defaults use a realistic desktop viewport');
  } else {
    fail(`viewport is not realistic: ${JSON.stringify(d.viewport)}`);
  }

  if (d.locale && d.timezoneId) pass('context defaults set both locale and timezone');
  else fail(`locale/timezone missing: ${JSON.stringify({ locale: d.locale, tz: d.timezoneId })}`);

  if (d.extraHTTPHeaders && d.extraHTTPHeaders['Accept-Language']) pass('context defaults send an Accept-Language header');
  else fail('Accept-Language header missing from context defaults');

  // ── Init script ──────────────────────────────────────────────────────────
  if (/webdriver/.test(STEALTH_INIT_SCRIPT)) pass('init script patches navigator.webdriver');
  else fail('init script does not touch navigator.webdriver');

  if (/window\.chrome/.test(STEALTH_INIT_SCRIPT)) pass('init script provides a window.chrome stub');
  else fail('init script does not provide window.chrome');

  // Every patch must be individually guarded: one throw in an init script runs
  // before page scripts and would break the whole navigation.
  const tryCount = (STEALTH_INIT_SCRIPT.match(/try\s*\{/g) || []).length;
  const catchCount = (STEALTH_INIT_SCRIPT.match(/catch/g) || []).length;
  if (tryCount >= 4 && tryCount === catchCount) pass(`init script guards every patch (${tryCount} try/catch pairs)`);
  else fail(`init script guards look unbalanced: ${tryCount} try vs ${catchCount} catch`);

  // ── Throttle ─────────────────────────────────────────────────────────────
  if (jitteredDelayMs(0) === 0 && jitteredDelayMs(-1) === 0 && jitteredDelayMs(undefined) === 0) {
    pass('jitteredDelayMs() returns 0 when throttling is disabled');
  } else {
    fail('jitteredDelayMs() should return 0 for non-positive input');
  }

  let inRange = true;
  for (let i = 0; i < 200; i++) {
    const v = jitteredDelayMs(5000);
    if (v < 5000 || v >= 10000) inRange = false;
  }
  if (inRange) pass('jitteredDelayMs() stays in [base, 2*base) across 200 draws');
  else fail('jitteredDelayMs() drifted outside [base, 2*base)');

  // ── The excluded call sites stay excluded ─────────────────────────────────
  // generate-pdf/img-to-pdf render LOCAL html (pinning them to the system Chrome
  // would make PDF output depend on the user's install) and doctor.mjs exists to
  // verify the BUNDLED chromium. If someone "helpfully" migrates them, say so.
  const fs = await import('node:fs');
  for (const f of ['generate-pdf.mjs', 'img-to-pdf.mjs', 'doctor.mjs']) {
    const src = fs.readFileSync(join(ROOT, f), 'utf8');
    if (!/browser-launch\.mjs/.test(src)) pass(`${f} correctly does NOT use the stealth launcher`);
    else fail(`${f} imports browser-launch.mjs — it renders local HTML / checks the bundled install`);
  }

  // ── Every OUTBOUND site does use it ──────────────────────────────────────
  for (const f of [
    'liveness-browser.mjs',
    'check-liveness.mjs',
    'browser-extract.mjs',
    'scan.mjs',
    'scan-ats-full.mjs',
    'archive-posting.mjs',
    'upskill.mjs',
    'openrouter-runner.mjs',
  ]) {
    const src = fs.readFileSync(join(ROOT, f), 'utf8');
    const usesShared = /browser-launch\.mjs/.test(src);
    const rawLaunch = /chromium\.launch\(\s*\{\s*headless/.test(src);
    if (usesShared && !rawLaunch) pass(`${f} launches via the shared stealth launcher`);
    else fail(`${f}: usesShared=${usesShared} rawLaunch=${rawLaunch} — outbound sites must not call chromium.launch directly`);
  }
} catch (err) {
  fail(`browser-launch test threw — ${err.message}`);
}
