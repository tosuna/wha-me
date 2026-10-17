import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginLink, portalToken, startPortal as start } from './portal.js';
import { createFeedback } from './feedback.js';
import { createRunLog } from './run-log.js';
import { historyFile } from './store.js';
import { createTopics } from './topics.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const BEA = 'bea@s.whatsapp.net';
const XSS = '<script>alert(1)</script>';

// No Host is trusted: every test server comes logged in, and get() sends that session cookie.
const sessions = new Map();
async function startPortal(opts) {
  const server = await start(opts);
  const { port } = server.address();
  sessions.set(port, (await login(port, portalToken(opts.stateDir))).cookie);
  return server;
}

function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host, cookie: sessions.get(port) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject).end();
  });
}

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'history'), { recursive: true });
  writeFileSync(join(stateDir, 'store.json'), JSON.stringify({
    transcripts: { [BEA]: [{ author: 'CONTACTO', text: XSS, at: 2 }] }, lastManual: {}, sentIds: [],
    state: { paused: false, locked: true, shadow: false }, jobs: [],
  }));
  writeFileSync(historyFile(stateDir, BEA), [{ author: 'CONTACTO', text: 'viejo', at: 1 }, { author: 'CONTACTO', text: XSS, at: 2 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' }]));
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0 });
  t.after(() => server.close());
  return server.address();
}

test('portal binds 127.0.0.1 and serves the chat list, a chat, the page and 404s', async (t) => {
  const { address, port } = await setup(t);
  assert.equal(address, '127.0.0.1');

  const list = await get(port, '/api/chats');
  assert.equal(list.status, 200);
  assert.match(list.type, /application\/json/);
  const v = JSON.parse(list.body);
  assert.equal(v.state.locked, true);
  assert.deepEqual(v.chats.map((c) => [c.name, c.messageCount]), [['Bea', 2]]);

  const chat = await get(port, `/api/chats/${encodeURIComponent(BEA)}`);
  assert.equal(chat.status, 200);
  assert.deepEqual(JSON.parse(chat.body).timeline.map((e) => e.text), ['viejo', XSS]);

  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /<html/);

  for (const path of ['/nope', '/api/chats/nadie%40x', '/api/chats/%E0%A4%A']) assert.equal((await get(port, path)).status, path.endsWith('%A') ? 400 : 404, path);
});

test('portal rejects any Host without a session (DNS rebinding)', async (t) => {
  const { port } = await setup(t);
  for (const host of [`evil.example:${port}`, `localhost:${port}`]) assert.equal((await req(port, { path: '/api/chats', host })).status, 401, host);
  assert.equal((await get(port, '/api/chats', `localhost:${port}`)).status, 200);
});

test('page renders untrusted text with textContent only, never innerHTML', async (t) => {
  const { port } = await setup(t);
  const { body } = await get(port, '/');
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(body, /textContent/);
});

// --- WhatsApp link status (state/wa.json, written by index.js) ---

async function setupWa(t, wa) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir);
  if (wa) writeFileSync(join(stateDir, 'wa.json'), JSON.stringify(wa));
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0 });
  t.after(() => server.close());
  return server.address().port;
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const QR = '2@secretLinkingRef,abc,def=';

test('/api/wa reflects wa.json but never the raw qr string', async (t) => {
  const port = await setupWa(t, { state: 'qr', qr: QR, at: ago(1000) });
  const r = await get(port, '/api/wa');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /secretLinkingRef/);
  const v = JSON.parse(r.body);
  assert.equal(v.state, 'qr');
  assert.equal(v.stale, false);
  assert.equal(v.qr, undefined);
});

test('/api/wa/qr.svg serves the current QR as svg, no-store', async (t) => {
  const port = await setupWa(t, { state: 'qr', qr: QR, at: ago(1000) });
  const r = await get(port, '/api/wa/qr.svg');
  assert.equal(r.status, 200);
  assert.match(r.type, /^image\/svg\+xml/);
  assert.match(r.body, /<svg/);
});

for (const [name, wa] of [
  ['open', { state: 'open', selfJid: '5210000000000@s.whatsapp.net', at: ago(1000) }],
  ['missing wa.json', null],
  ['stale qr', { state: 'qr', qr: QR, at: ago(61_000) }],
]) {
  test(`/api/wa/qr.svg is 404 when ${name}`, async (t) => {
    const port = await setupWa(t, wa);
    assert.equal((await get(port, '/api/wa/qr.svg')).status, 404);
  });
}

test('/api/wa stale: missing file, or not open and older than 60 s; open is never stale', async (t) => {
  const cases = [
    [null, 'missing', true],
    [{ state: 'connecting', at: ago(61_000) }, 'connecting', true],
    [{ state: 'connecting', at: ago(5_000) }, 'connecting', false],
    [{ state: 'open', selfJid: 'x@s.whatsapp.net', at: ago(3_600_000) }, 'open', false],
  ];
  for (const [wa, state, stale] of cases) {
    const port = await setupWa(t, wa);
    const v = JSON.parse((await get(port, '/api/wa')).body);
    assert.deepEqual([v.state, v.stale], [state, stale], JSON.stringify(wa));
  }
});

