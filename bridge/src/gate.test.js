import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCode, gateProfile, parseFailures, runGate } from './gate.js';

const HOME = homedir();
const BRIDGE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''); // this checkout's bridge/

test('gateProfile: no network, writes only in the worktree/tmp/home, secrets unreadable', () => {
  const p = gateProfile({ worktree: '/w/pet-2-presets-api', home: '/private/var/folders/x/gate-home' });
  assert.match(p, /^\(version 1\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /\(deny file-write\*\)/);
  const allow = p.slice(p.indexOf('(allow file-write*'));
  for (const d of ['/w/pet-2-presets-api', '/private/tmp', '/private/var/folders', '/private/var/folders/x/gate-home']) assert.ok(allow.includes(`(subpath "${d}")`), d);
  const deny = p.slice(p.indexOf('(deny file-read*'));
  for (const d of ['.ssh', '.aws', '.npmrc', '.config/gh', '.infisical', '.docker', '.kube']) assert.ok(deny.includes(`(subpath "${join(HOME, d)}")`), d);
  for (const f of ['auth', 'state', 'contacts.json']) assert.ok(deny.includes(`(subpath "${join(BRIDGE, f)}")`), f);
  // later rules win in SBPL: the write allowlist after the blanket write deny
  assert.ok(p.indexOf('(deny file-write*)') < p.indexOf('(allow file-write*'));
});

test('gateProfile: loopback and unix sockets in the writable dirs allowed after the network deny; never a blanket local-ip network* allow', () => {
  const p = gateProfile({ worktree: '/w/wt', home: '/h' });
  const deny = p.indexOf('(deny network*)');
  for (const rule of ['(allow network-bind network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']) {
    assert.ok(p.indexOf(rule) > deny, rule);
  }
  const unix = p.slice(p.indexOf('(allow network* (local unix-socket'));
  for (const d of ['/w/wt', '/private/tmp', '/private/var/folders', '/h']) assert.ok(unix.includes(`(subpath "${d}")`), d);
  // `(allow network* (local ip ...))` also lets connect() reach external hosts (checked live): only bind/inbound are local.
  assert.doesNotMatch(p, /\(allow network\* \(local ip/);
  assert.doesNotMatch(p, /\(allow network\* \(remote ip/);
  assert.match(p, /\(deny network\*\)/);
});

test('parseFailures: vitest, node:test (spec and TAP), opaque exit, success', () => {
  const vitest = [
    '\x1b[31m FAIL \x1b[39m tests/unit/presets.test.js > presets > lists by node',
    ' FAIL  tests/unit/boot.test.js [ tests/unit/boot.test.js ]',
    '   × presets > rejects other nodes 12ms',
    '   ✓ presets > creates 3ms',
    ' Test Files  2 failed | 4 passed (6)',
  ].join('\n');
  assert.deepEqual(parseFailures(vitest, 1), [
    'tests/unit/presets.test.js > presets > lists by node', 'tests/unit/boot.test.js [ tests/unit/boot.test.js ]', 'presets > rejects other nodes',
  ]);
  const nodeSpec = '✔ ok one (0.5ms)\n✖ worklist exposes users_table id (1.2ms)\n✖ failing tests:\n\n✖ worklist exposes users_table id (1.2ms)\n';
  assert.deepEqual(parseFailures(nodeSpec, 1), ['worklist exposes users_table id']);
  assert.deepEqual(parseFailures('TAP version 13\nok 1 - fine\nnot ok 2 - breaks on null\n', 1), ['breaks on null']);
  assert.deepEqual(parseFailures('Error: Cannot find module x', 2), ['<exit code 2>']);
  assert.deepEqual(parseFailures('✖ flaky but exit 0', 0), []);
});

test('runGate: each command through sandbox-exec with the profile, stripped env, empty HOME removed after; output tail guarded', async () => {
  const worktree = mkdtempSync(join(tmpdir(), 'wa-gate-wt-'));
  process.env.GH_TOKEN = 'ghp_fake_should_not_leak';
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts, homeExisted: existsSync(opts.env.HOME) && readdirSync(opts.env.HOME).length === 0 });
    return args.at(-1) === 'pnpm test' ? { code: 1, stdout: ' FAIL  tests/a.test.js > a > b\nsecret ghp_x', stderr: '' } : { code: 0, stdout: 'built', stderr: '' };
  };
  try {
    const out = await runGate({ worktree, commands: ['pnpm test', 'pnpm build'], exec, leaks: (t) => t.includes('ghp_') });
    assert.deepEqual(out.map((r) => [r.cmd, r.code, r.failures]), [['pnpm test', 1, ['tests/a.test.js > a > b']], ['pnpm build', 0, []]]);
    assert.doesNotMatch(out[0].output, /ghp_/);
    assert.equal(out[1].output, 'built');
    const [c] = calls;
    assert.equal(c.file, '/usr/bin/sandbox-exec');
    assert.equal(c.args[0], '-p');
    assert.match(c.args[1], /\(deny network\*\)/);
    assert.ok(c.args[1].includes(`(subpath "${realpathSync(worktree)}")`));
    assert.deepEqual(c.args.slice(2), ['/bin/sh', '-c', 'pnpm test']);
    assert.equal(c.opts.cwd, worktree);
    assert.deepEqual(Object.keys(c.opts.env).sort(), ['CI', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'COREPACK_HOME', 'HOME', 'PATH']);
    // pnpm is a corepack shim: the real cache (read-only here) instead of a download into the empty HOME
    assert.deepEqual([c.opts.env.COREPACK_HOME, c.opts.env.COREPACK_ENABLE_DOWNLOAD_PROMPT], [process.env.COREPACK_HOME || join(HOME, '.cache/node/corepack'), '0']);
    assert.deepEqual([c.opts.env.CI, c.opts.env.PATH], ['1', process.env.PATH]);
    assert.ok(c.homeExisted, 'HOME is a fresh empty dir');
    assert.ok(c.args[1].includes(`(subpath "${c.opts.env.HOME}")`));
    assert.ok(c.opts.timeout > 0);
    assert.equal(existsSync(c.opts.env.HOME), false, 'HOME removed after the run');
  } finally {
    delete process.env.GH_TOKEN;
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('execCode: a timeout kills the whole process group, grandchildren included', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'wa-gate-pg-')), 'pid');
  const r = await execCode('/bin/sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeout: 300 });
  assert.equal(r.code, 'timeout');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the background grandchild must be gone');
});

test('execCode: a finished command leaves no stragglers behind', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'wa-gate-pg-')), 'pid');
  const r = await execCode('/bin/sh', ['-c', `sleep 30 > /dev/null 2>&1 & echo $! > ${pidFile}; echo done`], {});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('execCode: a straggler holding stdout open does not delay the result', async () => {
  const t = Date.now();
  const r = await execCode('/bin/sh', ['-c', 'sleep 30 & echo done'], { timeout: 10000 });
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t < 3000, 'resolved right after sh exited');
});

test('execCode: input goes to stdin', async () => {
  assert.deepEqual(await execCode('/bin/cat', [], { input: 'a;\nb' }), { code: 0, stdout: 'a;\nb', stderr: '' });
});
