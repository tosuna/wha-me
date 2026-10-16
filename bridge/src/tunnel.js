import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The public https://<random>.trycloudflare.com URL of a quick tunnel, from one line of cloudflared output (never api.).
export const tunnelUrl = (line) => line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;

// npm run tunnel: Cloudflare quick tunnel to the portal. The URL goes to state/tunnel.json, where the bridge's /portal
// command reads it; the file is removed when cloudflared exits (a dead link is worse than "no hay túnel").
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'state');
  const file = join(stateDir, 'tunnel.json');
  const port = Number(process.env.PORTAL_PORT ?? 4747);
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'inherit', 'pipe'] });
  createInterface({ input: child.stderr }).on('line', (line) => {
    console.error(line);
    const url = tunnelUrl(line);
    if (!url) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ url, at: new Date().toISOString() }));
    console.log(`túnel listo: ${url}\nmanda /portal en tu chat contigo para recibir el link de acceso`);
  });
  child.on('error', (e) => {
    console.error(`cloudflared no arrancó (${e.message}); instálalo con brew install cloudflared`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    rmSync(file, { force: true });
    process.exit(code ?? (signal ? 1 : 0));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
