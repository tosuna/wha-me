import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyDelayMs, typingMs, bubbleGapMs } from './delays.js';

const lo = () => 0;
const hi = () => 0.9999999;

test('replyDelayMs within [180000, 360000]', () => {
  assert.equal(replyDelayMs(lo), 180000);
  const h = replyDelayMs(hi);
  assert.ok(h <= 360000 && h > 359000);
  const r = replyDelayMs();
  assert.ok(r >= 180000 && r <= 360000);
});

test('typingMs = chars/4 s * [0.8, 1.2]', () => {
  const text = 'x'.repeat(40); // 10 s base
  assert.equal(typingMs(text, lo), 8000);
  const h = typingMs(text, hi);
  assert.ok(h <= 12000 && h > 11999);
  assert.equal(typingMs('', lo), 0);
});

test('bubbleGapMs within [1500, 4000]', () => {
  assert.equal(bubbleGapMs(lo), 1500);
  const h = bubbleGapMs(hi);
  assert.ok(h <= 4000 && h > 3999);
});
