import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryChats } from './memory-chats.js';

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'wa-mc-')), 'memory-chats.json');

test('missing file is empty; add (same jid replaces) and remove persist; every list() reads the file fresh', () => {
  const file = fileIn();
  const a = createMemoryChats({ file });
  assert.deepEqual(a.list(), []);
  a.add({ jid: 'g@g.us', name: 'Obras', kind: 'group' });
  a.add({ jid: 'p@s.whatsapp.net', name: 'Fabi', kind: 'private' });
  a.add({ jid: 'g@g.us', name: 'Obras 2', kind: 'group' });
  assert.deepEqual(createMemoryChats({ file }).list(), [
    { jid: 'p@s.whatsapp.net', name: 'Fabi', kind: 'private' }, { jid: 'g@g.us', name: 'Obras 2', kind: 'group' },
  ]);
  a.remove('p@s.whatsapp.net');
  assert.deepEqual(a.list().map((c) => c.jid), ['g@g.us']);
  writeFileSync(file, JSON.stringify([{ jid: 'x@s.whatsapp.net', name: 'X', kind: 'private' }]));
  assert.deepEqual(a.list().map((c) => c.jid), ['x@s.whatsapp.net']);
});

test('add rejects a bad entry', () => {
  const a = createMemoryChats({ file: fileIn() });
  assert.throws(() => a.add({ jid: 'y@s.whatsapp.net', name: 'Y', kind: 'canal' }), /kind/);
  assert.throws(() => a.add({ jid: '', name: 'Y', kind: 'private' }), /jid/);
  assert.throws(() => a.add({ jid: 'y@s.whatsapp.net', name: ' ', kind: 'private' }), /name/);
  assert.deepEqual(a.list(), []);
});

test('a corrupt file reads as empty (logged), never throws into the bridge', () => {
  const file = fileIn();
  writeFileSync(file, '{not json');
  const errors = [];
  assert.deepEqual(createMemoryChats({ file, log: (m) => errors.push(m) }).list(), []);
  assert.equal(errors.length, 1);
});
