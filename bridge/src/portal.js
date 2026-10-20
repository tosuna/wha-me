import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookupContact } from './core/allowlist.js';
import { FEEDBACK_TABLE, LIST_SQL as FEEDBACK_LIST, pairRow } from './feedback.js';
import { createMemoryChats } from './memory-chats.js';
import { chatDetail, chatList, costTotals, parseHistory, preprodOf, runDetail, runRow, stationOf, subagents } from './portal-view.js';
import { qrSvg } from './qr-svg.js';
import { ACTIONS, createRequests } from './requests.js';
import { REDACTED, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';
import { createSeenChats } from './seen-chats.js';
import { createSettings } from './settings.js';
import { createStickerStore } from './stickers.js';
import { historyFile, historyJid } from './store.js';
import { createTopics } from './topics.js';

// View of the bridge state: reads files on each request and never writes them. The writes are replying to a chat (through
// the bridge's sendMessage callback, absent when run alone with npm run portal), sending a sticker (sendSticker, likewise), the owner's Peticiones actions (requests.js)
// the GitHub token in Ajustes (settings.js) and Memoria edits (topics.js, memory-chats.js, seen-chats.js).
// Every request but /login needs the session cookie from /login?k=<state/portal-token>, whatever its Host: loopback is not
// trust, since code run by the pipeline on this Mac (the Peticiones gate, the agents) can reach it and forge Host/Origin.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const COOKIE = 'wm_s';
const SESSION_S = 30 * 24 * 3600;
const MAX_BUBBLES = 10;
const MAX_BUBBLE = 4000;
const MAX_BODY = 256 * 1024;
const MAX_NOTE = 2000;
const TOPIC_ACTIONS = { close: 'closeTopic', reopen: 'reopenTopic', delete: 'deleteTopic' };
// Peticiones evidence files: basenames only (no dot-files, no separators), PNG or text.
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEXT = 'text/plain; charset=utf-8';
const EVIDENCE_TYPES = { '.png': 'image/png', '.txt': TEXT, '.md': TEXT, '.log': TEXT, '.diff': TEXT, '.json': TEXT, '.sql': TEXT };
// Sticker ids (stickers.js): a sha256 file hash as base64url.
const STICKER_ID = /^[A-Za-z0-9_-]{43}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Fábrica: the text evidence of each plan block (implement and review steps), inlined in the request detail. Fixed paths
// under <requestsDir>/<id>/ built from block keys (plan-step.js KEY_RE), each capped.
const BLOCK_KEY = /^[a-z0-9-]{1,30}$/;
const BLOCK_TEXTS = { report: (k) => `reports/${k}.md`, review: (k) => `reviews/${k}.md`, gate: (k) => `tests/${k}-gate.txt`, baseline: (k) => `tests/${k}-baseline.txt` };
const MAX_TEXT = 64 * 1024;
const CUT = '\n… [recortado]';
// Speech bubble in the portal's accent color; img-src 'self' allows it (no data: URIs under the CSP).
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M18 18h28a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H30l-10 8v-8h-2a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z" fill="#fff"/></svg>';
const DENIED = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>sin acceso</title><p>Sin acceso. Manda /portal en tu chat contigo para recibir el link.</p>';

// Random 32-byte secret, created once (0600). Deleting the file and restarting revokes every session.
export function portalToken(stateDir) {
  const file = join(stateDir, 'portal-token');
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return readFileSync(file, 'utf8').trim();
}

// https://<tunnel>/login?k=<token> from state/tunnel.json (written by npm run tunnel), or null without a tunnel.
export function loginLink(stateDir) {
  const url = readJson(join(stateDir, 'tunnel.json'), null)?.url;
  return url ? `${url}/login?k=${portalToken(stateDir)}` : null;
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const cookieOf = (header = '') => header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length <= MAX_BODY) return;
      req.removeAllListeners('data').resume(); // drain the rest without buffering it
      reject(Object.assign(new Error('demasiado grande'), { status: 413 }));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// CSRF for every POST: JSON only, and an Origin naming this very host (on top of the SameSite=Strict cookie). null = ok.
function csrfRefusal(req, reqHost) {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return { status: 415, error: 'se espera application/json' };
  let origin = null;
  try { origin = new URL(req.headers.origin).host; } catch { /* missing or opaque */ }
  return !origin || origin !== reqHost ? { status: 403, error: 'origen no permitido' } : null;
}

// An empty body is {}; anything else must be a JSON object.
async function jsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  let v;
  try { v = JSON.parse(body); } catch { v = null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('JSON inválido'), { status: 400 });
  return v;
}

