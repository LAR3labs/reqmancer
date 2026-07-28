/**
 * browser-launch.mjs — one place where every OUTBOUND browser session is
 * configured.
 *
 * Why this exists: default Playwright Chromium is trivially identifiable —
 * `navigator.webdriver === true`, an empty plugin array, no `window.chrome`, a
 * SwiftShader WebGL renderer string, and (in the bundled headless shell) a UA
 * containing "HeadlessChrome". Cloudflare / DataDome / Akamai read those before
 * a single line of our parsing code runs, so the page we get back is a challenge
 * wall rather than the posting. Eleven call sites each launching their own
 * browser meant eleven chances to get that wrong; now they share this.
 *
 * SCOPE — this module is for reading EXTERNAL pages only. generate-pdf.mjs,
 * img-to-pdf.mjs and doctor.mjs deliberately do NOT use it: the first two render
 * local HTML (pinning them to the system Chrome would make PDF output depend on
 * whatever Chrome the user happens to have installed), and doctor's whole job is
 * to verify the BUNDLED chromium install.
 *
 * NOT in scope: solving CAPTCHAs or defeating challenge pages. When a wall is
 * hit, the liveness layer already reports "challenge / uncertain" and never
 * guesses — that behaviour is unchanged.
 *
 * Ordered by payoff:
 *   1. Real Chrome (`channel: 'chrome'`) instead of bundled Chromium — fixes
 *      codecs, the plugin array, and WebGL renderer strings in one move. Falls
 *      back to bundled Chromium when Chrome isn't installed (CI, Linux servers).
 *   2. `--disable-blink-features=AutomationControlled` + an init script, so
 *      `navigator.webdriver` is undefined at both the flag and JS layer.
 *   3. A UA derived from the LAUNCHED BINARY's own version, with "Headless"
 *      stripped. A hardcoded UA is worse than none: it drifts, and a Chrome/120
 *      UA in 2026 is itself a bot signal.
 *   4. Realistic viewport / locale / timezone / scale factor. 800x600 with no
 *      timezone is a strong bot tell.
 *   5. Optional persistent profile, so cookies and site trust survive runs
 *      instead of presenting a brand-new fingerprint every time.
 *   6. Jittered throttling (jitteredDelayMs) — rate is usually what actually
 *      trips a WAF, not fingerprint.
 */

import { chromium } from 'playwright';
import path from 'path';

/** Chrome launch flags. Deliberately minimal — each one earns its place. */
export const STEALTH_ARGS = [
  // The load-bearing one: without it Blink advertises automation and
  // navigator.webdriver is true no matter what we patch in JS.
  '--disable-blink-features=AutomationControlled',
  // Suppress first-run/default-browser interstitials that would otherwise steal
  // focus (headed mode) or add a startup tab.
  '--no-first-run',
  '--no-default-browser-check',
  // Playwright sets this by default and it is a known automation tell.
  '--disable-features=AutomationControlled',
];

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

/**
 * Where the persistent Chrome profile lives.
 *
 * Sits under `.career-ops-web/` next to logo-cache — both are machine-local
 * caches, and .gitignore covers this path explicitly. It holds cookies for every
 * site the scanner visits (including any WAF clearance tokens, which is the
 * entire point), so it must never be committed or shared.
 *
 * Chrome LOCKS this directory: only one browser may use it at a time. That fits
 * the project's "never Playwright in parallel" convention, but it is why the
 * persistent path is opt-in per call site rather than the global default.
 * Deleting the directory is always safe — it rebuilds on next use.
 */
export const DEFAULT_PROFILE_DIR = path.join(process.cwd(), '.career-ops-web', 'browser-profile');

/** Platform token for the UA string, matching the host OS. */
function uaPlatform() {
  if (IS_MAC) return 'Macintosh; Intel Mac OS X 10_15_7';
  if (IS_WIN) return 'Windows NT 10.0; Win64; x64';
  return 'X11; Linux x86_64';
}

/**
 * Build a desktop Chrome UA for a given browser version string.
 *
 * Derived from the binary we actually launched, so it can never drift out of
 * sync the way a hardcoded constant does. "Headless" is stripped defensively —
 * Chrome's new headless mode has historically leaked it.
 *
 * @param {string} version e.g. "141.0.7390.65"
 * @returns {string}
 */
export function buildUserAgent(version) {
  const major = /^(\d+)\./.exec(String(version || ''))?.[1] || '141';
  return (
    `Mozilla/5.0 (${uaPlatform()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`
  ).replace(/Headless/gi, '');
}

/** Default context options. Realistic desktop, ET (the profile's timezone). */
export const STEALTH_CONTEXT_DEFAULTS = {
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: IS_MAC ? 2 : 1,
  colorScheme: 'light',
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};

/**
 * JS-layer fingerprint patches, applied before any page script runs.
 *
 * Kept small on purpose: each patch closes a check that real Chrome would pass
 * anyway. Over-patching creates NEW inconsistencies (a stubbed API that behaves
 * subtly wrong is a stronger signal than the original tell).
 */
export const STEALTH_INIT_SCRIPT = `
  // navigator.webdriver — the single most-checked property. The launch flag
  // handles it in Chrome, but keep a JS guard for the Chromium fallback.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch {}
  // window.chrome exists in real Chrome and is absent in bare Chromium.
  try {
    if (!window.chrome) window.chrome = { runtime: {} };
  } catch {}
  // An EMPTY plugin array is a headless tell. Report a plausible non-zero
  // length without fabricating detailed plugin objects.
  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => Object.assign([1, 2, 3], { length: 3 }),
        configurable: true,
      });
    }
  } catch {}
  // Headless reports an empty languages list on some builds.
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    }
  } catch {}
`;

