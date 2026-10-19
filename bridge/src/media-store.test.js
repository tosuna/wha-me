import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMediaStore, pruneOldDays, safeFileName } from './media-store.js';

const AT = Date.UTC(2026, 9, 15, 18); // midday in Mexico: 2026-10-15 in any American timezone

const setup = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'media-')), 'media');
  return { dir, store: createMediaStore({ dir }) };
};

test('saves under <dir>/<YYYY-MM-DD>/<msgId>-<name>, dirs 0700 and file 0600', async () => {
  const { dir, store } = setup();
  const path = await store.save({ id: 'ABC123', fileName: 'reporte.xlsx', at: AT, buf: Buffer.from('XLSX') });
  assert.equal(path, join(dir, '2026-10-15', 'ABC123-reporte.xlsx'));
  assert.equal(readFileSync(path, 'utf8'), 'XLSX');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('the same msgId is saved once and never rewritten', async () => {
  const { store } = setup();
  const a = await store.save({ id: 'ID1', fileName: 'a.pdf', at: AT, buf: Buffer.from('first') });
  const b = await store.save({ id: 'ID1', fileName: 'a.pdf', at: AT, buf: Buffer.from('second') });
  assert.equal(a, b);
  assert.equal(readFileSync(a, 'utf8'), 'first');
  assert.deepEqual(readdirSync(dirname(a)), ['ID1-a.pdf']);
});

test('malicious names and ids stay inside the media folder', async () => {
  const { dir, store } = setup();
  const names = ['../../x', '/etc/passwd', '..', '.', 'a\0b.txt', '\0', '..\\..\\win.ini', 'dir/', '', null, '.bashrc', '\u202Egnp.exe'];
  for (const [i, fileName] of names.entries()) {
    const path = await store.save({ id: `I${i}`, fileName, at: AT, buf: Buffer.from('x') });
    assert.equal(dirname(path), join(dir, '2026-10-15'), `${JSON.stringify(fileName)} -> ${path}`);
  }
  const evil = await store.save({ id: '../../../tmp/evil', fileName: 'x', at: AT, buf: Buffer.from('x') });
  assert.equal(dirname(evil), join(dir, '2026-10-15'));
});

test('safeFileName: basename, no control or bidi chars, no leading dots, extension kept, <= 100 chars, fallback documento', () => {
  assert.equal(safeFileName('../../x'), 'x');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\a\\b.docx'), 'b.docx');
  assert.equal(safeFileName('..'), 'documento');
  assert.equal(safeFileName('a\0b\n.txt'), 'ab.txt');
  assert.equal(safeFileName('..hidden.pdf'), 'hidden.pdf');
  assert.equal(safeFileName('\u202Egnp.exe'), 'gnp.exe');
  assert.equal(safeFileName(undefined), 'documento');
  const long = safeFileName(`${'a'.repeat(300)}.xlsx`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('.xlsx'));
});

test('pruneOldDays removes date folders older than 10 days, keeps recent ones and anything else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tmp-'));
  const dir = join(root, 'media-tmp');
  const now = new Date(2026, 9, 19, 12).getTime(); // local 2026-10-19
  for (const d of ['2026-10-01', '2026-10-08', '2026-10-09', '2026-10-19']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'x.png'), 'x');
  }
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, '2020-01-01'), 'a file, not a folder');
  writeFileSync(join(root, 'outside.txt'), 'x');
  pruneOldDays({ dir, days: 10, now });
  assert.deepEqual(readdirSync(dir).sort(), ['2020-01-01', '2026-10-09', '2026-10-19', 'notes']);
  assert.ok(existsSync(join(root, 'outside.txt')));
  pruneOldDays({ dir: join(root, 'missing'), now }); // no folder yet: no-op
});
