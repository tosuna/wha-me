// The QR encoder vendored inside qrcode-terminal (already a dependency), drawn as SVG for the portal.
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

export function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L); // same level as the terminal QR
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + 8; // 4-module quiet zone per side
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
