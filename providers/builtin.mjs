// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Built In provider — scrapes the server-rendered job list on any Built In city
// site (builtincharlotte.com, builtinnyc.com, builtin.com, …). There is no
// public API (builtin's own /api endpoints are auth-gated), but every job card
// is plain server-side HTML, so the list is parseable from one page fetch per
// query — zero tokens, no browser.
//
// Wire in via a `job_boards:` entry:
//
//   - name: BuiltIn Charlotte
//     provider: builtin
//     builtin:
//       site: builtincharlotte.com   # optional, defaults to builtin.com
//       queries: ["data engineer", "finops"]   # optional; omit to walk the
//                                              # unfiltered list
//       pages: 2                     # optional, per query, capped at 5
//     enabled: true
//
// Card boundaries are the `<div id="job-card-{id}">` containers. NOTE: the
// title anchor carries `data-id="job-card-title"`, which contains the literal
// substring `id="job-card-` — so boundaries MUST be matched on the full
// `id="job-card-{digits}"` pattern, never on the bare prefix, or every card
// gets truncated at its own title.
//
// Card text lines after tag-stripping follow a stable order:
//   company → title → relative age → "Saved" → workplace type → location →
//   salary → seniority → (attribute block repeats) → industry tags →
//   description summary → "Top Skills:" → skills…
// The description summary is carried into `description` so scan.mjs's
// content_filter can gate on it for free (no extra per-job request).

const DEFAULT_SITE = 'builtin.com';
const DEFAULT_PAGES = 1;
const MAX_PAGES = 5;

// Built In city sites are all builtin*.com (builtinchicago, builtinla, …).
// Pinning to this shape keeps a hostile portals.yml from pointing the scraper
// at an arbitrary host.
const HOST_RE = /^(?:www\.)?builtin[a-z]*\.com$/;

/**
 * Validate a configured site and return its bare hostname.
 * @param {unknown} raw
 * @returns {string}
 */
export function resolveSite(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_SITE;
  // Accept "builtincharlotte.com" or "https://builtincharlotte.com".
  const host = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!HOST_RE.test(host)) {
    throw new Error(`builtin: untrusted site "${value}" — must be a builtin*.com host`);
  }
  return host;
}

/** Resolve the `builtin:` config block. */
function resolveConfig(entry) {
  const cfg = entry?.builtin && typeof entry.builtin === 'object' ? entry.builtin : {};
  const host = resolveSite(cfg.site);
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    : [];
  const pages =
    Number.isInteger(cfg.pages) && cfg.pages > 0 ? Math.min(cfg.pages, MAX_PAGES) : DEFAULT_PAGES;
  return { host, queries, pages };
}

/**
 * Build one list-page URL. `query` empty → the unfiltered list.
 * @param {string} host
 * @param {string} query
 * @param {number} page
 */
export function listUrl(host, query, page) {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return `https://${host}/jobs${qs ? `?${qs}` : ''}`;
}

/**
 * Strip tags and return non-empty text lines. Exported for tests.
 * @param {string} segment
 */
