import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from '../yaml-compat.mjs';

test('empty and comment-only YAML keep the prior undefined result', () => {
  for (const input of ['', ' \n\t', '# explanation\n', '  # first\n\n# second\n']) {
    assert.equal(yaml.load(input), undefined);
  }
});

test('single documents retain their value and other yaml exports', () => {
  assert.deepEqual(yaml.load('enabled: true\n'), { enabled: true });
  assert.equal(yaml.load('null\n'), null);
  assert.match(yaml.dump({ enabled: true }), /enabled: true/);
});

test('multiple and malformed documents still fail', () => {
  assert.throws(() => yaml.load('a: 1\n---\nb: 2\n'));
  assert.throws(() => yaml.load('a: [\n'));
});
