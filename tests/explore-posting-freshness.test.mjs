import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobPostingDatePosted } from '../liveness-core.mjs';
import { resolveAtsApi } from '../liveness-api.mjs';
import { isOlderThanWindow } from '../web/src/lib/explore-freshness.mjs';
import { createAdmissionGate } from '../web/src/lib/core/liveness-admission.mjs';

test('datePosted comes only from a JobPosting JSON-LD node', () => {
  assert.equal(jobPostingDatePosted(['{"@type":"Organization","datePosted":"2026-09-24"}']), '');
  assert.equal(jobPostingDatePosted(['{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","datePosted":"2026-09-17T10:00:00Z"}]}']), '2026-09-17');
  assert.equal(jobPostingDatePosted(['not json', '[{"@type":"JobPosting","datePosted":"invalid"}]']), '');
});

test('datePosted preserves the declared date and rejects invalid ISO dates', () => {
  const posted = (datePosted) => jobPostingDatePosted([JSON.stringify({ '@type': 'JobPosting', datePosted })]);
  assert.equal(posted('2026-09-18T00:30:00+14:00'), '2026-09-18');
  assert.equal(posted('2026-09-18T00:30:00'), '2026-09-18');
  assert.equal(posted('2024-02-29'), '2024-02-29');
  assert.equal(posted('2026-02-30'), '');
  assert.equal(posted('2026-09-18T24:00:00'), '');
  assert.equal(posted('2026-09-18T08:61:00'), '');
});

test('freshness window uses calendar dates and leaves unknown dates unfiltered', () => {
  const now = Date.parse('2026-09-25T18:00:00Z');
  assert.equal(isOlderThanWindow('2026-09-17', 7, now), true);
  assert.equal(isOlderThanWindow('2026-09-18', 7, now), false);
  assert.equal(isOlderThanWindow('2026-09-25', 7, now), false);
  assert.equal(isOlderThanWindow('', 7, now), false);
  assert.equal(isOlderThanWindow('invalid', 7, now), false);
});

test('Workday liveness result includes the detail API start date', async () => {
  const api = resolveAtsApi('https://sample.wd5.myworkdayjobs.com/jobs/job/Example_R123456');
  assert.equal(api?.ats, 'workday');
  const verdict = await api.interpret(new Response(JSON.stringify({ jobPostingInfo: { startDate: '2026-08-14' } })));
  assert.equal(verdict?.postedAt, '2026-08-14');
  const offset = await api.interpret(new Response(JSON.stringify({ jobPostingInfo: { startDate: '2026-09-18T23:30:00-05:00' } })));
  assert.equal(offset?.postedAt, '2026-09-18');
  const undated = await api.interpret(new Response(JSON.stringify({ jobPostingInfo: {} })));
  assert.equal(undated?.postedAt, undefined);
});

test('liveness admission rejects excess requests and releases capacity once', () => {
  const admit = createAdmissionGate(2);
  const first = admit();
  const second = admit();
  assert.equal(typeof first, 'function');
  assert.equal(typeof second, 'function');
  assert.equal(admit(), null);
  first();
  const third = admit();
  assert.equal(typeof third, 'function');
  first();
  assert.equal(admit(), null);
  second();
  third();
  assert.equal(typeof admit(), 'function');
});
