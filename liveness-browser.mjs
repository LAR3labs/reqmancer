/**
 * liveness-browser.mjs — Playwright-driven liveness check for a single URL.
 *
 * Shared by check-liveness.mjs (CLI tool) and scan.mjs (--verify flag).
 * Returns the same shape as classifyLiveness: { result, reason }.
 */

import { classifyLiveness } from './liveness-core.mjs';
import {
  buildUserAgent,
  jitteredDelayMs as sharedJitteredDelayMs,
  launchPersistentStealthContext,
  launchStealthBrowser,
  newStealthPage,
  STEALTH_CONTEXT_DEFAULTS,
} from './browser-launch.mjs';

const NAVIGATE_TIMEOUT_MS = 15_000;
const HYDRATION_WAIT_MS = 2_000;

// Fingerprint hardening now lives in browser-launch.mjs (one place, all outbound
// sessions). This used to be a bare hardcoded Chrome/120 UA + locale; the problem
// with a pinned UA is that it DRIFTS — by 2026 a Chrome/120 UA is itself a bot
// signal, which is the opposite of what it was added for. The shared module
// derives the UA from the launched binary's real version instead.
//
// Kept as a named export because browser-extract.mjs and the tests import it.
export const LIVENESS_CONTEXT_OPTIONS = {
  userAgent: buildUserAgent(''),
  ...STEALTH_CONTEXT_DEFAULTS,
};

// Open a page in a context that presents a realistic fingerprint. Every caller
// uses this instead of browser.newPage() so a check is never instantly bot-walled.
// Delegates to the shared helper, which also installs the init-script layer
// (navigator.webdriver, window.chrome, plugins) that a plain newContext lacks.
export async function newLivenessPage(browser) {
  return newStealthPage(browser);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Re-exported from browser-launch.mjs so existing importers (scan.mjs,
// check-liveness.mjs, test-all.mjs) keep working unchanged.
export const jitteredDelayMs = sharedJitteredDelayMs;

// Defensive guards: URLs come from ATS feeds (mostly trusted) but a misconfigured
// portals.yml entry or a hijacked feed shouldn't be able to point Playwright at
// internal infrastructure. Only allow http(s) and reject loopback/private/link-local.
//
// The hostname coming out of `new URL(...)` needs normalization before the regex
// pass, because the WHATWG URL parser surfaces several encodings that bypass a
// naive match against `parsed.hostname`:
//   1. IPv6 hosts are serialized with brackets — `new URL('http://[::1]/').hostname`
//      is `'[::1]'`, so a regex like `/^::1$/` never fires unless brackets are stripped.
//   2. FQDN trailing dot is preserved — `localhost.` reaches the network as
//      localhost, but `/^localhost$/` doesn't match it.
//   3. IPv4-mapped IPv6 (`::ffff:127.0.0.1` or the hex form `::ffff:7f00:1`)
//      routes to the embedded IPv4 in Chromium, so the embedded address must
//      also be matched against the IPv4 block list.
// `0.0.0.0` and the all-zeros IPv6 `::` both reach loopback on Linux and need
// explicit entries; the original list omitted them.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/,
  /^localhost\.localdomain$/,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^::$/,
  /^fc[0-9a-f]{2}:/,
  /^fe80:/,
];

// Lowercase, strip IPv6 brackets, strip FQDN trailing dot. The `hostname`
// returned by `new URL(...)` is already percent-decoded and IDNA-normalized,
// but it preserves brackets around IPv6 hosts and trailing dots on FQDNs.
function normalizeHost(rawHostname) {
  if (!rawHostname) return '';
  let h = String(rawHostname).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

// IPv4-mapped IPv6 (RFC 4291 §2.5.5.2): `::ffff:0:0/96` routes to the embedded
// IPv4 address. Two textual forms — dotted (`::ffff:127.0.0.1`) and pure-hex
// (`::ffff:7f00:1`). Return the embedded IPv4 in dotted-decimal form, or null
// if `host` is not an IPv4-mapped IPv6.
function extractMappedIPv4(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

// Returns null when the URL is safe to fetch, otherwise a structured guard
// result with a stable `code` (used for routing in scan.mjs) plus a human
// `reason`. Stable codes — not regex on reason strings — drive downstream
// dispatch so the wording can change freely without breaking callers.
//
// Exported for unit tests; the main entry point is checkUrlLiveness.
export function rejectPrivateOrInvalid(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { code: 'invalid_url', reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { code: 'unsupported_protocol', reason: `unsupported protocol ${parsed.protocol}` };
  }
  const host = normalizeHost(parsed.hostname);
  const mappedIPv4 = extractMappedIPv4(host);
  const candidates = mappedIPv4 ? [host, mappedIPv4] : [host];
  for (const candidate of candidates) {
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return { code: 'blocked_host', reason: `blocked host ${parsed.hostname}` };
    }
  }
  return null;
}

export async function checkUrlLiveness(page, url, { extraSettleMs = 0 } = {}) {
  const guardError = rejectPrivateOrInvalid(url);
  if (guardError) {
    return { result: 'uncertain', code: guardError.code, reason: guardError.reason };
  }
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
    const status = response?.status() ?? 0;

    // Give SPAs (Ashby, Lever, Workday) time to hydrate. extraSettleMs adds slack
    // for the headed retry, where a JS anti-bot interstitial needs a moment to clear.
    await page.waitForTimeout(HYDRATION_WAIT_MS + extraSettleMs);

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
      );

      return candidates
        .filter((element) => {
          if (element.closest('nav, header, footer')) return false;
          if (element.closest('[aria-hidden="true"]')) return false;

          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (!element.getClientRects().length) return false;

          return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        })
        .map((element) => {
          const label = [
            element.innerText,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return label;
        })
        .filter(Boolean);
    });

    return classifyLiveness({ status, requestedUrl: url, finalUrl, bodyText, applyControls });
  } catch (err) {
    // Transient failures (timeout, DNS, TLS, 5xx) shouldn't be treated as expired —
    // doing so would cause scan --verify to drop the URL and write it to scan-history,
    // permanently filtering it out on subsequent scans.
    return {
      result: 'uncertain',
      code: 'navigation_error',
      reason: `navigation error: ${err.message.split('\n')[0]}`,
    };
  }
}

