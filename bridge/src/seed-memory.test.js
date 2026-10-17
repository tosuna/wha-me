import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headerName, parseExport, seedMemory } from './seed-memory.js';
import { createArchivist } from './archivist.js';
import { createTopics, opaqueKey } from './topics.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 16, 9, 0, 0).getTime(); // Oct 16 2026, local
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const noon = (ms, s = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, s).getTime(); };

test('headerName: the last parentheses group, nested parentheses kept, text before the first comma', () => {
  assert.equal(headerName('# Chat de trabajo con Ciro: OWNER (yo) con CONTACTO (Ciro)'), 'Ciro');
  assert.equal(headerName('# Chat de trabajo (Acme): OWNER (yo) con CONTACTO (Hugo (Acme))'), 'Hugo (Acme)');
  assert.equal(headerName('# Chat de trabajo: OWNER (yo) con CONTACTO (Elio, jefe)'), 'Elio');
  assert.equal(headerName('# sin nombre'), null);
});

test('parseExport: day and speaker blocks, one message per line, timestamps from 12:00 local 1 s apart per day', () => {
  const { name, messages } = parseExport([
    '# Chat de trabajo: OWNER (yo) con CONTACTO (Dalia)',
    'basura antes del primer día',
    '===== 2026-10-01 =====',
    'CONTACTO:',
    'hola',
    'me mandas el excel',
    '',
    'OWNER:',
    'va',
    '===== 2026-10-02 =====',
    'OWNER:',
    'listo',
  ].join('\n'), 'OWNER');
  assert.equal(name, 'Dalia');
  assert.deepEqual(messages, [
    { author: 'CONTACTO', text: 'hola', at: new Date(2026, 9, 1, 12, 0, 0).getTime() },
    { author: 'CONTACTO', text: 'me mandas el excel', at: new Date(2026, 9, 1, 12, 0, 1).getTime() },
    { author: 'OWNER', text: 'va', at: new Date(2026, 9, 1, 12, 0, 2).getTime() },
    { author: 'OWNER', text: 'listo', at: new Date(2026, 9, 2, 12, 0, 0).getTime() },
  ]);
});

const DAR_PN = '5210000000001@s.whatsapp.net';
const CONTACTS = [
  { jid: '777@lid', name: 'Ciro', register: 'tu' }, // same person, listed first: the canonical key
  { jid: DAR_PN, name: 'Ciro', register: 'tu' },
  { jid: 'g@g.us', name: 'Grupo', type: 'group', respondTo: [{ name: 'Mara', jids: [] }] },
];

function fixture({ archive } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-seed-'));
  const exports = join(dir, 'conversaciones');
  mkdirSync(exports);
  {
    const recent = NOW - 2 * DAY;
    writeFileSync(join(exports, 'contacto_0001.txt'), [
      '# Chat de trabajo: OWNER (yo) con CONTACTO (Ciro, enlace)',
      `===== ${ymd(NOW - 40 * DAY)} =====`, 'CONTACTO:', 'mensaje-viejo-fuera-de-ventana',
      `===== ${ymd(recent)} =====`, 'CONTACTO:', ...Array.from({ length: 150 }, (_, i) => `texto-ciro-${i}`),
      'OWNER:', ...Array.from({ length: 100 }, (_, i) => `texto-owner-${i}`),
    ].join('\n'));
    writeFileSync(join(exports, 'hugo_9999.txt'), [
      '# Chat de trabajo: OWNER (yo) con CONTACTO (Hugo (Acme))',
      `===== ${ymd(recent)} =====`, 'CONTACTO:', 'texto-hugo',
    ].join('\n'));
    writeFileSync(join(exports, 'notas.md'), 'no es un export');
    const calls = [];
    const runs = [];
    const archivist = { archive: async (a) => { calls.push(a); return (archive ?? (() => ({ applied: 2, rejected: [{ reason: 'x' }], costUsd: 0.01 })))(a); } };
    const runLog = { start: (a) => { const r = { a, events: [], end: null }; runs.push(r); return { event: (e) => r.events.push(e), finish: () => { r.end = 'ok'; }, fail: () => { r.end = 'error'; } }; } };
    const logs = [];
    const seed = (opts = {}) => seedMemory({
      profile: PROFILE, dir: exports, contacts: CONTACTS, archivist, runLog, stateFile: join(dir, 'state', 'seeded-exports.json'), now: () => NOW, log: (l) => logs.push(l), batch: 200, ...opts,
    });
    return { seed, calls, runs, logs, recent };
  }
}

