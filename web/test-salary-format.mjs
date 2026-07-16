// Tests for formatSalary() using Node's built-in test runner.
// Imports directly from format-salary.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test test-salary-format.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSalary } from "./src/lib/format-salary.mjs";

test("undefined → null (caller shows N/A)", () => {
  assert.equal(formatSalary(undefined), null);
});

test("empty string → null", () => {
  assert.equal(formatSalary(""), null);
});

test("whitespace-only → null", () => {
  assert.equal(formatSalary("   "), null);
});

test("single value with USD → symbol prefix", () => {
  assert.equal(formatSalary("120000 USD"), "$120k");
});

test("ranged value with USD → symbol on both bounds, rounded to k", () => {
  assert.equal(formatSalary("240570-297000 USD"), "$241k–$297k");
});

test("equal bounds collapse to a single value", () => {
  assert.equal(formatSalary("95000-95000 USD"), "$95k");
});

test("reversed bounds render ascending (hand-typed rows)", () => {
  assert.equal(formatSalary("160000-120000 USD"), "$120k–$160k");
});

test("reversed bounds without currency also render ascending", () => {
  assert.equal(formatSalary("160000-120000"), "120k–160k");
});

test("EUR → € symbol", () => {
  assert.equal(formatSalary("80000-100000 EUR"), "€80k–€100k");
});

test("GBP → £ symbol", () => {
  assert.equal(formatSalary("70000 GBP"), "£70k");
});

test("unknown ISO code keeps the code as a suffix", () => {
  assert.equal(formatSalary("120000-160000 CHF"), "120k–160k CHF");
});

test("no currency → bare compact range", () => {
  assert.equal(formatSalary("120000-160000"), "120k–160k");
});

test("values ≥ 1M scale to M with one decimal", () => {
  assert.equal(formatSalary("1200000-1500000 USD"), "$1.2M–$1.5M");
});

test("exact 1M drops the trailing .0", () => {
  assert.equal(formatSalary("1000000 USD"), "$1M");
});

test("values under 1000 stay verbatim (hourly rates, malformed data)", () => {
  assert.equal(formatSalary("85 USD"), "$85");
});

test("unparsable free text passes through verbatim", () => {
  assert.equal(formatSalary("competitive + equity"), "competitive + equity");
});