// Anti-bot results that a headed browser may be able to get past. A real (headed)
// Chromium clears the JS/Cloudflare challenge that headless trips on (e.g. pracuj.pl).
const CHALLENGE_CODES = new Set(['bot_challenge', 'access_blocked']);

export function isChallengeResult(result) {
  return result?.result === 'uncertain' && CHALLENGE_CODES.has(result.code);
}

// Lazily owns a single headed browser/page, created only on first use and reused
// across URLs. Headed Chromium needs a display, so launch can fail in headless/CI
// environments — in that case get() returns null and callers degrade to the
// headless result (challenge stays uncertain, never falsely expired).
//
// PERSISTENT PROFILE (opt-in, default ON here): this provider only ever runs
// AFTER a page has already tripped a wall headlessly, which makes it the single
// highest-value place to reuse browser state — a WAF clearance cookie earned on
// one URL then carries to the next instead of being thrown away with the
// browser. Chrome locks the profile directory, so if a second career-ops process
// already holds it we fall back to a throwaway (ephemeral) session rather than
// failing the check outright.
export function createHeadedPageProvider(chromium, { persist = true } = {}) {
  let browser = null;
  let context = null;
  let page = null;
  let launchFailed = false;
  return {
    async get() {
      if (page) return page;
      if (launchFailed) return null;
      // Headed + real Chrome + a warm profile is the strongest configuration
      // available, which is exactly what this fallback is for. `chromium` is
      // passed in by the caller, but the shared launcher owns the channel/args
      // choice, so it is ignored here.
      if (persist) {
        try {
          ({ context } = await launchPersistentStealthContext({ headed: true }));
          page = await context.newPage();
          return page;
        } catch {
          // Profile locked by a concurrent run, or unwritable — degrade to an
          // ephemeral session instead of giving up the retry entirely.
          context = null;
        }
      }
      try {
        ({ browser } = await launchStealthBrowser({ headed: true }));
        page = await newStealthPage(browser);
        return page;
      } catch {
        launchFailed = true;
        browser = null;
        page = null;
        return null;
      }
    },
    async close() {
      // Persistent mode has a context and no browser handle; ephemeral mode is
      // the reverse. Close whichever we actually opened.
      for (const handle of [context, browser]) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // best-effort teardown
          }
        }
      }
      browser = null;
      context = null;
      page = null;
    },
  };
}

// Runs the headless check, then retries once in a headed browser if the page was
// blocked by an anti-bot wall. The headed result wins when it actually sees the
// page; if the retry is still blocked (or no headed page is available) the
// original uncertain result is kept — we never upgrade a block to expired.
export async function checkUrlLivenessWithFallback(page, url, { getHeadedPage } = {}) {
  const first = await checkUrlLiveness(page, url);
  if (!getHeadedPage || !isChallengeResult(first)) {
    return first;
  }
  const headedPage = await getHeadedPage();
  if (!headedPage) {
    return first;
  }
  const second = await checkUrlLiveness(headedPage, url, { extraSettleMs: 3_000 });
  if (isChallengeResult(second)) {
    return { ...second, reason: `${second.reason} (headed retry also blocked)` };
  }
  return second;
}