test('CSP allows same-origin images only, and the page has the link panel', async (t) => {
  const port = await setupWa(t, null);
  const r = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, resolve).on('error', reject).end();
  });
  r.resume();
  assert.match(r.headers['content-security-policy'], /img-src 'self'/);
  const { body } = await get(port, '/');
  for (const s of ['Vincula tu WhatsApp', 'Dispositivos vinculados', '/api/wa/qr.svg', 'WhatsApp conectado']) assert.ok(body.includes(s), s);
});

test('standalone entry (npm run portal) still starts the server', async (t) => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL('./portal.js', import.meta.url).pathname], { env: { ...process.env, PORTAL_PORT: '0' } });
  t.after(() => child.kill());
  const line = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => resolve(String(d)));
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  assert.match(line, /portal en http:\/\/127\.0\.0\.1:\d+/);
});

// --- agent runs (state/agent-runs.db, written by the bridge's run log) ---

const NOW = Date.parse('2026-10-13T05:00:00Z'); // Oct 12, 23:00 at UTC-6

async function setupRuns(t, { keepOpen = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  let at = Date.parse('2026-10-12T07:00:00Z'); // Oct 12 01:00 local
  const log = createRunLog({ file: join(stateDir, 'agent-runs.db'), now: () => (at += 1000), leaks: () => false });
  const a = log.start({ kind: 'reply', mode: 'real', contact: { name: 'Bea' }, jid: BEA });
  a.event({ kind: 'thinking', text: 'pienso' });
  a.event({ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } });
  a.event({ kind: 'tool_result', id: 't1', status: 'ok', size: 4 });
  a.event({ kind: 'result', durationMs: 5000, costUsd: 0.5, isError: false, model: 'm', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } });
  a.finish({ result: 'REPLY:\nhola', decision: { bubbles: ['hola'], handoff: { type: 'bug', blocking: true } }, outcome: 'sent' });
  const b = log.start({ kind: 'job', mode: 'real', contact: { name: 'Bea' }, jid: BEA });
  b.event({ kind: 'result', durationMs: 9000, costUsd: 2, isError: false, model: 'm', usage: null });
  b.finish({ result: 'RESULT: deployed', decision: { result: 'deployed', bubbles: ['listo'] }, outcome: 'deployed' });
  at = Date.parse('2026-10-02T12:00:00Z'); // earlier this month, another contact
  const c = log.start({ kind: 'reply', mode: 'sim', contact: { name: 'Dalia' }, jid: 'dalia@s' });
  c.event({ kind: 'result', durationMs: 1, costUsd: 0.25, isError: false, model: 'm', usage: null });
  c.finish({ result: 'x', outcome: 'sim' });
  if (keepOpen) t.after(() => log.close()); else log.close();
  // Cost days are local to the profile timezone; these fixtures are in UTC-6.
  const server = await startPortal({ profile: { ...PROFILE, timezone: 'America/Mexico_City' }, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, now: () => NOW });
  t.after(() => server.close());
  return server.address().port;
}

for (const keepOpen of [false, true]) {
  test(`portal agent-run endpoints: chat runs newest first, one run with ordered events, costs (writer ${keepOpen ? 'open' : 'closed'})`, async (t) => {
    const port = await setupRuns(t, { keepOpen });
    const runs = JSON.parse((await get(port, `/api/chats/${encodeURIComponent(BEA)}/runs`)).body).runs;
    assert.deepEqual(runs.map((r) => [r.id, r.kind, r.outcome, r.toolCount, r.handoff?.type ?? null, r.preview]), [
      [2, 'job', 'deployed', 0, null, 'listo'],
      [1, 'reply', 'sent', 1, 'bug', 'hola'],
    ]);
    const run = await get(port, '/api/runs/1');
    assert.equal(run.status, 200);
    const d = JSON.parse(run.body);
    assert.deepEqual([d.costUsd, d.tokens, d.outcome], [0.5, { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }, 'sent']);
    assert.deepEqual(d.events.map((e) => [e.kind, e.name, e.status]), [['thinking', null, null], ['tool_use', 'Read', 'ok']]);
    assert.equal((await get(port, '/api/runs/99')).status, 404);
    const costs = JSON.parse((await get(port, '/api/costs')).body);
    assert.deepEqual([costs.today.costUsd, costs.today.runs, costs.month.costUsd, costs.month.runs], [2.5, 2, 2.75, 3]);
    assert.deepEqual(costs.month.byContact.map((c) => c.name), ['Bea', 'Dalia']);
    assert.deepEqual(JSON.parse((await get(port, '/api/chats/nadie%40x/runs')).body), { runs: [] });
  });
}