// 1..MAX_BUBBLES non-empty strings of at most MAX_BUBBLE chars, trimmed; null otherwise.
function bubblesOf(body) {
  let v;
  try { v = JSON.parse(body); } catch { return null; }
  const b = v?.bubbles;
  if (!Array.isArray(b) || !b.length || b.length > MAX_BUBBLES) return null;
  if (!b.every((x) => typeof x === 'string' && x.trim() && x.length <= MAX_BUBBLE)) return null;
  return b.map((x) => x.trim());
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
};

// ponytail: rereads every history file per list request (every 5 s); fine for a handful of chats.
function load({ stateDir, contactsFile }, jid) {
  const history = {};
  const dir = join(stateDir, 'history');
  const files = jid ? [historyFile(stateDir, jid)] : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) : [];
  for (const file of files) {
    try {
      history[historyJid(file.split('/').pop())] = parseHistory(readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof URIError)) throw e;
    }
  }
  return { store: readJson(join(stateDir, 'store.json'), {}), contacts: readJson(contactsFile, []), history };
}

// Not open and silent for 60 s (or no file) = the bridge is probably not running; a stale QR has expired anyway.
const STALE_MS = 60_000;
function waStatus(stateDir) {
  const wa = readJson(join(stateDir, 'wa.json'), null);
  if (!wa) return { state: 'missing', stale: true };
  return { ...wa, stale: wa.state !== 'open' && !(Date.now() - Date.parse(wa.at) <= STALE_MS) };
}

// Agent-run history (written by the bridge's run log), opened read-only per request. No file or no runs table yet (the
// Peticiones store can create the file first) = `empty`.
function readRuns(stateDir, empty, fn) {
  const file = join(stateDir, RUNS_DB);
  if (!existsSync(file)) return empty;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()) return empty;
    return fn(db);
  } finally {
    db.close();
  }
}
const RUN_LIST = `SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.kind = 'tool_use') AS tool_count
  FROM runs r WHERE r.jid = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 200`;
const MONTH_MS = 32 * 24 * 3600 * 1000; // covers the current local month
// A Peticiones request's pipeline runs (run-log.js request_id), oldest first.
const REQUEST_RUNS = `SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.kind = 'tool_use') AS tool_count
  FROM runs r WHERE r.request_id = ? ORDER BY r.started_at, r.id`;
// Rows written before the subagent columns (or by a bridge still on the old code) have none: nothing to group then.
const hasSubagentCols = (db) => db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'parent_tool_use_id');
const toolEvents = (db, runId) => (hasSubagentCols(db)
  ? db.prepare("SELECT seq, at, kind, name, input_json, status, size, text, tool_use_id, parent_tool_use_id FROM events WHERE run_id = ? AND kind = 'tool_use' ORDER BY seq").all(runId)
  : []);
// The latest agent draft the owner did not see go out: shadow or discarded (real runs only).
const DRAFT_SQL = `SELECT decision_json FROM runs WHERE jid = ? AND kind = 'reply' AND mode = 'real' AND outcome IN ('shadow', 'discarded')
  ORDER BY started_at DESC, id DESC LIMIT 1`;

