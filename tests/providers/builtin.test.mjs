// tests/providers/builtin.test.mjs — Built In city-board provider (#discover-coverage).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — builtin');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/builtin.mjs')).href);
  const builtin = mod.default;
  const { parseBuiltInListing, parseSalary, parseRelativeAge, composeLocation, resolveSite, listUrl } = mod;

  if (builtin.id === 'builtin') pass('builtin.id is "builtin"');
  else fail(`builtin.id is ${JSON.stringify(builtin.id)}`);

  const hit = builtin.detect({ name: 'BuiltIn Charlotte', provider: 'builtin', builtin: { site: 'builtincharlotte.com' } });
  if (hit && hit.url === 'https://builtincharlotte.com/jobs') pass('builtin.detect() claims explicit provider config');
  else fail(`builtin.detect() returned ${JSON.stringify(hit)}`);

  if (builtin.detect({ name: 'Other', provider: 'remoteok' }) === null) pass('builtin.detect() ignores other provider ids');
  else fail('builtin.detect() should only claim provider: builtin');

  // ── Host pinning (SSRF guard) ────────────────────────────────────────────
  if (resolveSite('builtinnyc.com') === 'builtinnyc.com') pass('resolveSite() accepts a builtin city host');
  else fail('resolveSite() rejected a valid builtin host');

  if (resolveSite(undefined) === 'builtin.com') pass('resolveSite() defaults to builtin.com');
  else fail('resolveSite() default is wrong');

  if (resolveSite('https://builtincharlotte.com/jobs') === 'builtincharlotte.com') pass('resolveSite() strips scheme and path');
  else fail('resolveSite() did not normalize a full URL');

  let threw = false;
  try { resolveSite('evil.com'); } catch { threw = true; }
  if (threw) pass('resolveSite() rejects a non-builtin host');
  else fail('resolveSite() accepted an untrusted host');

  threw = false;
  try { resolveSite('builtin.com.evil.net'); } catch { threw = true; }
  if (threw) pass('resolveSite() rejects a suffix-smuggled host');
  else fail('resolveSite() accepted builtin.com.evil.net');

  // ── URL building ─────────────────────────────────────────────────────────
  if (listUrl('builtincharlotte.com', 'data engineer', 1) === 'https://builtincharlotte.com/jobs?search=data+engineer') {
    pass('listUrl() encodes the search query and omits page=1');
  } else {
    fail(`listUrl() query form: ${listUrl('builtincharlotte.com', 'data engineer', 1)}`);
  }

  if (listUrl('builtincharlotte.com', '', 1) === 'https://builtincharlotte.com/jobs') pass('listUrl() bare list has no query string');
  else fail(`listUrl() bare form: ${listUrl('builtincharlotte.com', '', 1)}`);

  if (listUrl('builtincharlotte.com', '', 3) === 'https://builtincharlotte.com/jobs?page=3') pass('listUrl() paginates');
  else fail(`listUrl() page form: ${listUrl('builtincharlotte.com', '', 3)}`);

  // ── Salary parsing ───────────────────────────────────────────────────────
  const s1 = parseSalary('77K-202K Annually');
  if (s1 && s1.min === 77000 && s1.max === 202000 && s1.currency === 'USD') pass('parseSalary() expands K ranges');
  else fail(`parseSalary("77K-202K Annually") → ${JSON.stringify(s1)}`);

  const s2 = parseSalary('$120,000-$150,000 Annually');
  if (s2 && s2.min === 120000 && s2.max === 150000) pass('parseSalary() handles comma-formatted ranges');
  else fail(`parseSalary comma form → ${JSON.stringify(s2)}`);

  if (parseSalary('50/hr Hourly') === undefined) pass('parseSalary() refuses hourly rates (annual floor would misfire)');
  else fail('parseSalary() returned a value for an hourly rate');

  if (parseSalary('Senior level') === undefined) pass('parseSalary() ignores a non-salary line');
  else fail('parseSalary() matched a non-salary line');

  // ── Relative age ─────────────────────────────────────────────────────────
  const now = Date.parse('2026-07-27T00:00:00Z');
  if (parseRelativeAge('3 Days Ago', now) === now - 3 * 86400000) pass('parseRelativeAge() handles days');
  else fail('parseRelativeAge() days form wrong');

  if (parseRelativeAge('Reposted 2 Days Ago', now) === now - 2 * 86400000) pass('parseRelativeAge() tolerates a Reposted prefix');
  else fail('parseRelativeAge() failed on "Reposted 2 Days Ago"');

  if (parseRelativeAge('30+ Days Ago', now) === now - 30 * 86400000) pass('parseRelativeAge() handles the 30+ bucket');
  else fail('parseRelativeAge() failed on "30+ Days Ago"');

  if (parseRelativeAge('Saved', now) === undefined) pass('parseRelativeAge() rejects a non-age line');
  else fail('parseRelativeAge() matched a non-age line');

  // ── Location composition ─────────────────────────────────────────────────
  if (composeLocation('Hybrid', 'Charlotte, NC, USA') === 'Hybrid, Charlotte, NC, USA') pass('composeLocation() prepends the workplace chip');
  else fail(`composeLocation hybrid → ${composeLocation('Hybrid', 'Charlotte, NC, USA')}`);

  if (composeLocation('Remote', '') === 'Remote, United States') pass('composeLocation() names the US market for a placeless remote card');
  else fail(`composeLocation placeless remote → ${composeLocation('Remote', '')}`);

  // The bug this test locks down: never bolt "United States" onto a stated
  // non-US place.
  if (composeLocation('Remote', 'Berlin, Germany') === 'Remote, Berlin, Germany') pass('composeLocation() never contradicts a stated non-US place');
  else fail(`composeLocation non-US → ${composeLocation('Remote', 'Berlin, Germany')}`);

  if (composeLocation('', 'Charlotte, NC') === 'Charlotte, NC') pass('composeLocation() passes a bare place through');
  else fail(`composeLocation bare place → ${composeLocation('', 'Charlotte, NC')}`);

  // ── Listing parse ────────────────────────────────────────────────────────
  // Fixture mirrors the real markup, including the data-id="job-card-title"
  // attribute whose literal text contains `id="job-card-` — the false card
  // boundary that truncated every card before the full-pattern fix.
  const card = (id, slug, title, company, workplace, place, salary, age, blurb) => `
    <div id="job-card-${id}" data-id="job-card" class="job-bounded-responsive">
      <div><a href="/company/${company.toLowerCase()}" data-id="job-card-company-title"><span>${company}</span></a></div>
      <h2><a href="/job/${slug}/${id}" data-id="job-card-title" data-alias="/job/${slug}/${id}">${title}</a></h2>
      <div><span>${age}</span></div><button>Saved</button>
      <div><span>${workplace}</span></div><div><span>${place}</span></div>
      <div><span>${salary}</span></div><div><span>Senior level</span></div>
      <div><span>Cloud &bull; Analytics</span></div>
      <div><p>${blurb}</p></div>
    </div>`;

  const html = `<html><body>
    ${card('101', 'senior-data-engineer', 'Senior Data Engineer (Snowflake &amp; dbt)', 'Acme', 'Hybrid', 'Charlotte, NC, USA', '140K-180K Annually', '13 Minutes Ago', 'Own the Snowflake platform end to end, building ELT pipelines and cost telemetry for a regulated data estate across many lines of business.')}
    ${card('102', 'finops-lead', 'FinOps Lead', 'Globex', 'Remote', '', '150K Annually', 'Reposted 2 Days Ago', 'Drive cloud cost governance, chargeback and showback across a multi-account estate, partnering with finance and platform teams on budget attribution.')}
    ${card('101', 'senior-data-engineer', 'Senior Data Engineer (Snowflake &amp; dbt)', 'Acme', 'Hybrid', 'Charlotte, NC, USA', '140K-180K Annually', '13 Minutes Ago', 'Duplicate card — same URL, must be deduped by the parser before it reaches the scanner.')}
  </body></html>`;

  const jobs = parseBuiltInListing(html, 'builtincharlotte.com', now);

  if (jobs.length === 2) pass('parseBuiltInListing() parses both cards and dedups the repeat');
  else fail(`parseBuiltInListing() returned ${jobs.length} jobs (expected 2)`);

  const [a, b] = jobs;

  if (a && a.title === 'Senior Data Engineer (Snowflake & dbt)') pass('parseBuiltInListing() decodes entities in the title');
  else fail(`title → ${JSON.stringify(a && a.title)}`);

  if (a && a.url === 'https://builtincharlotte.com/job/senior-data-engineer/101') pass('parseBuiltInListing() builds an absolute posting URL');
  else fail(`url → ${JSON.stringify(a && a.url)}`);

  if (a && a.company === 'Acme') pass('parseBuiltInListing() reads the company from the company anchor');
  else fail(`company → ${JSON.stringify(a && a.company)}`);

  if (a && a.location === 'Hybrid, Charlotte, NC, USA') pass('parseBuiltInListing() composes the location');
  else fail(`location → ${JSON.stringify(a && a.location)}`);

  if (a && a.salary && a.salary.min === 140000 && a.salary.max === 180000) pass('parseBuiltInListing() attaches the salary range');
  else fail(`salary → ${JSON.stringify(a && a.salary)}`);

  if (a && a.postedAt === now - 13 * 60000) pass('parseBuiltInListing() attaches postedAt from the relative age');
  else fail(`postedAt → ${JSON.stringify(a && a.postedAt)}`);

  if (a && a.description && a.description.startsWith('Own the Snowflake platform')) pass('parseBuiltInListing() carries the summary into description');
  else fail(`description → ${JSON.stringify(a && a.description)}`);

  if (b && b.location === 'Remote, United States') pass('parseBuiltInListing() marks a placeless remote card as US');
  else fail(`remote card location → ${JSON.stringify(b && b.location)}`);

  if (parseBuiltInListing('<html><body>no cards here</body></html>', 'builtincharlotte.com').length === 0) {
    pass('parseBuiltInListing() returns [] for a card-less page');
  } else {
    fail('parseBuiltInListing() invented jobs from a card-less page');
  }

  if (parseBuiltInListing(null, 'builtincharlotte.com').length === 0) pass('parseBuiltInListing() tolerates a non-string body');
  else fail('parseBuiltInListing() mishandled a non-string body');

  // A card whose posting path is not /job/{slug}/{digits} must be dropped, not
  // turned into a URL.
  const hostile = `<div id="job-card-9"><a href="/job/../../evil" data-id="job-card-title">Evil</a></div>`;
  if (parseBuiltInListing(hostile, 'builtincharlotte.com').length === 0) pass('parseBuiltInListing() drops a card with a traversal-shaped path');
  else fail('parseBuiltInListing() accepted a traversal-shaped path');
} catch (err) {
  fail(`builtin provider test threw — ${err.message}`);
}
