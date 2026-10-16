import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaStore } from './media-store.js';
import { connectWa, createNormalizer, messageText } from './wa.js';

const SELF = '5210000000000@s.whatsapp.net';
const SELF_LID = '999@lid';
const BEA = '5210000000111@s.whatsapp.net';
const BEA_LID = '111@lid';

function setup(map = { [BEA_LID]: '5210000000111:0@s.whatsapp.net' }) {
  const notes = [];
  const lookups = [];
  const normalize = createNormalizer({
    self: () => ({ selfJid: SELF, selfLid: SELF_LID }),
    pnForLid: async (lid) => { lookups.push(lid); return map[lid] ?? null; },
    onUnresolved: (jid) => notes.push(jid),
  });
  return { normalize, notes, lookups };
}

const m = (key, message = { conversation: 'hola' }) => ({ key: { id: 'X', ...key }, message, messageTimestamp: 1_700_000_000 });

test('PN chats pass through', async () => {
  const { normalize } = setup();
  const msg = await normalize(m({ remoteJid: BEA }));
  assert.equal(msg.chatJid, BEA);
  assert.equal(msg.text, 'hola');
  assert.equal(msg.timestamp, 1_700_000_000_000);
});

test('@lid chats resolve through the LID mapping store', async () => {
  const { normalize, lookups } = setup();
  assert.equal((await normalize(m({ remoteJid: BEA_LID }))).chatJid, BEA);
  assert.deepEqual(lookups, [BEA_LID]);
});

test('fromMe never trusts remoteJidAlt', async () => {
  const { normalize } = setup({});
  const msg = await normalize(m({ remoteJid: BEA_LID, fromMe: true, remoteJidAlt: SELF }));
  assert.equal(msg, null);
});

test('incoming @lid falls back to remoteJidAlt when the store has no mapping', async () => {
  const { normalize } = setup({});
  assert.equal((await normalize(m({ remoteJid: BEA_LID, remoteJidAlt: BEA }))).chatJid, BEA);
});

test('own LID maps to the self-chat', async () => {
  const { normalize } = setup();
  assert.equal((await normalize(m({ remoteJid: SELF_LID, fromMe: true }))).chatJid, SELF);
});

test('unresolved @lid is dropped with one self-chat note per jid', async () => {
  const { normalize, notes } = setup({});
  assert.equal(await normalize(m({ remoteJid: '222@lid' })), null);
  assert.equal(await normalize(m({ remoteJid: '222@lid' })), null);
  assert.deepEqual(notes, ['222@lid']);
});

test('groups and broadcasts are ignored', async () => {
  const { normalize } = setup();
  assert.equal(await normalize(m({ remoteJid: '123@g.us' })), null);
  assert.equal(await normalize(m({ remoteJid: 'status@broadcast' })), null);
});

test('messageText renders non-text messages as placeholders', () => {
  assert.equal(messageText({ conversation: 'hola' }), 'hola');
  assert.equal(messageText({ extendedTextMessage: { text: 'link' } }), 'link');
  assert.equal(messageText({ audioMessage: {} }), '[audio]');
  assert.equal(messageText({ imageMessage: { caption: 'el error' } }), '[imagen: el error]');
  assert.equal(messageText({ imageMessage: {} }), '[imagen]');
  assert.equal(messageText({ videoMessage: { caption: 'asi sale' } }), '[video: asi sale]');
  assert.equal(messageText({ documentMessage: { fileName: 'oficio.pdf' } }), '[documento: oficio.pdf]');
  assert.equal(messageText({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.xlsx', caption: 'ahi va' } } } }), '[documento: a.xlsx] ahi va');
  assert.equal(messageText({ stickerMessage: {} }), '[sticker]');
  assert.equal(messageText({ reactionMessage: { text: '👍' } }), '');
  assert.equal(messageText(undefined), '');
});

// --- audio transcription (fake download/transcribe, never Baileys or the venv) ---

function audioSetup(transcribeImpl = async () => 'hola desde el audio', { shouldTranscribe = (jid) => jid === BEA, bytes = 'OGG' } = {}) {
  const downloads = [];
  const transcribed = [];
  const errors = [];
  const normalize = createNormalizer({
    self: () => ({ selfJid: SELF, selfLid: SELF_LID }),
    pnForLid: async () => null,
    onUnresolved: () => {},
    download: async (msg) => { downloads.push(msg); return Buffer.from(bytes); },
    transcribe: async (buf) => { transcribed.push(buf.toString()); return transcribeImpl(buf); },
    logError: (...a) => errors.push(a.join(' ')),
    ...(shouldTranscribe && { shouldTranscribe }),
  });
  return { normalize, downloads, transcribed, errors };
}

const audio = (seconds = 12, extra = {}) => ({ audioMessage: { seconds, ptt: true, fileLength: 20_000, ...extra } });
const MB8 = 8 * 1024 * 1024;

test('a transcribed audio becomes [audio] <transcript> (incoming and fromMe)', async () => {
  const a = audioSetup();
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio] hola desde el audio');
  assert.equal((await a.normalize(m({ remoteJid: BEA, fromMe: true }, audio()))).text, '[audio] hola desde el audio');
  assert.equal(a.downloads.length, 2);
  assert.deepEqual(a.transcribed, ['OGG', 'OGG']);
});

test('a transcriber failure becomes (no se pudo transcribir) and logs without the content', async () => {
  const a = audioSetup(async () => { throw new Error('venv missing'); });
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio] (no se pudo transcribir)');
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /venv missing/);
});

