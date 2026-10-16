import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, createWaAlerts } from './notify.js';

const SCRIPT = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"', '-e', 'end run', '--'];

function setup({ platform = 'darwin', fail = false, leaks = () => false } = {}) {
  const calls = [];
  const logs = [];
  let t = 0;
  const execFile = (cmd, args, cb) => { calls.push([cmd, args]); cb(fail ? new Error('boom') : null); };
  const n = createNotifier({ execFile, platform, log: (...a) => logs.push(a.join(' ')), leaks, now: () => t });
  return { n, calls, logs, advance: (ms) => { t += ms; } };
}

test('darwin: osascript with argv (no shell, no escaping) plus afplay', () => {
  const s = setup();
  s.n.alert({ title: 'wha-me: prueba', message: '-x "hola" \\ y' });
  assert.deepEqual(s.calls, [
    ['osascript', [...SCRIPT, '-x "hola" \\ y', 'wha-me: prueba']],
    ['afplay', ['/System/Library/Sounds/Glass.aiff']],
  ]);
});

test('non-darwin is a no-op', () => {
  const s = setup({ platform: 'linux' });
  s.n.alert({ title: 't', message: 'm' });
  assert.deepEqual(s.calls, []);
});

test('execFile failures are logged, never thrown', () => {
  const s = setup({ fail: true });
  assert.doesNotThrow(() => s.n.alert({ title: 't', message: 'm' }));
  assert.equal(s.logs.length, 2);
  const t = setup();
  const n = createNotifier({ execFile: () => { throw new Error('ENOENT'); }, platform: 'darwin', log: (...a) => t.logs.push(a.join(' ')) });
  assert.doesNotThrow(() => n.alert({ title: 't', message: 'm' }));
  assert.equal(t.logs.length, 2);
});

test('long messages are clipped to 200 chars; a leak match sends a generic message', () => {
  const s = setup({ leaks: (x) => x.includes('ghp_') });
  s.n.alert({ title: 't', message: 'a'.repeat(500) });
  assert.equal(s.calls[0][1].at(-2).length, 200);
  s.n.alert({ title: 't', message: 'token ghp_123' });
  const msg = s.calls[2][1].at(-2);
  assert.doesNotMatch(msg, /ghp_/);
  assert.match(msg, /chat/);
});

test('dedupe: same key alerts once per 10 min', () => {
  const s = setup();
  s.n.alert({ title: 't', message: 'm', key: 'k' });
  s.n.alert({ title: 't', message: 'otro', key: 'k' });
  s.advance(9 * 60_000);
  s.n.alert({ title: 't', message: 'm', key: 'k' });
  assert.equal(s.calls.length, 2);
  s.n.alert({ title: 't', message: 'm', key: 'k2' });
  assert.equal(s.calls.length, 4);
  s.advance(60_001);
  s.n.alert({ title: 't', message: 'm', key: 'k' });
  assert.equal(s.calls.length, 6);
});

test('wa alerts: logged_out and replaced alert; qr only after having been open', () => {
  const got = [];
  const onStatus = createWaAlerts({ alert: (a) => got.push(a), url: 'http://127.0.0.1:4747' });
  onStatus({ state: 'connecting' });
  onStatus({ state: 'qr', qr: 'x' });
  assert.deepEqual(got, []);
  onStatus({ state: 'open', selfJid: 'me' });
  onStatus({ state: 'logged_out' });
  onStatus({ state: 'qr', qr: 'y' });
  onStatus({ state: 'replaced' });
  assert.deepEqual(got.map((a) => a.title), Array(3).fill('wha-me: vincula WhatsApp'));
  assert.ok(got.every((a) => a.message.includes('http://127.0.0.1:4747')));
});
