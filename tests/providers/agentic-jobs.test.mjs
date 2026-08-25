// tests/providers/agentic-jobs.test.mjs — the ONE provider that shipped without a
// test, which is exactly why its 2026-07 markup change went unnoticed: the scanner
// reported "parsed 0 job cards" to stderr on every run and the board silently
// contributed nothing. These tests pin the card grammar so the next redesign fails
// loudly in CI instead.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — agentic-jobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/agentic-jobs.mjs')).href);
  const agentic = mod.default;
  const { parseAgenticListing, normalizeAgenticCard, cardLines, flagToCountry, parseAgenticSalary } = mod;

  if (agentic.id === 'agentic-jobs') pass('agentic-jobs.id is "agentic-jobs"');
  else fail(`agentic-jobs.id is ${JSON.stringify(agentic.id)}`);

  const hit = agentic.detect({ name: 'Agentic', provider: 'agentic-jobs' });
  if (hit && hit.url === 'https://agentic-engineering-jobs.com') pass('agentic-jobs.detect() claims explicit provider config');
  else fail(`detect() returned ${JSON.stringify(hit)}`);

  if (agentic.detect({ name: 'Other', provider: 'remoteok' }) === null) pass('agentic-jobs.detect() ignores other provider ids');
  else fail('detect() should only claim provider: agentic-jobs');

  // ── Flag → country ───────────────────────────────────────────────────────
  if (flagToCountry('🇩🇪') === 'Germany') pass('flagToCountry() decodes a regional-indicator pair');
  else fail(`flagToCountry("🇩🇪") → ${flagToCountry('🇩🇪')}`);

  if (flagToCountry('Remote') === '') pass('flagToCountry() ignores plain text');
  else fail('flagToCountry() matched plain text');

  // ── Salary badge ─────────────────────────────────────────────────────────
  const s = parseAgenticSalary('$216K - $224K/yr');
  if (s && s.min === 216000 && s.max === 224000 && s.currency === 'USD') pass('parseAgenticSalary() reads a K range');
  else fail(`parseAgenticSalary range → ${JSON.stringify(s)}`);

  const s2 = parseAgenticSalary('$120K/yr');
  if (s2 && s2.min === 120000 && s2.max === 120000) pass('parseAgenticSalary() reads a single figure');
  else fail(`parseAgenticSalary single → ${JSON.stringify(s2)}`);

  if (parseAgenticSalary('$60/hr') === undefined) pass('parseAgenticSalary() refuses an hourly badge');
  else fail('parseAgenticSalary() accepted an hourly badge');

  if (parseAgenticSalary('CrewAI') === undefined) pass('parseAgenticSalary() ignores a tech tag');
  else fail('parseAgenticSalary() matched a tech tag');

  // ── Listing parse (post-redesign anchor cards) ───────────────────────────
  // Mirrors the live markup: the card IS the <a href="/jobs/{slug}"> anchor, and
  // badges after the company appear in an ARBITRARY order — tech tags and pay
  // ranges may precede the country flag.
  const card = (slug, title, company, badges) => `
    <a class="block rounded-lg border p-4 transition-colors bg-surface" href="/jobs/${slug}">
      <div class="flex flex-col gap-3">
        <div class="min-w-0">
          <span class="text-base font-semibold text-foreground line-clamp-1">${title}</span>
          <p class="text-sm text-muted truncate">${company}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${badges.map((b) => `<span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs">${b}</span>`).join("\n          ")}
        </div>
      </div>
    </a>`;

  const html = `<html><body>
    ${card('orbit-product-engineer-bSoC5p', 'Product Engineer', 'Orbit', ['Remote', 'AWS Bedrock', '<span title="DE">🇩🇪</span>', '<div class="text-sm">2026-07-07</div>'])}
    ${card('tebra-staff-ai-1MZCLj', 'Staff Software Engineer, AI', 'Tebra', ['Remote', '$216K - $224K/yr', '<span title="US">🇺🇸</span>', '<div class="text-sm">2026-07-18</div>'])}
    ${card('sema4ai-fde-tcAgyZ', 'Forward Deployed Engineer', 'Sema4.ai', ['CrewAI', 'LangChain', '<span title="US">🇺🇸</span>', '<div class="text-sm">2026-07-18</div>'])}
    ${card('orbit-product-engineer-bSoC5p', 'Product Engineer', 'Orbit', ['Remote', '<span title="DE">🇩🇪</span>'])}
  </body></html>`;

  const jobs = parseAgenticListing(html);

  if (jobs.length === 3) pass('parseAgenticListing() parses anchor cards and dedups the repeat');
  else fail(`parseAgenticListing() returned ${jobs.length} jobs (expected 3)`);

  const [a, b, c] = jobs;

  if (a && a.url === 'https://agentic-engineering-jobs.com/jobs/orbit-product-engineer-bSoC5p') pass('builds the absolute posting URL from the href slug');
  else fail(`url → ${JSON.stringify(a && a.url)}`);

  if (a && a.title === 'Product Engineer' && a.company === 'Orbit') pass('reads title and company');
  else fail(`title/company → ${JSON.stringify(a && [a.title, a.company])}`);

  if (a && a.location === 'Remote, Germany') pass('composes location from the workplace badge + flag country');
  else fail(`location → ${JSON.stringify(a && a.location)}`);

  if (a && a.postedAt === Date.parse('2026-07-07T00:00:00Z')) pass('reads the ISO date badge into postedAt');
  else fail(`postedAt → ${JSON.stringify(a && a.postedAt)}`);

  if (b && b.salary && b.salary.min === 216000 && b.salary.max === 224000) pass('attaches the pay range to salary');
  else fail(`salary → ${JSON.stringify(b && b.salary)}`);

  // The regression this file exists for: a pay range must never land in location.
  if (b && b.location === 'Remote, United States') pass('a pay badge never leaks into location');
  else fail(`salary-card location → ${JSON.stringify(b && b.location)}`);

  // And neither may a tech tag, even when it is the FIRST badge after company.
  if (c && c.location === 'United States') pass('a tech tag never leaks into location');
  else fail(`tech-tag-card location → ${JSON.stringify(c && c.location)}`);

  if (parseAgenticListing('<html><body>nothing here</body></html>').length === 0) pass('returns [] for a card-less page');
  else fail('invented jobs from a card-less page');

  if (parseAgenticListing(null).length === 0) pass('tolerates a non-string body');
  else fail('mishandled a non-string body');

  // Path-traversal-shaped slugs must never become URLs.
  if (parseAgenticListing('<a href="/jobs/../../evil">x</a>').length === 0) pass('drops a traversal-shaped slug');
  else fail('accepted a traversal-shaped slug');

  if (normalizeAgenticCard('ok-slug', ['Title']) === null) pass('normalizeAgenticCard() rejects a card with no company');
  else fail('normalizeAgenticCard() accepted a company-less card');

  if (cardLines('<div>A</div><script>var x=1</script><div>B</div>').join('|') === 'A|B') pass('cardLines() strips scripts and empty nodes');
  else fail(`cardLines() → ${cardLines('<div>A</div><script>var x=1</script><div>B</div>').join('|')}`);

  // HTML permits href='…'. Matching only double quotes meant a template change
  // would silently return zero cards — the same failure this parser fixes.
  const singleQuoted = `<a href='/jobs/single-quoted-role'><div>Single Quoted Role</div><div>Acme</div></a>`;
  if (parseAgenticListing(singleQuoted).length === 1) pass('parseAgenticListing() accepts a single-quoted href');
  else fail(`parseAgenticListing() found ${parseAgenticListing(singleQuoted).length} cards for a single-quoted href (expected 1)`);

  // The closing quote must match the opening one, not just be any quote.
  const mismatched = `<a href="/jobs/mismatched'><div>T</div><div>C</div></a>`;
  if (parseAgenticListing(mismatched).length === 0) pass('parseAgenticListing() rejects mismatched href quotes');
  else fail('parseAgenticListing() accepted mismatched href quotes');

} catch (err) {
  fail(`agentic-jobs provider test threw — ${err.message}`);
}