test('an audio longer than 10 min is not downloaded nor transcribed', async () => {
  const a = audioSetup();
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(601)))).text, '[audio de 11 min, no transcrito]');
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(600)))).text, '[audio] hola desde el audio');
  assert.equal(a.downloads.length, 1);
});

test('an empty transcript becomes (sin voz)', async () => {
  const a = audioSetup(async () => '');
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio] (sin voz)');
});

test('an audio from a chat not allowed by shouldTranscribe stays [audio] and is never downloaded', async () => {
  const seen = [];
  const a = audioSetup(undefined, { shouldTranscribe: (jid) => { seen.push(jid); return false; } });
  const msg = await a.normalize(m({ remoteJid: '5210000000222@s.whatsapp.net' }, audio()));
  assert.equal(msg.text, '[audio]');
  assert.deepEqual(seen, ['5210000000222@s.whatsapp.net']);
  assert.equal(a.downloads.length + a.transcribed.length, 0);
});

test('the default predicate transcribes nothing but the self-chat', async () => {
  const a = audioSetup(undefined, { shouldTranscribe: null });
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio]');
  assert.equal(a.downloads.length, 0);
  assert.equal((await a.normalize(m({ remoteJid: SELF_LID, fromMe: true }, audio()))).text, '[audio] hola desde el audio');
  assert.equal((await a.normalize(m({ remoteJid: SELF, fromMe: true }, audio()))).text, '[audio] hola desde el audio');
  assert.equal(a.downloads.length, 2);
});

test('an audio over 8 MB or without fileLength is not downloaded', async () => {
  const a = audioSetup();
  const big = '[audio] (demasiado grande, no transcrito)';
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(12, { fileLength: MB8 + 1 })))).text, big);
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(12, { fileLength: { toNumber: () => MB8 + 1 } })))).text, big);
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(12, { fileLength: undefined })))).text, big);
  assert.equal(a.downloads.length, 0);
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio(12, { fileLength: { toNumber: () => MB8 } })))).text, '[audio] hola desde el audio');
  assert.equal(a.downloads.length, 1);
});

test('a downloaded buffer over 8 MB is not transcribed (fileLength can lie)', async () => {
  const a = audioSetup(undefined, { bytes: 'x'.repeat(MB8 + 1) });
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio] (demasiado grande, no transcrito)');
  assert.equal(a.downloads.length, 1);
  assert.equal(a.transcribed.length, 0);
});

test('a too-long error from the transcriber (real duration) becomes [audio de más de 10 min, no transcrito]', async () => {
  const a = audioSetup(async () => { throw Object.assign(new Error('audio longer than 600 s'), { tooLong: true }); });
  assert.equal((await a.normalize(m({ remoteJid: BEA }, audio()))).text, '[audio de más de 10 min, no transcrito]');
});