export function cardLines(segment) {
  const noMedia = segment
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ');
  return noMedia
    .split(/<[^>]+>/)
    .map((t) => decodeEntities(t).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const AGE_UNIT_MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Convert Built In's relative age label ("13 Minutes Ago", "30+ Days Ago") to
 * epoch ms. Returns undefined when the label isn't recognized. Exported for tests.
 * @param {string} label
 * @param {number} [now]
 */
export function parseRelativeAge(label, now = Date.now()) {
  // Cards prefix the age with "Reposted"/"Posted" when the role was re-listed.
  const m = /^(?:(?:re)?posted\s+)?(\d+)\+?\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(
    label.trim(),
  );
  if (!m) return undefined;
  const unit = AGE_UNIT_MS[m[2].toLowerCase()];
  if (!unit) return undefined;
  return now - Number(m[1]) * unit;
}

/**
 * Parse Built In's salary label into the scanner's salary shape. Only annual
 * figures are trusted — an hourly or unlabelled figure yields undefined so
 * scan.mjs's salary_filter treats the posting as "no data" (which passes)
 * rather than comparing an hourly rate against an annual floor.
 *
 * Handles "77K-202K Annually", "124K Annually", "$120,000-$150,000 Annually".
 * Exported for tests.
 * @param {string} label
 */
export function parseSalary(label) {
  if (!/annually/i.test(label)) return undefined;
  const nums = [];
  for (const m of label.matchAll(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k?)/gi)) {
    const raw = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    nums.push(m[2].toLowerCase() === 'k' ? raw * 1000 : raw);
  }
  const sane = nums.filter((n) => n >= 1000 && n <= 10_000_000);
  if (sane.length === 0) return undefined;
  const min = Math.min(...sane);
  const max = Math.max(...sane);
  return { min, max, currency: 'USD' };
}

// Workplace-type chips appear standalone ("Hybrid") or compound ("Remote or
// Hybrid", "In-Office or Remote"). They must be recognized as workplace, NOT
// mistaken for the location line — a compound chip contains "Remote", which
// would otherwise satisfy LOCATION_RE and mask the real place.
const WORKPLACE_TERM = String.raw`(?:remote|hybrid|on-?site|in-?office|in\s*office)`;
const WORKPLACE_RE = new RegExp(`^${WORKPLACE_TERM}(?:\\s+or\\s+${WORKPLACE_TERM})*$`, 'i');
// "Charlotte, NC, USA" / "Remote" / "United States" — a location line always
// carries a comma-separated place or a remote/US marker, and never the trailing
// UI affordances ("Saved", "Apply Now") or the attribute labels.
const LOCATION_RE = /(,\s*[A-Z]{2}\b)|(\b(?:USA|United States|Remote|Nationwide)\b)/i;

/**
 * Compose the location string the scanner filters on, from the card's workplace
 * chip plus its place line.
 *
 * Two deliberate enrichments, both safe because every Built In property is a
 * US market (builtin.com and its builtin{city}.com siblings):
 *
 *  1. The workplace chip is prepended when the place line doesn't already carry
 *     it, so a remote posting reads "Remote, …" for scan.mjs's location_filter.
 *  2. "United States" is appended ONLY when the posting is remote and the card
 *     names no place whatsoever. A bare "Remote" chip would otherwise fail a
 *     location policy that (correctly) demands a positive US signal, silently
 *     dropping real US-remote roles; naming the board's own market fixes that.
 *     When the card DOES name a place, it is passed through untouched — so a
 *     posting that says "Berlin, Germany" never gets a contradictory "United
 *     States" bolted onto it.
 *
 * Exported for tests.
 * @param {string} workplace
 * @param {string} rawLocation
 */
export function composeLocation(workplace, rawLocation) {
  const parts = [];
  const flat = (s) => s.replace(/[^a-z]/gi, '').toLowerCase();
  if (workplace && !flat(rawLocation).includes(flat(workplace))) parts.push(workplace);
  if (rawLocation) parts.push(rawLocation);
  let location = parts.join(', ');
  // Only a placeless remote card gets the market country. Any stated place —
  // US or not — is authoritative and passes through unchanged.
  if (!rawLocation && /remote/i.test(location)) location = `${location}, United States`;
  return location;
}

/**
 * Normalize one card. Exported for tests.
 * @param {string} id
 * @param {string} segment
 * @param {string} host
 * @param {number} [now]
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency: string}} | null}
 */
export function normalizeBuiltInCard(id, segment, host, now = Date.now()) {
  const hrefMatch = /href="(\/job\/[^"]+)"/.exec(segment);
  if (!hrefMatch) return null;
  const path = hrefMatch[1];
  // Path goes straight into a URL — keep it to safe slug/id characters.
  if (!/^\/job\/[A-Za-z0-9._~-]+\/\d+$/.test(path)) return null;
  const url = `https://${host}${path}`;

  const titleMatch = /data-id="job-card-title"[^>]*>([^<]+)</.exec(segment);
  const lines = cardLines(segment);
  // The first line of a card is the boundary attribute remainder; drop anything
  // that still looks like raw markup.
  const fields = lines.filter((l) => !l.includes('="') && l !== 'Saved');

  const title = decodeEntities(titleMatch ? titleMatch[1] : '').replace(/\s+/g, ' ').trim() || fields[1] || '';
  if (!title) return null;

  const companyMatch = /href="\/company\/[^"]*"[^>]*>(?:\s*<span[^>]*>)?([^<]+)</.exec(segment);
  const company = decodeEntities(companyMatch ? companyMatch[1] : '').replace(/\s+/g, ' ').trim() || fields[0] || '';

  const workplace = fields.find((l) => WORKPLACE_RE.test(l)) || '';
  // A workplace chip is never the location, even though "Remote or Hybrid"
  // matches LOCATION_RE.
  const rawLocation =
    fields.find((l) => l !== title && l !== company && !WORKPLACE_RE.test(l) && LOCATION_RE.test(l)) || '';
  const location = composeLocation(workplace, rawLocation);

  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency: string}}} */
  const job = { title, url, company, location };

  const ageLine = fields.find((l) => /\bago$/i.test(l));
  if (ageLine) {
    const postedAt = parseRelativeAge(ageLine, now);
    if (postedAt !== undefined) job.postedAt = postedAt;
  }

  const salaryLine = fields.find((l) => /annually|hourly|\/\s*hr/i.test(l));
  if (salaryLine) {
    const salary = parseSalary(salaryLine);
    if (salary) job.salary = salary;
  }

  // The longest prose line in the card is Built In's own summary blurb. Only
  // trust it when it reads like a sentence — never a tag list or a label.
  const summary = fields
    .filter((l) => l.length >= 80 && !l.includes('•') && !/^top skills/i.test(l))
    .sort((a, b) => b.length - a.length)[0];
  if (summary) job.description = summary;

  return job;
}

