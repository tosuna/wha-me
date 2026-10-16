import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp } from './totp.js';

// RFC 6238 Appendix B, SHA1, seed "12345678901234567890" in base32.
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

test('RFC 6238 SHA1 vectors, 8 digits', () => {
  for (const [s, code] of VECTORS) assert.equal(totp(SEED, s * 1000, 8), code, `T=${s}`);
});

test('6 digits by default = last 6 of the 8-digit vectors', () => {
  for (const [s, code] of VECTORS) assert.equal(totp(SEED, s * 1000), code.slice(2), `T=${s}`);
});

test('base32 seed tolerates spaces, lowercase and padding', () => {
  assert.equal(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==', 59_000), '287082');
});

test('invalid base32 throws', () => {
  assert.throws(() => totp('not base32!', 0), /base32/);
});
