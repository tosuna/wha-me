import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from './debounce.js';

function fakeTimers() {
  let id = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    fireAll: () => { const t = [...timers.values()]; timers.clear(); t.forEach((x) => x.fn()); },
    timers,
  };
}

test('burst of bumps runs only the last fn once', () => {
  const t = fakeTimers();
  let calls = 0;
  const d = createDebouncer({ ...t, delayMs: () => { calls++; return 1000; } });
  const ran = [];
  d.bump('a', () => ran.push(1));
  d.bump('a', () => ran.push(2));
  d.bump('a', () => ran.push(3));
  assert.equal(calls, 3);
  assert.equal(t.timers.size, 1);
  assert.equal(d.pending('a'), true);
  t.fireAll();
  assert.deepEqual(ran, [3]);
  assert.equal(d.pending('a'), false);
});

test('keys are independent', () => {
  const t = fakeTimers();
  const d = createDebouncer({ ...t, delayMs: () => 5 });
  const ran = [];
  d.bump('a', () => ran.push('a'));
  d.bump('b', () => ran.push('b'));
  t.fireAll();
  assert.deepEqual(ran.sort(), ['a', 'b']);
});

test('cancel prevents execution', () => {
  const t = fakeTimers();
  const d = createDebouncer({ ...t, delayMs: () => 5 });
  const ran = [];
  d.bump('a', () => ran.push('a'));
  d.cancel('a');
  assert.equal(d.pending('a'), false);
  t.fireAll();
  assert.deepEqual(ran, []);
  d.cancel('missing'); // no throw
});

test('delayMs value is passed to setTimer', () => {
  const t = fakeTimers();
  const d = createDebouncer({ ...t, delayMs: () => 4242 });
  d.bump('a', () => {});
  assert.equal([...t.timers.values()][0].ms, 4242);
});
