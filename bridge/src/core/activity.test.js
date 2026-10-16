import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerActive } from './activity.js';

const now = new Date('2026-10-02T18:00:00Z');
const W = 30 * 60 * 1000;

test('null/undefined -> false', () => {
  assert.equal(isOwnerActive(null, now), false);
  assert.equal(isOwnerActive(undefined, now), false);
});

test('inside window -> true, edge and beyond -> false', () => {
  assert.equal(isOwnerActive(new Date(now - W + 1), now), true);
  assert.equal(isOwnerActive(new Date(now - W), now), false);
  assert.equal(isOwnerActive(new Date(now - W - 1), now), false);
});

test('accepts epoch ms and custom window', () => {
  assert.equal(isOwnerActive(now.getTime() - 500, now.getTime(), 1000), true);
  assert.equal(isOwnerActive(now.getTime() - 1000, now.getTime(), 1000), false);
});