// sendMessage(jid, bubbles) -> { ok: true, sent } | { ok: false, reason } (secret guard); throws on a WhatsApp error.
// sendSticker(jid, webpBuffer, id): sends a sticker through the bridge, which records its store id for the chat view (absent =
// 405, like sendMessage); stickers: the WhatsApp Desktop sticker store (stickers.js). Stickers are images: they skip the text secret guard, not the session and CSRF checks.
// selfJid(): the owner's own chat once WhatsApp is up (else null), listed as «Tú» and a valid send target although it is not in
// contacts.json (the agent's allowlist); the bridge sends to it without treating it as a contact or a command.
// requests: the bridge's Peticiones store (opened here when absent); askContact(jid, note): the bridge's "Pedir info" reply
// run (absent = 503); requestsDir: evidence files, one dir per request; settings: Ajustes (GitHub token).
// onRequestAction(id, action): after a successful action (the bridge's pipeline: approve enqueues, cancel aborts the step).
// topics: the bridge's topic memory (opened here on first use when absent).
// portal.html with the owner's tokens filled in: __OWNER_TAG__ (persisted author), __OWNER_KEY__ (person/actor key),
// __OWNER_NAME__ (comments only), __TENANTS__ (tenant id -> label, from config knowledge.tenants[id].label) and __REPOS__
// (the pipeline repos the GitHub token must write to, config pipeline.repos). The config validates them (tag: [A-Z0-9_];
// name and labels: no quotes, backslashes or angle brackets; tenant and repo ids: [\w-] / [\w.-]).
export function portalPage(profile, { tenants = {}, repos = {} } = {}) {
  const key = (id) => (/^[A-Za-z_$][\w$]*$/.test(id) ? id : `'${id}'`);
  const labels = Object.entries(tenants).filter(([, t]) => t.label).map(([id, t]) => `${key(id)}: '${t.label}'`);
  return Buffer.from(readFileSync(new URL('./portal.html', import.meta.url), 'utf8')
    .replaceAll('__OWNER_TAG__', profile.tag).replaceAll('__OWNER_KEY__', profile.tag.toLowerCase()).replaceAll('__OWNER_NAME__', profile.name)
    .replace('__TENANTS__', () => (labels.length ? `{ ${labels.join(', ')} }` : '{}'))
    .replace('__REPOS__', new Intl.ListFormat('es', { type: 'conjunction' }).format(Object.keys(repos))));
}

