import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { qrSvg } from './qr-svg.js';

test('qrSvg draws one 1x1 square per dark module, inside a 4-module quiet zone', () => {
  const text = '2@AbCdEf0123456789,ZZZ,yyy=';
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark++;

  const svg = qrSvg(text);
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`), svg.slice(0, 120));
  assert.equal(svg.match(/M\d+ \d+h1v1h-1z/g).length, dark);
});
