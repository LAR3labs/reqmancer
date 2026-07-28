// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

// Agentic Engineering Jobs provider — scrapes the server-rendered listing at
// https://agentic-engineering-jobs.com/. The site has no public API, but every
// job card is plain HTML wrapped in a `data-impression-slug` container, so the
// full list is parseable from one page fetch (zero tokens, no browser).
//
// Card text lines after tag-stripping follow a stable order:
//   [Featured?] → title → company → location → tech tags… → 🇺🇸 flag → [date]
// The country flag emoji is decoded to a country name and appended to the
// location so scan.mjs's location_filter can gate non-US postings that only
// say "Remote".
//
// Wire in via a `job_boards:` entry with `provider: agentic-jobs`.

const SITE_ORIGIN = 'https://agentic-engineering-jobs.com';
const TRUSTED_HOST = 'agentic-engineering-jobs.com';

/** @param {string} url */
function assertAgenticUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`agentic-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`agentic-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`agentic-jobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Convert a two-letter regional-indicator flag emoji (e.g. 🇩🇪) into an
 * English country name ("Germany"). Returns '' when the input isn't a flag or
 * the region code can't be resolved.
 * @param {string} s
 */
export function flagToCountry(s) {
  const cps = [...s];
  if (cps.length !== 2) return '';
  const codes = cps.map((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= 0x1f1e6 && cp <= 0x1f1ff ? String.fromCharCode(cp - 0x1f1e6 + 65) : '';
  });
  if (codes.some((c) => !c)) return '';
  try {
    const name = regionNames.of(codes.join(''));
    return name && name !== codes.join('') ? name : '';
  } catch {
    return '';
  }
}

/**
 * Parse one job card's HTML segment into text lines (tags stripped, entities
 * decoded, blanks removed). Exported for tests.
 * @param {string} segment
 */
export function cardLines(segment) {
  const noMedia = segment.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<img[^>]*>/gi, ' ');
  return noMedia
    .split(/<[^>]+>/)
    .map((t) => decodeEntities(t).trim())
    .filter(Boolean);
}

/**
 * Normalize one card. Exported for tests.
 * @param {string} slug
 * @param {string[]} lines
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalizeAgenticCard(slug, lines) {
  if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) return null;
  // Drop the leftover `slug">` artifact of the split plus any Featured badge.
  const fields = lines.filter((l) => !l.includes('">') && l !== 'Featured');
  if (fields.length < 2) return null;
  const [title, company] = fields;
  if (!title || !company) return null;

  // Badges after the company are CLASSIFIED, not positional. The 2026-07 redesign
  // reordered them (salary and tech tags can now precede the country flag), and
  // the old `fields[2]` read produced locations like "CrewAI, United States" and
  // "$120K - $120K/yr, United States" — a tech tag and a pay range landing in the
  // location, which then went to scan.mjs's location_filter.
  const rest = fields.slice(2);
  const workplace = rest.find((l) => WORKPLACE_RE.test(l)) || '';
  const flag = fields.map(flagToCountry).find(Boolean);
  const location = [workplace, flag].filter(Boolean).join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number, salary?: {min: number, max: number, currency: string} }} */
  const job = { title, url: `${SITE_ORIGIN}/jobs/${slug}`, company, location };

  const dateLine = fields.find((l) => /^\d{4}-\d{2}-\d{2}$/.test(l));
  if (dateLine) {
    const parsed = Date.parse(`${dateLine}T00:00:00Z`);
    if (!Number.isNaN(parsed)) job.postedAt = parsed;
  }

  // The redesign also exposed pay ranges on the card. Free signal — feed it to
  // salary_filter rather than throwing it away.
  const salaryLine = rest.find((l) => SALARY_RE.test(l));
  if (salaryLine) {
    const salary = parseAgenticSalary(salaryLine);
    if (salary) job.salary = salary;
  }
  return job;
}

const WORKPLACE_RE = /^(remote|hybrid|on-?site|in-?office)$/i;
const SALARY_RE = /\$\s*[\d.,]+\s*k?\s*(?:-|–|to)?/i;

/**
 * Parse an agentic-jobs pay badge ("$216K - $224K/yr", "$120K/yr") into the
 * scanner's salary shape. Only per-YEAR ranges are trusted, so an hourly badge
 * can never be compared against an annual floor. Exported for tests.
 * @param {string} label
 */
export function parseAgenticSalary(label) {
  if (!/\/\s*yr|per\s+year|annual/i.test(label)) return undefined;
  const nums = [];
  for (const m of label.matchAll(/\$\s*([\d,.]+)\s*(k?)/gi)) {
    const raw = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    nums.push(m[2].toLowerCase() === 'k' ? raw * 1000 : raw);
  }
  const sane = nums.filter((n) => n >= 1000 && n <= 10_000_000);
  if (sane.length === 0) return undefined;
  return { min: Math.min(...sane), max: Math.max(...sane), currency: 'USD' };
}

/**
 * Parse the full listing page. Exported for tests.
 * @param {string} html
 */
export function parseAgenticListing(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // The site dropped `data-impression-slug` containers (2026-07 redesign) — each
  // card is now the posting ANCHOR itself, `<a … href="/jobs/{slug}">`. The field
  // order INSIDE a card is unchanged, so only the boundary detection moved here.
  // Anchoring on the href also makes the parser independent of the utility-class
  // soup around it, which is what broke last time.
  const bounds = [...html.matchAll(/<a[^>]*\bhref="\/jobs\/([A-Za-z0-9._~-]+)"/g)];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i].index ?? 0;
    const end = i + 1 < bounds.length ? bounds[i + 1].index : html.length;
    const slug = bounds[i][1];
    const job = normalizeAgenticCard(slug, cardLines(html.slice(start, end)));
    if (job && !seen.has(job.url)) {
      seen.add(job.url);
      out.push(job);
    }
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'agentic-jobs',

  detect(entry) {
    return entry?.provider === 'agentic-jobs' ? { url: SITE_ORIGIN } : null;
  },

  async fetch(_entry, ctx) {
    const url = assertAgenticUrl(`${SITE_ORIGIN}/`);
    // redirect:'error' prevents SSRF via server-side redirects
    const html = await ctx.fetchText(url, { redirect: 'error' });
    const jobs = parseAgenticListing(html);
    if (jobs.length === 0) {
      throw new Error(
        'agentic-jobs: parsed 0 job cards — the site markup likely changed (expected data-impression-slug containers)',
      );
    }
    return jobs;
  },
};