test('text and image messages never download or transcribe', async () => {
  const a = audioSetup();
  assert.equal((await a.normalize(m({ remoteJid: BEA }))).text, 'hola');
  assert.equal((await a.normalize(m({ remoteJid: BEA }, { imageMessage: { caption: 'el error' } }))).text, '[imagen: el error]');
  assert.equal(a.downloads.length + a.transcribed.length, 0);
});

// --- documents: saved to disk for gated chats, announced in the self-chat; the text stays the placeholder ---

const DOC_AT = Date.UTC(2026, 9, 15, 18) / 1000; // 2026-10-15 in any American timezone
const MB25 = 25 * 1024 * 1024;
const doc = (extra = {}) => ({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'reporte.xlsx', caption: 'ahi va', fileLength: 2048, ...extra } } } });
const docMsg = (key, message = doc()) => ({ ...m(key, message), messageTimestamp: DOC_AT });

function docSetup({ shouldTranscribe = (jid) => jid === BEA, downloadImpl = async () => Buffer.from('XLSX') } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'wa-doc-')), 'media');
  const downloads = [];
  const notices = [];
  const errors = [];
  const normalize = createNormalizer({
    self: () => ({ selfJid: SELF, selfLid: SELF_LID }),
    pnForLid: async () => null,
    onUnresolved: () => {},
    download: async (msg) => { downloads.push(msg); return downloadImpl(msg); },
    shouldTranscribe,
    allowGroup: (jid) => jid === GRP,
    saveDocument: createMediaStore({ dir }).save,
    notice: (text) => notices.push(text),
    nameOf: (jid) => ({ [BEA]: 'Bea', [GRP]: 'Obras' })[jid] ?? jid,
    logError: (...a) => errors.push(a.join(' ')),
  });
  const files = () => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()) : []);
  return { normalize, dir, downloads, notices, errors, files };
}

test('a document from an allowed chat is saved (0600) and announced with its path; the text is unchanged', async () => {
  const d = docSetup();
  const msg = await d.normalize(docMsg({ remoteJid: BEA, id: 'DOC1' }));
  const path = join(d.dir, '2026-10-15', 'DOC1-reporte.xlsx');
  assert.equal(msg.text, '[documento: reporte.xlsx] ahi va');
  assert.equal(d.downloads.length, 1);
  assert.equal(readFileSync(path, 'utf8'), 'XLSX');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(d.notices, [`📎 Bea: reporte.xlsx guardado en ${path}`]);
});

test('a document in an allowlisted group asks the gate with the participant ids and is saved', async () => {
  const asked = [];
  const d = docSetup({ shouldTranscribe: (jid, ids) => { asked.push([jid, ids]); return true; } });
  const msg = await d.normalize(docMsg({ remoteJid: GRP, participant: IKER_LID, participantAlt: IKER_PN, id: 'G1' }));
  assert.equal(msg.text, '[documento: reporte.xlsx] ahi va');
  assert.deepEqual(asked.map(([jid, ids]) => [jid, ids.sort()]), [[GRP, [IKER_LID, IKER_PN].sort()]]);
  assert.deepEqual(d.notices, [`📎 Obras: reporte.xlsx guardado en ${join(d.dir, '2026-10-15', 'G1-reporte.xlsx')}`]);
});

test('a document from a chat outside the gate (or the self-chat) is not downloaded, saved nor announced', async () => {
  const d = docSetup();
  const other = await d.normalize(docMsg({ remoteJid: '5210000000222@s.whatsapp.net', id: 'N1' }));
  const own = await d.normalize(docMsg({ remoteJid: SELF, fromMe: true, id: 'N2' }));
  assert.deepEqual([other.text, own.text], ['[documento: reporte.xlsx] ahi va', '[documento: reporte.xlsx] ahi va']);
  assert.deepEqual([d.downloads.length, d.files(), d.notices], [0, [], []]);
});

test('a document over 25 MB (declared, missing, or real) is not saved and the text says it is too big', async () => {
  const big = '[documento demasiado grande: reporte.xlsx] ahi va';
  const d = docSetup();
  assert.equal((await d.normalize(docMsg({ remoteJid: BEA, id: 'B1' }, doc({ fileLength: MB25 + 1 })))).text, big);
  assert.equal((await d.normalize(docMsg({ remoteJid: BEA, id: 'B2' }, doc({ fileLength: { toNumber: () => MB25 + 1 } })))).text, big);
  assert.equal((await d.normalize(docMsg({ remoteJid: BEA, id: 'B3' }, doc({ fileLength: undefined })))).text, big);
  assert.equal(d.downloads.length, 0);
  const lying = docSetup({ downloadImpl: async () => Buffer.alloc(MB25 + 1) });
  assert.equal((await lying.normalize(docMsg({ remoteJid: BEA, id: 'B4' }))).text, big);
  assert.deepEqual([lying.downloads.length, lying.files()], [1, []]);
});

