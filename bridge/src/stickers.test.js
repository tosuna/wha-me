import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStickerStore } from './stickers.js';

// Fixture shaped like WhatsApp Desktop's group container: Sticker.sqlite, BackedUpKeyValue.sqlite and stickers/<dir>/<file>.webp.
const hash = (n) => Buffer.alloc(32, n).toString('base64'); // standard base64, like ZFILEHASH
const id = (n) => Buffer.alloc(32, n).toString('base64url');
const webp = (tag) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(`WEBP${tag}`)]);

const varint = (n) => {
  const out = [];
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
  return Buffer.from(out);
};
const field = (no, bytes) => Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes]);
// rs.v2 blob: repeated field 1 Entry { 1: id string, 2: float32 weight, 3: varint timestamp ms }.
const recentsBlob = (hashes) => Buffer.concat(hashes.map((h) => field(1, Buffer.concat([
  field(1, Buffer.from(h)), Buffer.from([0x15, 0, 0, 0x80, 0x3f]), varint(0x18), varint(1_760_000_000_000),
]))));

function fixture({ withKv = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wa-stickers-'));
  mkdirSync(join(root, 'stickers', 'no-sticker-pack'), { recursive: true });
  mkdirSync(join(root, 'stickers', 'pack-a'), { recursive: true });
  writeFileSync(join(root, 'secret.webp'), webp('secret'));
  const db = new DatabaseSync(join(root, 'Sticker.sqlite'));
  db.exec(`CREATE TABLE ZWACDABSTRACTSTICKERPACK (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZNAME TEXT, ZSTICKERPACKID TEXT, ZORDER INTEGER);
    CREATE TABLE ZWACDSTICKER (Z_PK INTEGER PRIMARY KEY, ZSTICKERPACK INTEGER, ZSORT INTEGER, ZFILEHASH TEXT, ZEMOJIS TEXT, ZRELATIVEIMAGEPATH TEXT, ZMIMETYPE TEXT);
    INSERT INTO ZWACDABSTRACTSTICKERPACK VALUES (1, 2, 'Mine', 'mine-id', 2), (2, 3, 'Store pack', 'store-id', 1), (3, 3, 'Not downloaded', 'nd-id', 0);`);
  const add = db.prepare('INSERT INTO ZWACDSTICKER (ZSTICKERPACK, ZSORT, ZFILEHASH, ZEMOJIS, ZRELATIVEIMAGEPATH, ZMIMETYPE) VALUES (?, ?, ?, ?, ?, ?)');
  const sticker = (n, pack, sort, rel, emojis = '😀 🎉', onDisk = true) => {
    add.run(pack, sort, hash(n), emojis, rel, 'image/webp');
    if (onDisk) writeFileSync(join(root, 'stickers', rel), webp(String(n)));
  };
  sticker(1, null, 0, 'no-sticker-pack/one.webp');
  sticker(2, null, 1, 'no-sticker-pack/two.webp', null);
  sticker(3, 1, 1, 'pack-a/three.webp');
  sticker(4, 1, 0, 'pack-a/four.webp');
  sticker(5, 2, 0, 'pack-a/five.webp');
  sticker(6, 3, 0, 'pack-b/six.webp', '', false); // store pack never downloaded
  sticker(7, null, 2, '../secret.webp', '', false); // traversal: must never be served
  sticker(8, null, 3, 'no-sticker-pack/notwebp.webp', '', false);
  writeFileSync(join(root, 'stickers', 'no-sticker-pack', 'notwebp.webp'), 'plain text');
  db.close();
  if (withKv) {
    const kv = new DatabaseSync(join(root, 'BackedUpKeyValue.sqlite'));
    kv.exec('CREATE TABLE ZWAKEYVALUEELEMENT (Z_PK INTEGER PRIMARY KEY, ZKEY TEXT, ZNAMESPACE TEXT, ZVALUE BLOB, ZSORT INTEGER, ZDATE REAL)');
    const kvAdd = kv.prepare('INSERT INTO ZWAKEYVALUEELEMENT (ZKEY, ZNAMESPACE, ZVALUE, ZSORT) VALUES (?, ?, ?, ?)');
    kvAdd.run(hash(1), 'fs.v2', null, 10);
    kvAdd.run(hash(3), 'fs.v2', null, 12); // newest favorite
    kvAdd.run(hash(6), 'fs.v2', null, 11); // file missing: dropped
    kvAdd.run(hash(9), 'fs.v2', null, 13); // unknown sticker: dropped
    kvAdd.run(hash(2), 'other', null, 99);
    kvAdd.run('ordered_regular_recent_stickers_data', 'rs.v2', recentsBlob([hash(4), hash(9), hash(1)]), 0);
    kv.close();
  }
  return root;
}

test('list: favorites (newest first), recents (blob order) and packs with files on disk', () => {
  const l = createStickerStore({ root: fixture() }).list();
  assert.equal(l.available, true);
  assert.deepEqual(l.favorites, [{ id: id(3), emojis: ['😀', '🎉'] }, { id: id(1), emojis: ['😀', '🎉'] }]);
  assert.deepEqual(l.recents.map((s) => s.id), [id(4), id(1)]);
  assert.deepEqual(l.packs.map((p) => [p.id, p.name, p.stickers.map((s) => s.id)]), [
    ['store-id', 'Store pack', [id(5)]],
    ['mine-id', 'Mine', [id(4), id(3)]],
  ]);
});

test('list without WhatsApp Desktop: available false, empty lists, no throw', () => {
  assert.deepEqual(createStickerStore({ root: join(tmpdir(), 'no-such-wa-root') }).list(), { available: false, favorites: [], recents: [], packs: [] });
});

test('list without the key-value store: packs still listed, no favorites or recents', () => {
  const l = createStickerStore({ root: fixture({ withKv: false }) }).list();
  assert.equal(l.available, true);
  assert.deepEqual([l.favorites, l.recents], [[], []]);
  assert.equal(l.packs.length, 2);
});

test('file: the webp for a known id; null for unknown, malformed, traversal or non-webp', () => {
  const s = createStickerStore({ root: fixture() });
  assert.deepEqual(s.file(id(1)), webp('1'));
  assert.equal(s.file(id(9)), null, 'unknown');
  assert.equal(s.file(id(6)), null, 'not on disk');
  assert.equal(s.file(id(7)), null, '../ in ZRELATIVEIMAGEPATH');
  assert.equal(s.file(id(8)), null, 'not a webp');
  for (const bad of ['', '../secret', hash(1), 'x'.repeat(43) + '/']) assert.equal(s.file(bad), null, bad);
  assert.equal(createStickerStore({ root: join(tmpdir(), 'no-such-wa-root') }).file(id(1)), null);
});