/**
 * Launch a browser for reading external pages.
 *
 * Tries the real Chrome channel first and transparently falls back to bundled
 * Chromium, so a machine without Chrome (CI, a Linux box) still works — just
 * with a weaker fingerprint.
 *
 * @param {{headed?: boolean, args?: string[]}} [opts]
 * @returns {Promise<{browser: import('playwright').Browser, channel: 'chrome'|'chromium'}>}
 */
/**
 * Last observed Chrome version, cached process-wide.
 *
 * Persistent contexts have NO Browser handle (Playwright's persistent mode
 * returns only a BrowserContext), so `browser.version()` isn't available to
 * derive the UA from — and a persistent context launched without an explicit
 * userAgent inherits Chrome's default, which in headless mode contains
 * "HeadlessChrome". That is the exact string this module exists to avoid, so
 * every successful launch records its version here for the persistent path to
 * reuse.
 */
let cachedChromeVersion = '';

/** Learn the Chrome version without a caller-visible session. Cached after the
 *  first call; returns '' if even the fallback launch fails (buildUserAgent then
 *  uses its pinned major). */
async function probeChromeVersion() {
  if (cachedChromeVersion) return cachedChromeVersion;
  for (const opts of [{ channel: 'chrome', headless: true }, { headless: true }]) {
    let probe;
    try {
      probe = await chromium.launch({ ...opts, args: STEALTH_ARGS });
      cachedChromeVersion = probe.version();
      return cachedChromeVersion;
    } catch {
      /* try the next configuration */
    } finally {
      if (probe) await probe.close().catch(() => {});
    }
  }
  return '';
}

export async function launchStealthBrowser({ headed = false, args = [] } = {}) {
  const launchArgs = [...STEALTH_ARGS, ...args];
  // With channel:'chrome', headless:true runs Chrome's NEW headless mode (a real
  // Chrome build), not the bundled headless-shell. Playwright has no
  // headless:'new' option — that is Puppeteer's spelling of the same idea.
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: !headed, args: launchArgs });
    cachedChromeVersion = browser.version() || cachedChromeVersion;
    return { browser, channel: 'chrome' };
  } catch {
    const browser = await chromium.launch({ headless: !headed, args: launchArgs });
    cachedChromeVersion = browser.version() || cachedChromeVersion;
    return { browser, channel: 'chromium' };
  }
}

/**
 * Launch a PERSISTENT session — cookies, storage and site trust survive across
 * runs, so repeat visits don't look like a brand-new visitor every time.
 *
 * Returns a BrowserContext (Playwright's persistent mode has no Browser handle).
 *
 * @param {{headed?: boolean, profileDir?: string, args?: string[]}} [opts]
 * @returns {Promise<{context: import('playwright').BrowserContext, channel: 'chrome'|'chromium'}>}
 */
export async function launchPersistentStealthContext({
  headed = false,
  profileDir = DEFAULT_PROFILE_DIR,
  args = [],
} = {}) {
  const options = {
    headless: !headed,
    args: [...STEALTH_ARGS, ...args],
    // MUST be set explicitly here — see cachedChromeVersion. Without it a
    // headless persistent context ships a "HeadlessChrome" UA in every request
    // header, which is the loudest bot signal there is.
    userAgent: buildUserAgent(await probeChromeVersion()),
    ...STEALTH_CONTEXT_DEFAULTS,
  };
  let context;
  let channel = /** @type {'chrome'|'chromium'} */ ('chrome');
  try {
    context = await chromium.launchPersistentContext(profileDir, { ...options, channel: 'chrome' });
  } catch {
    context = await chromium.launchPersistentContext(profileDir, options);
    channel = 'chromium';
  }
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  return { context, channel };
}

/**
 * Create a context with the full stealth profile applied.
 *
 * The UA is derived from `browser.version()` here rather than hardcoded, which
 * is the whole point — see buildUserAgent.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} [overrides] Merged over the defaults (e.g. a different locale).
 */
export async function newStealthContext(browser, overrides = {}) {
  let version = '';
  try {
    version = browser.version();
  } catch {
    /* fall back to the pinned major in buildUserAgent */
  }
  const context = await browser.newContext({
    userAgent: buildUserAgent(version),
    ...STEALTH_CONTEXT_DEFAULTS,
    ...overrides,
  });
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  return context;
}

/**
 * Open a page in a fresh stealth context.
 * @param {import('playwright').Browser} browser
 * @param {object} [overrides]
 */
export async function newStealthPage(browser, overrides = {}) {
  const context = await newStealthContext(browser, overrides);
  return context.newPage();
}

/**
 * Throttle delay with jitter: a value in [baseMs, 2*baseMs).
 *
 * Rate is usually what trips a WAF, not fingerprint — pracuj.pl's Cloudflare
 * flags a session after ~2 rapid hits, after which even headed retries are
 * blocked. A randomized gap also avoids a fixed-cadence request fingerprint.
 * Returns 0 for a non-positive base (throttling disabled).
 *
 * @param {number} baseMs
 * @returns {number}
 */
export function jitteredDelayMs(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}