test('a malicious file name is saved inside the media folder', async () => {
  const d = docSetup();
  await d.normalize(docMsg({ remoteJid: BEA, id: 'M1' }, doc({ fileName: '../../../etc/passwd' })));
  assert.deepEqual(d.files(), [join('2026-10-15', 'M1-passwd')]);
});

test('a failed download is announced with the reason and handling continues', async () => {
  const d = docSetup({ downloadImpl: async () => { throw new Error('media key expired'); } });
  const msg = await d.normalize(docMsg({ remoteJid: BEA, id: 'F1' }));
  assert.equal(msg.text, '[documento: reporte.xlsx] ahi va');
  assert.deepEqual(d.notices, ['📎 Bea: no pude descargar reporte.xlsx (media key expired)']);
  assert.equal(d.errors.length, 1);
  assert.deepEqual(d.files(), []);
});

test('the same document msgId twice leaves a single file, never rewritten', async () => {
  let n = 0;
  const d = docSetup({ downloadImpl: async () => Buffer.from(`v${++n}`) });
  await d.normalize(docMsg({ remoteJid: BEA, id: 'D1' }));
  await d.normalize(docMsg({ remoteJid: BEA, id: 'D1' }));
  assert.deepEqual(d.files(), [join('2026-10-15', 'D1-reporte.xlsx')]);
  assert.equal(readFileSync(join(d.dir, '2026-10-15', 'D1-reporte.xlsx'), 'utf8'), 'v1');
});

// --- connection lifecycle with a fake Baileys socket ---

const close = (statusCode) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
const tick = () => new Promise((r) => setImmediate(r));

function fakeWa({ authName = 'auth', ...opts } = {}) {
  const authDir = join(mkdtempSync(join(tmpdir(), 'wa-conn-')), authName);
  mkdirSync(authDir);
  writeFileSync(join(authDir, 'creds.json'), '{}');
  const socks = [];
  const statuses = [];
  const exits = [];
  let authLoads = 0;
  const p = connectWa({
    authDir,
    onStatus: (s) => statuses.push(s),
    exit: (code) => exits.push(code),
    makeSocket: () => { const sock = { ev: new EventEmitter(), user: { id: SELF } }; socks.push(sock); return sock; },
    useAuth: async () => { authLoads++; return { state: {}, saveCreds: () => {} }; },
    retryMs: 0,
    printQr: () => {},
    ...opts,
  });
  const last = () => socks.at(-1);
  const emit = (u) => last().ev.emit('connection.update', u);
  return { p, authDir, socks, statuses, exits, last, emit, states: () => statuses.map((s) => s.state), authLoads: () => authLoads };
}

test('qr and open are reported as status (qr with its string, open with selfJid, all with at)', async () => {
  const w = fakeWa();
  await tick();
  w.emit({ qr: 'QR-1' });
  w.emit({ connection: 'open' });
  const api = await w.p;
  assert.equal(api.selfJid, SELF);
  assert.deepEqual(w.statuses.map(({ at, ...s }) => s), [{ state: 'connecting' }, { state: 'qr', qr: 'QR-1' }, { state: 'open', selfJid: SELF }]);
  assert.ok(w.statuses.every((s) => !Number.isNaN(Date.parse(s.at))));
});

test('loggedOut wipes the auth dir, reports logged_out, reloads auth and reconnects (no exit)', async () => {
  const w = fakeWa();
  await tick();
  w.emit({ connection: 'open' });
  await w.p;
  w.emit(close(401));
  assert.deepEqual(readdirSync(w.authDir), []);
  assert.ok(existsSync(w.authDir));
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.socks.length, 2);
  assert.equal(w.authLoads(), 2);
  assert.deepEqual(w.states(), ['connecting', 'open', 'logged_out', 'connecting']);
  assert.deepEqual(w.exits, []);
});