test('portal agent-run endpoints with no run database yet return empty results', async (t) => {
  const port = await setupWa(t, null);
  assert.deepEqual(JSON.parse((await get(port, `/api/chats/${encodeURIComponent(BEA)}/runs`)).body), { runs: [] });
  assert.equal((await get(port, '/api/runs/1')).status, 404);
  assert.deepEqual(JSON.parse((await get(port, '/api/costs')).body), { today: { costUsd: 0, runs: 0, byContact: [] }, month: { costUsd: 0, runs: 0, byContact: [] } });
});

test('page has the Agentes tab and the cost header, still textContent only', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  for (const s of ['Agentes', 'Historial', '/api/costs', '/runs', '/api/runs/', 'Hoy ', ' · Mes ']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// --- learning pairs (feedback_pairs in the same database, written by the bridge's feedback collector) ---

test('/api/feedback lists finalized pairs newest first (open ones hidden); ?unreviewed=1 filters; no table or DB -> empty', async (t) => {
  const port0 = await setupWa(t, null);
  assert.deepEqual(JSON.parse((await get(port0, '/api/feedback')).body), { pairs: [] });

  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  createRunLog({ file: join(stateDir, 'agent-runs.db'), leaks: () => false }).close();
  const server0 = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0 });
  t.after(() => server0.close());
  assert.deepEqual(JSON.parse((await get(server0.address().port, '/api/feedback')).body), { pairs: [] }, 'run log without the feedback table');

  let at = 1000;
  const fb = createFeedback({ file: join(stateDir, 'agent-runs.db'), now: () => at, leaks: () => false });
  const contact = { name: 'Contacto B' };
  fb.draft({ runId: 6, jid: BEA, contact, out: { bubbles: ['disculpa'], handoff: { type: 'follow-up' } }, outcome: 'shadow' });
  fb.contact(BEA, at += 10);
  fb.draft({ runId: 7, jid: BEA, contact, out: { bubbles: [XSS] }, outcome: 'shadow', transcript: [{ author: 'CONTACTO', text: XSS, at: 1 }] });
  fb.manual(BEA, XSS, at += 10);
  fb.contact(BEA, at += 10);
  fb.draft({ runId: 8, jid: BEA, contact, out: { bubbles: ['abierto'] }, outcome: 'shadow' });
  fb.markReviewed([1]);
  fb.close();
  const port = server0.address().port;
  const all = JSON.parse((await get(port, '/api/feedback')).body).pairs;
  assert.deepEqual(all.map((p) => [p.runId, p.verdict, p.draftHandoff, p.reviewedAt != null]), [[7, 'verbatim', null, false], [6, 'ignored', 'follow-up', true]]);
  assert.deepEqual([all[0].draftBubbles, all[0].sentTexts, all[0].contactName], [[XSS], [XSS], 'Contacto B']);
  assert.deepEqual([all[0].input.transcript[0].text, all[1].input], [XSS, null]);
  assert.deepEqual(JSON.parse((await get(port, '/api/feedback?unreviewed=1')).body).pairs.map((p) => p.runId), [7]);
});

test('page has the Aprendizaje view (draft vs sent), still textContent only', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  for (const s of ['Aprendizaje', '/api/feedback', 'Borrador', 'Enviado', 'verbatim', 'missed', 'Lo que vio el agente']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// --- remote access through the tunnel: token login, session cookie, replying ---

const TUNNEL = 'abc-def.trycloudflare.com';

function req(port, { method = 'GET', path = '/', host = TUNNEL, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    }).on('error', reject);
    r.end(body);
  });
}

async function setupRemote(t, { send = async (jid, bubbles) => ({ ok: true, sent: bubbles.length }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' }]));
  const calls = [];
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, sendMessage: async (...a) => { calls.push(a); return send(...a); } });
  t.after(() => server.close());
  return { port: server.address().port, stateDir, calls, token: readFileSync(join(stateDir, 'portal-token'), 'utf8').trim() };
}

const login = async (port, token) => {
  const r = await req(port, { path: `/login?k=${encodeURIComponent(token)}` });
  return { ...r, cookie: r.headers['set-cookie']?.[0]?.split(';')[0] };
};

test('portal token: 32 random bytes in state/portal-token, mode 0600, stable across restarts', async (t) => {
  const { stateDir, token } = await setupRemote(t);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(stateDir, 'portal-token')).mode & 0o777, 0o600);
  assert.equal(portalToken(stateDir), token);
});

test('without a session: 401 on the page, the API, the QR and send, whatever the Host (loopback included)', async (t) => {
  const { port, calls } = await setupRemote(t);
  const local = `127.0.0.1:${port}`;
  for (const host of [TUNNEL, local, `localhost:${port}`]) {
    for (const path of ['/', '/api/chats', '/api/wa/qr.svg']) assert.equal((await req(port, { path, host })).status, 401, `${host}${path}`);
    const page = await req(port, { path: '/', host });
    assert.match(page.headers['content-type'], /text\/html/);
    assert.doesNotMatch(page.body, /Chats del bridge/);
  }
  // Code run by the pipeline on this Mac reaches loopback and can forge a matching Origin.
  assert.equal((await post(port, { host: local, origin: `http://${local}` })).status, 401);
  assert.equal(calls.length, 0);
});