test('seed: 30-day window, phone-suffix mapping to the canonical chat key, batches of at most 200, run-log kind archive', async () => {
  const f = fixture();
  await f.seed();
  const dar = f.calls.filter((c) => c.chat.jid === '777@lid');
  assert.deepEqual(dar.map((c) => c.entries.length), [200, 50]);
  assert.deepEqual(dar[0].chat, { jid: '777@lid', name: 'Ciro', kind: 'private' });
  const entries = dar.flatMap((c) => c.entries);
  assert.ok(!entries.some((e) => e.text === 'mensaje-viejo-fuera-de-ventana'));
  assert.deepEqual(entries[0], { author: 'CONTACTO', name: 'Ciro', person: 'ciro', text: 'texto-ciro-0', at: noon(f.recent) });
  assert.deepEqual(entries.at(-1), { author: 'OWNER', name: 'owner', person: 'owner', text: 'texto-owner-99', at: noon(f.recent, 249) });
  assert.deepEqual(dar[0].knownPeople, [{ name: 'Ciro', key: 'ciro' }, { name: 'Mara', key: 'mara' }]);
  const wal = f.calls.find((c) => c.chat.jid === 'export:hugo_9999.txt');
  assert.deepEqual(wal.chat, { jid: 'export:hugo_9999.txt', name: 'Hugo (Acme)', kind: 'private' });
  assert.equal(wal.entries[0].person, opaqueKey('export:hugo_9999.txt')); // not in contacts.json: never a name
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.runs.map((r) => [r.a.kind, r.a.mode, r.end, r.events.find((e) => e.kind === 'result').costUsd]),
    [['archive', 'real', 'ok', 0.01], ['archive', 'real', 'ok', 0.01], ['archive', 'real', 'ok', 0.01]]);
});

test('seed: an export mapped to a persona contact is skipped (persona chats never feed the memory)', async () => {
  const f = fixture();
  await f.seed({ contacts: CONTACTS.map((c) => (c.jid === DAR_PN ? { ...c, persona: '/abs/p.md' } : c)) });
  assert.deepEqual(f.calls.map((c) => c.chat.jid), ['export:hugo_9999.txt']);
  assert.match(f.logs.join('\n'), /contacto_0001\.txt: chat con persona/);
});

test('seed: summary per file (window, ops, cost) and never a message text', async () => {
  const f = fixture();
  await f.seed();
  const out = f.logs.join('\n');
  assert.match(out, /contacto_0001\.txt.*250 mensajes.*4 ops aplicadas.*2 rechazadas.*\$0\.0200/);
  assert.match(out, /hugo_9999\.txt.*1 mensaje\b/);
  assert.doesNotMatch(out, /texto-|mensaje-viejo/);
});

test('seed: idempotent (seeded files skipped) unless force; a failed batch leaves the file unseeded', async () => {
  let fail = true;
  const f = fixture({ archive: (a) => (fail && a.chat.jid.startsWith('export:') ? { applied: 0, rejected: [], costUsd: 0.002, error: 'Unexpected token texto-hugo' } : { applied: 1, rejected: [], costUsd: 0.01 }) });
  await f.seed();
  assert.equal(f.calls.length, 3);
  assert.ok(f.runs.some((r) => r.end === 'error'));
  assert.doesNotMatch(f.logs.join('\n'), /texto-/, 'the archivist error is not printed (it can quote the model output)');
  fail = false;
  await f.seed();
  assert.deepEqual(f.calls.slice(3).map((c) => c.chat.jid), ['export:hugo_9999.txt']);
  await f.seed();
  assert.equal(f.calls.length, 4);
  await f.seed({ force: true });
  assert.equal(f.calls.length, 7);
});

test('seed through the real archivist: msg-cited ops land with the export contact as said_by', async () => {
  const topics = createTopics({ profile: PROFILE, file: ':memory:', now: () => NOW });
  const run = async () => ({ costUsd: 0.01, text: JSON.stringify({ ops: [
    { op: 'new_topic', ref: 'n', title: 'Lista de sedes', msg: 0 },
    { op: 'add_fact', topic: 'n', text: 'Ciro mandó la base', said_by: 'owner', msg: 0 },
  ] }) });
  const f = fixture();
  const archivist = createArchivist({ profile: PROFILE, topics, run, leaks: () => false, now: () => NOW });
  await f.seed({ archivist });
  const facts = topics.list().flatMap((t) => topics.get(t.id).facts);
  // per batch, msg 0 is: Ciro (1st), Alex (2nd batch: entries 200-249), Hugo; the forged said_by is ignored
  assert.deepEqual(facts.map((x) => x.saidBy).sort(), ['ciro', 'owner', opaqueKey('export:hugo_9999.txt')].sort());
  assert.ok(topics.list().every((t) => t.participants.length === 1));
});