test('loggedOut refuses to wipe a directory not named auth', async () => {
  const w = fakeWa({ authName: 'state' });
  await tick();
  assert.throws(() => w.emit(close(401)), /refusing to wipe/);
  assert.deepEqual(readdirSync(w.authDir), ['creds.json']);
});

test('connectionReplaced reports replaced and exits without reconnecting', async () => {
  const w = fakeWa();
  await tick();
  w.emit(close(440));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.states().at(-1), 'replaced');
  assert.deepEqual(w.exits, [1]);
  assert.equal(w.socks.length, 1);
});

test('other closes reconnect', async () => {
  const w = fakeWa();
  await tick();
  w.emit(close(428));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.socks.length, 2);
  assert.deepEqual(w.exits, []);
});

test('relinking a different number reports wrong_number and exits', async () => {
  const w = fakeWa();
  await tick();
  w.emit({ connection: 'open' });
  await w.p;
  w.emit(close(401));
  await new Promise((r) => setTimeout(r, 5));
  w.last().user = { id: BEA };
  w.emit({ connection: 'open' });
  assert.deepEqual(w.statuses.at(-1).state, 'wrong_number');
  assert.equal(w.statuses.at(-1).selfJid, BEA);
  assert.equal(w.statuses.at(-1).expected, SELF);
  assert.deepEqual(w.exits, [1]);
});

test('relinking the same number keeps running', async () => {
  const w = fakeWa();
  await tick();
  w.emit({ connection: 'open' });
  await w.p;
  w.emit(close(401));
  await new Promise((r) => setTimeout(r, 5));
  w.emit({ connection: 'open' });
  assert.equal(w.states().at(-1), 'open');
  assert.deepEqual(w.exits, []);
});