test('/login: wrong, empty, missing or different-length token -> 401 without a cookie', async (t) => {
  const { port, token } = await setupRemote(t);
  const wrong = token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  for (const path of [`/login?k=${wrong}`, '/login?k=', '/login', `/login?k=${token}00`, '/login?k=abc']) {
    const r = await req(port, { path });
    assert.equal(r.status, 401, path);
    assert.equal(r.headers['set-cookie'], undefined, path);
    assert.ok(!r.body.includes(token), path);
  }
});

test('/login with the right token: 303 to / with a HttpOnly Secure SameSite=Strict cookie that grants access; forged cookies do not', async (t) => {
  const { port, token } = await setupRemote(t);
  const r = await login(port, token);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  const set = r.headers['set-cookie'][0];
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 24 * 3600}`]) assert.ok(set.includes(attr), attr);
  assert.ok(!set.includes(token), 'the cookie is not the token');
  for (const path of ['/', '/api/chats']) assert.equal((await req(port, { path, headers: { cookie: r.cookie } })).status, 200, path);
  const [name, value] = r.cookie.split('=');
  const [at, mac] = value.split('.');
  for (const forged of [`${name}=${at}.${mac.slice(0, -2)}AA`, `${name}=${Number(at) + 1}.${mac}`, `${name}=${token}`, `${name}=`, 'other=1']) {
    assert.equal((await req(port, { path: '/api/chats', headers: { cookie: forged } })).status, 401, forged);
  }
});

const post = (port, { cookie, host = TUNNEL, origin = `https://${host}`, type = 'application/json', jid = BEA, body = { bubbles: ['hola'] } } = {}) => req(port, {
  method: 'POST', host, path: `/api/chats/${encodeURIComponent(jid)}/send`,
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('send: auth, content-type, Origin, jid and bubble checks; nothing reaches sendMessage on refusal', async (t) => {
  const { port, token, calls } = await setupRemote(t);
  const { cookie } = await login(port, token);
  assert.equal((await post(port)).status, 401, 'no cookie');
  assert.equal((await post(port, { cookie, origin: null })).status, 403, 'no Origin');
  assert.equal((await post(port, { cookie, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await post(port, { cookie, origin: 'null' })).status, 403, 'opaque Origin');
  assert.ok([403, 415].includes((await post(port, { cookie, type: 'text/plain' })).status), 'text/plain');
  assert.ok([403, 415].includes((await post(port, { cookie, type: null })).status), 'no content-type');
  assert.equal((await post(port, { cookie, jid: 'nadie@s.whatsapp.net' })).status, 404, 'unknown jid');
  for (const body of [{ bubbles: [] }, { bubbles: ['  '] }, { bubbles: Array(11).fill('x') }, { bubbles: ['x'.repeat(4001)] }, { bubbles: [3] }, {}, 'no json']) {
    assert.equal((await post(port, { cookie, body })).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
  assert.equal((await req(port, { method: 'PUT', path: '/api/chats', headers: { cookie } })).status, 405, 'other writes stay read-only');
});

test('send happy path (remote and local, with cookie): sendMessage once with the bubbles -> { ok, sent }', async (t) => {
  const { port, token, calls } = await setupRemote(t);
  const { cookie } = await login(port, token);
  const r = await post(port, { cookie, body: { bubbles: ['hola', 'ya quedó'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, sent: 2 });
  assert.deepEqual(calls, [[BEA, ['hola', 'ya quedó']]]);
  const local = `127.0.0.1:${port}`;
  assert.equal((await post(port, { cookie, host: local, origin: `http://${local}` })).status, 200);
  assert.equal(calls.length, 2);
});

test('send: a guard refusal is 400 with the reason, a WhatsApp error is 502', async (t) => {
  const a = await setupRemote(t, { send: async () => ({ ok: false, reason: 'patrón de secreto' }) });
  const ra = await post(a.port, { cookie: (await login(a.port, a.token)).cookie });
  assert.deepEqual([ra.status, JSON.parse(ra.body).error], [400, 'patrón de secreto']);
  const b = await setupRemote(t, { send: async () => { throw new Error('socket cerrado'); } });
  const rb = await post(b.port, { cookie: (await login(b.port, b.token)).cookie });
  assert.deepEqual([rb.status, JSON.parse(rb.body).error], [502, 'socket cerrado']);
});

test('without a sendMessage callback (npm run portal) sending is 405', async (t) => {
  const port = await setupWa(t, null);
  const local = `127.0.0.1:${port}`;
  assert.equal((await post(port, { cookie: sessions.get(port), host: local, origin: `http://${local}` })).status, 405);
});

// --- stickers (stickers.js store, sent with wa.sendSticker) ---

const STICKER = Buffer.alloc(32, 7).toString('base64url');
const STICKER_WEBP = Buffer.from('RIFF\0\0\0\0WEBPfake');
const fakeStickers = {
  list: () => ({ available: true, favorites: [{ id: STICKER, emojis: ['😀'] }], recents: [], packs: [] }),
  file: (id) => (id === STICKER ? STICKER_WEBP : null),
};

async function setupStickers(t, { sendSticker = async () => 'msg-id', selfJid } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' }]));
  const calls = [];
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, stickers: fakeStickers, selfJid,
    sendSticker: sendSticker && (async (...a) => { calls.push(a); return sendSticker(...a); }),
    sendMessage: async (...a) => { calls.push(a); return { ok: true, sent: a[1].length }; } });
  t.after(() => server.close());
  return { port: server.address().port, calls, cookie: sessions.get(server.address().port) };
}
const postSticker = (port, { cookie, origin = `https://${TUNNEL}`, type = 'application/json', jid = BEA, body = { id: STICKER } } = {}) => req(port, {
  method: 'POST', path: `/api/chats/${encodeURIComponent(jid)}/sticker`,
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('/api/stickers lists the store; /api/stickers/<id>.webp serves it cached; unknown or traversal ids 404', async (t) => {
  const { port } = await setupStickers(t);
  assert.deepEqual(JSON.parse((await get(port, '/api/stickers')).body), fakeStickers.list());
  const img = await req(port, { path: `/api/stickers/${STICKER}.webp`, headers: { cookie: sessions.get(port) } });
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/webp');
  assert.match(img.headers['cache-control'], /max-age/);
  assert.equal(img.body, STICKER_WEBP.toString());
  for (const path of [`/api/stickers/${Buffer.alloc(32, 1).toString('base64url')}.webp`, '/api/stickers/..%2F..%2Fsecret.webp', `/api/stickers/${STICKER}`]) {
    assert.equal((await get(port, path)).status, 404, path);
  }
  assert.equal((await req(port, { path: `/api/stickers/${STICKER}.webp` })).status, 401, 'no session');
});

test('sticker send: CSRF, jid and id checks; happy path sends the webp buffer to the chat', async (t) => {
  const { port, calls, cookie } = await setupStickers(t);
  assert.equal((await postSticker(port)).status, 401, 'no cookie');
  assert.equal((await postSticker(port, { cookie, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.ok([403, 415].includes((await postSticker(port, { cookie, type: 'text/plain' })).status), 'text/plain');
  assert.equal((await postSticker(port, { cookie, jid: 'nadie@s.whatsapp.net' })).status, 404, 'unknown jid');
  for (const body of [{}, { id: 3 }, { id: '../x' }, 'no json']) assert.equal((await postSticker(port, { cookie, body })).status, 400, JSON.stringify(body));
  assert.equal((await postSticker(port, { cookie, body: { id: Buffer.alloc(32, 1).toString('base64url') } })).status, 404, 'unknown sticker');
  assert.equal(calls.length, 0);
  const r = await postSticker(port, { cookie });
  assert.deepEqual([r.status, JSON.parse(r.body)], [200, { ok: true }]);
  assert.deepEqual(calls, [[BEA, STICKER_WEBP, STICKER]], 'the sticker id goes along to be recorded');
});

test('sticker send: a WhatsApp error is 502; without sendSticker (npm run portal) it is 405', async (t) => {
  const a = await setupStickers(t, { sendSticker: async () => { throw new Error('socket cerrado'); } });
  const ra = await postSticker(a.port, { cookie: a.cookie });
  assert.deepEqual([ra.status, JSON.parse(ra.body).error], [502, 'socket cerrado']);
  const b = await setupStickers(t, { sendSticker: null });
  assert.equal((await postSticker(b.port, { cookie: b.cookie })).status, 405);
});

const SELF = '5210000000009@s.whatsapp.net';

test('self-chat «Tú»: listed first and opens once WhatsApp is up; text and stickers to it are accepted, other non-contacts still 404', async (t) => {
  let self = null;
  const { port, calls, cookie } = await setupStickers(t, { selfJid: () => self });
  const chats = async () => JSON.parse((await get(port, '/api/chats')).body).chats;
  assert.deepEqual((await chats()).map((c) => c.jid), [], 'not connected: no «Tú»');
  assert.equal((await postSticker(port, { cookie, jid: SELF })).status, 404, 'not connected: self not accepted');
  self = SELF;
  assert.deepEqual((await chats()).map((c) => [c.jid, c.name, c.self]), [[SELF, 'Tú', true]]);
  assert.equal((await get(port, `/api/chats/${encodeURIComponent(SELF)}`)).status, 200);
  assert.equal((await postSticker(port, { cookie, jid: SELF })).status, 200);
  const text = await post(port, { cookie, jid: SELF, body: { bubbles: ['prueba'] } });
  assert.equal(text.status, 200);
  assert.deepEqual(calls, [[SELF, STICKER_WEBP, STICKER], [SELF, ['prueba']]]);
  assert.equal((await postSticker(port, { cookie, jid: 'nadie@s.whatsapp.net' })).status, 404);
  assert.equal((await post(port, { cookie, jid: 'nadie@s.whatsapp.net' })).status, 404);
  assert.equal(calls.length, 2);
});

test('chat API returns the sticker id of portal-sent stickers, for contacts and «Tú»', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'history'), { recursive: true });
  const line = (e) => JSON.stringify(e) + '\n';
  writeFileSync(historyFile(stateDir, BEA), line({ author: 'OWNER', text: '[sticker]', sticker: STICKER, at: 1 }) + line({ author: 'OWNER', text: '[sticker]', at: 2 }));
  writeFileSync(historyFile(stateDir, SELF), line({ author: 'OWNER', text: 'prueba', at: 3 }) + line({ author: 'OWNER', text: '[sticker]', sticker: STICKER, at: 4 }));
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea' }]));
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, selfJid: () => SELF });
  t.after(() => server.close());
  const port = server.address().port;
  const timeline = async (jid) => JSON.parse((await get(port, `/api/chats/${encodeURIComponent(jid)}`)).body).timeline.map((e) => [e.text, e.sticker]);
  assert.deepEqual(await timeline(BEA), [['[sticker]', STICKER], ['[sticker]', undefined]]);
  assert.deepEqual(await timeline(SELF), [['prueba', undefined], ['[sticker]', STICKER]]);
});

test('page: a sticker image src is only ever /api/stickers/<checked id>.webp, lazy, with a [sticker] text fallback', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  const srcs = body.match(/\w+\.src\s*=.*api\/stickers.*/g) ?? [];
  assert.deepEqual(srcs, ["img.src = '/api/stickers/' + id + '.webp';"], 'one sticker src assignment, in stickerImg');
  const fn = body.slice(body.indexOf('function stickerImg('), body.indexOf(srcs[0]));
  assert.match(fn, /if \(!STICKER_ID\.test\(id\)\) return null;/, 'the id is checked before src');
  assert.ok(body.includes("const STICKER_ID = /^[A-Za-z0-9_-]{43}$/;"));
  assert.match(body, /loading = 'lazy'/);
  assert.match(body, /onerror/);
  assert.match(body, /stickerImg\(e\.sticker, /, 'chat bubbles render the recorded sticker');
});

test('self-chat «Tú» sorts before the contacts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'history'), { recursive: true });
  writeFileSync(historyFile(stateDir, BEA), JSON.stringify({ author: 'CONTACTO', text: 'hola', at: Date.now() }) + '\n');
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea' }]));
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, selfJid: () => SELF });
  t.after(() => server.close());
  assert.deepEqual(JSON.parse((await get(server.address().port, '/api/chats')).body).chats.map((c) => c.name), ['Tú', 'Bea']);
});

test('page has the sticker picker (Favoritos, Recientes, Paquetes), still textContent only', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  for (const s of ['/api/stickers', '/sticker', 'Favoritos', 'Recientes', 'Paquetes', 'b.self']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('/api/chats/:jid/draft: latest real shadow or discarded draft of the chat; 404 when none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  let at = 1000;
  const log = createRunLog({ file: join(stateDir, 'agent-runs.db'), now: () => (at += 1000), leaks: () => false });
  const run = (mode, outcome, bubbles, jid = BEA) => log.start({ kind: 'reply', mode, contact: { name: 'x' }, jid }).finish({ result: '', decision: { bubbles }, outcome });
  run('real', 'shadow', ['viejo']);
  run('real', 'discarded', ['uno', 'dos']);
  run('real', 'sent', ['ya enviado']);
  run('sim', 'sim', ['simulado']);
  run('real', 'shadow', ['de otro'], 'dalia@s');
  log.close();
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0 });
  t.after(() => server.close());
  const port = server.address().port;
  assert.deepEqual(JSON.parse((await get(port, `/api/chats/${encodeURIComponent(BEA)}/draft`)).body), { bubbles: ['uno', 'dos'] });
  assert.equal((await get(port, '/api/chats/nadie%40x/draft')).status, 404);
});

test('page has the composer (--- splits bubbles, Usar borrador, confirm) and a phone breakpoint, still textContent only', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  for (const s of ['Usar borrador', 'Enviar', '---', '/draft', '/send', 'confirm(', '@media (max-width']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('/favicon.svg is served as svg; the page links it and has the app shell landmarks', async (t) => {
  const port = await setupWa(t, null);
  const icon = await get(port, '/favicon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.type, /^image\/svg\+xml/);
  assert.match(icon.body, /^<svg/);
  const { body } = await get(port, '/');
  assert.match(body, /<link rel="icon" href="\/favicon.svg"/);
  for (const s of ['<nav', 'data-view="chats"', 'data-view="pending"', 'data-view="learn"', 'id="composer"', 'id="search"', 'Elige un chat']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /<footer/);
  // Mode explained in visible text (touch has no tooltips); composer errors are announced on the textarea.
  assert.match(body, /<p id="mode-help" class="mode-line"/);
  assert.match(body, /aria-describedby="composer-tip composer-msg"/);
  assert.match(body, /aria-invalid/);
  // Missing run data drops the segment instead of printing a raw "?".
  assert.doesNotMatch(body, /\|\| '\?'|\?\? '\?'|\? '\?' :/);
  assert.doesNotMatch(body, /'handoff ' \+ handoffType|manda \/aprender para/);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('loginLink: https://<tunnel>/login?k=<token> from state/tunnel.json, null without a tunnel', async (t) => {
  const { stateDir, token } = await setupRemote(t);
  assert.equal(loginLink(stateDir), null);
  writeFileSync(join(stateDir, 'tunnel.json'), JSON.stringify({ url: `https://${TUNNEL}` }));
  assert.equal(loginLink(stateDir), `https://${TUNNEL}/login?k=${token}`);
});

// --- Memoria: topic memory, memory-only chats and the seen-chats registry ---

const MO = 'fabi@s.whatsapp.net'; // memory-only chat
const NEW = 'nuevo@s.whatsapp.net'; // seen, in neither list

async function setupMemory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-'));
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'history'), { recursive: true });
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' }]));
  writeFileSync(join(stateDir, 'memory-chats.json'), JSON.stringify([{ jid: MO, name: 'Fabi', kind: 'private' }]));
  writeFileSync(join(stateDir, 'seen-chats.json'), JSON.stringify([{ jid: NEW, name: 'Lino', kind: 'private', lastAt: 5, count: 3 }]));
  for (const jid of [BEA, MO]) writeFileSync(historyFile(stateDir, jid), `${JSON.stringify({ author: 'CONTACTO', text: 'hola', at: 1 })}\n`);
  const topics = createTopics({ profile: PROFILE, file: join(stateDir, 'topics.db'), now: () => 1000 });
  topics.apply([
    { op: 'new_topic', ref: 'a', title: 'Folio REQ-0027 pago', msg: 0 },
    { op: 'add_fact', topic: 'a', text: 'Fabi manda la base mañana', msg: 0 },
    { op: 'add_fact', topic: 'a', text: 'Alex pidió el Excel', msg: 1 },
    { op: 'new_topic', ref: 'b', title: 'Formulario 312', msg: 1 },
    { op: 'close_topic', topic: 'b', msg: 1 },
  ], { chat: { jid: MO, name: 'Fabi', kind: 'private' }, entries: [{ person: 'fabi', text: 'mañana', at: 900 }, { person: 'owner', text: 'el Excel', at: 950 }] });
  const calls = [];
  const server = await startPortal({ profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, topics, sendMessage: async (...a) => { calls.push(a); return { ok: true, sent: 1 }; } });
  t.after(() => { server.close(); topics.close(); });
  const port = server.address().port;
  const local = `127.0.0.1:${port}`;
  const postJson = (path, body, { cookie = sessions.get(port), origin = `http://${local}`, type = 'application/json' } = {}) => req(port, {
    method: 'POST', host: local, path,
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) },
    body: body == null ? '' : JSON.stringify(body),
  });
  const getJson = async (path) => { const r = await get(port, path); return { status: r.status, body: JSON.parse(r.body) }; };
  return { port, stateDir, topics, calls, postJson, getJson };
}

test('memory API: topic list (open/closed filter, newest first, fact count) and detail with who/where/when', async (t) => {
  const { getJson } = await setupMemory(t);
  const all = (await getJson('/api/memory/topics')).body.topics;
  assert.deepEqual(all.map((x) => [x.title, x.status, x.factCount]), [['Formulario 312', 'closed', 0], ['Folio REQ-0027 pago', 'open', 2]]);
  assert.deepEqual((await getJson('/api/memory/topics?status=open')).body.topics.map((x) => x.title), ['Folio REQ-0027 pago']);
  assert.deepEqual((await getJson('/api/memory/topics?status=closed')).body.topics.map((x) => x.title), ['Formulario 312']);
  const id = all[1].id;
  const d = await getJson(`/api/memory/topics/${id}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.participants, ['fabi', 'owner']);
  assert.deepEqual(d.body.facts.map((f) => [f.text, f.saidBy, f.chatName, f.chatKind, f.at]),
    [['Fabi manda la base mañana', 'fabi', 'Fabi', 'private', 900], ['Alex pidió el Excel', 'owner', 'Fabi', 'private', 950]]);
  assert.equal((await getJson('/api/memory/topics/9999')).status, 404);
});

test('memory API: close / reopen / delete fact / delete topic; unknown ids are 404', async (t) => {
  const { postJson, topics } = await setupMemory(t);
  const [{ id }] = topics.list({ status: 'open' });
  assert.equal((await postJson(`/api/memory/topics/${id}/close`)).status, 200);
  assert.equal(topics.get(id).status, 'closed');
  assert.equal((await postJson(`/api/memory/topics/${id}/reopen`)).status, 200);
  assert.equal(topics.get(id).status, 'open');
  const fact = topics.get(id).facts[0].id;
  assert.equal((await postJson(`/api/memory/facts/${fact}/delete`)).status, 200);
  assert.equal(topics.get(id).facts.length, 1);
  assert.equal((await postJson(`/api/memory/facts/${fact}/delete`)).status, 404);
  assert.equal((await postJson(`/api/memory/topics/${id}/delete`)).status, 200);
  assert.equal(topics.get(id), null);
  for (const a of ['close', 'reopen', 'delete']) assert.equal((await postJson(`/api/memory/topics/${id}/${a}`)).status, 404, a);
  assert.equal((await postJson(`/api/memory/topics/${id}/nope`)).status, 404);
});

test('memory API: 401 without a session; POST needs JSON and a matching Origin', async (t) => {
  const { port, postJson, topics } = await setupMemory(t);
  const [{ id }] = topics.list({ status: 'open' });
  for (const path of ['/api/memory/topics', `/api/memory/topics/${id}`, '/api/memory/chats']) {
    assert.equal((await req(port, { path, host: `127.0.0.1:${port}` })).status, 401, path);
  }
  assert.equal((await postJson(`/api/memory/topics/${id}/delete`, null, { cookie: null })).status, 401);
  assert.equal((await postJson(`/api/memory/topics/${id}/delete`, null, { origin: null })).status, 403);
  assert.equal((await postJson(`/api/memory/topics/${id}/delete`, null, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await postJson(`/api/memory/topics/${id}/delete`, null, { type: 'text/plain' })).status, 415);
  assert.equal((await postJson('/api/memory/chats/add', { jid: NEW }, { origin: null })).status, 403);
  assert.ok(topics.get(id), 'nothing deleted');
});

test('memory chats: feeding + recent lists; Alimentar memoria moves a seen chat to memory-chats; remove; unknown jid 404', async (t) => {
  const { getJson, postJson, stateDir } = await setupMemory(t);
  assert.deepEqual((await getJson('/api/memory/chats')).body, {
    feeding: [{ jid: MO, name: 'Fabi', kind: 'private' }], recent: [{ jid: NEW, name: 'Lino', kind: 'private', lastAt: 5, count: 3 }],
  });
  assert.equal((await postJson('/api/memory/chats/add', { jid: 'nadie@s.whatsapp.net' })).status, 404);
  assert.equal((await postJson('/api/memory/chats/add', { jid: NEW })).status, 200);
  const v = (await getJson('/api/memory/chats')).body;
  assert.deepEqual([v.feeding.map((c) => [c.jid, c.name, c.kind]), v.recent], [[[MO, 'Fabi', 'private'], [NEW, 'Lino', 'private']], []]);
  assert.equal((await postJson('/api/memory/chats/remove', { jid: MO })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'memory-chats.json'), 'utf8')).map((c) => c.jid), [NEW]);
  assert.equal((await postJson('/api/memory/chats/remove', { jid: MO })).status, 404);
});

test('a seen chat without a name is added under its number', async (t) => {
  const { postJson, stateDir } = await setupMemory(t);
  writeFileSync(join(stateDir, 'seen-chats.json'), JSON.stringify([{ jid: '5210000005678@s.whatsapp.net', name: null, kind: 'private', lastAt: 5, count: 1 }]));
  assert.equal((await postJson('/api/memory/chats/add', { jid: '5210000005678@s.whatsapp.net' })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'memory-chats.json'), 'utf8')).at(-1).name, '+5210000005678');
});

test('memory-only chats are not in the chat list and the send endpoint refuses them', async (t) => {
  const { getJson, postJson, calls } = await setupMemory(t);
  assert.deepEqual((await getJson('/api/chats')).body.chats.map((c) => c.jid), [BEA]);
  assert.equal((await postJson(`/api/chats/${encodeURIComponent(MO)}/send`, { bubbles: ['hola'] })).status, 404);
  assert.equal(calls.length, 0);
});

test('page has the Memoria view (topics, feeding chats, recent chats, confirms), still textContent only', async (t) => {
  const port = await setupWa(t, null);
  const { body } = await get(port, '/');
  for (const s of ['data-view="memory"', 'Memoria', '/api/memory/topics', '/api/memory/chats', 'mem-topics', 'mem-feeding', 'mem-recent',
    'Chats que alimentan la memoria', 'Chats recientes', 'Alimentar memoria', 'confirm(']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
