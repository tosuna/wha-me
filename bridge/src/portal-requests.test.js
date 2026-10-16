import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portalToken, startPortal as start } from './portal.js';
import { createRequests } from './requests.js';
import { createRunLog, REDACTED, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';
import { none } from './deploy.js';
import { createSettings } from './settings.js';
import example from '../../config/example.config.js';

// Neutral pipeline: repos under two owners (the token is checked against each).
const PIPELINE = { branchPrefix: 'pet/', repos: { api: { github: 'acme/api', prodBranch: 'main', deploy: none() }, site: { github: 'alex/site', prodBranch: 'main', deploy: none() } } };
const PIPELINE_REPOS = Object.values(PIPELINE.repos).map((r) => r.github);

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const BEA = 'bea@s.whatsapp.net';
const TUNNEL = 'abc-def.trycloudflare.com';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const GH_TOKEN = 'ghp_' + 'ZZZ0123456789abcdefghijklmnopqrstuvwxyzAB' // fake, split so scanners don't flag it;
const fr = (summary) => ({ type: 'feature-request', blocking: false, fields: { summary, evidence: 'problema: x' } });

function req(port, { method = 'GET', path = '/', host = TUNNEL, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buf });
      });
    }).on('error', reject);
    r.end(body);
  });
}

// No Host is trusted: every test server comes logged in, and local() sends that session cookie.
const sessions = new Map();
async function startPortal(opts) {
  const server = await start(opts);
  const { port } = server.address();
  const login = await req(port, { path: `/login?k=${portalToken(opts.stateDir)}` });
  sessions.set(port, login.headers['set-cookie'][0].split(';')[0]);
  return server;
}

