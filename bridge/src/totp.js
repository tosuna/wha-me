import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(seed) {
  const s = String(seed).toUpperCase().replace(/[\s=]/g, '');
  if (!/^[A-Z2-7]+$/.test(s)) throw new Error('TOTP seed is not valid base32');
  let bits = '';
  for (const ch of s) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

// RFC 6238: HMAC-SHA1, 30 s steps, dynamic truncation.
export function totp(seed, nowMs, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const h = createHmac('sha1', base32(seed)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