/**
 * Parse a Built In list page. Exported for tests.
 * @param {string} html
 * @param {string} host
 * @param {number} [now]
 */
export function parseBuiltInListing(html, host, now = Date.now()) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // Match the FULL id="job-card-{digits}" pattern — see the header note about
  // data-id="job-card-title" false boundaries.
  const bounds = [...html.matchAll(/<div[^>]*\bid="job-card-\d+"/g)];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i].index ?? 0;
    const end = i + 1 < bounds.length ? bounds[i + 1].index : html.length;
    const segment = html.slice(start, end);
    const id = /id="job-card-(\d+)"/.exec(bounds[i][0])?.[1] ?? '';
    const job = normalizeBuiltInCard(id, segment, host, now);
    if (job && !seen.has(job.url)) {
      seen.add(job.url);
      out.push(job);
    }
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'builtin',

  detect(entry) {
    if (entry?.provider !== 'builtin') return null;
    return { url: `https://${resolveSite(entry?.builtin?.site)}/jobs` };
  },

  async fetch(entry, ctx) {
    const { host, queries, pages } = resolveConfig(entry);
    const byUrl = new Map();
    let fetched = 0;

    // No configured queries → walk the unfiltered list; scan.mjs's title filter
    // gates the results, same as the other whole-board feeds.
    for (const query of queries.length ? queries : ['']) {
      for (let page = 1; page <= pages; page++) {
        const url = listUrl(host, query, page);
        // redirect:'error' prevents SSRF via server-side redirects; combined
        // with resolveSite it keeps every request pinned to a builtin*.com host.
        const html = await ctx.fetchText(url, { redirect: 'error' });
        fetched++;
        const jobs = parseBuiltInListing(html, host);
        for (const job of jobs) {
          if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        // Short-circuit paging once a page runs dry.
        if (jobs.length === 0) break;
      }
    }

    if (fetched > 0 && byUrl.size === 0) {
      throw new Error(
        `builtin: parsed 0 job cards from ${host} — the site markup likely changed (expected <div id="job-card-{id}"> containers)`,
      );
    }
    return [...byUrl.values()];
  },
};