// profile: the owner (config profile): page tokens, Ajustes keychain service, requests actor, cost-day time zone.
// knowledge / pipeline: config sections, for the page's tenant labels and GitHub token hint (portalPage).
export function startPortal({
  profile, knowledge, pipeline, stateDir, contactsFile, port = 4747, host = '127.0.0.1', now = Date.now, sendMessage = null, requests = null, askContact = null,
  requestsDir, settings = createSettings({ stateDir, service: profile.keychainService }), leaks = null, onRequestAction = () => {},
  topics = null, memoryChats = createMemoryChats({ file: join(stateDir, 'memory-chats.json') }),
  seenChats = createSeenChats({ file: join(stateDir, 'seen-chats.json') }), sendSticker = null, stickers = createStickerStore(), selfJid = () => null,
}) {
  const page = portalPage(profile, { tenants: knowledge?.tenants, repos: pipeline?.repos });
  const token = portalToken(stateDir);
  const guard = leaks ?? createSecretGuard({ secrets: () => [token, settings.token()] });
  // Opened on first use: npm run portal alone must not create the database before the bridge does.
  const store = () => (requests ??= createRequests({ profile, file: join(stateDir, RUNS_DB), leaks: guard }));
  const memory = () => (topics ??= createTopics({ profile, file: join(stateDir, 'topics.db') }));
  // The view with the self-chat as a pseudo-contact «Tú» (never written to contacts.json).
  const withSelf = (v) => {
    const self = selfJid();
    return self ? { ...v, contacts: [...v.contacts, { jid: self, name: 'Tú' }], history: { [self]: [], ...v.history } } : v;
  };
  const canSend = (jid) => !!lookupContact(readJson(contactsFile, []), jid) || (!!jid && jid === selfJid());
  const mac = (at) => createHmac('sha256', token).update(`${COOKIE}:${at}`).digest('base64url');
  const sessionOk = (value) => {
    const [at, sig] = String(value ?? '').split('.');
    const age = now() - Number(at);
    return /^\d+$/.test(at ?? '') && age >= 0 && age < SESSION_S * 1000 && sameText(sig, mac(at));
  };
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' };
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const json = (status, v) => send(status, 'application/json; charset=utf-8', JSON.stringify(v));
    const reqHost = req.headers.host ?? '';
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname === '/login' && req.method === 'GET') {
      if (!sameText(searchParams.get('k'), token)) return send(401, 'text/html; charset=utf-8', DENIED);
      const at = now();
      res.writeHead(303, { ...headers, location: '/', 'set-cookie': `${COOKIE}=${at}.${mac(at)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_S}` });
      return res.end();
    }
    if (!sessionOk(cookieOf(req.headers.cookie))) {
      if (req.method === 'POST') console.error(`portal: POST ${pathname} refused, no valid session (host ${reqHost}, cookie ${cookieOf(req.headers.cookie) ? 'invalid' : 'absent'})`);
      return pathname.startsWith('/api/') ? json(401, { error: 'sin acceso' }) : send(401, 'text/html; charset=utf-8', DENIED);
    }
    if (req.method === 'POST') {
      const reply = pathname.match(/^\/api\/chats\/([^/]+)\/send$/);
      if (reply && sendMessage) return sendReply(req, reply[1], reqHost, json);
      const sticker = pathname.match(/^\/api\/chats\/([^/]+)\/sticker$/);
      if (sticker && sendSticker) return sendStickerTo(req, sticker[1], reqHost, json);
      const action = pathname.match(/^\/api\/requests\/(\d+)\/([a-z-]+)$/);
      if (action) return requestAction(req, Number(action[1]), action[2], reqHost, json);
      if (pathname === '/api/settings/github-token') return setGithubToken(req, reqHost, json);
      const topic = pathname.match(/^\/api\/memory\/topics\/(\d+)\/([a-z]+)$/);
      if (topic) return memoryEdit(req, reqHost, json, () => Object.hasOwn(TOPIC_ACTIONS, topic[2]) && memory()[TOPIC_ACTIONS[topic[2]]](Number(topic[1])));
      const fact = pathname.match(/^\/api\/memory\/facts\/(\d+)\/delete$/);
      if (fact) return memoryEdit(req, reqHost, json, () => memory().deleteFact(Number(fact[1])));
      if (pathname === '/api/memory/chats/add') return memoryEdit(req, reqHost, json, ({ jid }) => feedMemory(jid));
      if (pathname === '/api/memory/chats/remove') {
        return memoryEdit(req, reqHost, json, ({ jid }) => memoryChats.list().some((c) => c.jid === jid) && (memoryChats.remove(jid), true));
      }
    }
    if (req.method !== 'GET') return json(405, { error: 'solo lectura' });
    try {
      if (pathname === '/') return send(200, 'text/html; charset=utf-8', page);
      if (pathname === '/favicon.svg') return send(200, 'image/svg+xml', FAVICON);
      if (pathname === '/api/wa') {
        const { qr, ...wa } = waStatus(stateDir);
        return json(200, wa);
      }
      if (pathname === '/api/wa/qr.svg') {
        const wa = waStatus(stateDir);
        return wa.state === 'qr' && wa.qr && !wa.stale ? send(200, 'image/svg+xml', qrSvg(wa.qr)) : json(404, { error: 'sin QR' });
      }
      if (pathname === '/api/chats') {
        // Memory-only chats are answered from the phone: listed under Memoria, never as answerable chats.
        const v = withSelf(load({ stateDir, contactsFile }));
        const list = chatList(v);
        const mem = memoryChats.list();
        const self = selfJid();
        const chats = list.chats.filter((c) => lookupContact(v.contacts, c.jid) || !lookupContact(mem, c.jid));
        return json(200, { ...list, chats: [...chats.filter((c) => c.jid === self).map((c) => ({ ...c, self: true })), ...chats.filter((c) => c.jid !== self)] });
      }
      if (pathname === '/api/memory/topics') {
        const status = searchParams.get('status');
        return json(200, { topics: memory().list(['open', 'closed'].includes(status) ? { status } : {}) });
      }
      const mt = pathname.match(/^\/api\/memory\/topics\/(\d+)$/);
      if (mt) {
        const d = memory().get(Number(mt[1]));
        return d ? json(200, d) : json(404, { error: 'asunto no encontrado' });
      }
      if (pathname === '/api/stickers') return json(200, stickers.list());
      const st = pathname.match(/^\/api\/stickers\/([A-Za-z0-9_-]{43})\.webp$/);
      if (st) {
        const buf = stickers.file(st[1]);
        if (!buf) return json(404, { error: 'sticker no encontrado' });
        res.writeHead(200, { ...headers, 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' }); // same id = same bytes
        return res.end(buf);
      }
      if (pathname === '/api/memory/chats') return json(200, { feeding: memoryChats.list(), recent: seenChats.list() });
      if (pathname === '/api/costs') {
        const t = now();
        return json(200, costTotals(readRuns(stateDir, [], (db) => db.prepare('SELECT contact_name, started_at, cost_usd FROM runs WHERE started_at >= ?').all(t - MONTH_MS)), t, profile.timezone));
      }
      if (pathname === '/api/feedback') {
        const pairs = readRuns(stateDir, [], (db) => (db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(FEEDBACK_TABLE)
          ? db.prepare(FEEDBACK_LIST(searchParams.get('unreviewed') === '1')).all().map(pairRow) : []));
        return json(200, { pairs });
      }
      if (pathname === '/api/settings') return json(200, { github: settings.github(), pipeline: { enabled: settings.pipelineEnabled() } });
      if (pathname === '/api/requests') return json(200, { requests: store().list(searchParams.get('filter')).map((r) => withStation(r)) });
      const rq = pathname.match(/^\/api\/requests\/(\d+)(?:\/files\/([^/]+)|\/(runs))?$/);
      if (rq && rq[2]) return evidenceFile(Number(rq[1]), rq[2], send, json);
      if (rq && rq[3]) {
        const d = store().detail(Number(rq[1]));
        if (!d) return json(404, { error: 'petición no encontrada' });
        const runs = readRuns(stateDir, [], (db) => db.prepare(REQUEST_RUNS).all(d.request.id).map((r) => ({
          ...runRow(r), step: r.kind.replace(/^request-/, ''), endedAt: r.ended_at, error: r.error, model: r.model,
          agents: subagents(runDetail(r, toolEvents(db, r.id)).events, d.blocks),
        })));
        return json(200, { runs });
      }
      if (rq) {
        const d = store().detail(Number(rq[1]));
        return d ? json(200, { ...d, request: withStation(d.request, d.events), texts: blockTexts(d.request.id, d.blocks), preprod: preprodOf(d.events) }) : json(404, { error: 'petición no encontrada' });
      }
      const run = pathname.match(/^\/api\/runs\/(\d+)$/);
      if (run) {
        const d = readRuns(stateDir, null, (db) => {
          const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(run[1]));
          return r && runDetail(r, db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq').all(r.id));
        });
        if (!d) return json(404, { error: 'run no encontrado' });
        const blocks = d.requestId ? store().detail(d.requestId)?.blocks ?? [] : [];
        return json(200, { ...d, agents: subagents(d.events, blocks) });
      }
      const m = pathname.match(/^\/api\/chats\/([^/]+)(\/runs|\/draft)?$/);
      if (!m) return json(404, { error: 'no encontrado' });
      let jid;
      try { jid = decodeURIComponent(m[1]); } catch { return json(400, { error: 'jid invalido' }); }
      if (m[2] === '/runs') return json(200, { runs: readRuns(stateDir, [], (db) => db.prepare(RUN_LIST).all(jid)).map(runRow) });
      if (m[2] === '/draft') {
        const row = readRuns(stateDir, null, (db) => db.prepare(DRAFT_SQL).get(jid));
        let bubbles = [];
        try { bubbles = JSON.parse(row?.decision_json ?? 'null')?.bubbles ?? []; } catch { /* redacted decision */ }
        return bubbles.length ? json(200, { bubbles }) : json(404, { error: 'sin borrador' });
      }
      const detail = chatDetail(withSelf(load({ stateDir, contactsFile }, jid)), jid);
      return detail ? json(200, detail) : json(404, { error: 'chat no encontrado' });
    } catch (e) {
      return json(500, { error: e.message });
    }
  });

  async function sendReply(req, rawJid, reqHost, json) {
    const refused = csrfRefusal(req, reqHost);
    if (refused) return json(refused.status, { error: refused.error });
    let jid;
    try { jid = decodeURIComponent(rawJid); } catch { return json(400, { error: 'jid invalido' }); }
    if (!canSend(jid)) return json(404, { error: 'chat no encontrado' });
    let body;
    try { body = await readBody(req); } catch (e) { return json(e.status ?? 400, { error: e.message }); }
    const bubbles = bubblesOf(body);
    if (!bubbles) return json(400, { error: `manda de 1 a ${MAX_BUBBLES} mensajes no vacíos de hasta ${MAX_BUBBLE} caracteres` });
    let r;
    try { r = await sendMessage(jid, bubbles); } catch (e) { return json(502, { error: e.message }); }
    return r.ok ? json(200, { ok: true, sent: r.sent }) : json(400, { error: r.reason });
  }
  // Body { id } of a sticker in the store; its webp bytes go to the chat (contacts.json or the self-chat, like a reply).
  async function sendStickerTo(req, rawJid, reqHost, json) {
    const refused = csrfRefusal(req, reqHost);
    if (refused) return json(refused.status, { error: refused.error });
    let jid;
    try { jid = decodeURIComponent(rawJid); } catch { return json(400, { error: 'jid invalido' }); }
    if (!canSend(jid)) return json(404, { error: 'chat no encontrado' });
    let body;
    try { body = await jsonBody(req); } catch (e) { return json(e.status ?? 400, { error: e.message }); }
    if (!STICKER_ID.test(typeof body.id === 'string' ? body.id : '')) return json(400, { error: 'sticker inválido' });
    const buf = stickers.file(body.id);
    if (!buf) return json(404, { error: 'sticker no encontrado' });
    try { await sendSticker(jid, buf, body.id); } catch (e) { return json(502, { error: e.message }); }
    return json(200, { ok: true });
  }

  // Approve / reject (optional reason) / ask (question -> askContact) / cancel / retry / preprod-ok (clears a review hold) /
  // merge (target: the request id it merges into; answers the merged detail). 409 = not valid in the current state.
  // Logged in request_events as the owner's actor with the cf-connecting-ip, if any (see requests.js).
  async function requestAction(req, id, action, reqHost, json) {
    const refused = csrfRefusal(req, reqHost);
    if (refused) return json(refused.status, { error: refused.error });
    if (!Object.hasOwn(ACTIONS, action)) return json(404, { error: 'acción desconocida' });
    const r = store().get(id);
    if (!r) return json(404, { error: 'petición no encontrada' });
    if (!r.actions.includes(action)) return json(409, { error: `no se puede en el estado ${r.status}` });
    let body;
    try { body = await jsonBody(req); } catch (e) { return json(e.status ?? 400, { error: e.message }); }
    const field = { ask: 'question', reject: 'reason' }[action];
    const raw = field ? body[field] : undefined;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > MAX_NOTE)) return json(400, { error: `texto de hasta ${MAX_NOTE} caracteres` });
    const text = raw?.trim() || null;
    const target = body.target;
    if (action === 'merge' && !(Number.isSafeInteger(target) && target > 0)) return json(400, { error: 'indica el número de la petición destino' });
    if (action === 'ask') {
      if (!text) return json(400, { error: 'escribe qué información le pides' });
      if (!askContact) return json(503, { error: 'el bridge no está corriendo' });
      try { await askContact(r.jid, text); } catch (e) { return json(502, { error: e.message }); }
    }
    try {
      const ip = String(req.headers['cf-connecting-ip'] ?? '').slice(0, 64) || null;
      const request = store().act(id, action, { text, ip, target });
      (async () => onRequestAction(id, action))().catch((e) => console.error('request action hook failed:', e.message));
      return json(200, action === 'merge' ? store().detail(id) : { request });
    } catch (e) {
      return json({ ILLEGAL_TRANSITION: 409, NOT_FOUND: 404 }[e.code] ?? 500, { error: e.message });
    }
  }

  // Memoria edits: the same CSRF checks as every POST; fn(body) -> true, or false = 404.
  async function memoryEdit(req, reqHost, json, fn) {
    const refused = csrfRefusal(req, reqHost);
    if (refused) return json(refused.status, { error: refused.error });
    let body;
    try { body = await jsonBody(req); } catch (e) { return json(e.status ?? 400, { error: e.message }); }
    try {
      return fn(body) ? json(200, { ok: true }) : json(404, { error: 'no encontrado' });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // "Alimentar memoria": a seen chat moves to memory-chats.json (named by its number, or Telegram id, if it came with no name).
  function feedMemory(jid) {
    const c = seenChats.list().find((x) => x.jid === jid);
    if (!c) return false;
    memoryChats.add({ jid, name: c.name?.trim() || (jid.startsWith('tg:') ? `Telegram ${jid.slice(3)}` : `+${jid.split('@')[0]}`), kind: c.kind });
    seenChats.remove(jid);
    return true;
  }

  async function setGithubToken(req, reqHost, json) {
    const refused = csrfRefusal(req, reqHost);
    if (refused) return json(refused.status, { error: refused.error });
    let body;
    try { body = await jsonBody(req); } catch (e) { return json(e.status ?? 400, { error: e.message }); }
    const r = await settings.setGithubToken(body.token);
    // Never the token itself: only why it was refused and its shape.
    if (!r.ok) console.error(`settings: GitHub token not saved: ${r.error} (length ${String(body.token ?? '').trim().length}, prefix ${String(body.token ?? '').trim().slice(0, 4)})`);
    return r.ok ? json(200, { github: r.github }) : json(r.status, { error: r.error });
  }

  // The factory station of a request row; a failed one also needs its events (where it failed). One detail read per
  // failed request in a list: a handful at most.
  function withStation(r, events) {
    return { ...r, ...stationOf(r, r.status === 'fallida' ? events ?? store().detail(r.id)?.events ?? [] : []) };
  }

  // { key: { report, review, gate, baseline } } with the texts that exist (regular files only), through the secret guard.
  function blockTexts(id, blocks) {
    const out = {};
    for (const b of blocks ?? []) {
      if (!BLOCK_KEY.test(b?.key ?? '')) continue;
      const texts = {};
      for (const [k, path] of Object.entries(BLOCK_TEXTS)) {
        const file = join(requestsDir, String(id), path(b.key));
        let text;
        try {
          if (!lstatSync(file).isFile()) continue;
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + CUT;
        texts[k] = guard(text) ? REDACTED : text;
      }
      out[b.key] = texts;
    }
    return out;
  }

  // Basenames inside <requestsDir>/<id>/ only; regular files (no symlinks); PNG (checked by signature) or text.
  function evidenceFile(id, rawName, send, json) {
    let name;
    try { name = decodeURIComponent(rawName); } catch { return json(400, { error: 'nombre inválido' }); }
    if (!EVIDENCE_NAME.test(name)) return json(400, { error: 'nombre inválido' });
    const type = EVIDENCE_TYPES[extname(name).toLowerCase()];
    if (!type) return json(415, { error: 'solo PNG o texto' });
    const file = join(requestsDir, String(id), name);
    let buf;
    try {
      if (!lstatSync(file).isFile()) return json(404, { error: 'archivo no encontrado' });
      buf = readFileSync(file);
    } catch {
      return json(404, { error: 'archivo no encontrado' });
    }
    if (type === 'image/png') return buf.subarray(0, 8).equals(PNG_SIGNATURE) ? send(200, type, buf) : json(415, { error: 'no es un PNG' });
    const text = buf.toString('utf8');
    return send(200, type, guard(text) ? REDACTED : text);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const BRIDGE = dirname(dirname(fileURLToPath(import.meta.url)));
  const { profile, workspace, pipeline, knowledge } = await (await import('./config.js')).loadConfig(); // entrypoint: loads the config itself
  const stateDir = join(BRIDGE, 'state');
  const server = await startPortal({ profile, knowledge, pipeline, stateDir, contactsFile: join(BRIDGE, 'contacts.json'), port: Number(process.env.PORTAL_PORT ?? 4747),
    requestsDir: workspace.requestsDir, settings: createSettings({ stateDir, service: profile.keychainService, pipeline }) });
  console.log(`portal en http://127.0.0.1:${server.address().port}`);
}