test('connectWa injects download/transcribe/shouldTranscribe into the upsert path', async () => {
  const w = fakeWa({ download: async () => Buffer.from('OGG'), transcribe: async (b) => `oido ${b}`, shouldTranscribe: (jid) => jid === BEA });
  await tick();
  w.emit({ connection: 'open' });
  const api = await w.p;
  const got = [];
  api.onMessage((msg) => got.push(msg.text));
  w.last().ev.emit('messages.upsert', { messages: [m({ remoteJid: BEA }, audio())] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, ['[audio] oido OGG']);
});

test('connectWa injects saveDocument/notice/nameOf into the upsert path', async () => {
  const saved = [];
  const notices = [];
  const w = fakeWa({
    download: async () => Buffer.from('PDF'), shouldTranscribe: (jid) => jid === BEA, nameOf: () => 'Bea', notice: (t) => notices.push(t),
    saveDocument: async ({ id, fileName, buf }) => { saved.push([id, fileName, String(buf)]); return `/m/${id}-${fileName}`; },
  });
  await tick();
  w.emit({ connection: 'open' });
  await w.p;
  w.last().ev.emit('messages.upsert', { messages: [m({ remoteJid: BEA }, doc())] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([saved, notices], [[['X', 'reporte.xlsx', 'PDF']], ['📎 Bea: reporte.xlsx guardado en /m/X-reporte.xlsx']]);
});

// --- allowlisted groups ---

const GRP = '120363000000000001@g.us';
const IKER_LID = '444@lid';
const IKER_PN = '5210000000444@s.whatsapp.net';

function groupSetup({ map = {}, shouldTranscribe } = {}) {
  const logs = [];
  const asked = [];
  const normalize = createNormalizer({
    self: () => ({ selfJid: SELF, selfLid: SELF_LID }),
    pnForLid: async (lid) => map[lid] ?? null,
    onUnresolved: () => {},
    allowGroup: (jid) => jid === GRP,
    download: async () => Buffer.from('OGG'),
    transcribe: async () => 'audio del grupo',
    shouldTranscribe: shouldTranscribe ?? ((jid, ids) => { asked.push([jid, ids]); return false; }),
    log: (...a) => logs.push(a.join(' ')),
  });
  return { normalize, logs, asked };
}

test('allowlisted group message keeps the group as chat, with participant ids (LID + PN alt), pushName and the raw message', async () => {
  const { normalize } = groupSetup();
  const raw = { ...m({ remoteJid: GRP, participant: `${IKER_LID.replace('@', ':3@')}`, participantAlt: IKER_PN }, { conversation: 'no me carga' }), pushName: 'Iker' };
  const msg = await normalize(raw);
  assert.equal(msg.chatJid, GRP);
  assert.equal(msg.text, 'no me carga');
  assert.equal(msg.pushName, 'Iker');
  assert.equal(msg.participant, IKER_PN);
  assert.deepEqual(msg.participantIds.sort(), [IKER_LID, IKER_PN].sort());
  assert.deepEqual(msg.message, { conversation: 'no me carga' });
});

test('group participant LID resolves through the LID mapping store when there is no PN alt', async () => {
  const { normalize } = groupSetup({ map: { [IKER_LID]: '5210000000444:0@s.whatsapp.net' } });
  const msg = await normalize(m({ remoteJid: GRP, participant: IKER_LID }));
  assert.equal(msg.participant, IKER_PN);
  assert.deepEqual(msg.participantIds.sort(), [IKER_LID, IKER_PN].sort());
});

test('a group outside the allowlist is dropped and logged once; broadcasts are dropped', async () => {
  const { normalize, logs } = groupSetup();
  assert.equal(await normalize(m({ remoteJid: '999@g.us', participant: IKER_LID })), null);
  assert.equal(await normalize(m({ remoteJid: '999@g.us', participant: IKER_LID })), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /999@g\.us/);
  assert.equal(await normalize(m({ remoteJid: 'status@broadcast', participant: IKER_LID })), null);
});

test('a skipped group reports jid, time and its subject (groupMetadata fetched once per group), never the text', async () => {
  const seen = [];
  let fetches = 0;
  const w = fakeWa({ allowGroup: () => false, onSkippedGroup: (...a) => seen.push(a) });
  await tick();
  w.last().groupMetadata = async (jid) => { fetches++; return { id: jid, subject: 'Obras Centro' }; };
  w.emit({ connection: 'open' });
  const api = await w.p;
  const got = [];
  api.onMessage((msg) => got.push(msg));
  for (let i = 0; i < 2; i++) w.last().ev.emit('messages.upsert', { messages: [m({ remoteJid: '999@g.us', participant: IKER_LID }, { conversation: 'texto' })] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([got, seen, fetches], [[], [['999@g.us', 1_700_000_000_000, 'Obras Centro'], ['999@g.us', 1_700_000_000_000, 'Obras Centro']], 1]);
});

test('group audio asks shouldTranscribe with the group and the participant ids; refused stays [audio]', async () => {
  const g = groupSetup();
  const msg = await g.normalize(m({ remoteJid: GRP, participant: IKER_LID, participantAlt: IKER_PN }, audio()));
  assert.equal(msg.text, '[audio]');
  assert.deepEqual(g.asked.map(([jid, ids]) => [jid, ids.sort()]), [[GRP, [IKER_LID, IKER_PN].sort()]]);
  const ok = groupSetup({ shouldTranscribe: (jid, ids) => jid === GRP && ids.includes(IKER_PN) });
  assert.equal((await ok.normalize(m({ remoteJid: GRP, participant: IKER_LID, participantAlt: IKER_PN }, audio()))).text, '[audio] audio del grupo');
});

test('sendText quotes a message when asked; fetchGroups returns the participating groups', async () => {
  const sent = [];
  const groups = { [GRP]: { id: GRP, subject: 'Grupo', participants: [] } };
  const w = fakeWa();
  await tick();
  Object.assign(w.last(), {
    sendMessage: async (jid, content, opts) => { sent.push([jid, content, opts]); return { key: { id: `S${sent.length}` } }; },
    groupFetchAllParticipating: async () => groups,
  });
  w.emit({ connection: 'open' });
  const api = await w.p;
  const quoted = { key: { id: 'Q', remoteJid: GRP, participant: IKER_LID }, message: { conversation: 'hola' } };
  assert.equal(await api.sendText(GRP, 'va', { quoted }), 'S1');
  assert.equal(await api.sendText(BEA, 'hola'), 'S2');
  assert.deepEqual(sent, [[GRP, { text: 'va' }, { quoted }], [BEA, { text: 'hola' }, undefined]]);
  assert.deepEqual(await api.fetchGroups(), groups);
});
