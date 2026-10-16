import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, historyFile, historyJid } from './store.js';

const initialState = () => ({ paused: false, locked: false, shadow: true });

test('getHistory: the full per-chat history (beyond the 30-message transcript, handoffs included), [] when none', () => {
  const s = createStore(mkdtempSync(join(tmpdir(), 'wa-store-')), { initialState });
  for (let i = 0; i < 35; i++) s.appendTranscript('c', { author: 'CONTACTO', text: `m${i}`, at: i });
  s.addHandoff('c', { type: 'bug' });
  const h = s.getHistory('c');
  assert.deepEqual([h.length, h[0].text, h.at(-1).kind], [36, 'm0', 'handoff']);
  assert.deepEqual(s.getHistory('nadie'), []);
});

test('store persists everything across instances and caps transcript at 30', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
  const a = createStore(dir, { initialState });
  assert.deepEqual(a.getState(), initialState());
  for (let i = 0; i < 35; i++) a.appendTranscript('c', { author: 'CONTACTO', text: `m${i}` });
  a.setLastManualFromMeAt('c', 123);
  a.addSentId('X1');
  a.setState({ paused: true, locked: false, shadow: false });
  a.setJobs([{ jid: 'c', implement: { summary: 's', spec: 'x' } }]);

  const b = createStore(dir, { initialState });
  const t = b.getTranscript('c');
  assert.equal(t.length, 30);
  assert.equal(t[0].text, 'm5');
  assert.equal(b.getLastManualFromMeAt('c'), 123);
  assert.equal(b.getLastManualFromMeAt('other'), null);
  assert.equal(b.isSentId('X1'), true);
  assert.equal(b.isSentId('nope'), false);
  assert.equal(b.getState().paused, true);
  assert.equal(b.getJobs().length, 1);
});

test('store persists pending replies and tolerates older store files without them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
  writeFileSync(join(dir, 'store.json'), JSON.stringify({ transcripts: {}, lastManual: {}, sentIds: [], state: initialState(), jobs: [] }));
  const a = createStore(dir, { initialState });
  assert.deepEqual(a.getPending(), {});
  a.setPending('c', 1000);
  a.setPending('d', 2000);
  a.clearPending('d');
  assert.deepEqual(createStore(dir, { initialState }).getPending(), { c: 1000 });
});

test('store keeps the last 20 handoffs per chat across reloads; older store files without handoffs load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
  writeFileSync(join(dir, 'store.json'), JSON.stringify({ transcripts: {}, lastManual: {}, sentIds: [], state: initialState(), jobs: [] }));
  const a = createStore(dir, { initialState });
  assert.deepEqual(a.getHandoffs('c'), []);
  for (let i = 0; i < 25; i++) a.addHandoff('c', { type: 'bug', blocking: false, summary: `h${i}`, at: i, shadow: true });
  const h = createStore(dir, { initialState }).getHandoffs('c');
  assert.equal(h.length, 20);
  assert.equal(h[0].summary, 'h5');
});

test('full history: every transcript entry and handoff is appended to history/<jid>.jsonl; the agent transcript stays capped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-store-'));
  const jid = '521000@s.whatsapp.net';
  const a = createStore(dir, { initialState });
  for (let i = 0; i < 35; i++) a.appendTranscript(jid, { author: 'CONTACTO', text: `m${i}`, at: i });
  a.addHandoff(jid, { type: 'bug', blocking: true, summary: 's', at: 99, shadow: false });
  assert.equal(a.getTranscript(jid).length, 30);
  const lines = readFileSync(historyFile(dir, jid), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 36);
  assert.deepEqual(lines[0], { author: 'CONTACTO', text: 'm0', at: 0 });
  assert.deepEqual(lines[35], { kind: 'handoff', type: 'bug', blocking: true, summary: 's', at: 99, shadow: false });
  const [name] = readdirSync(join(dir, 'history'));
  assert.ok(!/[@/]/.test(name), name);
  assert.equal(historyJid(name), jid);
  for (const j of ['bea@lid', '52100:12@s.whatsapp.net', 'a/../b']) assert.equal(historyJid(historyFile(dir, j).split('/').pop()), j);
});
