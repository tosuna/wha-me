// Live check of the gate sandbox (gate.js), not a test: external network (by name and by IP), credential reads and writes
// outside the worktree must be blocked; writes inside it and loopback (a local http server) allowed. Usage: node scripts/gate-probe.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../src/gate.js';

const worktree = mkdtempSync(join(tmpdir(), 'wa-gate-probe-'));
const outside = join(homedir(), 'gate-probe.txt');
const LOOPBACK = `node -e "const s = require('http').createServer((q, r) => r.end('pong')).listen(0, '127.0.0.1', async () => { const r = await fetch('http://127.0.0.1:' + s.address().port); console.log(await r.text()); s.close(); })"`;
const probes = [
  ['curl -sS https://example.com', 'blocked'],
  ['curl -sS -m 5 https://1.1.1.1', 'blocked'],
  [LOOPBACK, 'allowed'],
  ['cat ~/.npmrc', 'blocked'],
  [`echo x > ${outside}`, 'blocked'],
  ['echo ok > ./inside.txt', 'allowed'],
];
try {
  // `~` in the commands expands to the gate's empty HOME, so the credential and write probes use the real paths too.
  const cmds = probes.map(([c]) => c.replace('~/.npmrc', join(homedir(), '.npmrc')));
  const res = await runGate({ worktree, commands: cmds, leaks: () => false });
  let bad = 0;
  res.forEach((r, i) => {
    const want = probes[i][1];
    const got = i === 4 ? (existsSync(outside) ? 'allowed' : 'blocked')
      : i === 5 ? (existsSync(join(worktree, 'inside.txt')) && readFileSync(join(worktree, 'inside.txt'), 'utf8').trim() === 'ok' ? 'allowed' : 'blocked')
        : i === 2 ? (r.code === 0 && r.output.trim() === 'pong' ? 'allowed' : 'blocked')
        : r.code === 0 ? 'allowed' : 'blocked';
    if (got !== want) bad += 1;
    // the .npmrc output is never printed: a leak would print the token
    console.log(`${got === want ? 'OK ' : 'BAD'} ${want.padEnd(7)} code=${r.code} ${r.cmd}${i === 3 ? ` :: denied by the sandbox: ${/Operation not permitted/.test(r.output)}` : ` :: ${r.output.trim().split('\n').at(-1) ?? ''}`}`);
  });
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { force: true });
}