async function setup(t, { ask = async () => {}, github = 200, onRequestAction } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-req-'));
  const stateDir = join(dir, 'state');
  const requestsDir = join(dir, 'wha-me-requests');
  mkdirSync(stateDir);
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify([{ jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' }]));
  const requests = createRequests({ profile: PROFILE, file: join(stateDir, RUNS_DB) });
  const nueva = requests.fromHandoff(BEA, { name: 'Bea' }, fr('reporte de becas'), { shadow: false }).id;
  const activa = requests.fromHandoff(BEA, { name: 'Bea' }, fr('campo curp en eventos'), { shadow: false }).id;
  requests.act(activa, 'approve', {});
  mkdirSync(join(requestsDir, String(nueva)), { recursive: true });
  writeFileSync(join(requestsDir, String(nueva), 'shot.png'), PNG);
  writeFileSync(join(requestsDir, String(nueva), 'report.txt'), 'todo bien');
  writeFileSync(join(requestsDir, String(nueva), 'fake.png'), 'not a png');
  writeFileSync(join(requestsDir, String(nueva), 'page.html'), '<script>1</script>');
  writeFileSync(join(requestsDir, String(nueva), '.env'), 'X=1');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  symlinkSync(join(dir, 'secret.txt'), join(requestsDir, String(nueva), 'link.txt'));
  const asks = [];
  const security = [];
  const settings = createSettings({ service: 'wha-me', pipeline: PIPELINE, stateDir,
    execFile: async (cmd, args) => { security.push([cmd, args]); return { stdout: '' }; },
    fetch: async (url) => ({
      ok: github === 200, status: url.endsWith('/user') || PIPELINE_REPOS.some((r) => url.endsWith(r)) ? github : 404,
      headers: new Headers({ 'github-authentication-token-expiration': '2026-11-14 18:05:13 -0600', 'x-oauth-scopes': 'repo' }),
      json: async () => ({ permissions: { push: true } }),
    }),
  });
  const server = await startPortal({
    profile: PROFILE, stateDir, contactsFile: join(dir, 'contacts.json'), port: 0, requests, requestsDir, settings,
    askContact: async (...a) => { asks.push(a); return ask(...a); }, onRequestAction,
  });
  t.after(() => { server.close(); requests.close(); });
  const port = server.address().port;
  return { port, requests, nueva, activa, asks, security, stateDir, cookie: sessions.get(port) };
}

const local = (port, path) => req(port, { path, host: `127.0.0.1:${port}`, headers: { cookie: sessions.get(port) } });
const post = (port, path, { cookie, origin = `https://${TUNNEL}`, type = 'application/json', body = {}, ip } = {}) => req(port, {
  method: 'POST', path,
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('GET /api/requests: filters and list shape', async (t) => {
  const { port, nueva, activa } = await setup(t);
  const ids = async (q) => JSON.parse((await local(port, `/api/requests${q}`)).body).requests.map((r) => r.id);
  assert.deepEqual(await ids(''), [activa, nueva]);
  assert.deepEqual(await ids('?filter=por_revisar'), [nueva]);
  assert.deepEqual(await ids('?filter=activas'), [activa]);
  assert.deepEqual(await ids('?filter=listas'), []);
  assert.deepEqual(await ids('?filter=cerradas'), []);
  const [r] = JSON.parse((await local(port, '/api/requests?filter=por_revisar')).body).requests;
  assert.deepEqual([r.contactName, r.summary, r.status, r.handoffCount], ['Bea', 'reporte de becas', 'nueva', 1]);
  assert.equal((await req(port, { path: '/api/requests' })).status, 401, 'remote without a session');
});

test('GET /api/requests/:id: request with its valid actions, evidence briefs, events timeline; 404 otherwise', async (t) => {
  const { port, nueva } = await setup(t);
  const d = JSON.parse((await local(port, `/api/requests/${nueva}`)).body);
  assert.deepEqual(d.request.actions, ['approve', 'reject', 'ask', 'merge']);
  assert.equal(d.evidence[0].evidence, 'problema: x');
  assert.deepEqual(d.events.map((e) => e.toStatus), ['nueva']);
  for (const p of ['/api/requests/999', '/api/requests/abc']) assert.equal((await local(port, p)).status, 404, p);
});

test('GET /api/requests/:id/files/:name: PNG and text only, basenames inside the request dir; traversal rejected', async (t) => {
  const { port, nueva } = await setup(t);
  const png = await local(port, `/api/requests/${nueva}/files/shot.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.deepEqual(png.buf, PNG);
  const txt = await local(port, `/api/requests/${nueva}/files/report.txt`);
  assert.equal(txt.status, 200);
  assert.match(txt.headers['content-type'], /^text\/plain/);
  assert.equal(txt.headers['x-content-type-options'], 'nosniff');
  assert.equal(txt.body, 'todo bien');
  for (const name of ['..%2Fsecret.txt', '%2e%2e%2F%2e%2e%2Fsecret.txt', '..', '.env', 'a%2Fb.txt', '%E0%A4%A']) {
    assert.ok([400, 404].includes((await local(port, `/api/requests/${nueva}/files/${name}`)).status), name);
  }
  assert.equal((await local(port, `/api/requests/${nueva}/../../secret.txt`)).status, 404);
  for (const name of ['page.html', 'fake.png']) assert.equal((await local(port, `/api/requests/${nueva}/files/${name}`)).status, 415, name);
  assert.equal((await local(port, `/api/requests/${nueva}/files/link.txt`)).status, 404, 'symlink out of the dir');
  assert.equal((await local(port, `/api/requests/${nueva}/files/missing.txt`)).status, 404);
});

test('POST actions: CSRF (session, Origin, content-type) before anything; nothing changes on refusal', async (t) => {
  const { port, nueva, requests, cookie } = await setup(t);
  const path = `/api/requests/${nueva}/approve`;
  assert.equal((await post(port, path)).status, 401, 'no cookie');
  assert.equal((await post(port, path, { cookie, origin: null })).status, 403, 'no Origin');
  assert.equal((await post(port, path, { cookie, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await post(port, path, { cookie, type: 'text/plain' })).status, 415, 'text/plain');
  assert.equal(requests.get(nueva).status, 'nueva');
});

test('POST actions: 409 on an invalid state, 404 on unknown request/action; approve logs actor owner + cf-connecting-ip', async (t) => {
  const { port, nueva, activa, requests, cookie } = await setup(t);
  assert.equal((await post(port, `/api/requests/${nueva}/cancel`, { cookie })).status, 409);
  assert.equal((await post(port, `/api/requests/${activa}/approve`, { cookie })).status, 409);
  assert.equal((await post(port, '/api/requests/999/approve', { cookie })).status, 404);
  assert.equal((await post(port, `/api/requests/${nueva}/explode`, { cookie })).status, 404);
  const r = await post(port, `/api/requests/${nueva}/approve`, { cookie, ip: '201.1.2.3' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).request.status, 'aprobada');
  assert.deepEqual(requests.detail(nueva).events.at(-1), { ...requests.detail(nueva).events.at(-1), actor: 'owner', toStatus: 'aprobada', ip: '201.1.2.3' });
  const c = await post(port, `/api/requests/${activa}/cancel`, { cookie });
  assert.equal(JSON.parse(c.body).request.status, 'fallida');
  assert.equal(JSON.parse((await post(port, `/api/requests/${activa}/retry`, { cookie })).body).request.status, 'aprobada');
});

test('POST reject keeps the optional reason; ask needs a question, runs askContact(jid, note) and moves to info_pedida', async (t) => {
  const { port, nueva, requests, asks, cookie } = await setup(t);
  assert.equal((await post(port, `/api/requests/${nueva}/ask`, { cookie, body: { question: '   ' } })).status, 400);
  assert.equal((await post(port, `/api/requests/${nueva}/ask`, { cookie, body: 'no json' })).status, 400);
  assert.equal(asks.length, 0);
  const r = await post(port, `/api/requests/${nueva}/ask`, { cookie, body: { question: 'cuantos registros al mes?' }, ip: '201.1.2.3' });
  assert.equal(r.status, 200);
  assert.deepEqual(asks, [[BEA, 'cuantos registros al mes?']]);
  assert.equal(requests.get(nueva).status, 'info_pedida');
  assert.equal(requests.get(nueva).question, 'cuantos registros al mes?');
  assert.equal(requests.detail(nueva).events.at(-1).ip, '201.1.2.3');
  const other = requests.fromHandoff(BEA, { name: 'Bea' }, fr('otra cosa distinta totalmente'), { shadow: false }).id;
  assert.equal((await post(port, `/api/requests/${other}/reject`, { cookie, body: { reason: 'ya existe' } })).status, 200);
  assert.equal(requests.detail(other).events.at(-1).text, 'ya existe');
});

test('POST ask: askContact failing = 502 and the request stays nueva', async (t) => {
  const { port, nueva, requests, cookie } = await setup(t, { ask: async () => { throw new Error('WhatsApp todavía no está conectado'); } });
  assert.equal((await post(port, `/api/requests/${nueva}/ask`, { cookie, body: { question: 'x?' } })).status, 502);
  assert.equal(requests.get(nueva).status, 'nueva');
});

test('Ajustes: GitHub token stored through the fake security tool; never in the response, settings or console', async (t) => {
  const { port, cookie, security, stateDir } = await setup(t);
  assert.deepEqual(JSON.parse((await local(port, '/api/settings')).body), { github: { configured: false, expiresAt: null, warnings: [] }, pipeline: { enabled: false } });
  assert.equal((await post(port, '/api/settings/github-token', { cookie, origin: 'https://evil.example', body: { token: GH_TOKEN } })).status, 403);
  const out = [];
  const orig = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  let r;
  try {
    r = await post(port, '/api/settings/github-token', { cookie, body: { token: GH_TOKEN } });
  } finally {
    [console.log, console.error] = orig;
  }
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes(GH_TOKEN));
  assert.deepEqual(JSON.parse(r.body), { github: { configured: true, expiresAt: Date.parse('2026-11-15T00:05:13Z'), warnings: [] } });
  assert.deepEqual(security, [['security', ['add-generic-password', '-U', '-s', 'wha-me', '-a', 'github.token', '-w', GH_TOKEN]]]);
  assert.ok(!out.join('\n').includes(GH_TOKEN));
  assert.ok(!readFileSync(join(stateDir, 'settings.json'), 'utf8').includes(GH_TOKEN));
});

test('Ajustes: an invalid token is 400 and nothing is stored', async (t) => {
  const { port, cookie, security } = await setup(t, { github: 401 });
  const r = await post(port, '/api/settings/github-token', { cookie, body: { token: GH_TOKEN } });
  assert.equal(r.status, 400);
  assert.ok(!r.body.includes(GH_TOKEN));
  assert.deepEqual(security, []);
  assert.equal(JSON.parse((await local(port, '/api/settings')).body).github.configured, false);
});

test('the GitHub token set in Ajustes is redacted from the run log (secret guard reads settings.token())', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-guard-'));
  const settings = createSettings({ service: 'wha-me', pipeline: PIPELINE, stateDir: dir, execFile: async () => ({ stdout: '' }),
    fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'x-oauth-scopes': 'repo' }), json: async () => ({ permissions: { push: true } }) }),
  });
  const leaks = createSecretGuard({ readFile: () => '', secrets: () => [settings.token()] });
  // Not ghp_-prefixed on purpose: only the literal check can catch it.
  const plain = 'ZZtok3nZZ0123456789abcdefXYZ';
  await settings.setGithubToken(plain);
  const file = join(dir, RUNS_DB);
  const log = createRunLog({ file, leaks });
  const run = log.start({ kind: 'reply', mode: 'real', jid: BEA });
  run.event({ kind: 'text', text: `aqui va ${plain}` });
  run.finish({ result: plain, decision: { bubbles: [plain] }, outcome: 'sent' });
  log.close();
  assert.ok(!readFileSync(file).includes(plain));
});

test('POST preprod-ok: only en_revision with a hold (409 otherwise, CSRF first); clears the hold -> en_preprod; the page shows the reasons', async (t) => {
  const { port, activa, requests, cookie } = await setup(t);
  for (const s of ['planificando', 'implementando', 'en_revision']) requests.transition(activa, s, { actor: 'bridge' });
  assert.equal((await post(port, `/api/requests/${activa}/preprod-ok`, { cookie })).status, 409, 'no hold');
  requests.patch(activa, { hold: 'presets-api: .github/workflows/ci.yml (GitHub)' });
  assert.equal((await post(port, `/api/requests/${activa}/preprod-ok`, { cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal(requests.get(activa).status, 'en_revision');
  const r = await post(port, `/api/requests/${activa}/preprod-ok`, { cookie, ip: '201.1.2.3' });
  assert.equal(r.status, 200);
  assert.deepEqual([JSON.parse(r.body).request.status, requests.get(activa).hold], ['en_preprod', null]);
  assert.deepEqual(requests.detail(activa).events.at(-1), { ...requests.detail(activa).events.at(-1), actor: 'owner', toStatus: 'en_preprod', ip: '201.1.2.3' });
  const { body } = await local(port, '/');
  for (const s of ["'preprod-ok'", 'OK para preprod', 'Requiere tu OK para preprod', 'r.hold']) assert.ok(body.includes(s), s);
});

test('POST clash-ok: only en_preprod held by a clash; clears the hold, stays en_preprod; the page shows overlaps and verdict', async (t) => {
  const { port, activa, requests, cookie } = await setup(t);
  for (const s of ['planificando', 'implementando', 'en_revision', 'en_preprod']) requests.transition(activa, s, { actor: 'bridge' });
  requests.patch(activa, { hold: 'esperando a que preprod esté arriba' });
  assert.equal((await post(port, `/api/requests/${activa}/clash-ok`, { cookie })).status, 409, 'not a clash hold');
  requests.patch(activa, { hold: 'choque con #9: misma tabla', clash: { signature: 's', overlaps: [{ ref: '#9', project: 'x', files: [], tables: ['A/b/c'] }], verdict: { clash: true, impact: 'i', recommendation: 'r' }, acked: null } });
  const r = await post(port, `/api/requests/${activa}/clash-ok`, { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual([requests.get(activa).status, requests.get(activa).hold, requests.detail(activa).clash.acked], ['en_preprod', null, 's']);
  assert.equal(JSON.parse((await local(port, `/api/requests/${activa}`)).body).clash.verdict.impact, 'i');
  const { body } = await local(port, '/');
  for (const s of ["'clash-ok'", 'Continuar pese al choque', 'Choques con otras peticiones', 'Detenida por choque']) assert.ok(body.includes(s), s);
});

test('page has the Peticiones view (filters, Por qué, timeline, action bar) and Ajustes (GitHub token), textContent only', async (t) => {
  const { port } = await setup(t);
  const { body } = await local(port, '/');
  for (const s of ['data-view="requests"', 'Peticiones', '/api/requests', 'Por revisar', 'Activas', 'Listas', 'Cerradas', 'Por qué', 'Historial',
    'id="req-bar"', 'Aprobar', 'Rechazar', 'Pedir info', 'confirm(', 'id="settings-btn"', 'Ajustes', '/api/settings/github-token', 'id="gh-chip"',
    'https://github.com/settings/tokens/new?scopes=repo', "type = 'password'"]) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('npm run portal on a fresh state: opening Peticiones first does not break the run views (no runs table yet)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-portal-fresh-'));
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'contacts.json'), '[]');
  const server = await startPortal({ profile: PROFILE, stateDir: join(dir, 'state'), contactsFile: join(dir, 'contacts.json'), port: 0, requestsDir: dir });
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal((await local(port, '/api/requests')).status, 200);
  for (const p of ['/api/costs', '/api/feedback', `/api/chats/${encodeURIComponent(BEA)}/runs`, '/api/runs/1']) assert.ok([200, 404].includes((await local(port, p)).status), p);
  assert.equal((await local(port, '/api/costs')).status, 200);
});

test('a successful action hands (id, action) to the pipeline hook; a refused one does not', async (t) => {
  const seen = [];
  const { port, cookie, nueva, activa } = await setup(t, { onRequestAction: (...a) => seen.push(a) });
  assert.equal((await post(port, `/api/requests/${nueva}/approve`, { cookie })).status, 200);
  assert.equal((await post(port, `/api/requests/${nueva}/approve`, { cookie })).status, 409);
  assert.equal((await post(port, `/api/requests/${activa}/cancel`, { cookie })).status, 200);
  assert.deepEqual(seen, [[nueva, 'approve'], [activa, 'cancel']]);
});

test('Ajustes shows the pipeline engine: PIPELINE_ENABLED in state/settings.json, off by default', async (t) => {
  const { port, stateDir } = await setup(t);
  writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ PIPELINE_ENABLED: true }));
  assert.deepEqual(JSON.parse((await local(port, '/api/settings')).body).pipeline, { enabled: true });
  const body = (await local(port, '/')).body;
  for (const s of ['Motor de peticiones', 'apagado (en construcción)', 'queuePosition', 'stepAttempt', 'Ver corrida']) assert.ok(body.includes(s), s);
});

// --- Fábrica: stations, a request's runs with their subagents, evidence texts ---

// activa implemented with two blocks: an implement run whose orchestrator delegated each block to an implementer subagent.
function implemented(t, { requests, activa, stateDir, requestsDir }) {
  for (const s of ['planificando', 'implementando']) requests.transition(activa, s, { actor: 'bridge' });
  const blocks = [
    { key: 'api', project: 'acme-api', branch: `pet/${activa}-api`, worktree: `/w/acme-api-worktrees/pet-${activa}-api`, commits: ['c1'], verdict: null },
    { key: 'ui', project: 'acme-web', branch: `pet/${activa}-ui`, worktree: `/w/acme-web-worktrees/pet-${activa}-ui`, commits: [], verdict: null },
  ];
  requests.patch(activa, { plan: { blocks: blocks.map((b) => ({ key: b.key, project: b.project, goal: 'g', spec: 's' })), migrations: [], e2e: [], risks: [] }, blocks, step: 'implement', stepAttempt: 1 });
  const log = createRunLog({ file: join(stateDir, RUNS_DB), leaks: createSecretGuard({ readFile: () => '' }) });
  t.after(() => log.close());
  const plan = log.start({ kind: 'request-plan', mode: 'real', contact: { name: 'Bea' }, jid: BEA, requestId: activa });
  plan.event({ kind: 'tool_use', id: 'p1', name: 'Read', input: { file_path: '/v/CLAUDE.md' } });
  plan.finish({ result: 'plan', outcome: 'ok' });
  const run = log.start({ kind: 'request-implement', mode: 'real', contact: { name: 'Bea' }, jid: BEA, requestId: activa });
  run.event({ kind: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'implementer', prompt: `Spec: ${requestsDir}/${activa}/specs/api.md` } });
  run.event({ kind: 'tool_use', id: 'a2', name: 'Agent', input: { subagent_type: 'implementer', prompt: `## Project\nacme-web @ /w/acme-web-worktrees/pet-${activa}-ui (branch pet/${activa}-ui)` } });
  run.event({ kind: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' }, parent: 'a1' });
  run.event({ kind: 'tool_result', id: 'c1', status: 'error', size: 10, parent: 'a1' });
  run.event({ kind: 'tool_use', id: 'c2', name: 'Edit', input: { file_path: '/x' }, parent: 'a2' });
  run.event({ kind: 'tool_result', id: 'a1', status: 'ok', size: 40 });
  const other = log.start({ kind: 'reply', mode: 'real', contact: { name: 'Bea' }, jid: BEA });
  other.finish({ result: 'REPLY: hola', outcome: 'sent' });
  return { planRun: plan.id, implRun: run.id };
}

test('GET /api/requests: each row says its factory station (and where a failed one failed)', async (t) => {
  const { port, nueva, activa, requests } = await setup(t);
  const rows = async () => Object.fromEntries(JSON.parse((await local(port, '/api/requests')).body).requests.map((r) => [r.id, [r.station, r.failedAt]]));
  assert.deepEqual(await rows(), { [nueva]: ['intake', null], [activa]: ['planning', null] });
  requests.transition(activa, 'planificando', { actor: 'bridge' });
  requests.transition(activa, 'fallida', { actor: 'bridge', text: 'tiempo agotado' });
  assert.deepEqual((await rows())[activa], ['blocked', 'planning']);
});

test('GET /api/requests/:id/runs: the request\'s pipeline runs in order, each with its step and subagents mapped to blocks; GET only, session required', async (t) => {
  const s = await setup(t);
  const dir = join(s.stateDir, '..', 'wha-me-requests');
  const { planRun, implRun } = implemented(t, { ...s, requestsDir: dir });
  const r = await local(s.port, `/api/requests/${s.activa}/runs`);
  assert.equal(r.status, 200);
  const { runs } = JSON.parse(r.body);
  assert.deepEqual(runs.map((x) => [x.id, x.step, x.status, x.toolCount]), [[planRun, 'plan', 'ok', 1], [implRun, 'implement', 'running', 4]]);
  assert.deepEqual(runs[0].agents, []);
  assert.deepEqual(runs[1].agents.map((a) => [a.toolUseId, a.block, a.subagentType, a.status, a.toolCount, a.errors]), [
    ['a1', 'api', 'implementer', 'ok', 1, 1],
    ['a2', 'ui', 'implementer', 'missing', 1, 0],
  ]);
  for (const k of ['startedAt', 'durationMs', 'costUsd', 'error', 'model']) assert.ok(k in runs[1], k);
  assert.equal((await local(s.port, '/api/requests/999/runs')).status, 404);
  assert.equal((await req(s.port, { path: `/api/requests/${s.activa}/runs` })).status, 401, 'remote without a session');
  assert.equal((await req(s.port, { path: `/api/requests/${s.activa}/runs`, headers: { cookie: s.cookie } })).status, 200, 'remote with a session');
  const p = await post(s.port, `/api/requests/${s.activa}/runs`, { cookie: s.cookie });
  assert.notEqual(p.status, 200, 'not a mutation');
  assert.equal(s.requests.get(s.activa).status, 'implementando');
});

test('GET /api/runs/:id of an implement run: events carry their parent call; agents grouped and mapped to the request blocks', async (t) => {
  const s = await setup(t);
  const { implRun } = implemented(t, { ...s, requestsDir: join(s.stateDir, '..', 'wha-me-requests') });
  const d = JSON.parse((await local(s.port, `/api/runs/${implRun}`)).body);
  assert.deepEqual(d.events.map((e) => [e.name, e.toolUseId, e.parentToolUseId]), [['Agent', 'a1', null], ['Agent', 'a2', null], ['Bash', 'c1', 'a1'], ['Edit', 'c2', 'a2']]);
  assert.deepEqual(d.agents.map((a) => [a.toolUseId, a.block]), [['a1', 'api'], ['a2', 'ui']]);
  assert.equal(d.requestId, s.activa);
});

test('GET /api/requests/:id: evidence texts per block (report, review, gate, baseline), capped, redacted, only valid block keys', async (t) => {
  const s = await setup(t);
  const dir = mkdtempSync(join(tmpdir(), 'wa-ev-'));
  const server = await startPortal({ profile: PROFILE, stateDir: s.stateDir, contactsFile: join(s.stateDir, '..', 'contacts.json'), port: 0, requests: s.requests, requestsDir: dir });
  t.after(() => server.close());
  const port = server.address().port;
  const base = join(dir, String(s.activa));
  for (const d of ['reports', 'reviews', 'tests']) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, 'reports', 'api.md'), '## Report\nVerify: passed');
  writeFileSync(join(base, 'reviews', 'api.md'), '# Revisión de api\n- falta un test');
  writeFileSync(join(base, 'tests', 'api-gate.txt'), `$ npm test\n(exit 1)\n${'x'.repeat(100_000)}`);
  writeFileSync(join(base, 'tests', 'api-baseline.txt'), `token ${'ghp_'}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`);
  writeFileSync(join(dir, 'outside.md'), 'nope');
  s.requests.patch(s.activa, { blocks: [{ key: 'api', project: 'acme-api' }, { key: '../outside', project: 'x' }] });
  const d = JSON.parse((await local(port, `/api/requests/${s.activa}`)).body);
  assert.deepEqual(Object.keys(d.texts), ['api']);
  const api = d.texts.api;
  assert.equal(api.report, '## Report\nVerify: passed');
  assert.equal(api.review, '# Revisión de api\n- falta un test');
  assert.ok(api.gate.length < 70_000 && api.gate.startsWith('$ npm test') && api.gate.endsWith('[recortado]'), 'capped');
  assert.equal(api.baseline, REDACTED);
  assert.ok(!JSON.stringify(d).includes('ghp_'));
  assert.deepEqual(JSON.parse((await local(port, `/api/requests/${s.nueva}`)).body).texts, {}, 'no blocks yet');
});

test('page has the Fábrica view: Lista/Fábrica toggle, one team per request through the stations, process filter, bitácora, subagent streams, reduced motion', async (t) => {
  const { port } = await setup(t);
  const { body } = await local(port, '/');
  for (const s of ['Fábrica', 'Lista', 'Product Manager', 'Tech Lead', 'Developers', 'Reviewer', 'QA', 'Tu visto bueno', 'Incidentes', 'Bitácora',
    '/runs', 'parentToolUseId', 'station', 'failedAt', 'prefers-reduced-motion', 'Ver cerradas', 'texts', 'Equipo #', 'Todos', 'preserve-3d', 'openStream']) assert.ok(body.includes(s), s);
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('GET /api/requests/:id: preprod links (branch push, PR, deploy) from the preprod step\'s events; the page renders them', async (t) => {
  const { port, activa, requests } = await setup(t);
  requests.event(activa, { actor: 'agent:preprod', kind: 'pr', text: 'api: https://github.com/o/r/pull/5' });
  const d = JSON.parse((await local(port, `/api/requests/${activa}`)).body);
  assert.deepEqual(d.preprod.map((x) => x.url), ['https://github.com/o/r/pull/5']);
  const { body } = await local(port, '/');
  for (const s of ['preprodNode(', "section('Preprod'", "startsWith('https://github.com/')"]) assert.ok(body.includes(s), s);
});

test('POST merge: session + CSRF like every action; target must be a positive integer; returns the merged detail', async (t) => {
  const { port, nueva, activa, requests, cookie } = await setup(t);
  const other = requests.fromHandoff(BEA, { name: 'Bea' }, fr('otra cosa distinta totalmente'), { shadow: false }).id;
  const path = `/api/requests/${other}/merge`;
  assert.equal((await post(port, path, { body: { target: nueva } })).status, 401, 'no cookie');
  assert.equal((await post(port, path, { cookie, origin: 'https://evil.example', body: { target: nueva } })).status, 403);
  for (const target of [undefined, '3; DROP', -1, 3.5, '1', 0]) assert.equal((await post(port, path, { cookie, body: { target } })).status, 400, String(target));
  assert.equal((await post(port, path, { cookie, body: { target: 999 } })).status, 404);
  assert.equal((await post(port, path, { cookie, body: { target: other } })).status, 409);
  assert.equal((await post(port, `/api/requests/${activa}/merge`, { cookie, body: { target: nueva } })).status, 409, 'active source');
  assert.equal(requests.get(other).status, 'nueva');
  const r = await post(port, path, { cookie, body: { target: nueva }, ip: '201.1.2.3' });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.deepEqual([d.request.status, d.request.mergedInto], ['fusionada', nueva]);
  assert.deepEqual(d.events.at(-1), { ...d.events.at(-1), actor: 'owner', toStatus: 'fusionada', ip: '201.1.2.3' });
  assert.equal(requests.get(nueva).handoffCount, 2);
});
