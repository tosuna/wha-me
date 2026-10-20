import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContactLinks, linkGroupOf } from './contact-links.js';

const WA = '5218111111111@s.whatsapp.net';
const TG = 'tg:123';
const TG2 = 'tg:456';
const GROUP = 'obras@g.us';
const KNOWN = [{ jid: WA, kind: 'private' }, { jid: TG, kind: 'private' }, { jid: TG2, kind: 'private' }, { jid: GROUP, kind: 'group' }];
const fileIn = () => join(mkdtempSync(join(tmpdir(), 'wa-links-')), 'contact-links.json');

test('missing file is empty; link persists one group per person; groupOf ignores the device suffix; unlink drops the group', () => {
  const file = fileIn();
  const links = createContactLinks({ file });
  assert.deepEqual(links.list(), []);
  links.link(WA, TG, KNOWN);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ jids: [WA, TG] }]);
  assert.deepEqual(createContactLinks({ file }).groupOf('5218111111111:7@s.whatsapp.net'), { jids: [WA, TG] });
  assert.equal(links.groupOf(TG2), null);
  assert.equal(links.unlink(TG), true);
  assert.deepEqual(links.list(), []);
  assert.equal(links.unlink(TG), false);
});

test('every list() reads the file fresh (portal writes, bridge reads live); malformed groups are ignored', () => {
  const file = fileIn();
  const links = createContactLinks({ file });
  writeFileSync(file, JSON.stringify([{ jids: [WA, TG] }, { nope: 1 }, null]));
  assert.deepEqual(links.list(), [{ jids: [WA, TG] }]);
});

test('link refuses an unknown jid, a self-link, a group and a jid already linked; nothing is written', () => {
  const file = fileIn();
  const links = createContactLinks({ file });
  assert.throws(() => links.link(WA, 'tg:999', KNOWN), /desconocido/);
  assert.throws(() => links.link(WA, WA, KNOWN), /consigo mismo/);
  assert.throws(() => links.link(WA, GROUP, KNOWN), /grupo/);
  assert.throws(() => links.link(42, TG, KNOWN), /desconocido/);
  assert.deepEqual(links.list(), []);
  links.link(WA, TG, KNOWN);
  assert.throws(() => links.link(TG2, WA, KNOWN), /ya está enlazado/);
  assert.throws(() => links.link(TG, WA, KNOWN), /ya está enlazado/);
  assert.deepEqual(links.list(), [{ jids: [WA, TG] }]);
});

test('a corrupt file reads as empty (logged), never throws into the bridge', () => {
  const file = fileIn();
  writeFileSync(file, '{not json');
  const errors = [];
  assert.deepEqual(createContactLinks({ file, log: (m) => errors.push(m) }).list(), []);
  assert.equal(errors.length, 1);
  assert.equal(linkGroupOf([], WA), null);
});
