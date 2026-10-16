import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinHours as within, nextOpening as next } from './hours.js';

// Office hours Mon-Fri 08:00-17:30 in a UTC-6 zone without DST.
const P = { timezone: 'America/Mexico_City', hours: { open: '08:00', close: '17:30', days: [1, 2, 3, 4, 5] } };
const isWithinHours = (d) => within(d, P);
const nextOpening = (d) => next(d, P);

// UTC-6 (no DST). 2026-10-02 is a Friday.
const u = (s) => new Date(s);

test('isWithinHours: weekday bounds', () => {
  assert.equal(isWithinHours(u('2026-10-02T14:00:00Z')), true); // fri 08:00
  assert.equal(isWithinHours(u('2026-10-02T13:59:59Z')), false); // fri 07:59:59
  assert.equal(isWithinHours(u('2026-10-02T23:29:59Z')), true); // fri 17:29:59
  assert.equal(isWithinHours(u('2026-10-02T23:30:00Z')), false); // fri 17:30
  assert.equal(isWithinHours(u('2026-09-28T18:00:00Z')), true); // mon 12:00
});

test('isWithinHours: weekend is closed', () => {
  assert.equal(isWithinHours(u('2026-10-03T18:00:00Z')), false); // sat 12:00
  assert.equal(isWithinHours(u('2026-10-04T18:00:00Z')), false); // sun 12:00
});

test('nextOpening: within hours returns same date', () => {
  const d = u('2026-10-02T18:00:00Z');
  assert.equal(nextOpening(d).getTime(), d.getTime());
});

test('nextOpening: fri 18:00 -> mon 08:00', () => {
  assert.equal(nextOpening(u('2026-10-03T00:00:00Z')).toISOString(), '2026-10-05T14:00:00.000Z');
});

test('nextOpening: mon 07:00 -> mon 08:00', () => {
  assert.equal(nextOpening(u('2026-10-05T13:00:00Z')).toISOString(), '2026-10-05T14:00:00.000Z');
});

test('nextOpening: sat -> mon 08:00', () => {
  assert.equal(nextOpening(u('2026-10-03T18:00:00Z')).toISOString(), '2026-10-05T14:00:00.000Z');
});

test('nextOpening: tue 20:00 -> wed 08:00', () => {
  assert.equal(nextOpening(u('2026-09-30T02:00:00Z')).toISOString(), '2026-09-30T14:00:00.000Z');
});
