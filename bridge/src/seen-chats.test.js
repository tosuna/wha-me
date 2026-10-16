import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeenChats, MAX_SEEN } from './seen-chats.js';

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'wa-seen-')), 'seen-chats.json');

test('record: counts, keeps the latest name and lastAt, newest first; only {jid,name,kind,lastAt,count} reach the file', () => {
  const file = fileIn();
  const s = createSeenChats({ file });
  s.record({ jid: 'a@s.whatsapp.net', name: 'Dalia', kind: 'private', at: 10, text: 'secreto' });
  s.record({ jid: 'g@g.us', name: 'Obras', kind: 'group', at: 20 });
  s.record({ jid: 'a@s.whatsapp.net', name: null, kind: 'private', at: 30 });
  assert.deepEqual(createSeenChats({ file }).list(), [
    { jid: 'a@s.whatsapp.net', name: 'Dalia', kind: 'private', lastAt: 30, count: 2 },
    { jid: 'g@g.us', name: 'Obras', kind: 'group', lastAt: 20, count: 1 },
  ]);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /secreto/);
  s.remove('a@s.whatsapp.net');
  assert.deepEqual(s.list().map((c) => c.jid), ['g@g.us']);
});

test(`capped at ${MAX_SEEN}, the oldest dropped`, () => {
  const s = createSeenChats({ file: fileIn() });
  for (let i = 0; i <= MAX_SEEN; i++) s.record({ jid: `${i}@s.whatsapp.net`, name: null, kind: 'private', at: i });
  const list = s.list();
  assert.equal(list.length, MAX_SEEN);
  assert.equal(list[0].jid, `${MAX_SEEN}@s.whatsapp.net`);
  assert.ok(!list.some((c) => c.jid === '0@s.whatsapp.net'));
});
