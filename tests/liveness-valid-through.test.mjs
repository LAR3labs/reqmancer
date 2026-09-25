// tests/liveness-valid-through.test.mjs — a posting whose own schema.org
// JobPosting.validThrough has passed is expired, even with an Apply button.
//
// Built In (and other boards) keep serving dead postings with a working-looking
// Apply control. Measured 2026-09-25: live postings carry validThrough ~30 days
// out; stale ones a date months in the past, and liveness called them active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness, jobPostingValidThrough } from '../liveness-core.mjs';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const livePage = {
  status: 200,
  requestedUrl: 'https://builtin.com/job/data-engineer/11367442',
  finalUrl: 'https://builtin.com/job/data-engineer/11367442',
  bodyText: 'Data Engineer. '.repeat(40),
  applyControls: ['Apply Now'],
  now: NOW,
};

test('a passed validThrough expires a page that still shows Apply', () => {
  const v = classifyLiveness({ ...livePage, validThrough: '2025-06-11T23:54:15+00:00' });
  assert.equal(v.result, 'expired');
  assert.equal(v.code, 'valid_through_passed');
});

test('a future validThrough leaves the Apply-control verdict alone', () => {
  const v = classifyLiveness({ ...livePage, validThrough: '2026-10-25T06:20:21+00:00' });
  assert.equal(v.result, 'active');
});

test('one day of grace: validThrough a few hours ago is not expired yet', () => {
  const v = classifyLiveness({ ...livePage, validThrough: '2026-09-25T06:00:00Z' });
  assert.equal(v.result, 'active');
});

test('missing or unparseable validThrough changes nothing', () => {
  assert.equal(classifyLiveness({ ...livePage }).result, 'active');
  assert.equal(classifyLiveness({ ...livePage, validThrough: 'soon' }).result, 'active');
});

test('HTTP 404 still wins over validThrough', () => {
  const v = classifyLiveness({ ...livePage, status: 404, validThrough: '2027-01-01' });
  assert.equal(v.code, 'http_gone');
});

test('jobPostingValidThrough reads plain, array, @graph and typed-array JSON-LD', () => {
  assert.equal(jobPostingValidThrough([JSON.stringify({ '@type': 'JobPosting', validThrough: '2026-01-29' })]), '2026-01-29');
  assert.equal(
    jobPostingValidThrough([JSON.stringify([{ '@type': 'Organization' }, { '@type': 'JobPosting', validThrough: '2026-02-01' }])]),
    '2026-02-01',
  );
  assert.equal(
    jobPostingValidThrough([JSON.stringify({ '@graph': [{ '@type': ['JobPosting'], validThrough: '2026-03-13' }] })]),
    '2026-03-13',
  );
});

test('jobPostingValidThrough ignores junk, non-arrays and other types', () => {
  assert.equal(jobPostingValidThrough(['{not json', JSON.stringify({ '@type': 'ItemList' })]), '');
  assert.equal(jobPostingValidThrough('not-an-array'), '');
  assert.equal(jobPostingValidThrough(undefined), '');
});
