import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_SECRETS } from './agent.js';
import { createSecretGuard } from './secrets.js';

// Peticiones gate runner: a project's blocking verify_commands run by the bridge itself
// under macOS sandbox-exec: no network, writes only in the worktree, the temp dirs and a fresh empty HOME, credentials
// unreadable, env with PATH/HOME/CI and corepack's cache only. Used for the baseline (implement step) and the gate (review step, B9b).
const GATE_TIMEOUT = 15 * 60 * 1000;
const TAIL = 4000;
const SECRET_DIRS = ['.ssh', '.aws', '.npmrc', '.config/gh', '.infisical', '.docker', '.kube'].map((p) => join(homedir(), p));
const q = (p) => `(subpath ${JSON.stringify(p)})`;

// pnpm is a corepack shim: with the empty HOME it would download pnpm (no network here), so it reads the real cache.
// Reads are allowed everywhere but the secrets (pnpm's store included); writes stay in the dirs below.
const COREPACK_HOME = process.env.COREPACK_HOME || join(homedir(), '.cache/node/corepack');

// SBPL: the last matching rule wins, so the allowlists come after the blanket denies. Loopback stays open for tests that
// start a local server: bind/accept on a local loopback address, connect only to a remote loopback one (an
// `(allow network* (local ip ...))` also lets connect() reach external hosts, checked live), unix sockets in the writable dirs.
export const gateProfile = ({ worktree, home }) => {
  const writable = [worktree, '/private/tmp', '/private/var/folders', home].map(q).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    `(allow network* (local unix-socket ${writable}) (remote unix-socket ${writable}))`,
    '(deny file-write*)',
    `(allow file-write* ${writable} ${q('/dev')})`,
    `(deny file-read* ${[...SECRET_DIRS, ...BRIDGE_SECRETS].map(q).join(' ')})`,
  ].join('\n');
};

const ANSI = /\x1b\[[0-9;]*m/g;
const RULES = [
  /^\s*FAIL\s+(.+)$/, // vitest file/test
  /^\s*[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?$/, // vitest test
  /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/, // node:test spec reporter
  /^\s*not ok \d+ - (.+)$/, // TAP
];

// Failing test identifiers in a command's output; a failure with nothing recognizable -> ['<exit code N>'].
export function parseFailures(output, code) {
  if (code === 0) return [];
  const found = new Set();
  for (const line of String(output).replace(ANSI, '').split('\n')) {
    const name = RULES.map((re) => line.match(re)?.[1]).find(Boolean)?.trim();
    if (name && name !== 'failing tests:') found.add(name);
  }
  return found.size ? [...found] : [`<exit code ${code}>`];
}

// Runs a command in its own process group and never rejects: { code, stdout, stderr } (code 'timeout' when killed by the
// timeout or the signal). The whole group is killed when it ends or times out, so vitest workers can't outlive it.
// input: written to stdin (else stdin is closed).
export const execCode = (file, args, { timeout, signal, maxBuffer = 64 * 1024 * 1024, input, ...opts } = {}) => new Promise((resolve) => {
  const child = spawn(file, args, { ...opts, detached: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input != null) child.stdin.on('error', () => {}).end(input); // EPIPE when the child exits early
  const out = { stdout: '', stderr: '' };
  for (const k of ['stdout', 'stderr']) child[k].on('data', (d) => { if (out[k].length < maxBuffer) out[k] += d; });
  let killed = false;
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const stop = () => { killed = true; killGroup(); };
  const timer = timeout ? setTimeout(stop, timeout) : null;
  signal?.addEventListener('abort', stop, { once: true });
  const done = (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    killGroup();
    resolve({ code: killed ? 'timeout' : code, ...out });
  };
  child.on('exit', killGroup); // a straggler holding the pipes open would otherwise delay 'close' until the timeout
  child.on('error', () => done(1));
  child.on('close', (code) => done(code ?? 1));
});

// -> [{ cmd, code, failures, output }] in order; output is the tail, replaced if the secret guard flags it.
export async function runGate({ worktree, commands, signal, exec = execCode, leaks = createSecretGuard(), timeoutMs = GATE_TIMEOUT }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wa-gate-home-')));
  const profile = gateProfile({ worktree: realpathSync(worktree), home });
  const env = { PATH: process.env.PATH ?? '', HOME: home, CI: '1', COREPACK_HOME, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  try {
    const out = [];
    for (const cmd of commands) {
      const r = await exec('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { cwd: worktree, env, timeout: timeoutMs, signal, maxBuffer: 64 * 1024 * 1024 });
      const all = `${r.stdout}${r.stderr}`;
      const tail = all.slice(-TAIL);
      out.push({ cmd, code: r.code, failures: parseFailures(all, r.code), output: leaks(tail) ? '[salida omitida: posible secreto]' : tail });
    }
    return out;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
