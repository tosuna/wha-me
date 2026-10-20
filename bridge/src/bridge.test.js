import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStageLock } from './pipeline.js';
import { ARCHIVE_BATCH, ARCHIVE_QUIET_MS, canonicalChat, createBridge, knownPeopleOf, personKey } from './bridge.js';
import { createNotifier } from './notify.js';
import { parseAgentOutput, parseJobOutput } from './core/parse.js';
import { applyCommand } from './core/state.js';
import { skillDir } from './agent.js';
import { createSecretGuard } from './secrets.js';
import { createStore, historyFile } from './store.js';
import { createArchivist } from './archivist.js';
import { contactKey, createTopics } from './topics.js';
import { createRequests } from './requests.js';
import { createSeenChats } from './seen-chats.js';
import example from '../../config/example.config.js';

const ROOT = '/home/alex/work'; // workspace root: trimmed from /simular trace paths

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)
const SKILL_DIR = skillDir(PROFILE);

const SELF = 'me@s.whatsapp.net';
const BEA = 'bea@s.whatsapp.net';
const DALIA = 'dalia@s.whatsapp.net';
const INIGO = 'inigo@s.whatsapp.net';
const contacts = [
  { jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo', canTriggerImplementation: true },
  { jid: DALIA, name: 'Dalia', register: 'usted', tenant: 'demo2', canTriggerImplementation: false },
  { jid: INIGO, name: 'Íñigo Muestra', register: 'usted', tenant: 'demo2', canTriggerImplementation: false },
  { jid: 'bea@lid', name: 'Bea', register: 'tu', tenant: 'demo', canTriggerImplementation: true }, // same person, LID jid
];
const DELAY = 1000;
const NPM_TOKEN = 'npmTok3nValue99';
const PORTAL_TOKEN = 'f00d'.repeat(16);
const HEALTH = [{ url: 'https://example.com', status: 200, ms: 50 }];

// Minimal fake honoring the core API; agent/job text is JSON of the parsed shape.
function fakeCore(over = {}) {
  return {
    replyDelayMs: () => DELAY,
    shadowDelayMs: () => DELAY,
    personaDelayMs: () => DELAY,
    typingMs: (t) => t.length * 1000,
    bubbleGapMs: () => 2000,
    isWithinHours: () => true,
    nextOpening: (d) => new Date(d.getTime() + 3_600_000),
    isOwnerActive: (last, now, w = 1_800_000) => last != null && now - last < w,
    lookupContact: (cs, jid) => cs.find((c) => c.jid === jid) ?? null,
    createDebouncer({ setTimer, clearTimer, delayMs }) {
      const t = new Map();
      return {
        bump(k, fn) {
          if (t.has(k)) clearTimer(t.get(k));
          t.set(k, setTimer(() => { t.delete(k); return fn(); }, typeof delayMs === 'function' ? delayMs() : delayMs));
        },
        cancel(k) { if (t.has(k)) clearTimer(t.get(k)); t.delete(k); },
        pending: (k) => t.has(k),
      };
    },
    parseAgentOutput: (text) => JSON.parse(text),
    parseJobOutput: (text) => JSON.parse(text),
    initialState: () => ({ paused: false, locked: false, shadow: true }),
    applyCommand(state, text) {
      const m = { '/pausa': { paused: true }, '/sigue': { paused: false }, '/desbloquear': { locked: false }, '/sombra off': { shadow: false } }[text];
      return m ? { state: { ...state, ...m }, reply: `ok ${text}` } : null;
    },
    ...over,
  };
}

function setup({ core = {}, state = {}, reply, job, trace = [], jobSim, snaps = [], dir = mkdtempSync(join(tmpdir(), 'wa-bridge-')), topics, topicLines, archiveRun, memoryChats = [], links = [], tracer, notify, runLog, actions, feedback, learner, contacts: cs = contacts, groups = {}, portalLink, requests, stageLock, seenChats = createSeenChats({ file: join(dir, 'seen-chats.json') }) } = {}) {
  const log = [];
  const logs = [];
  const alerts = [];
  let t = Date.parse('2026-10-05T15:00:00Z');
  let n = 0;
  const timers = new Map();
  const clock = {
    now: () => new Date(t),
    sleep: async (ms) => { log.push(['sleep', ms]); t += ms; },
    setTimer: (fn, ms) => { timers.set(++n, { fn, at: t + ms }); return n; },
    clearTimer: (id) => timers.delete(id),
  };
  async function advance(ms) {
    t += ms;
    for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (x.at <= t && timers.has(id)) { timers.delete(id); await x.fn(); }
    }
    await new Promise((r) => setImmediate(r));
  }
  let sent = 0;
  const wa = {
    markRead: async (keys) => { log.push(['read', keys.length]); },
    sendPresence: async (jid, type) => { log.push(['presence', jid, type]); },
    sendText: async (jid, text, opts) => { log.push(['send', jid, text, ...(opts ? [opts] : [])]); return `B${++sent}`; },
    sendSticker: async (jid, buffer) => { log.push(['sticker', jid, buffer]); return `B${++sent}`; },
    fetchGroups: async () => { if (groups instanceof Error) throw groups; return groups; },
  };
  const calls = { reply: [], job: [], jobSim: [], recall: [], archive: [] };
  const realTopics = topics ?? createTopics({ profile: PROFILE, file: ':memory:', now: () => t });
  topics = { ...realTopics, recall: (q) => { calls.recall.push(q); return topicLines ?? realTopics.recall(q); } };
  const agent = {
    runReply: async (arg) => {
      calls.reply.push(arg);
      const r = await (typeof reply === 'function' ? reply(arg) : reply);
      return typeof r === 'string' ? r : JSON.stringify(r ?? { bubbles: ['hola'], handoff: null, implement: null });
    },
    runReplyTrace: async (arg) => ({ result: await agent.runReply(arg), calls: trace, durationMs: 7800, costUsd: 0.0571 }),
    runJob: (arg) => { calls.job.push(arg); return typeof job === 'function' ? job(arg) : Promise.resolve(JSON.stringify(job)); },
    runJobSim: async (arg) => { calls.jobSim.push(arg); return typeof jobSim === 'function' ? jobSim(arg) : jobSim; },
    snapshotRepos: async () => snaps.shift() ?? [],
  };
  const c = fakeCore(core);
  const store = createStore(dir, { initialState: c.initialState });
  store.setState({ ...c.initialState(), ...state });
  const health = async () => HEALTH;
  const leaks = createSecretGuard({ readFile: () => `//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n`, secrets: [PORTAL_TOKEN] });
  const archiver = createArchivist({ profile: PROFILE, topics, run: archiveRun ?? (async () => ({ text: '{"ops":[]}', costUsd: 0.001 })), leaks, now: () => t });
  const archivist = { archive: (a) => { calls.archive.push(a); return archiver.archive(a); } };
  const make = () => createBridge({ profile: PROFILE, workspace: { root: ROOT }, wa, store, agent, clock, contacts: cs, selfJid: SELF, core: c, health, leaks, topics, archivist, memoryChats: { list: () => memoryChats }, contactLinks: { list: () => links }, trace: tracer, notify: notify ?? ((a) => alerts.push(a)), runLog, actions, feedback, learner, portalLink, requests, stageLock, seenChats, log: (...a) => logs.push(a.join(' ')) });
  const bridge = make();
  let m = 0;
  const msg = (chatJid, text, extra = {}) =>
    bridge.handleMessage({ id: `M${++m}`, chatJid, fromMe: false, text, timestamp: t, pushName: 'x', key: { id: `M${m}` }, ...extra });
  const toSelf = () => log.filter((l) => l[0] === 'send' && l[1] === SELF).map((l) => l[2]);
  const toContact = (jid) => log.filter((l) => l[0] === 'send' && l[1] === jid).map((l) => l[2]);
  return { bridge, make, store, log, logs, calls, advance, msg, toSelf, toContact, timers, now: () => t, dir, alerts, topics, seenChats };
}

test('ignores jids outside the allowlist', async () => {
  const s = setup();
  await s.msg('stranger@s.whatsapp.net', 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
  assert.deepEqual(s.store.getTranscript('stranger@s.whatsapp.net'), []);
  assert.equal(s.log.length, 0);
});

test('burst of 3 messages triggers a single runReply with all of them', async () => {
  const s = setup();
  await s.msg(BEA, 'uno');
  await s.advance(500);
  await s.msg(BEA, 'dos');
  await s.msg(BEA, 'tres');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
  assert.deepEqual(s.calls.reply[0].transcript.map((e) => e.text), ['uno', 'dos', 'tres']);
  assert.equal(s.calls.reply[0].contact.name, 'Bea');
});

// Shadow is for watching the agent: short debounce instead of the human-like delay, and no business-hours wait.
const FAST = { replyDelayMs: () => 300_000, shadowDelayMs: () => 15_000 };

test('shadow: replies after the short shadow debounce, not the human delay', async () => {
  const s = setup({ core: FAST });
  await s.msg(BEA, 'hola');
  await s.advance(15_000);
  assert.equal(s.calls.reply.length, 1);
});

test('live (shadow off): still waits the human delay', async () => {
  const s = setup({ core: FAST, state: { shadow: false } });
  await s.msg(BEA, 'hola');
  await s.advance(15_000);
  assert.equal(s.calls.reply.length, 0);
  await s.advance(300_000);
  assert.equal(s.calls.reply.length, 1);
});

test('shadow: out of hours still drafts right away', async () => {
  const s = setup({ core: { ...FAST, isWithinHours: () => false } });
  await s.msg(BEA, 'hola');
  await s.advance(15_000);
  assert.equal(s.calls.reply.length, 1);
  assert.ok(s.toSelf().some((m) => m.startsWith('[sombra]')));
});

test('paused: does nothing when debounce fires', async () => {
  const s = setup({ state: { paused: true } });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
});

test('outside hours (live): reschedules to next opening + reply delay', async () => {
  let open = false;
  const s = setup({ state: { shadow: false }, core: { isWithinHours: () => open } });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
  open = true;
  await s.advance(3_600_000);
  assert.equal(s.calls.reply.length, 0);
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
});

test('Alex active in chat: does not reply', async () => {
  const s = setup();
  s.store.setLastManualFromMeAt(BEA, s.now() - 60_000);
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
});

test('manual fromMe message updates activity and cancels the pending debounce', async () => {
  const s = setup();
  await s.msg(BEA, 'hola');
  await s.msg(BEA, 'yo te contesto', { fromMe: true });
  assert.equal(s.store.getLastManualFromMeAt(BEA), s.now());
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
});

test('fromMe messages sent by the bridge do not count as Alex activity', async () => {
  const s = setup();
  s.store.addSentId('B9');
  await s.msg(BEA, 'hola');
  await s.msg(BEA, 'eco', { fromMe: true, id: 'B9' });
  assert.equal(s.store.getLastManualFromMeAt(BEA), null);
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
});

test('shadow off: markRead, then composing/typing/send/gap per bubble; ids recorded', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: ['hola', 'va'], handoff: null, implement: null } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.log, [
    ['read', 1],
    ['presence', BEA, 'composing'], ['sleep', 4000], ['send', BEA, 'hola'], ['sleep', 2000],
    ['presence', BEA, 'composing'], ['sleep', 2000], ['send', BEA, 'va'], ['sleep', 2000],
  ]);
  assert.ok(s.store.isSentId('B1') && s.store.isSentId('B2'));
  assert.deepEqual(s.store.getTranscript(BEA).map((e) => e.author), ['CONTACTO', 'OWNER', 'OWNER']);
});

test('long typing re-sends composing every ~8s', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: ['x'.repeat(20)], handoff: null, implement: null } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  const composing = s.log.filter((l) => l[0] === 'presence').length;
  const typed = s.log.filter((l) => l[0] === 'sleep' && l[1] !== 2000).reduce((a, l) => a + l[1], 0);
  assert.equal(composing, 3);
  assert.equal(typed, 20_000);
});

test('shadow on: drafts go to self-chat, nothing to contact, no job runs', async () => {
  const s = setup({
    reply: {
      bubbles: ['hola', 'ahorita lo veo'],
      handoff: { type: 'bug', blocking: false, fields: { summary: 'no carga' }, raw: '' },
      implement: { summary: 'arreglar boton', spec: '## Goal\nfix' },
    },
  });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.log.some((l) => l[0] === 'read'), false);
  assert.equal(s.calls.job.length, 0);
  const self = s.toSelf();
  assert.equal(self.length, 1);
  assert.ok(self[0].startsWith('[sombra] → Bea:'));
  for (const part of ['hola', 'ahorita lo veo', 'no carga', 'arreglar boton', '## Goal\nfix']) assert.ok(self[0].includes(part), part);
});

test('handoff goes to self-chat with its fields', async () => {
  const s = setup({
    state: { shadow: false },
    reply: { bubbles: [], handoff: { type: 'outage', blocking: true, fields: { contact: 'Bea', summary: 'se cayo' }, raw: '' }, implement: null },
  });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  const self = s.toSelf().join('\n');
  for (const part of ['outage', 'true', 'se cayo', 'Bea']) assert.ok(self.includes(part), part);
});

test('implement from contact without permission is reported as handoff, no job', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } } });
  await s.msg(DALIA, 'oye');
  await s.advance(DELAY);
  assert.equal(s.calls.job.length, 0);
  assert.equal(s.store.getJobs().length, 0);
  assert.ok(s.toSelf().some((m) => m.includes('cambio')));
});

test('job queue runs one job at a time', async () => {
  const resolvers = [];
  const s = setup({
    state: { shadow: false },
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: () => new Promise((r) => resolvers.push(r)),
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  await s.msg(BEA, 'dos');
  await s.advance(DELAY);
  assert.equal(s.calls.job.length, 1);
  assert.equal(s.store.getJobs().length, 1);
  resolvers[0](JSON.stringify({ result: 'failed', report: 'r', bubbles: [] }));
  await s.advance(0);
  assert.equal(s.calls.job.length, 2);
  assert.equal(s.calls.job[0].contact.name, 'Bea');
});

test('a job runs inside the stage lock shared with the Peticiones pipeline', async () => {
  const stageLock = createStageLock();
  let release;
  const held = stageLock(() => new Promise((r) => { release = r; }));
  const s = setup({
    state: { shadow: false }, stageLock,
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: () => Promise.resolve(JSON.stringify({ result: 'failed', report: 'r', bubbles: [] })),
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  assert.equal(s.calls.job.length, 0, 'waits while a request holds stage');
  release();
  await held;
  await s.advance(0);
  assert.equal(s.calls.job.length, 1);
});

test('job queue does not start while locked or paused, resumes after command', async () => {
  const s = setup({
    state: { shadow: false, locked: true },
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: { result: 'failed', report: 'r', bubbles: [] },
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  assert.equal(s.calls.job.length, 0);
  assert.equal(s.store.getJobs().length, 1);
  await s.msg(SELF, '/desbloquear', { fromMe: true });
  await s.advance(0);
  assert.equal(s.calls.job.length, 1);
});

async function runJobWith(result, opts = {}) {
  const s = setup({
    state: { shadow: false },
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: result,
    ...opts,
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  return s;
}

test('job deployed: user message to contact with typing + report to self', async () => {
  const s = await runJobWith({ result: 'deployed', report: 'deploy ok', bubbles: ['Listo ya quedó'] });
  assert.deepEqual(s.toContact(BEA), ['Listo ya quedó']);
  assert.ok(s.log.some((l) => l[0] === 'presence' && l[1] === BEA));
  assert.ok(s.toSelf().some((m) => m.includes('deploy ok')));
});

test('job deployed outside hours: user message waits for next opening', async () => {
  let open = true;
  const s = setup({
    state: { shadow: false },
    core: { isWithinHours: () => open },
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: () => { open = false; return Promise.resolve(JSON.stringify({ result: 'deployed', report: 'ok', bubbles: ['Listo'] })); },
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  open = true;
  await s.advance(3_600_000 + DELAY);
  assert.deepEqual(s.toContact(BEA), ['Listo']);
});

test('job rolled-back: locks the bridge and reports incident', async () => {
  const s = await runJobWith({ result: 'rolled-back', report: 'prod roto', bubbles: [] });
  assert.equal(s.store.getState().locked, true);
  assert.ok(s.toSelf().some((m) => m.includes('prod roto')));
  assert.deepEqual(s.toContact(BEA), []);
});

for (const result of ['failed', 'blocked-credentials', 'not-small']) {
  test(`job ${result}: report to self, nothing to contact`, async () => {
    const s = await runJobWith({ result, report: `rep ${result}`, bubbles: ['no deberia'] });
    assert.ok(s.toSelf().some((m) => m.includes(`rep ${result}`)));
    assert.deepEqual(s.toContact(BEA), []);
    assert.equal(s.store.getState().locked, false);
  });
}

test('self-chat command applies, persists state and replies in self-chat', async () => {
  const s = setup();
  await s.msg(SELF, '/pausa', { fromMe: true });
  assert.equal(s.store.getState().paused, true);
  assert.deepEqual(s.toSelf(), ['ok /pausa']);
});

test('malformed agent output is reported to self, nothing to contact', async () => {
  const s = setup({ state: { shadow: false }, reply: 'not json' });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.log.some((l) => l[0] === 'read'), false);
  assert.equal(s.toSelf().length, 1);
});

test('reply run receives the bridge health check results', async () => {
  const s = setup();
  await s.msg(BEA, 'esta caida?');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.reply[0].health, HEALTH);
});

// --- outbound secret guard (trust boundary) ---

const noSecret = (s) => assert.ok(!s.log.some((l) => l[0] === 'send' && /ghp_|BEGIN|npmTok3n/.test(l[2])), 'secret left the bridge');

test('secret in reply bubble: nothing to contact, no job, self-chat alert without the text', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: ['hola', 'toma ghp_abc123'], handoff: null, implement: { summary: 'x', spec: 'S' } } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.log.some((l) => l[0] === 'read'), false);
  assert.equal(s.store.getJobs().length + s.calls.job.length, 0);
  assert.ok(s.toSelf().some((m) => /secret/i.test(m)));
  noSecret(s);
});

test('literal ~/.npmrc token in a bubble is blocked too', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: [`es ${NPM_TOKEN}`], handoff: null, implement: null } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  noSecret(s);
});

test('secret in a [sombra] draft: only the alert reaches self-chat', async () => {
  const s = setup({ reply: { bubbles: ['-----BEGIN RSA PRIVATE KEY-----'], handoff: null, implement: null } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.equal(s.toSelf().length, 1);
  assert.match(s.toSelf()[0], /secret/i);
  noSecret(s);
});

test('secret in job USER_MESSAGE: nothing to contact, alert to self', async () => {
  const s = await runJobWith({ result: 'deployed', report: 'ok', bubbles: ['Listo ghp_zzz'] });
  assert.deepEqual(s.toContact(BEA), []);
  assert.ok(s.toSelf().some((m) => /secret/i.test(m)));
  noSecret(s);
});

// --- unknown job outcome locks (Major 3) ---

for (const [name, job] of [
  ['runJob rejects (timeout / non-zero exit)', () => Promise.reject(new Error('claude timed out after 5400000 ms'))],
  ['job output unparseable', () => Promise.resolve('not json')],
]) {
  test(`${name}: incident, bridge locked, nothing to contact, queue stops`, async () => {
    const s = setup({ state: { shadow: false }, reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } }, job });
    await s.msg(BEA, 'uno');
    await s.advance(DELAY);
    assert.equal(s.store.getState().locked, true);
    const alert = s.toSelf().find((m) => m.startsWith('INCIDENT'));
    assert.ok(alert, 'incident alert');
    assert.match(alert, /outcome unknown/);
    assert.match(alert, /\/desbloquear/);
    assert.deepEqual(s.toContact(BEA), []);
    await s.msg(BEA, 'dos');
    await s.advance(DELAY);
    assert.equal(s.calls.job.length, 1);
  });
}

// --- respect Alex after the run (Major 5, minor 6) ---

const withImpl = { bubbles: ['hola'], handoff: null, implement: { summary: 'cambio', spec: 'S' } };

test('Alex writes during the reply run: nothing sent, no job, draft posted as [descartado]', async () => {
  let s;
  s = setup({ state: { shadow: false }, reply: () => { s.store.setLastManualFromMeAt(BEA, s.now()); return withImpl; } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.store.getJobs().length + s.calls.job.length, 0);
  const self = s.toSelf().find((m) => m.startsWith('[descartado]'));
  assert.ok(self && self.includes('hola') && self.includes('cambio'));
});

test('paused during the reply run: nothing sent, no job, [descartado]', async () => {
  let s;
  s = setup({ state: { shadow: false }, reply: () => { s.store.setState({ ...s.store.getState(), paused: true }); return withImpl; } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.store.getJobs().length, 0);
  assert.ok(s.toSelf().some((m) => m.startsWith('[descartado]')));
});

test('hours close during the reply run: nothing sent, rescheduled to next opening + delay', async () => {
  let open = true;
  const s = setup({ state: { shadow: false }, core: { isWithinHours: () => open }, reply: () => { open = false; return { bubbles: ['hola'], handoff: null, implement: null }; } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.calls.reply.length, 1);
  open = true;
  await s.advance(3_600_000);
  assert.equal(s.calls.reply.length, 1, 'waits the reply delay after opening');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 2);
});

test('job success while Alex is active in the chat: held, posted to self-chat for Alex', async () => {
  let s;
  s = setup({
    state: { shadow: false },
    reply: { bubbles: [], handoff: null, implement: { summary: 'cambio', spec: 'S' } },
    job: () => { s.store.setLastManualFromMeAt(BEA, s.now()); return Promise.resolve(JSON.stringify({ result: 'deployed', report: 'ok', bubbles: ['Listo ya quedó'] })); },
  });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.ok(s.toSelf().some((m) => m.startsWith('[no enviado]') && m.includes('Listo ya quedó')));
});

// --- pending replies survive restarts (minor 7) ---

test('pending debounced chat is persisted and restored on startup', async () => {
  const s = setup();
  await s.msg(BEA, 'hola');
  assert.equal(s.store.getPending()[BEA], s.now() + DELAY);
  // "restart": drop the old timers, new bridge on the same store
  s.timers.clear();
  const b2 = s.make();
  await b2.restorePending();
  assert.ok(s.toSelf().some((m) => /restored/i.test(m) && m.includes('Bea')));
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
  assert.deepEqual(s.store.getPending(), {});
});

test('overdue pending chat fires right away after restart', async () => {
  const s = setup();
  await s.msg(BEA, 'hola');
  s.timers.clear();
  await s.advance(10 * DELAY);
  const b2 = s.make();
  await b2.restorePending();
  await s.advance(0);
  assert.equal(s.calls.reply.length, 1);
});

test('restorePending with nothing pending posts nothing', async () => {
  const s = setup();
  await s.bridge.restorePending();
  assert.deepEqual(s.toSelf(), []);
});

// --- integration with the real core/parse.js (minor 11) ---

test('real parser: contract text reply is sent to the contact', async () => {
  const s = setup({
    state: { shadow: false },
    core: { parseAgentOutput, parseJobOutput },
    reply: 'REPLY:\nBuen dia, ya lo cheque\n---\nsi esta funcionando\nHANDOFF: none\nIMPLEMENT: none',
  });
  await s.msg(BEA, 'esta caida?');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), ['Buen dia, ya lo cheque', 'si esta funcionando']);
  assert.deepEqual(s.toSelf(), []);
});

test('real parser: malformed text sends nothing to contact and reports an error to self', async () => {
  const s = setup({ state: { shadow: false }, core: { parseAgentOutput, parseJobOutput }, reply: 'Claro, aqui va mi respuesta: hola' });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), []);
  assert.equal(s.toSelf().length, 1);
  assert.match(s.toSelf()[0], /ERROR/);
});

// --- /simular sandbox in the self-chat ---

const posts = (s) => s.toSelf().filter((m) => !m.startsWith('[sim traza]'));
const self = (s, text) => s.msg(SELF, text, { fromMe: true });
const notSelf = (s) => s.log.filter((l) => l[0] !== 'send' || l[1] !== SELF);

test('/simular: fuzzy, accent-insensitive name match starts a session', async () => {
  const s = setup();
  await self(s, '/simular inigo');
  await self(s, '/simular BEA'); // duplicate entries for one name are not ambiguous
  await self(s, '/simular muéstra');
  assert.deepEqual(posts(s), [
    '[sim] simulando a Íñigo Muestra (usted, demo2, implementa: no). Escribe como si fueras el/ella. /simular fin para salir',
    '[sim] simulando a Bea (tu, demo, implementa: si). Escribe como si fueras el/ella. /simular fin para salir',
    '[sim] simulando a Íñigo Muestra (usted, demo2, implementa: no). Escribe como si fueras el/ella. /simular fin para salir',
  ]);
});

for (const q of ['pedro', 'r', '']) {
  test(`/simular "${q}": no unique match lists contact names, no session`, async () => {
    const s = setup();
    await self(s, `/simular ${q}`);
    assert.equal(posts(s).length, 1);
    for (const n of ['Bea', 'Dalia', 'Íñigo Muestra']) assert.ok(posts(s)[0].includes(n), n);
    assert.equal(posts(s)[0].split('Bea').length, 2, 'names listed once');
    await self(s, 'hola');
    assert.equal(s.calls.reply.length, 0);
  });
}

test('sim message runs the reply run as the contact, posts only to self-chat, touches no state', async () => {
  const s = setup({ state: { paused: true, shadow: false }, core: { isWithinHours: () => false } });
  s.store.setLastManualFromMeAt(BEA, s.now()); // Alex-active rule ignored
  await self(s, '/simular bea');
  await self(s, 'oye no carga');
  assert.equal(s.calls.reply.length, 1);
  const arg = s.calls.reply[0];
  assert.equal(arg.contact.jid, BEA);
  assert.deepEqual(arg.health, HEALTH);
  assert.deepEqual(arg.transcript.map((e) => [e.author, e.text]), [['CONTACTO', 'oye no carga']]);
  assert.deepEqual(posts(s).slice(1), ['hola', '[sim Bea] HANDOFF: none\nIMPLEMENT: none']);
  assert.deepEqual(notSelf(s), []);
  assert.deepEqual(s.store.getTranscript(BEA), []);
  assert.deepEqual(s.store.getPending(), {});
  assert.equal(s.timers.size, 0);
});

test('sim multi-turn: transcript carries previous bubbles as Alex', async () => {
  const s = setup({ reply: { bubbles: ['hola', 'dime'], handoff: null, implement: null } });
  await self(s, '/simular dalia');
  await self(s, 'buenas');
  await self(s, 'no carga');
  assert.deepEqual(s.calls.reply[1].transcript.map((e) => [e.author, e.text]), [
    ['CONTACTO', 'buenas'], ['OWNER', 'hola'], ['OWNER', 'dime'], ['CONTACTO', 'no carga'],
  ]);
});

test('sim restart resets the transcript', async () => {
  const s = setup();
  await self(s, '/simular dalia');
  await self(s, 'uno');
  await self(s, '/simular dalia');
  await self(s, 'dos');
  assert.deepEqual(s.calls.reply[1].transcript.map((e) => e.text), ['dos']);
});

const IMPL = { bubbles: ['va'], handoff: { type: 'bug', blocking: true, fields: { type: 'bug', blocking: 'true', summary: 'no carga' }, raw: '' }, implement: { summary: 'arreglar boton', spec: '## Goal\nfix' } };

for (const [who, state, expected] of [
  ['bea', {}, 'se encolaría: si'],
  ['dalia', {}, 'se encolaría: no (canTriggerImplementation false)'],
  ['bea', { locked: true }, 'se encolaría: no (locked)'],
]) {
  test(`sim IMPLEMENT for ${who} ${JSON.stringify(state)}: "${expected}", no job enqueued`, async () => {
    const s = setup({ state: { shadow: false, ...state }, reply: IMPL });
    await self(s, `/simular ${who}`);
    await self(s, 'oye');
    await s.advance(0);
    const [bubble, post] = posts(s).slice(1);
    assert.equal(bubble, 'va');
    assert.ok(post.endsWith(`] HANDOFF: bug (blocking: true) no carga\nIMPLEMENT: arreglar boton → ${expected}\nspec:\n## Goal\nfix`), post);
    assert.equal(s.store.getJobs().length + s.calls.job.length, 0);
    assert.deepEqual(notSelf(s), []);
  });
}

test('sim with the real parser: each bubble is its own self-chat message (no --- shown), REPLY (none) shows (sin respuesta)', async () => {
  let text = 'REPLY:\nuno\n---\ndos\nHANDOFF: none\nIMPLEMENT: none';
  const s = setup({ core: { parseAgentOutput }, reply: () => text });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  text = 'REPLY: (none)\nHANDOFF: none\nIMPLEMENT: none';
  await self(s, 'ok');
  assert.deepEqual(posts(s).slice(1), ['uno', 'dos', '[sim Dalia] HANDOFF: none\nIMPLEMENT: none', '[sim Dalia] (sin respuesta)\nHANDOFF: none\nIMPLEMENT: none']);
});

test('sim parse error is reported as [sim] error', async () => {
  const s = setup({ core: { parseAgentOutput }, reply: 'Claro, aqui va: hola' });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  assert.match(posts(s)[1], /^\[sim\] error: Malformed output/);
});

test('/simular fin ends the session', async () => {
  const s = setup();
  await self(s, '/simular dalia');
  await self(s, '/simular fin');
  await self(s, 'hola');
  assert.equal(posts(s)[1], '[sim] fin');
  assert.equal(s.calls.reply.length, 0);
});

test('self-chat text without a session does nothing', async () => {
  const s = setup();
  await self(s, 'nota para mi');
  assert.equal(s.calls.reply.length, 0);
  assert.deepEqual(s.log, []);
});

test('/estado shows the active simulation', async () => {
  const s = setup({ core: { applyCommand } });
  await self(s, '/estado');
  await self(s, '/simular inigo');
  await self(s, '/estado');
  assert.doesNotMatch(posts(s)[0], /simulando/);
  assert.match(posts(s)[2], /simulando: Íñigo Muestra$/);
});

test('secret in a sim post: only the alert reaches self-chat', async () => {
  const s = setup({ reply: { bubbles: ['toma ghp_abc123'], handoff: null, implement: null } });
  await self(s, '/simular dalia');
  await self(s, 'pasame el token');
  assert.match(posts(s)[1], /secret/i);
  noSecret(s);
});

test('sim messages during a run are queued and processed one at a time', async () => {
  const resolvers = [];
  const s = setup({ reply: () => new Promise((r) => resolvers.push(r)) });
  await self(s, '/simular dalia');
  const p1 = self(s, 'uno');
  const p2 = self(s, 'dos');
  await s.advance(0);
  assert.equal(s.calls.reply.length, 1);
  resolvers[0](JSON.stringify({ bubbles: ['r1'], handoff: null, implement: null }));
  await p1;
  await s.advance(0);
  assert.equal(s.calls.reply.length, 2);
  assert.deepEqual(s.calls.reply[1].transcript.map((e) => e.text), ['uno', 'r1', 'dos']);
  resolvers[1](JSON.stringify({ bubbles: ['r2'], handoff: null, implement: null }));
  await p2;
  assert.equal(posts(s).length, 5, 'start + (bubble + decision) per run');
  assert.equal(s.toSelf().length, 7, 'one trace per run');
});

test('sim posts the tool-call trace before the result, with short paths and denials', async () => {
  const trace = [
    { name: 'Read', input: { file_path: `${SKILL_DIR}references/flows/system-status.md` }, status: 'ok', size: 2100 },
    { name: 'Grep', input: { pattern: 'approve', path: `${ROOT}/acme-web/src` }, status: 'ok', size: 340 },
    { name: 'Read', input: { file_path: `${ROOT}/acme-api/.env` }, status: 'denied', size: 0 },
    { name: 'Glob', input: { pattern: 'x'.repeat(300) }, status: 'error', size: 10 },
  ];
  const s = setup({ trace });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  const [, t] = s.toSelf();
  const result = s.toSelf().at(-1);
  const lines = t.split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    '[sim traza]',
    '1. Read references/flows/system-status.md (ok, 2.1k)',
    '2. Grep "approve" in acme-web/src (ok, 340)',
    '3. Read acme-api/.env (DENEGADO)',
  ]);
  assert.match(lines[4], /^4\. Glob "x+… \(error\)$/);
  assert.ok(lines[4].length < 150);
  assert.equal(lines[5], '4 llamadas, 7.8s, $0.06');
  assert.ok(result.startsWith('[sim Dalia]'));
});

test('long sim trace is split into several self-chat messages', async () => {
  const trace = Array.from({ length: 80 }, (_, i) => ({ name: 'Read', input: { file_path: `/x/${i}/${'y'.repeat(100)}` }, status: 'ok', size: 5 }));
  const s = setup({ trace });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  const parts = s.toSelf().filter((m) => m.startsWith('[sim traza]'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 3500), 'chunk size');
  assert.equal(parts.join('\n').split('\n').filter((l) => /^\d+\. Read/.test(l)).length, 80);
});

test('secret in the sim trace: only the alert reaches self-chat', async () => {
  const s = setup({ trace: [{ name: 'Grep', input: { pattern: 'ghp_abc123' }, status: 'ok', size: 1 }] });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  assert.match(s.toSelf()[1], /secret/i);
  noSecret(s);
});

// --- /simular job: the real job run in the sandbox ---

const JOB_TEXT = [
  'WOULD RUN: bash deploy.sh prod',
  'RESULT: failed',
  'REPORT:',
  'Tests verdes en acme-web-worktrees/fix-boton; me detuve en deploy.',
  'WOULD RUN: git -C acme-web push origin fix-boton:stage',
  'USER_MESSAGE: (none)',
].join('\n');
const simTrace = (n = 2) => ({
  result: JOB_TEXT, durationMs: 754_000, costUsd: 1.234,
  calls: [
    { name: 'Bash', input: { command: `git -C ${ROOT}/acme-web worktree add ../acme-web-worktrees/fix-boton\n-b fix-boton` }, status: 'ok', size: 40 },
    { name: 'Bash', input: { command: `npm test ${'x'.repeat(300)}` }, status: 'error', size: 900 },
    ...Array.from({ length: n - 2 }, (_, i) => ({ name: 'Read', input: { file_path: `${ROOT}/acme-web/f${i}.js` }, status: 'ok', size: 10 })),
  ],
});
const jobPosts = (s) => s.toSelf().filter((m) => m.startsWith('[sim job]'));

async function simWithSpec(opts = {}, who = 'bea') {
  const s = setup({ state: { shadow: false }, reply: IMPL, core: { parseJobOutput }, ...opts });
  await self(s, `/simular ${who}`);
  await self(s, 'oye no carga el boton');
  return s;
}

for (const [name, prep] of [
  ['no session', async (s) => {}],
  ['session without IMPLEMENT', async (s) => { await self(s, '/simular dalia'); await self(s, 'hola'); }],
]) {
  test(`/simular job with ${name}: "[sim] no hay spec para correr", nothing runs`, async () => {
    const s = setup({ jobSim: simTrace() });
    await prep(s);
    await self(s, '/simular job');
    assert.equal(s.toSelf().at(-1), '[sim] no hay spec para correr');
    assert.equal(s.calls.jobSim.length, 0);
  });
}

test('/simular job runs the last IMPLEMENT spec in the sandbox and reports trace, result, WOULD RUN and leftovers', async () => {
  const s = await simWithSpec({ jobSim: simTrace(), snaps: [['acme-web branch stage'], ['acme-web branch stage', `acme-web worktree ${ROOT}/acme-web-worktrees/fix-boton`, 'acme-web branch fix-boton']] });
  await self(s, '/simular job');
  assert.equal(s.calls.jobSim.length, 1);
  assert.deepEqual(s.calls.jobSim[0].contact.name, 'Bea');
  assert.deepEqual(s.calls.jobSim[0].implement, IMPL.implement);
  const [head, trace, final, left] = jobPosts(s);
  assert.equal(head, '[sim job] arrancando en sandbox (red cerrada, sin credenciales)\nBea: arreglar boton\nel real se encolaría: si');
  const lines = trace.split('\n');
  assert.equal(lines[0], '[sim job]');
  assert.equal(lines[1], '1. Bash: git -C acme-web worktree add ../acme-web-worktrees/fix-boton -b fix-boton (ok, 40)');
  assert.match(lines[2], /^2\. Bash: npm test x+… \(error\)$/);
  assert.ok(lines[2].length < 190, 'bash command truncated');
  assert.equal(final, [
    '[sim job] RESULT: failed',
    'Tests verdes en acme-web-worktrees/fix-boton; me detuve en deploy.',
    'WOULD RUN: git -C acme-web push origin fix-boton:stage',
    'WOULD RUN: bash deploy.sh prod',
    '2 llamadas, 12.6 min, $1.23',
  ].join('\n'));
  assert.equal(left, '[sim job] quedaron:\nacme-web worktree acme-web-worktrees/fix-boton\nacme-web branch fix-boton');
});

test('/simular job touches no real job queue, store state or contact chat', async () => {
  const s = await simWithSpec({ jobSim: simTrace() });
  const before = JSON.stringify(s.store.getState());
  await self(s, '/simular job');
  assert.equal(s.calls.job.length, 0);
  assert.deepEqual(s.store.getJobs(), []);
  assert.equal(JSON.stringify(s.store.getState()), before);
  assert.deepEqual(s.store.getTranscript(BEA), []);
  assert.deepEqual(notSelf(s), []);
  assert.equal(jobPosts(s).at(-1), '[sim job] quedaron: nada');
});

test('/simular job runs for a contact who cannot trigger implementation, header says the real one would not', async () => {
  const s = await simWithSpec({ jobSim: simTrace(), state: { locked: true } }, 'dalia');
  await self(s, '/simular job');
  assert.equal(s.calls.jobSim.length, 1);
  assert.match(jobPosts(s)[0], /el real se encolaría: no \(canTriggerImplementation false\)$/);
});

test('/simular job posts the trace progressively: every 25 finished calls or after 60 s', async () => {
  let finish;
  const s = await simWithSpec({ jobSim: (arg) => new Promise((r) => { finish = r; }) });
  const done = self(s, '/simular job');
  await s.advance(0);
  const { onCalls } = s.calls.jobSim[0];
  const calls = simTrace(40).calls;
  onCalls([...calls.slice(0, 24), { ...calls[24], status: 'missing' }]);
  await s.advance(0);
  assert.equal(jobPosts(s).length, 1, 'only the header: 24 finished calls');
  onCalls(calls.slice(0, 27));
  await s.advance(0);
  assert.equal(jobPosts(s).length, 2);
  assert.match(jobPosts(s)[1], /\n27\. Read .*$/);
  onCalls(calls.slice(0, 30));
  await s.advance(0);
  assert.equal(jobPosts(s).length, 2, '3 new calls, under a minute');
  await s.advance(61_000);
  onCalls(calls.slice(0, 31));
  await s.advance(0);
  assert.equal(jobPosts(s).length, 3);
  assert.match(jobPosts(s)[2], /^\[sim job\]\n28\. Read [\s\S]*\n31\. Read [^\n]*$/);
  finish(simTrace(40));
  await done;
  assert.match(jobPosts(s)[3], /^\[sim job\]\n32\. Read [\s\S]*\n40\. Read [^\n]*$/);
  assert.match(jobPosts(s)[4], /^\[sim job\] RESULT: failed\n[\s\S]*\n40 llamadas, 12.6 min, \$1.23$/);
});

test('only one sim job at a time', async () => {
  let finish;
  const s = await simWithSpec({ jobSim: () => new Promise((r) => { finish = r; }) });
  const done = self(s, '/simular job');
  await s.advance(0);
  await self(s, '/simular job');
  assert.equal(s.toSelf().at(-1), '[sim] ya hay un job simulado corriendo');
  assert.equal(s.calls.jobSim.length, 1);
  finish(simTrace());
  await done;
});

test('/simular fin while a sim job runs kills it and posts [sim job] cancelado', async () => {
  const s = await simWithSpec({
    jobSim: ({ signal, onCalls }) => new Promise((_, reject) => {
      onCalls(simTrace().calls.slice(0, 1));
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    }),
  });
  const done = self(s, '/simular job');
  await s.advance(0);
  await self(s, '/simular fin');
  await done;
  assert.ok(s.calls.jobSim[0].signal.aborted);
  assert.ok(s.toSelf().includes('[sim] fin'));
  const posts = jobPosts(s);
  assert.match(posts.at(-3), /^\[sim job\]\n1\. Bash: /, 'calls seen so far are flushed');
  assert.equal(posts.at(-2), '[sim job] cancelado');
  assert.equal(posts.at(-1), '[sim job] quedaron: nada');
});

test('sim job output off the contract is shown raw', async () => {
  const s = await simWithSpec({ jobSim: { ...simTrace(), result: 'me quede a medias\nWOULD RUN: git push' } });
  await self(s, '/simular job');
  assert.ok(jobPosts(s).includes('[sim job] RESULT: (salida sin formato)\nme quede a medias\nWOULD RUN: git push\n2 llamadas, 12.6 min, $1.23'));
});

test('sim job failure is reported as [sim job] error', async () => {
  const s = await simWithSpec({ jobSim: () => Promise.reject(new Error('claude exited 1: sandbox unavailable')) });
  await self(s, '/simular job');
  assert.ok(jobPosts(s).includes('[sim job] error: claude exited 1: sandbox unavailable'));
});

test('secret in the sim job output: only the alert reaches self-chat', async () => {
  const s = await simWithSpec({ jobSim: { ...simTrace(), result: `${JOB_TEXT}\nWOULD RUN: echo ghp_abc123` } });
  await self(s, '/simular job');
  noSecret(s);
});

test('echo guard: the bridge\'s own self-chat posts coming back are ignored (no paid sim loop)', async () => {
  const s = setup();
  await self(s, '/simular dalia'); // say -> wa id B1
  await s.msg(SELF, '[sim] simulando a Dalia ...', { fromMe: true, id: 'B1' });
  assert.equal(s.calls.reply.length, 0);
  assert.ok(s.store.isSentId('B1'));
  await self(s, 'hola');
  assert.equal(s.calls.reply.length, 1);
});

// --- topic memory (topics.js + archivist.js): recall for the reply, archiving of every feeding chat, bridge events ---

const TOPICS = [{
  id: 1, title: 'Folio REQ-0027', status: 'open', participants: ['bea'],
  facts: [{ at: '2026-10-01T10:00:00.000Z', by: 'bea', where: 'este chat', text: 'sigue sin pago', mention: true }],
}];
const bugHandoff = { type: 'bug', blocking: false, fields: { summary: 'no carga el boton' }, raw: '' };
const DAY = 24 * 60 * 60 * 1000;
const opsRun = (ops) => async () => ({ text: JSON.stringify({ ops }), costUsd: 0.002 });
// Texts of the bridge events handed to the archivist once the chat goes quiet.
async function bridgeEvents(s) {
  await s.advance(ARCHIVE_QUIET_MS);
  return s.calls.archive.flatMap((a) => a.entries).filter((e) => e.author === 'BRIDGE').map((e) => e.text);
}

test('reply run gets the topics recalled for this chat, the contact and this turn\'s inbound text', async () => {
  const s = setup({ topicLines: TOPICS });
  await s.msg(BEA, 'ya quedo');
  await s.msg(BEA, 'lo del REQ-0027?');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.recall.map(({ person, chat, text }) => ({ person, chat, text })),
    [{ person: 'bea', chat: { jid: BEA, name: 'Bea', kind: 'private' }, text: 'ya quedo\nlo del REQ-0027?' }]);
  assert.deepEqual(s.calls.reply[0].topics, TOPICS);
  assert.equal('memory' in s.calls.reply[0], false);
});

test('topics recall failing: no topics and the reply still goes out', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const s = setup({ state: { shadow: false }, topics: { ...createTopics({ profile: PROFILE, file: ':memory:' }), recall: () => { throw new Error('db locked'); } } });
    await s.msg(BEA, 'oye');
    await s.advance(DELAY);
    assert.deepEqual(s.calls.reply[0].topics, []);
    assert.deepEqual(s.toContact(BEA), ['hola']);
  } finally {
    console.error = orig;
  }
});

test('Ciro: a file sent in private is understood with the topic Alex opened in the group', async () => {
  const CIRO = 'ciro@s.whatsapp.net';
  const TITLE = 'Formulario #312 registro de voluntarios: lista de sedes';
  let n = 0;
  const archiveRun = async () => ({
    costUsd: 0.002,
    text: JSON.stringify({ ops: n++ ? [] : [
      { op: 'new_topic', ref: 'n1', title: TITLE, msg: 1 },
      { op: 'add_fact', topic: 'n1', text: 'Ciro dice que el formulario 312 ya quedó publicado', msg: 0 },
      { op: 'add_fact', topic: 'n1', text: 'Alex pidió a Ciro el Excel de la lista de sedes con código de sede', msg: 1 },
    ] }),
  });
  const ciro = { jid: CIRO, name: 'Ciro', register: 'tu', tenant: 'demo2', canTriggerImplementation: false };
  const s = groupSetup({ contacts: [...contacts, GROUP, ciro], archiveRun });
  await s.gmsg(['ciro@lid'], 'ya quedó publicado el formulario 312 de registro de voluntarios', { pushName: 'Ciri' });
  await s.msg(GRP, 'Ciro, pásame el Excel de la lista de sedes con el código de sede', { fromMe: true });
  await s.advance(ARCHIVE_QUIET_MS);
  assert.equal(s.calls.reply.length, 0, 'Alex answered in the group');
  const [batch] = s.calls.archive;
  assert.deepEqual(batch.chat, { jid: GRP, name: GROUP.name, kind: 'group' });
  assert.deepEqual(batch.entries.map((e) => [e.author, e.name, e.person]), [['Ciro', 'Ciro', 'ciro'], ['OWNER', 'owner', 'owner']]);
  for (const p of ['Ciro', 'Contacto C', 'Bea']) assert.ok(batch.knownPeople.some((k) => k.name === p && k.key === contactKey(p)), p);

  await s.msg(CIRO, '[documento: lista sedes.xlsx]');
  await s.msg(CIRO, 'Listo, la estuve limpiando');
  await s.advance(DELAY);
  const topic = s.calls.reply[0].topics.find((x) => x.title === TITLE);
  assert.ok(topic, 'the group topic reaches the private reply');
  assert.ok(topic.facts.some((f) => f.by === 'owner' && /Excel/.test(f.text) && f.mention === true && f.where === `grupo ${GROUP.name}`));
});

test('memory-only chats: stored and archived, never answered, no handoff, no self-chat, no pending, no feedback', async () => {
  const MO = 'fabi@s.whatsapp.net';
  const MOG = 'mog@g.us';
  const fb = [];
  const feedback = { draft: () => fb.push('draft'), manual: () => fb.push('manual'), contact: () => fb.push('contact') };
  const memoryChats = [{ jid: MO, name: 'Fabi', kind: 'private' }, { jid: MOG, name: 'Grupo Obras', kind: 'group' }, { jid: BEA, name: 'Otro', kind: 'private' }];
  const s = setup({ state: { shadow: false }, memoryChats, feedback });
  await s.msg(MO, 'te mando la base mañana');
  await s.msg(MO, 'va', { fromMe: true });
  await s.msg(MOG, 'junta el lunes', { participant: 'z@lid', participantIds: ['z@lid'], pushName: 'Mara' });
  await s.advance(DELAY * 10);
  assert.equal(s.calls.reply.length, 0);
  assert.deepEqual(s.log, [], 'nothing sent, read or typed');
  assert.deepEqual([s.store.getPending(), s.store.getHandoffs(MO), fb], [{}, [], []]);
  assert.deepEqual(s.store.getTranscript(MO).map((e) => [e.author, e.text]), [['CONTACTO', 'te mando la base mañana'], ['OWNER', 'va']]);
  await s.advance(ARCHIVE_QUIET_MS);
  const byChat = Object.fromEntries(s.calls.archive.map((a) => [a.chat.jid, a]));
  assert.deepEqual(byChat[MO].chat, { jid: MO, name: 'Fabi', kind: 'private' });
  assert.deepEqual(byChat[MO].entries.map((e) => [e.name, e.text]), [['Fabi', 'te mando la base mañana'], ['owner', 'va']]);
  assert.deepEqual(byChat[MOG].entries.map((e) => [e.name, e.text]), [['Mara', 'junta el lunes']]);
  assert.ok(byChat[MO].knownPeople.some((p) => p.name === 'Fabi' && /^wa:/.test(p.key)));
  // A jid also in contacts.json keeps its contact behaviour.
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.reply.map((r) => r.contact.name), ['Bea']);
});

test('archive: cursor kept on failure, advanced on success, logged as kind archive; restart catch-up reads only what came after it', async () => {
  let fail = true;
  const runs = [];
  const runLog = {
    start: (a) => {
      const r = { a, events: [], end: null };
      runs.push(r);
      return { id: runs.length, event: (e) => r.events.push(e), finish: () => { r.end = 'ok'; }, fail: () => { r.end = 'error'; } };
    },
  };
  const archiveRun = async () => { if (fail) throw new Error('haiku down'); return { text: '{"ops":[]}', costUsd: 0.003 }; };
  const s = setup({ archiveRun, runLog });
  const texts = (a) => a.entries.map((e) => e.text);
  await s.msg(BEA, 'uno');
  await s.advance(ARCHIVE_QUIET_MS);
  assert.equal(s.topics.cursor(BEA), null);
  fail = false;
  await s.msg(BEA, 'dos');
  const at2 = s.now();
  await s.advance(ARCHIVE_QUIET_MS);
  assert.deepEqual(s.calls.archive.map(texts), [['uno'], ['uno', 'dos']]);
  assert.equal(s.topics.cursor(BEA), at2);
  const archives = runs.filter((r) => r.a.kind === 'archive');
  assert.deepEqual(archives.map((r) => [r.a.mode, r.a.contact.name, r.end, r.events.find((e) => e.kind === 'result')?.costUsd]),
    [['real', 'Bea', 'error', 0], ['real', 'Bea', 'ok', 0.003]]);

  s.store.appendTranscript(BEA, { author: 'CONTACTO', text: 'tres', at: s.now() });
  s.store.appendTranscript('bea@lid', { author: 'CONTACTO', text: 'cuatro', at: s.now() + 1 });
  await s.make().catchUpArchive();
  assert.deepEqual(s.calls.archive.slice(2).map(texts), [['tres', 'cuatro']]);
  assert.equal(s.topics.cursor(BEA), s.now() + 1);
});

test('archive catch-up with no cursor starts 30 days back', async () => {
  const s = setup();
  s.store.appendTranscript(DALIA, { author: 'CONTACTO', text: 'viejo', at: s.now() - 31 * DAY });
  s.store.appendTranscript(DALIA, { author: 'CONTACTO', text: 'reciente', at: s.now() - DAY });
  await s.bridge.catchUpArchive();
  assert.deepEqual(s.calls.archive.map((a) => [a.chat.name, a.entries.map((e) => e.text)]), [['Dalia', ['reciente']]]);
});

test('archive goes in batches of ARCHIVE_BATCH messages, the next one queued right after', async () => {
  const s = setup();
  for (let i = 0; i < ARCHIVE_BATCH + 5; i++) s.store.appendTranscript(DALIA, { author: 'CONTACTO', text: `m${i}`, at: s.now() - DAY + i });
  await s.bridge.catchUpArchive();
  assert.deepEqual(s.calls.archive.map((a) => a.entries.length), [ARCHIVE_BATCH, 5]);
  assert.equal(s.topics.cursor(DALIA), s.now() - DAY + ARCHIVE_BATCH + 4);
});

test('archive batch never splits messages sharing a timestamp (the next run skips at === cursor)', async () => {
  const s = setup();
  const base = s.now() - DAY;
  for (let i = 0; i < ARCHIVE_BATCH - 2; i++) s.store.appendTranscript(DALIA, { author: 'CONTACTO', text: `m${i}`, at: base + i });
  for (let i = 0; i < 5; i++) s.store.appendTranscript(DALIA, { author: 'CONTACTO', text: `tie${i}`, at: base + ARCHIVE_BATCH });
  await s.bridge.catchUpArchive();
  assert.deepEqual(s.calls.archive.map((a) => a.entries.length), [ARCHIVE_BATCH - 2, 5]);
  assert.equal(s.topics.cursor(DALIA), base + ARCHIVE_BATCH);
});

test('unknown chats land in the seen-chats registry (name, kind, lastAt, count), never their text', async () => {
  const s = setup();
  const UNK = 'nuevo@s.whatsapp.net';
  await s.msg(UNK, 'texto privadisimo', { pushName: 'Lino' });
  await s.msg(UNK, 'otro texto privadisimo', { fromMe: true, pushName: 'Alex' });
  assert.deepEqual(s.seenChats.list(), [{ jid: UNK, name: 'Lino', kind: 'private', lastAt: s.now(), count: 2 }]);
  await s.advance(ARCHIVE_QUIET_MS);
  assert.equal(s.calls.archive.length, 0);
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(join(d, f.name)) : [join(d, f.name)]));
  for (const f of files(s.dir)) assert.doesNotMatch(readFileSync(f, 'utf8'), /privadisimo/, f);
  // Chats already known never land there.
  await s.msg(BEA, 'hola');
  assert.deepEqual(s.seenChats.list().map((c) => c.jid), [UNK]);
});

test('one memory key per person: a fact archived from one jid is "este chat" from the other (phone + LID)', async () => {
  const s = setup({ archiveRun: opsRun([
    { op: 'new_topic', ref: 'a', title: 'Folio REQ-0027 pago', msg: 0 },
    { op: 'add_fact', topic: 'a', text: 'Bea dice que REQ-0027 sigue sin pago', msg: 0 },
  ]) });
  await s.msg('bea@lid', 'el REQ-0027 sigue sin pago');
  await s.advance(ARCHIVE_QUIET_MS);
  assert.equal(s.calls.archive[0].chat.jid, BEA);
  await s.msg(BEA, 'ya quedó el REQ-0027?');
  await s.advance(DELAY);
  const [fact] = s.calls.reply.at(-1).topics[0].facts;
  assert.deepEqual([fact.where, fact.mention], ['este chat', true]);
});

test('archive identity from jids: a stranger with pushName Ciro is opaque, a contacts.json jid is the contact, legacy names anon', async () => {
  const CIRO = 'ciro@s.whatsapp.net';
  const ciro = { jid: CIRO, name: 'Ciro', register: 'tu', tenant: 'demo2', canTriggerImplementation: false };
  let n = 0;
  const archiveRun = async () => ({ costUsd: 0.002, text: JSON.stringify({ ops: n++ ? [] : [
    { op: 'new_topic', ref: 'n1', title: 'Lista de sedes 312', msg: 0 },
    { op: 'add_fact', topic: 'n1', text: 'Ciro dice que la lista de sedes 312 está lista', said_by: 'ciro', msg: 0 },
  ] }) });
  const s = groupSetup({ contacts: [...contacts, GROUP, ciro], archiveRun });
  await s.gmsg(['fake@lid'], 'la lista de sedes 312 está lista', { pushName: 'Ciro' });
  await s.gmsg([BEA], 'yo la reviso', { pushName: 'Pau' });
  s.store.appendTranscript(GRP, { author: 'Fulano', text: 'entrada vieja sin jid', at: s.now() });
  await s.advance(ARCHIVE_QUIET_MS);
  const [batch] = s.calls.archive;
  const [stranger, bea, legacy] = batch.entries.map((e) => e.person);
  assert.match(stranger, /^wa:[0-9a-f]{10}$/);
  assert.equal(bea, 'bea');
  assert.match(legacy, /^anon:/);
  assert.equal(batch.entries[0].name, 'Ciro'); // the pushName is only a label
  const [t] = s.topics.list();
  assert.deepEqual(s.topics.get(t.id).facts.map((f) => f.saidBy), [stranger]);
  await s.msg(CIRO, 'la lista de sedes 312?');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.reply[0].topics, [], 'what the stranger said is never the real Ciro\'s');
});

// Two people called Carlos: one on WhatsApp (phone + LID, same name), one on Telegram.
const CARLOS_WA = '5218111111111@s.whatsapp.net';
const CARLOS_LID = '424242@lid';
const CARLOS_TG = 'tg:123';
const CARLOSES = [{ jid: CARLOS_WA, name: 'Carlos' }, { jid: CARLOS_LID, name: 'Carlos' }, { jid: CARLOS_TG, name: 'Carlos' }];

test('identity: an equal name merges only on the same channel; an explicit link makes one person under the WhatsApp key', () => {
  assert.deepEqual(canonicalChat(CARLOS_LID, CARLOSES), { jid: CARLOS_WA, name: 'Carlos', kind: 'private' }, 'phone + LID still merge');
  assert.deepEqual(canonicalChat(CARLOS_TG, CARLOSES), { jid: CARLOS_TG, name: 'Carlos', kind: 'private' });
  assert.deepEqual([personKey(CARLOS_WA, CARLOSES), personKey(CARLOS_LID, CARLOSES), personKey(CARLOS_TG, CARLOSES)], ['carlos', 'carlos', 'tg:carlos']);
  assert.match(personKey('tg:777', CARLOSES), /^tg:[0-9a-f]{10}$/, 'an unlisted Telegram id is opaque');
  assert.deepEqual(knownPeopleOf(CARLOSES), [{ name: 'Carlos', key: 'carlos' }, { name: 'Carlos', key: 'tg:carlos' }]);
  // Linked (Telegram listed first): the WhatsApp contacts.json member gives the key and the canonical chat.
  const links = [{ jids: [CARLOS_TG, CARLOS_LID] }];
  assert.deepEqual(canonicalChat(CARLOS_TG, CARLOSES, [], links), { jid: CARLOS_WA, name: 'Carlos', kind: 'private' });
  assert.equal(personKey(CARLOS_TG, CARLOSES, links), 'carlos');
  assert.deepEqual(knownPeopleOf(CARLOSES, [], links), [{ name: 'Carlos', key: 'carlos' }, { name: 'Carlos', key: 'carlos' }]);
  // A link without a WhatsApp contacts.json member: its first member's key.
  const memory = [{ jid: 'tg:9', name: 'Charly', kind: 'private' }];
  assert.equal(personKey('seen@s.whatsapp.net', CARLOSES, [{ jids: ['tg:9', 'seen@s.whatsapp.net'] }]), personKey('tg:9', CARLOSES));
  assert.equal(canonicalChat('tg:9', CARLOSES, memory, [{ jids: ['tg:9', CARLOS_TG] }]).jid, CARLOS_TG, 'contacts.json before memory-only');
});

test('two unlinked Carloses (WhatsApp, Telegram) stay two people in archive and recall; linked they share one; unlinked again they split', async () => {
  const links = [];
  const s = setup({ contacts: [...contacts, ...CARLOSES], links });
  await s.msg(CARLOS_LID, 'mando las sedes de Monterrey');
  await s.msg(CARLOS_TG, 'mando el oficio de Saltillo');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.recall.map((q) => [q.person, q.chat.jid]), [['carlos', CARLOS_WA], ['tg:carlos', CARLOS_TG]]);
  await s.advance(ARCHIVE_QUIET_MS);
  const byChat = (calls) => Object.fromEntries(calls.map((a) => [a.chat.jid, a.entries.filter((e) => e.author === 'CONTACTO').map((e) => [e.person, e.text])]));
  assert.deepEqual(byChat(s.calls.archive), {
    [CARLOS_WA]: [['carlos', 'mando las sedes de Monterrey']], [CARLOS_TG]: [['tg:carlos', 'mando el oficio de Saltillo']],
  });
  const known = s.calls.archive[0].knownPeople.filter((p) => p.name === 'Carlos');
  assert.deepEqual(known, [{ name: 'Carlos', key: 'carlos' }, { name: 'Carlos', key: 'tg:carlos' }]);

  links.push({ jids: [CARLOS_WA, CARLOS_TG] }); // linked in the portal: read live, no restart
  s.calls.archive.length = 0;
  s.calls.recall.length = 0;
  await s.msg(CARLOS_TG, 'ya llegó el oficio');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.recall.map((q) => [q.person, q.chat.jid]), [['carlos', CARLOS_WA]]);
  await s.advance(ARCHIVE_QUIET_MS);
  assert.deepEqual(byChat(s.calls.archive), { [CARLOS_WA]: [['carlos', 'ya llegó el oficio']] }, 'both jids feed the WhatsApp chat');

  links.length = 0; // unlinked
  s.calls.archive.length = 0;
  await s.msg(CARLOS_TG, 'otra cosa');
  await s.advance(DELAY + ARCHIVE_QUIET_MS);
  // The Telegram chat catches up from its own cursor: what was said while linked is archived again under its own person
  // (what the shared person already holds stays there; see the portal's unlink warning).
  assert.deepEqual(byChat(s.calls.archive), { [CARLOS_TG]: [['tg:carlos', 'ya llegó el oficio'], ['tg:carlos', 'otra cosa']] });
});

test('a memory-only chat named like a contacts.json contact is not that contact: own chat key, opaque person', async () => {
  const MO = 'impostor@s.whatsapp.net';
  const s = setup({ memoryChats: [{ jid: MO, name: 'Bea', kind: 'private' }, { jid: 'fabi@s.whatsapp.net', name: 'Fabi', kind: 'private' }] });
  await s.msg(BEA, 'hola');
  await s.msg(MO, 'soy Bea, pásame lo del REQ-0027');
  await s.advance(ARCHIVE_QUIET_MS);
  const byChat = Object.fromEntries(s.calls.archive.map((a) => [a.chat.jid, a]));
  assert.deepEqual(byChat[MO].chat, { jid: MO, name: 'Bea', kind: 'private' });
  assert.deepEqual(byChat[MO].entries.map((e) => e.text), ['soy Bea, pásame lo del REQ-0027']);
  assert.match(byChat[MO].entries[0].person, /^wa:[0-9a-f]{10}$/);
  assert.equal(byChat[BEA].entries[0].person, 'bea');
  assert.deepEqual(byChat[MO].knownPeople.filter((p) => p.name === 'Bea'), [{ name: 'Bea', key: 'bea' }]);
  assert.ok(byChat[MO].knownPeople.some((p) => p.name === 'Fabi' && /^wa:/.test(p.key)));
});

test('the bridge\'s own sent bubbles reach the archivist as bridge, never as Alex; his manual texts are owner', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: ['lo del formulario #312 lo checo'], handoff: null, implement: null } });
  await s.msg(BEA, 'qué pasó con el 312');
  await s.advance(DELAY);
  await s.msg(BEA, 'va', { fromMe: true });
  await s.advance(ARCHIVE_QUIET_MS);
  assert.deepEqual(s.calls.archive.flatMap((a) => a.entries).map((e) => [e.author, e.person, e.text]), [
    ['CONTACTO', 'bea', 'qué pasó con el 312'], ['OWNER', 'bridge', 'lo del formulario #312 lo checo'], ['OWNER', 'owner', 'va'],
  ]);
});

test('bridge events reach the archivist: (sombra) for shadow drafts, plain when delivered', async () => {
  const reply = { bubbles: ['ahorita lo veo'], handoff: bugHandoff, implement: { summary: 'arreglar boton', spec: 'S' } };
  const expected = ['[evento] handoff bug: no carga el boton; respondimos: ahorita lo veo', '[evento] implementación pendiente: arreglar boton'];
  const shadow = setup({ reply });
  await shadow.msg(BEA, 'no carga');
  await shadow.advance(DELAY);
  // A shadow draft never reached the contact: the archivist must not read it as something we said.
  assert.deepEqual(await bridgeEvents(shadow), [
    '(sombra: borrador no enviado) [evento] handoff bug: no carga el boton; borrador: ahorita lo veo',
    '(sombra: borrador no enviado) [evento] implementación pendiente: arreglar boton',
  ]);
  const real = setup({ state: { shadow: false, locked: true }, reply });
  await real.msg(BEA, 'no carga');
  await real.advance(DELAY);
  assert.deepEqual(await bridgeEvents(real), expected);
});

test('job deployed / failed become bridge events', async () => {
  const ok = await runJobWith({ result: 'deployed', report: 'ok', bubbles: ['Listo'] });
  assert.deepEqual((await bridgeEvents(ok)).slice(1), ['[evento] desplegado: cambio']);
  for (const result of ['failed', 'rolled-back', 'not-small']) {
    const bad = await runJobWith({ result, report: 'r', bubbles: [] });
    assert.deepEqual((await bridgeEvents(bad)).slice(1), [`[evento] falló el job (${result}): cambio`], result);
  }
});

for (const [name, opts, prep] of [
  ['identity handoff', { state: { shadow: false }, reply: { bubbles: [], handoff: { type: 'identity', blocking: true, fields: {}, raw: '' }, implement: null } }],
  ['secret-blocked reply', { state: { shadow: false }, reply: { bubbles: ['ghp_abc'], handoff: bugHandoff, implement: { summary: 'x', spec: 'S' } } }],
  ['discarded reply (Alex wrote meanwhile)', { state: { shadow: false } }, (s) => () => { s.store.setLastManualFromMeAt(BEA, s.now()); return { bubbles: ['va'], handoff: bugHandoff, implement: null }; }],
  ['handoff with no reply delivered', { state: { shadow: false }, reply: { bubbles: [], handoff: bugHandoff, implement: null } }],
]) {
  test(`no bridge event on ${name}`, async () => {
    const s = setup({ ...opts, ...(prep ? { reply: (a) => prep(s)(a) } : {}) });
    await s.msg(BEA, 'oye');
    await s.advance(DELAY);
    assert.equal(s.calls.reply.length, 1);
    assert.deepEqual(await bridgeEvents(s), []);
  });
}

test('/simular recalls topics (read-only) and never feeds the archivist, neither reply nor job', async () => {
  const s = await simWithSpec({ topicLines: TOPICS, jobSim: simTrace(), core: { parseJobOutput } });
  await self(s, '/simular job');
  assert.deepEqual(s.calls.recall.map((q) => [q.person, q.chat.jid, q.text]), [['bea', BEA, 'oye no carga el boton']]);
  assert.deepEqual(s.calls.reply[0].topics, TOPICS);
  assert.equal(s.calls.jobSim.length, 1);
  assert.deepEqual(await bridgeEvents(s), []);
});

// --- console trace: local stdout only, never WhatsApp ---

// Records every tracer call as [step, arg].
function recTrace() {
  const rec = [];
  return { rec, turn: (x) => (rec.push(['turn', x]), Object.fromEntries(['memory', 'health', 'event', 'decision'].map((k) => [k, (a) => rec.push([k, a])]))) };
}
const THINK = { kind: 'thinking', text: 'Pregunta de estado' };
const DONE = { kind: 'result', durationMs: 7800, costUsd: 0.05, isError: false };
const emitting = (arg) => { arg.onEvent(THINK); arg.onEvent(DONE); return { bubbles: ['hola'], handoff: null, implement: null }; };

test('real reply: tracer gets turn (new inbound texts) -> memory -> health -> live events -> decision; nothing extra to WhatsApp', async () => {
  const trace = recTrace();
  const s = setup({ state: { shadow: false }, topicLines: TOPICS, reply: emitting, tracer: trace });
  s.store.appendTranscript(BEA, { author: 'OWNER', text: 'antes', at: 0 });
  await s.msg(BEA, 'uno');
  await s.msg(BEA, 'dos');
  await s.advance(DELAY);
  assert.deepEqual(trace.rec.map(([k]) => k), ['turn', 'memory', 'health', 'event', 'event', 'decision']);
  const [[, turn], [, mem], [, health], [, think], [, done], [, decision]] = trace.rec;
  assert.equal(turn.mode, 'real');
  assert.equal(turn.contact.name, 'Bea');
  assert.equal(turn.jid, BEA);
  assert.deepEqual(turn.inbound, ['uno', 'dos']);
  assert.deepEqual(mem, TOPICS);
  assert.deepEqual(health, HEALTH);
  assert.deepEqual([think, done], [THINK, DONE]);
  assert.deepEqual(decision.bubbles, ['hola']);
  assert.deepEqual(s.toContact(BEA), ['hola']);
  assert.deepEqual(s.toSelf(), []);
});

test('real reply parse error reaches the tracer as the decision error', async () => {
  const trace = recTrace();
  const s = setup({ core: { parseAgentOutput }, reply: 'Claro, aqui va: hola', tracer: trace });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  const [k, d] = trace.rec.at(-1);
  assert.equal(k, 'decision');
  assert.match(d.error.message, /Malformed output/);
});

test('sim message: tracer gets turn -> memory -> health -> live events -> decision; self-chat posts unchanged', async () => {
  const trace = recTrace();
  const s = setup({ topicLines: TOPICS, reply: emitting, tracer: trace });
  const plain = setup({ topicLines: TOPICS });
  for (const x of [s, plain]) { await self(x, '/simular bea'); await self(x, 'oye no carga'); }
  assert.deepEqual(trace.rec.map(([k]) => k), ['turn', 'memory', 'health', 'event', 'event', 'decision']);
  const [, turn] = trace.rec[0];
  assert.equal(turn.mode, 'sim');
  assert.equal(turn.jid, BEA);
  assert.deepEqual(turn.inbound, ['oye no carga']);
  assert.deepEqual(trace.rec[5][1].bubbles, ['hola']);
  assert.deepEqual(s.toSelf(), plain.toSelf());
  assert.deepEqual(notSelf(s), []);
});

test('sim parse error reaches the tracer as the decision error', async () => {
  const trace = recTrace();
  const s = setup({ core: { parseAgentOutput }, reply: 'Claro, aqui va: hola', tracer: trace });
  await self(s, '/simular dalia');
  await self(s, 'hola');
  assert.match(trace.rec.at(-1)[1].error.message, /Malformed output/);
});

// --- handoffs persisted per chat (read by the portal) ---

const HANDOFF = { bubbles: ['va'], handoff: { type: 'bug', blocking: true, fields: { type: 'bug', blocking: 'true', summary: 'no carga' }, raw: '' }, implement: null };

for (const shadow of [true, false]) {
  test(`handoff recorded for the contact jid (shadow ${shadow})`, async () => {
    let s, at;
    s = setup({ state: { shadow }, reply: () => { at = s.now(); return HANDOFF; } });
    await s.msg(BEA, 'oye');
    await s.advance(DELAY);
    assert.deepEqual(s.store.getHandoffs(BEA), [{ type: 'bug', blocking: true, summary: 'no carga', at, shadow }]);
  });
}

test('handoff recorded even when the draft is discarded because Alex wrote meanwhile', async () => {
  let s;
  s = setup({ state: { shadow: false }, reply: () => { s.store.setLastManualFromMeAt(BEA, s.now()); return HANDOFF; } });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.equal(s.store.getHandoffs(BEA).length, 1);
});

test('sim handoffs are not recorded', async () => {
  const s = setup({ reply: HANDOFF });
  await self(s, '/simular bea');
  await self(s, 'oye');
  await s.advance(0);
  assert.equal(s.calls.reply.length, 1);
  assert.deepEqual(s.store.getHandoffs(BEA), []);
});

test('the agent still receives at most 30 transcript entries while the history file keeps them all', async () => {
  const s = setup();
  for (let i = 0; i < 34; i++) s.store.appendTranscript(BEA, { author: 'CONTACTO', text: `m${i}`, at: i });
  await s.msg(BEA, 'ultimo');
  await s.advance(DELAY);
  const { transcript } = s.calls.reply[0];
  assert.equal(transcript.length, 30);
  assert.equal(transcript.at(-1).text, 'ultimo');
  assert.equal(readFileSync(historyFile(s.dir, BEA), 'utf8').trim().split('\n').length, 35);
});

// --- macOS alerts for blocking events ---

const blockingReply = (blocking = true) => ({ bubbles: [], handoff: { type: 'outage', blocking, fields: { summary: 'se cayo' }, raw: '' }, implement: null });

test('blocking handoff: one alert with contact and summary', async () => {
  const s = setup({ state: { shadow: false }, reply: blockingReply() });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.alerts.map(({ title, message }) => [title, message]), [['wha-me: necesitas intervenir', 'Bea: se cayo']]);
});

test('blocking handoff in shadow mode: alert prefixed (sombra)', async () => {
  const s = setup({ state: { shadow: true }, reply: blockingReply() });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.alerts.map((a) => a.message), ['(sombra) Bea: se cayo']);
});

test('non-blocking handoff: no alert', async () => {
  const s = setup({ state: { shadow: false }, reply: blockingReply(false) });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  assert.deepEqual(s.alerts, []);
});

test('/simular never alerts, even on a blocking handoff', async () => {
  const s = setup({ state: { shadow: false }, reply: IMPL });
  await self(s, '/simular bea');
  await self(s, 'oye');
  await s.advance(0);
  assert.deepEqual(s.alerts, []);
});

for (const [name, job] of [
  ['rolled-back', { result: 'rolled-back', report: 'prod roto', bubbles: [] }],
  ['unknown outcome', () => Promise.reject(new Error('timed out'))],
]) {
  test(`incident (${name}): bridge locked alert with the job summary`, async () => {
    const s = await runJobWith(job);
    assert.deepEqual(s.alerts.map((a) => a.title), ['wha-me: bridge bloqueado']);
    assert.match(s.alerts[0].message, /Bea: cambio/);
  });
}

test('the same blocking handoff alerts once within 10 min (real notifier, fake execFile)', async () => {
  const runs = [];
  let s;
  const n = createNotifier({ execFile: (cmd, args, cb) => { if (cmd === 'osascript') runs.push(args.at(-2)); cb(null); }, platform: 'darwin', now: () => s.now() });
  s = setup({ state: { shadow: false }, reply: blockingReply(), notify: n.alert });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  await s.msg(BEA, 'sigue caido');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 2);
  assert.deepEqual(runs, ['Bea: se cayo']);
});

// --- run log: every agent run (reply/job, real/sim) is recorded ---

function fakeRunLog() {
  const runs = [];
  return {
    runs,
    start(meta) {
      const r = { ...meta, events: [], finished: null, failed: null };
      runs.push(r);
      return { event: (e) => r.events.push(e), finish: (x) => { r.finished = x; }, fail: (e) => { r.failed = e; } };
    },
  };
}
const EV = { kind: 'text', text: 'REPLY:\nhola' };
const replyWithEvent = (out = { bubbles: ['hola'], handoff: null, implement: null }) => (arg) => { arg.onEvent(EV); return out; };

test('run log: real reply in shadow mode records outcome shadow, its events (console tracer gets them too) and the decision', async () => {
  const runLog = fakeRunLog();
  const seen = [];
  const tracer = { turn: () => ({ memory() {}, health() {}, decision() {}, event: (e) => seen.push(e) }) };
  const s = setup({ runLog, tracer, reply: replyWithEvent() });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(runLog.runs.length, 1);
  const [r] = runLog.runs;
  assert.deepEqual([r.kind, r.mode, r.jid, r.contact.name], ['reply', 'real', BEA, 'Bea']);
  assert.deepEqual(r.events, [EV]);
  assert.deepEqual(seen, [EV]);
  assert.equal(r.finished.outcome, 'shadow');
  assert.deepEqual(r.finished.decision.bubbles, ['hola']);
  assert.equal(r.finished.result, JSON.stringify({ bubbles: ['hola'], handoff: null, implement: null }));
  assert.equal(r.failed, null);
});

let closeHours = false;
for (const [name, opts, prep, outcome] of [
  ['sent reply', { reply: { bubbles: ['hola'], handoff: null, implement: null } }, () => {}, 'sent'],
  ['empty reply', { reply: { bubbles: [], handoff: null, implement: null } }, () => {}, 'silent'],
  ['secret in a bubble', { reply: { bubbles: ['ghp_x'], handoff: null, implement: null } }, () => {}, 'blocked'],
  ['Alex writes during the run', {}, (s) => s.store.setLastManualFromMeAt(BEA, s.now()), 'discarded'],
  ['hours close during the run', {}, () => { closeHours = true; }, 'deferred'],
]) {
  test(`run log: ${name} records outcome ${outcome}`, async () => {
    closeHours = false;
    const runLog = fakeRunLog();
    const base = opts.reply ?? { bubbles: ['hola'], handoff: null, implement: null };
    let s;
    s = setup({ runLog, state: { shadow: false }, core: { isWithinHours: () => !closeHours }, reply: async () => { prep(s); return base; } });
    await s.msg(BEA, 'hola');
    await s.advance(DELAY);
    assert.equal(runLog.runs[0].finished?.outcome, outcome);
  });
}

test('run log: a failed reply run records the error', async () => {
  const runLog = fakeRunLog();
  const s = setup({ runLog, reply: async () => { throw new Error('claude timed out'); } });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(runLog.runs[0].failed.message, 'claude timed out');
  assert.equal(runLog.runs[0].finished, null);
});

test('run log: malformed agent output records the error', async () => {
  const runLog = fakeRunLog();
  const s = setup({ runLog, reply: 'no es json' });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.ok(runLog.runs[0].failed instanceof Error);
});

test('run log: real job records kind job, its events and the outcome from its RESULT', async () => {
  const runLog = fakeRunLog();
  const s = await runJobWith((arg) => { arg.onEvent(EV); return Promise.resolve(JSON.stringify({ result: 'deployed', report: 'ok', bubbles: ['Listo'] })); }, { runLog });
  const job = runLog.runs.find((r) => r.kind === 'job');
  assert.deepEqual([job.mode, job.jid, job.contact.name, job.finished.outcome], ['real', BEA, 'Bea', 'deployed']);
  assert.deepEqual(job.events, [EV]);
  assert.equal(job.finished.decision.report, 'ok');
  assert.ok(s.toContact(BEA).includes('Listo'));
  const failed = fakeRunLog();
  await runJobWith({ result: 'rolled-back', report: 'r', bubbles: [] }, { runLog: failed });
  assert.equal(failed.runs.find((r) => r.kind === 'job').finished.outcome, 'rolled-back');
});

test('run log: a job that crashes records the error (and still locks the bridge)', async () => {
  const runLog = fakeRunLog();
  const s = await runJobWith(() => Promise.reject(new Error('claude exited 1')), { runLog });
  assert.equal(runLog.runs.find((r) => r.kind === 'job').failed.message, 'claude exited 1');
  assert.equal(s.store.getState().locked, true);
});

test('run log: sim reply records mode sim, outcome sim, events and decision', async () => {
  const runLog = fakeRunLog();
  const s = setup({ runLog, reply: replyWithEvent() });
  await self(s, '/simular bea');
  await self(s, 'oye');
  const [r] = runLog.runs;
  assert.deepEqual([r.kind, r.mode, r.jid, r.finished.outcome], ['reply', 'sim', BEA, 'sim']);
  assert.deepEqual(r.events, [EV]);
  assert.deepEqual(r.finished.decision.bubbles, ['hola']);
});

test('run log: sim reply error records the error', async () => {
  const runLog = fakeRunLog();
  const s = setup({ runLog, reply: 'no es json' });
  await self(s, '/simular bea');
  await self(s, 'oye');
  assert.ok(runLog.runs[0].failed instanceof Error);
});

test('run log: sim job records kind job, mode sim, its events; a failing one records the error', async () => {
  const runLog = fakeRunLog();
  const s = await simWithSpec({ runLog, jobSim: (arg) => { arg.onEvent(EV); return simTrace(); } });
  await self(s, '/simular job');
  const job = runLog.runs.find((r) => r.kind === 'job');
  assert.deepEqual([job.mode, job.jid, job.finished.outcome, job.finished.result], ['sim', BEA, 'sim', JOB_TEXT]);
  assert.deepEqual(job.events, [EV]);
  const bad = fakeRunLog();
  const s2 = await simWithSpec({ runLog: bad, jobSim: async () => { throw new Error('sandbox down'); } });
  await self(s2, '/simular job');
  assert.equal(bad.runs.find((r) => r.kind === 'job').failed.message, 'sandbox down');
});

// --- APPROVE: the bridge around the config's ActionAdapter (actions.js) ---
const { none: noActions } = await import('./actions.js');

const AUTO = 'auto@s.whatsapp.net';
const autoContact = (over = {}) => ({ jid: AUTO, name: 'Contacto A', register: 'tu', tenant: 'demo', canTriggerImplementation: false, autoApprove: true, ...over });
const APPROVE_OUT = { bubbles: ['ya quedo aprobada'], handoff: null, implement: null, approve: { folios: ['X-26'] } };
// A fake ActionAdapter: its static gate needs autoApprove; approve() re-checks it, then answers with `result`. Records calls.
const gate = (contact, approve) => (!approve.folios ? `directiva APPROVE inválida (${approve.error})` : contact.autoApprove === true ? null : 'el contacto no tiene aprobación automática');
function fakeActions({ result = ({ approve }) => ({ ok: true, done: approve.folios.map((f) => `Aprobé ${f}`) }) } = {}) {
  const calls = [];
  return {
    calls, idPattern: /^X-\d+$/, precheck: gate,
    approve: async (arg) => { calls.push(arg); const refused = gate(arg.contact, arg.approve); return refused ? { ok: false, reason: refused } : result(arg); },
  };
}

async function approveRun({ contact = autoContact(), out = APPROVE_OUT, shadow = false, actions = fakeActions(), ...rest } = {}) {
  const s = setup({ contacts: [contact], state: { shadow }, reply: out, actions, ...rest });
  await s.msg(AUTO, 'ya envie la solicitud, es la X-26');
  await s.advance(DELAY);
  return { s, actions };
}

const assertFallback = (s, reason) => {
  assert.deepEqual(s.toContact(AUTO), ['Buen dia, va lo checo']);
  const [h] = s.store.getHandoffs(AUTO);
  assert.equal(h.type, 'approval');
  assert.equal(h.blocking, true);
  assert.match(h.summary, reason);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].message, reason);
  assert.ok(s.toSelf().some((m) => /HANDOFF · Contacto A/.test(m) && reason.test(m)));
};

test('approve: happy path -> adapter called with the contact and directive, agent reply sent, one note per action, run-log event', async () => {
  const runLog = fakeRunLog();
  const { s, actions } = await approveRun({ runLog });
  assert.deepEqual(actions.calls, [{ contact: autoContact(), approve: { folios: ['X-26'] } }]);
  assert.deepEqual(s.toContact(AUTO), ['ya quedo aprobada']);
  assert.ok(s.toSelf().includes('Aprobé X-26'));
  assert.deepEqual(s.store.getHandoffs(AUTO), []);
  assert.equal(s.alerts.length, 0);
  assert.deepEqual(runLog.runs[0].events.find((e) => e.kind === 'approval'), { kind: 'approval', status: 'ok', text: 'Aprobé X-26' });
  assert.equal(runLog.runs[0].finished.outcome, 'sent');
});

test('approve: actions none() -> the agent reply is never sent; neutral ack + blocking approval handoff (like a contact without autoApprove)', async () => {
  const { s } = await approveRun({ actions: noActions() });
  assertFallback(s, /no se aprobó X-26 automáticamente: aprobación automática no configurada/);
  assert.ok(!s.toSelf().some((m) => m.startsWith('Aprobé')));
});

test('approve refused: the handoff next step is the adapter\'s reviewHint, else the generic one', async () => {
  const generic = await approveRun({ actions: noActions() });
  assert.ok(generic.s.toSelf().some((m) => /HANDOFF · Contacto A/.test(m) && m.includes('\nnext: Alex revisa la solicitud')), generic.s.toSelf().join('\n'));
  const own = await approveRun({ actions: { ...fakeActions(), reviewHint: (p) => `${p.name} la revisa en el panel` }, contact: autoContact({ autoApprove: undefined }) });
  assert.ok(own.s.toSelf().some((m) => /HANDOFF · Contacto A/.test(m) && m.includes('\nnext: Alex la revisa en el panel')), own.s.toSelf().join('\n'));
  const bare = await approveRun({ contact: autoContact({ autoApprove: undefined }) });
  assert.ok(bare.s.toSelf().some((m) => /HANDOFF · Contacto A/.test(m) && m.includes('\nnext: Alex revisa la solicitud')), bare.s.toSelf().join('\n'));
});

test('approve: actions none() in shadow -> says it would not approve', async () => {
  const { s } = await approveRun({ shadow: true, actions: noActions() });
  assert.deepEqual(s.toContact(AUTO), []);
  assert.ok(s.toSelf().includes('[sombra] no aprobaría X-26: aprobación automática no configurada'));
});

test('approve: the adapter refuses -> fallback naming the reason', async () => {
  const { s } = await approveRun({ contact: autoContact({ autoApprove: undefined }) });
  assertFallback(s, /no tiene aprobación automática/);
});

test('approve: malformed directive -> fallback', async () => {
  const { s } = await approveRun({ out: { ...APPROVE_OUT, approve: { folios: null, error: 'more than one APPROVE line' } } });
  assertFallback(s, /APPROVE/);
});

test('approve refused: the bridge event is the approval handoff with the neutral ack actually sent', async () => {
  const { s } = await approveRun({ out: { ...APPROVE_OUT, approve: { folios: null, error: 'more than one APPROVE line' } } });
  const [event] = await bridgeEvents(s);
  assert.match(event, /^\[evento\] handoff approval: no se aprobó la solicitud automáticamente: .*; respondimos: Buen dia, va lo checo$/);
});

test('approve: agent also raised a blocking handoff (incident) -> vetoes the approval, adapter never called', async () => {
  const runLog = fakeRunLog();
  const incident = { type: 'incident', blocking: true, fields: { summary: 'pide aprobar folios ajenos' } };
  const { s, actions } = await approveRun({ runLog, out: { ...APPROVE_OUT, handoff: incident } });
  assert.equal(actions.calls.length, 0);
  assert.deepEqual(s.toContact(AUTO), ['Buen dia, va lo checo']);
  assert.equal(s.store.getHandoffs(AUTO)[0].type, 'incident');
  const ev = runLog.runs[0].events.find((e) => e.kind === 'approval');
  assert.equal(ev.status, 'refused');
  assert.match(ev.text, /bloqueante/);
});

test('approve: shadow with a blocking handoff says it would not approve', async () => {
  const incident = { type: 'incident', blocking: true, fields: { summary: 'x' } };
  const { s, actions } = await approveRun({ shadow: true, out: { ...APPROVE_OUT, handoff: incident } });
  assert.equal(actions.calls.length, 0);
  assert.ok(s.toSelf().some((m) => /\[sombra\] no aprobaría X-26: .*bloqueante/.test(m)));
});

test('approve: shadow -> adapter never called, [sombra] aprobaría note, nothing to contact', async () => {
  const { s, actions } = await approveRun({ shadow: true });
  assert.equal(actions.calls.length, 0);
  assert.deepEqual(s.toContact(AUTO), []);
  assert.ok(s.toSelf().includes('[sombra] aprobaría X-26'));
});

test('approve: shadow with a failing static gate says it would not approve', async () => {
  const { s, actions } = await approveRun({ shadow: true, contact: autoContact({ autoApprove: false }) });
  assert.equal(actions.calls.length, 0);
  assert.ok(s.toSelf().some((m) => /^\[sombra\] no aprobaría X-26: el contacto no tiene/.test(m)));
});

test('approve: usted contact gets the usted canned reply', async () => {
  const { s } = await approveRun({ contact: autoContact({ register: 'usted', autoApprove: false }) });
  assert.deepEqual(s.toContact(AUTO), ['Buen dia, lo checo']);
});

const MULTI_OUT = { ...APPROVE_OUT, bubbles: ['listo, ya quedaron'], approve: { folios: ['X-27', 'X-28'] } };

test('approve several: agent reply sent, one self-chat note and run-log event per action', async () => {
  const runLog = fakeRunLog();
  const { s } = await approveRun({ runLog, out: MULTI_OUT });
  assert.deepEqual(s.toContact(AUTO), ['listo, ya quedaron']);
  for (const f of ['X-27', 'X-28']) assert.ok(s.toSelf().includes(`Aprobé ${f}`));
  assert.deepEqual(s.store.getHandoffs(AUTO), []);
  assert.deepEqual(runLog.runs[0].events.filter((e) => e.kind === 'approval').map((e) => e.status), ['ok', 'ok']);
});

test('approve several: a failure mid-way -> note for the action already done, then canned ack + blocking handoff', async () => {
  const runLog = fakeRunLog();
  const actions = fakeActions({ result: () => ({ ok: false, done: ['Aprobé X-27'], reason: 'X-28: no se pudo (ya se aprobaron: X-27)' }) });
  const { s } = await approveRun({ runLog, out: MULTI_OUT, actions });
  assert.ok(s.toSelf().includes('Aprobé X-27'));
  assertFallback(s, /X-27, X-28 automáticamente: X-28: no se pudo \(ya se aprobaron: X-27\)/);
  assert.deepEqual(runLog.runs[0].events.filter((e) => e.kind === 'approval').map((e) => e.status), ['ok', 'refused']);
});

test('approve several: shadow names every id', async () => {
  const { s, actions } = await approveRun({ shadow: true, out: MULTI_OUT });
  assert.equal(actions.calls.length, 0);
  assert.ok(s.toSelf().includes('[sombra] aprobaría X-27, X-28'));
});

test('approve several: a blocking handoff still vetoes them all', async () => {
  const runLog = fakeRunLog();
  const incident = { type: 'incident', blocking: true, fields: { summary: 'x' } };
  const { s, actions } = await approveRun({ runLog, out: { ...MULTI_OUT, handoff: incident } });
  assert.equal(actions.calls.length, 0);
  assert.deepEqual(s.toContact(AUTO), ['Buen dia, va lo checo']);
  assert.match(runLog.runs[0].events.find((e) => e.kind === 'approval').text, /X-27, X-28: .*bloqueante/);
});

test('approve: the owner writes during the run -> discarded, no approval', async () => {
  const actions = fakeActions();
  let s;
  s = setup({ contacts: [autoContact()], state: { shadow: false }, actions, reply: () => { s.store.setLastManualFromMeAt(AUTO, s.now()); return APPROVE_OUT; } });
  await s.msg(AUTO, 'ya la envie');
  await s.advance(DELAY);
  assert.equal(actions.calls.length, 0);
  assert.deepEqual(s.toContact(AUTO), []);
});

test('approve: the real parser reads the directive with the adapter id pattern', async () => {
  const text = (id) => `REPLY:\nya quedo\nHANDOFF: none\nAPPROVE: ${id}\nIMPLEMENT: none`;
  for (const [id, folios] of [['X-26', ['X-26']], ['Y-26', null]]) {
    const actions = fakeActions();
    const s = setup({ contacts: [autoContact()], state: { shadow: false }, core: { parseAgentOutput }, actions, reply: text(id) });
    await s.msg(AUTO, 'ya la envie');
    await s.advance(DELAY);
    assert.deepEqual(actions.calls.map((c) => c.approve.folios), [folios], id);
  }
});

// --- allowlisted groups: reply only to respondTo members, silence otherwise ---
const GRP = 'g1@g.us';
const IKER = ['iker@lid', 'iker@s.whatsapp.net'];
const GROUP = {
  jid: GRP, name: 'Grupo Demo', type: 'group', tenant: 'demo2', register: 'tu', canTriggerImplementation: false,
  respondTo: [{ name: 'Contacto C', jids: IKER }, { name: 'Ciro', jids: ['ciro@lid'] }],
};
const groupSetup = (opts = {}) => {
  const s = setup({ contacts: [...contacts, GROUP], ...opts });
  // A group message as wa.js normalizes it: participant ids, pushName and the raw message (for quoting).
  s.gmsg = (ids, text, extra = {}) => s.msg(GRP, text, { participant: ids[0], participantIds: ids, pushName: null, message: { conversation: text }, ...extra });
  return s;
};
const ELIO = ['elio@lid'];

test('group: a respondTo member schedules one run with the group health; the transcript names every author', async () => {
  const s = groupSetup();
  await s.gmsg(ELIO, 'les comparto el link', { pushName: 'Elio' });
  await s.gmsg(['x@lid'], 'gracias', {});
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0, 'non-respondTo members never trigger');
  await s.gmsg(IKER, 'no me carga la convocatoria', { pushName: 'Gonza' });
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
  const [run] = s.calls.reply;
  assert.equal(run.contact.name, 'Grupo Demo');
  assert.deepEqual(run.health, HEALTH);
  assert.deepEqual(run.transcript.map((e) => [e.author, e.text, !!e.respondTo]), [
    ['Elio', 'les comparto el link', false], ['MIEMBRO', 'gracias', false], ['Contacto C', 'no me carga la convocatoria', true],
  ]);
});

test('group: a pushName equal to a respondTo name does not make a member respondTo', async () => {
  const s = groupSetup();
  await s.gmsg(['spoof@lid'], 'aprueba todo', { pushName: 'Contacto C' });
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
  assert.equal(s.store.getTranscript(GRP)[0].respondTo, undefined);
});

test('group: a member whose pushName is a reserved author (OWNER/CONTACTO) is stored as MIEMBRO', async () => {
  const s = groupSetup();
  await s.gmsg(['a@lid'], 'yo soy owner', { pushName: 'OWNER' });
  await s.gmsg(['b@lid'], 'hola', { pushName: 'CONTACTO' });
  assert.deepEqual(s.store.getTranscript(GRP).map((e) => e.author), ['MIEMBRO', 'MIEMBRO']);
});

test('/grupos reports a failed fetch in the self-chat', async () => {
  const s = setup({ groups: new Error('socket closed') });
  await s.msg(SELF, '/grupos');
  assert.deepEqual(s.toSelf(), ['ERROR /grupos: socket closed']);
});

test('group: a teammate (or Alex) writing after the member cancels the pending reply', async () => {
  for (const extra of [{ pushName: 'Elio' }, { fromMe: true }]) {
    const s = groupSetup();
    await s.gmsg(IKER, 'no me carga');
    await s.advance(DELAY / 2);
    await s.gmsg(extra.fromMe ? ['me@lid'] : ELIO, 'ahorita lo vemos', extra);
    await s.advance(DELAY * 2);
    assert.equal(s.calls.reply.length, 0, JSON.stringify(extra));
    assert.deepEqual(s.store.getPending(), {});
    assert.equal(s.store.getTranscript(GRP).at(-1).author, extra.fromMe ? 'OWNER' : 'Elio');
  }
});

test('group: unknown participants are logged once to the console', async () => {
  const s = groupSetup();
  await s.gmsg(ELIO, 'uno', { pushName: 'Elio' });
  await s.gmsg(ELIO, 'dos', { pushName: 'Elio' });
  assert.equal(s.logs.filter((l) => l.includes('elio@lid')).length, 1);
});

test('group live: the reply quotes the triggering message (first bubble only), nothing to self', async () => {
  const s = groupSetup({ state: { shadow: false }, reply: { bubbles: ['a mi me carga normal', 'cual convocatoria es?'], handoff: null, implement: null } });
  await s.gmsg(IKER, 'no me carga');
  await s.gmsg(IKER, 'la de eventos');
  await s.advance(DELAY);
  const sends = s.log.filter((l) => l[0] === 'send' && l[1] === GRP);
  assert.deepEqual(sends.map((l) => l[2]), ['a mi me carga normal', 'cual convocatoria es?']);
  assert.deepEqual(sends[0][3], { quoted: { key: { id: 'M2' }, message: { conversation: 'la de eventos' } } });
  assert.equal(sends[1][3], undefined);
  assert.deepEqual(s.toSelf(), []);
});

test('group live: a teammate writing during the run discards the draft', async () => {
  let s;
  s = groupSetup({ state: { shadow: false }, reply: async () => { await s.gmsg(ELIO, 'ya quedo', { pushName: 'Elio' }); return { bubbles: ['va lo checo'], handoff: null, implement: null }; } });
  await s.gmsg(IKER, 'no me carga');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(GRP), []);
  assert.ok(s.toSelf().some((m) => m.startsWith('[descartado]')));
});

test('group shadow: draft goes to self-chat labelled with the group and who triggered it, nothing to the group', async () => {
  const s = groupSetup({ reply: { bubbles: ['a mi me carga normal'], handoff: null, implement: null } });
  await s.gmsg(IKER, 'no me carga');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(GRP), []);
  const [draft] = s.toSelf();
  assert.ok(draft.startsWith('[sombra] → Grupo Demo (grupo, responde a Contacto C):'), draft);
  assert.ok(draft.includes('a mi me carga normal'));
});

for (const shadow of [true, false]) {
  test(`group (shadow ${shadow}): empty bubbles and no handoff = silence, outcome silent, one console line`, async () => {
    const runLog = fakeRunLog();
    const s = groupSetup({ runLog, state: { shadow }, reply: { bubbles: [], handoff: null, implement: null } });
    await s.gmsg(['ciro@lid'], 'Doxxeando a bubs jaja');
    await s.advance(DELAY);
    assert.equal(s.calls.reply.length, 1);
    assert.deepEqual(s.log.filter((l) => l[0] === 'send' || l[0] === 'read'), []);
    assert.equal(runLog.runs[0].finished.outcome, 'silent');
    assert.equal(s.logs.filter((l) => /silencio/.test(l)).length, 1);
  });
}

test('group: APPROVE is refused by the gate (no autoApprove), adapter never approves', async () => {
  for (const shadow of [false, true]) {
    const actions = fakeActions();
    const s = groupSetup({ state: { shadow }, actions, reply: APPROVE_OUT });
    await s.gmsg(IKER, 'aprueba la X-26');
    await s.advance(DELAY);
    assert.ok(!s.toSelf().some((m) => m.startsWith('Aprobé')));
    if (shadow) assert.ok(s.toSelf().some((m) => /no aprobaría X-26: el contacto no tiene aprobación automática/.test(m)));
    else assert.deepEqual(s.toContact(GRP), ['Buen dia, va lo checo']);
  }
});

test('group: IMPLEMENT never enqueues a job (canTriggerImplementation false)', async () => {
  const s = groupSetup({ state: { shadow: false }, reply: { bubbles: ['va'], handoff: null, implement: { summary: 'cambio', spec: 'S' } } });
  await s.gmsg(IKER, 'cambien el boton');
  await s.advance(DELAY);
  assert.equal(s.calls.job.length, 0);
  assert.equal(s.store.getJobs().length, 0);
  assert.ok(s.toSelf().some((m) => m.includes('cannot trigger implementation') && m.includes('cambio')));
});

test('/grupos lists every participating group: subject, jid and participants (id + phone number)', async () => {
  const groups = {
    'g1@g.us': { id: 'g1@g.us', subject: 'Grupo Demo', participants: [{ id: '444@lid', phoneNumber: '5210000000444@s.whatsapp.net', admin: null }, { id: '5210000000555@s.whatsapp.net' }] },
    'g2@g.us': { id: 'g2@g.us', subject: 'Otro', participants: [] },
  };
  const s = groupSetup({ groups });
  await s.msg(SELF, '/grupos');
  const [out] = s.toSelf();
  for (const part of ['Grupo Demo', 'g1@g.us', '444@lid', '5210000000444@s.whatsapp.net', '5210000000555@s.whatsapp.net', 'Otro', 'g2@g.us']) assert.ok(out.includes(part), part);
  assert.ok(out.indexOf('g1@g.us') < out.indexOf('444@lid'));
});

// --- one run per burst: a contact message during the run supersedes its output ---

for (const shadow of [true, false]) {
  test(`contact writes during the reply run (shadow ${shadow}): output superseded, then one run with every message`, async () => {
    const runLog = fakeRunLog();
    let s;
    s = setup({ runLog, state: { shadow }, reply: async () => { if (s.calls.reply.length === 1) await s.msg(BEA, 'dos'); return HANDOFF; } });
    await s.msg(BEA, 'uno');
    await s.advance(DELAY);
    assert.equal(s.calls.reply.length, 1);
    assert.deepEqual(s.log.filter((l) => l[0] === 'send' || l[0] === 'read'), []);
    assert.deepEqual(s.store.getHandoffs(BEA), []);
    assert.deepEqual(s.alerts, []);
    assert.equal(runLog.runs[0].finished.outcome, 'superseded');
    assert.equal(s.logs.filter((l) => /superseded/.test(l)).length, 1);
    await s.advance(DELAY);
    assert.equal(s.calls.reply.length, 2);
    assert.deepEqual(s.calls.reply[1].transcript.map((e) => e.text), ['uno', 'dos']);
    assert.equal(runLog.runs[1].finished.outcome, shadow ? 'shadow' : 'sent');
    assert.equal(s.store.getHandoffs(BEA).length, 1);
  });

  test(`1:1 (shadow ${shadow}): REPLY (none) and no handoff = silence, outcome silent, one console line`, async () => {
    const runLog = fakeRunLog();
    const s = setup({ runLog, state: { shadow }, reply: { bubbles: [], handoff: null, implement: null } });
    await s.msg(BEA, 'esa vez si funciono');
    await s.advance(DELAY);
    assert.equal(s.calls.reply.length, 1);
    assert.deepEqual(s.log.filter((l) => l[0] === 'send' || l[0] === 'read'), []);
    assert.equal(runLog.runs[0].finished.outcome, 'silent');
    assert.equal(s.logs.filter((l) => /silencio/.test(l)).length, 1);
  });
}

// --- learning loop: drafts vs what Alex really sent (see feedback.js), /aprender (see learn.js) ---

function fakeFeedback() {
  const calls = [];
  return { calls, draft: (x) => calls.push(['draft', x]), manual: (...a) => calls.push(['manual', ...a]), contact: (...a) => calls.push(['contact', ...a]) };
}
function idRunLog() {
  let n = 40;
  return { start: () => ({ id: ++n, event() {}, finish() {}, fail() {} }) };
}

test('feedback: a shadow draft is recorded with its run id; Alex manual texts and contact messages reach the pair collector', async () => {
  const feedback = fakeFeedback();
  const s = setup({ feedback, runLog: idRunLog(), reply: { bubbles: ['va lo checo'], handoff: null, implement: null } });
  const t0 = s.now();
  await s.msg(BEA, 'oye');
  await s.advance(DELAY);
  await s.msg(BEA, 'Va lo checo', { fromMe: true });
  await s.msg(BEA, 'gracias');
  const [contact1, draft, manual, contact2] = feedback.calls;
  assert.deepEqual(contact1, ['contact', BEA, t0]);
  assert.equal(draft[0], 'draft');
  assert.deepEqual([draft[1].runId, draft[1].jid, draft[1].outcome, draft[1].out.bubbles, draft[1].contact.name], [41, BEA, 'shadow', ['va lo checo'], 'Bea']);
  assert.deepEqual(draft[1].transcript.map((e) => [e.author, e.text]), [['CONTACTO', 'oye']], 'the transcript the reply run saw');
  assert.deepEqual(manual, ['manual', BEA, 'Va lo checo', s.now()]);
  assert.deepEqual(contact2, ['contact', BEA, s.now()]);
});

test('feedback: the bridge own sends are never Alex manual texts; silent runs are recorded too', async () => {
  const feedback = fakeFeedback();
  let out = { bubbles: ['hola'], handoff: null, implement: null };
  const s = setup({ feedback, state: { shadow: false }, reply: () => out });
  await s.msg(BEA, 'oye');
  await s.advance(DELAY + 60_000);
  for (const [, , text] of s.log.filter((l) => l[0] === 'send' && l[1] === BEA)) await s.msg(BEA, text, { fromMe: true, id: 'B1' });
  out = { bubbles: [], handoff: null, implement: null };
  await s.msg(BEA, 'ok');
  await s.advance(DELAY);
  assert.deepEqual(feedback.calls.filter((c) => c[0] === 'draft').map((c) => c[1].outcome), ['sent', 'silent']);
  assert.equal(feedback.calls.filter((c) => c[0] === 'manual').length, 0);
});

test('feedback in a group: Alex is manual, a respondTo member closes the window, a teammate does neither', async () => {
  const feedback = fakeFeedback();
  const s = groupSetup({ feedback });
  await s.gmsg(IKER, 'oye');
  await s.gmsg(ELIO, 'yo lo veo');
  await s.msg(GRP, 'ya quedó', { fromMe: true });
  assert.deepEqual(feedback.calls.map((c) => c.slice(0, 2)), [['contact', GRP], ['manual', GRP]]);
});

test('/aprender goes to the learner with its argument; its answer goes to self-chat', async () => {
  const seen = [];
  const learner = { handle: async (arg, say) => { seen.push(arg); await say('analizando'); return `ok ${arg}`; } };
  const s = setup({ learner });
  await s.msg(SELF, '/aprender', { fromMe: true });
  await s.msg(SELF, '/aprender SI', { fromMe: true });
  assert.deepEqual(seen, ['', 'si']);
  assert.deepEqual(s.toSelf(), ['analizando', 'ok ', 'analizando', 'ok si']);
});

// --- replying from the portal (bridge.sendManual) and the /portal login link ---

test('sendManual: sent like Alex typing: OWNER transcript, Alex active, pending reply cancelled, feedback pair texts; echoes ignored', async () => {
  const feedback = fakeFeedback();
  const s = setup({ feedback, state: { shadow: false } });
  await s.msg(BEA, 'hola');
  assert.notEqual(s.store.getPending()[BEA], undefined);
  assert.deepEqual(await s.bridge.sendManual(BEA, ['uno', 'dos']), { ok: true, sent: 2 });
  assert.deepEqual(s.toContact(BEA), ['uno', 'dos']);
  assert.ok(s.log.some((l) => l[0] === 'read'), 'the contact message is marked read');
  assert.deepEqual(s.store.getTranscript(BEA).map((e) => [e.author, e.text]), [['CONTACTO', 'hola'], ['OWNER', 'uno'], ['OWNER', 'dos']]);
  assert.equal(s.store.getLastManualFromMeAt(BEA), s.now());
  assert.equal(s.store.getPending()[BEA], undefined);
  const manual = () => feedback.calls.filter((c) => c[0] === 'manual').map((c) => c.slice(1, 3));
  assert.deepEqual(manual(), [[BEA, 'uno'], [BEA, 'dos']]);
  // Baileys delivers our own sends back as fromMe: never re-appended or re-counted.
  await s.msg(BEA, 'uno', { fromMe: true, id: 'B1' });
  await s.msg(BEA, 'dos', { fromMe: true, id: 'B2' });
  assert.equal(s.store.getTranscript(BEA).length, 3);
  assert.deepEqual(manual(), [[BEA, 'uno'], [BEA, 'dos']]);
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
});

test('sendManualSticker: like a manual text: pending reply cancelled, Alex active, [sticker] in the transcript and feedback; no text guard', async () => {
  const feedback = fakeFeedback();
  const s = setup({ feedback, state: { shadow: false } });
  await s.msg(BEA, 'hola');
  assert.notEqual(s.store.getPending()[BEA], undefined);
  const webp = Buffer.from('RIFF\0\0\0\0WEBP');
  const id = Buffer.alloc(32, 7).toString('base64url');
  assert.deepEqual(await s.bridge.sendManualSticker(BEA, webp, id), { ok: true, sent: 1 });
  assert.deepEqual(s.log.filter((l) => l[0] === 'sticker'), [['sticker', BEA, webp]]);
  assert.ok(s.log.some((l) => l[0] === 'read'), 'the contact message is marked read');
  // The agent's text stays [sticker]; the sticker id rides along for the portal only.
  assert.deepEqual(s.store.getTranscript(BEA).map((e) => [e.author, e.text, e.sticker]), [['CONTACTO', 'hola', undefined], ['OWNER', '[sticker]', id]]);
  assert.deepEqual(s.store.getHistory(BEA).at(-1).sticker, id);
  assert.equal(s.store.getLastManualFromMeAt(BEA), s.now());
  assert.equal(s.store.getPending()[BEA], undefined);
  assert.deepEqual(feedback.calls.filter((c) => c[0] === 'manual').map((c) => c.slice(1, 3)), [[BEA, '[sticker]']]);
  // Baileys' own-send echo is ignored like a text's.
  await s.msg(BEA, '[sticker]', { fromMe: true, id: 'B1' });
  assert.equal(s.store.getTranscript(BEA).length, 2);
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 0);
});

test('portal sends to the self-chat: straight to WhatsApp, never a command, no owner activity, echoes ignored; text still guarded', async () => {
  const feedback = fakeFeedback();
  const s = setup({ feedback, state: { shadow: false } });
  await s.msg(BEA, 'hola');
  const pending = s.store.getPending()[BEA];
  assert.notEqual(pending, undefined);
  assert.deepEqual(await s.bridge.sendManual(SELF, ['/pausa']), { ok: true, sent: 1 });
  const webp = Buffer.from('RIFF\0\0\0\0WEBP');
  const id = Buffer.alloc(32, 7).toString('base64url');
  assert.deepEqual(await s.bridge.sendManualSticker(SELF, webp, id), { ok: true, sent: 1 });
  assert.deepEqual(s.toSelf(), ['/pausa'], 'sent, and nothing answered it');
  assert.deepEqual(s.log.filter((l) => l[0] === 'sticker'), [['sticker', SELF, webp]]);
  assert.equal(s.store.getState().paused, false, 'not run as a command');
  assert.deepEqual(s.store.getPending()[BEA], pending, "another chat's pending reply is untouched");
  assert.equal(s.store.getLastManualFromMeAt(SELF), null);
  // Only the portal's own sends are kept for the «Tú» view, read by the portal alone (the self-chat is never a reply or archive chat).
  assert.deepEqual(s.store.getHistory(SELF).map((e) => [e.author, e.text, e.sticker]), [['OWNER', '/pausa', undefined], ['OWNER', '[sticker]', id]]);
  assert.equal(s.log.some((l) => l[0] === 'read'), false);
  assert.deepEqual(feedback.calls.filter((c) => c[0] === 'manual'), []);
  // The echoes of our own sends (ids recorded) are not read as the owner's commands either.
  await s.msg(SELF, '/pausa', { fromMe: true, id: 'B1' });
  await s.msg(SELF, '[sticker]', { fromMe: true, id: 'B2' });
  await s.msg(SELF, '/sigue', { fromMe: true, id: 'X9' }); // a real command typed on the phone: run, not recorded for «Tú»
  assert.equal(s.store.getHistory(SELF).length, 2);
  assert.equal(s.store.getState().paused, false);
  const r = await s.bridge.sendManual(SELF, [`token ${NPM_TOKEN}`]);
  assert.equal(r.ok, false);
  assert.equal(s.store.getHistory(SELF).length, 2);
});

test('sendManual: a secret in any bubble refuses the whole send, nothing reaches WhatsApp or the transcript', async () => {
  const s = setup({ state: { shadow: false } });
  const r = await s.bridge.sendManual(BEA, ['ok', `token ${NPM_TOKEN}`]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /secreto/);
  assert.equal(s.log.filter((l) => l[0] === 'send').length, 0);
  assert.deepEqual(s.store.getTranscript(BEA), []);
  assert.equal(s.store.getLastManualFromMeAt(BEA), null);
});

test('/portal posts the login link (exempt from the secret guard) or the tunnel hint; the token never reaches trace, run log or console', async () => {
  const traced = [];
  const started = [];
  let link = null;
  const s = setup({
    portalLink: () => link, tracer: { turn: (x) => { traced.push(x); return {}; } }, runLog: { start: (x) => { started.push(x); return { event() {}, finish() {}, fail() {} }; } },
  });
  await self(s, '/portal');
  assert.deepEqual(s.toSelf(), ['no hay túnel; corre npm run tunnel']);
  link = `https://abc.trycloudflare.com/login?k=${PORTAL_TOKEN}`;
  await self(s, '/portal');
  assert.ok(s.toSelf()[1].includes(link));
  await s.msg(SELF, s.toSelf()[1], { fromMe: true, id: 'B2' }); // its echo is ignored
  assert.equal(s.toSelf().length, 2);
  assert.deepEqual([traced, started], [[], []]);
  assert.ok(!s.logs.join('\n').includes(PORTAL_TOKEN));
});

test('the portal token is a secret everywhere else: a draft carrying it only raises the alert', async () => {
  const s = setup({ reply: { bubbles: [`entra con ${PORTAL_TOKEN}`], handoff: null, implement: null } });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.ok(s.toSelf().every((t) => !t.includes(PORTAL_TOKEN)));
  assert.match(s.toSelf()[0], /ALERT/);
});

// --- Peticiones: feature-request handoffs become requests (requests.js); Pedir info from the portal (askContact) ---

const featureHandoff = (summary = 'reporte de becas por colonia') => ({ type: 'feature-request', blocking: false, fields: { summary, evidence: 'problema: no ven avance' }, raw: '' });
const withRequests = (opts) => setup({ ...opts, requests: createRequests({ profile: PROFILE, file: ':memory:' }) });

test('feature-request handoff (real): one request, the PETICIÓN self-chat line and a request event for the archivist', async () => {
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  const s = setup({ state: { shadow: false }, requests, reply: { bubbles: ['va, lo veo con el equipo'], handoff: featureHandoff(), implement: null } });
  await s.msg(BEA, 'quiero un reporte');
  await s.advance(DELAY);
  const list = requests.list();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].status, list[0].shadow, list[0].contactName], ['nueva', false, 'Bea']);
  assert.ok(s.toSelf().includes(`PETICIÓN #${list[0].id} · Bea: reporte de becas por colonia`));
  assert.deepEqual(await bridgeEvents(s), [`[evento] petición #${list[0].id} registrada: reporte de becas por colonia (nueva)`]);
});

test('feature-request handoff in shadow: request flagged shadow, [sombra] line, (sombra) event', async () => {
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  const s = setup({ requests, reply: { bubbles: ['va'], handoff: featureHandoff(), implement: null } });
  await s.msg(BEA, 'quiero un reporte');
  await s.advance(DELAY);
  const [r] = requests.list();
  assert.equal(r.shadow, true);
  assert.ok(s.toSelf().includes(`[sombra] PETICIÓN #${r.id} · Bea: reporte de becas por colonia`));
  assert.deepEqual(await bridgeEvents(s), [`(sombra: borrador no enviado) [evento] petición #${r.id} registrada: reporte de becas por colonia (nueva)`]);
});

test('the same feature request twice merges into one request (count 2); other handoff types create none', async () => {
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  let handoff = featureHandoff();
  const s = setup({ state: { shadow: false }, requests, reply: () => ({ bubbles: ['va'], handoff, implement: null }) });
  await s.msg(BEA, 'uno');
  await s.advance(DELAY);
  await s.msg(BEA, 'dos');
  await s.advance(DELAY);
  assert.deepEqual(requests.list().map((r) => r.handoffCount), [2]);
  handoff = bugHandoff;
  await s.msg(BEA, 'tres');
  await s.advance(DELAY);
  assert.equal(requests.list().length, 1);
  assert.equal(s.toSelf().filter((l) => l.includes('PETICIÓN')).length, 2);
});

test('no requests store configured: a feature-request handoff still works as before', async () => {
  const s = setup({ state: { shadow: false }, reply: { bubbles: ['va'], handoff: featureHandoff(), implement: null } });
  await s.msg(BEA, 'quiero un reporte');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(BEA), ['va']);
  assert.ok(!s.toSelf().some((l) => l.includes('PETICIÓN')));
});

test('askContact: a normal reply run carrying Alex\'s note, through act() (sent to the contact when real)', async () => {
  const s = withRequests({ state: { shadow: false }, reply: { bubbles: ['oye, cuantos registros son?'], handoff: null, implement: null } });
  s.bridge.askContact(BEA, 'pregunta cuantos registros al mes');
  await s.advance(0);
  await s.advance(DELAY * 10);
  assert.equal(s.calls.reply.length, 1);
  assert.equal(s.calls.reply[0].note, 'pregunta cuantos registros al mes');
  assert.deepEqual(s.toContact(BEA), ['oye, cuantos registros son?']);
  // The note is used once: the next contact message runs without it.
  await s.msg(BEA, 'como 300');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 2);
  assert.equal('note' in s.calls.reply[1], false);
});

test('askContact honors shadow (draft to self-chat only) and the secret guard', async () => {
  const shadow = withRequests({ reply: { bubbles: ['cuantos son?'], handoff: null, implement: null } });
  shadow.bridge.askContact(BEA, 'pregunta volumen');
  await shadow.advance(0);
  assert.equal(shadow.calls.reply[0].note, 'pregunta volumen');
  assert.deepEqual(shadow.toContact(BEA), []);
  assert.ok(shadow.toSelf()[0].startsWith('[sombra] → Bea:'));
  const leak = withRequests({ state: { shadow: false }, reply: { bubbles: ['ghp_abc'], handoff: null, implement: null } });
  leak.bridge.askContact(BEA, 'x');
  await leak.advance(0);
  assert.deepEqual(leak.toContact(BEA), []);
  assert.throws(() => leak.bridge.askContact('nadie@s.whatsapp.net', 'x'), /chat no encontrado/);
});

test('reply run gets the chat\'s open requests (same shadow flag), nothing from other chats', async () => {
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  const mine = requests.fromHandoff(BEA, { name: 'Bea' }, featureHandoff('reporte de becas por colonia'), { shadow: false }).id;
  requests.fromHandoff(BEA, { name: 'Bea' }, featureHandoff('de sombra'), { shadow: true });
  requests.fromHandoff('dalia@s.whatsapp.net', { name: 'Dalia' }, featureHandoff('de otro chat'), { shadow: false });
  const s = setup({ state: { shadow: false }, requests });
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.reply[0].openRequests, [{ id: mine, status: 'nueva', summary: 'reporte de becas por colonia' }]);
});

// --- persona contacts (contacts.json `persona`): a lightweight agent, walled off from the owner's work voice and memory ---
const ROBIN = 'robin@s.whatsapp.net';
const PERSONA = { jid: ROBIN, name: 'Robin', register: 'tu', persona: '/abs/robin.md' };
const PGRP = 'family@g.us';
const PGROUP = { jid: PGRP, name: 'Familia', type: 'group', persona: '/abs/robin.md', respondTo: [{ name: 'Ana', jids: ['ana@lid'] }] };
const personaSetup = (opts = {}) => setup({ contacts: [...contacts, PERSONA, PGROUP], state: { shadow: false }, ...opts });

test('persona: no health check or topic recall; a plain REPLY is sent', async () => {
  const s = personaSetup();
  await s.msg(ROBIN, 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
  assert.deepEqual([s.calls.reply[0].health, s.calls.reply[0].topics], [[], []]);
  assert.equal(s.calls.recall.length, 0);
  assert.deepEqual(s.toContact(ROBIN), ['hola']);
});

test('persona: HANDOFF, IMPLEMENT or APPROVE means no reply: nothing sent, no canned ack, handoff, alert, request or job', async () => {
  for (const out of [
    { bubbles: ['ya'], handoff: { type: 'bug', blocking: true, fields: { summary: 's' } }, implement: null },
    { bubbles: ['ya'], handoff: null, implement: { summary: 'x', spec: 'y' } },
    { bubbles: ['ya quedo'], handoff: null, implement: null, approve: { folios: ['X-1'] } },
  ]) {
    const s = personaSetup({ contacts: [{ ...PERSONA, canTriggerImplementation: true, autoApprove: true }], reply: out, actions: fakeActions() });
    await s.msg(ROBIN, 'hola');
    await s.advance(DELAY);
    assert.deepEqual([s.toContact(ROBIN), s.toSelf(), s.store.getHandoffs(ROBIN), s.alerts, s.store.getJobs()], [[], [], [], [], []]);
  }
});

test('persona: never archived nor learned from (messages, replies, manual sends, catch-up)', async () => {
  const feedback = fakeFeedback();
  const s = personaSetup({ feedback, memoryChats: [{ jid: ROBIN, name: 'Robin', kind: 'private' }] });
  await s.msg(ROBIN, 'hola');
  await s.advance(DELAY);
  await s.msg(ROBIN, 'yo', { fromMe: true });
  await s.bridge.sendManual(ROBIN, ['manual']);
  await s.msg(PGRP, 'hola', { participant: 'ana@lid', participantIds: ['ana@lid'], pushName: null, message: { conversation: 'hola' } });
  await s.advance(DELAY);
  await s.advance(ARCHIVE_QUIET_MS);
  await s.make().catchUpArchive();
  assert.deepEqual(s.calls.archive, []);
  assert.deepEqual(feedback.calls, []);
  assert.deepEqual(s.toContact(ROBIN).length, 2, 'still answered and manual send still works');
});

test('persona group: the reply quotes the triggering respondTo message', async () => {
  const s = personaSetup();
  await s.msg(PGRP, 'hola', { participant: 'ana@lid', participantIds: ['ana@lid'], pushName: null, message: { conversation: 'hola' } });
  await s.advance(DELAY);
  const [send] = s.log.filter((l) => l[0] === 'send' && l[1] === PGRP);
  assert.deepEqual(send[3].quoted.message, { conversation: 'hola' });
});

// A banter group: friends keep talking, so only the owner silences the bot, and it answers fast (personaDelayMs).
const pmsg = (s, ids, text, extra = {}) => s.msg(PGRP, text, { participant: ids[0], participantIds: ids, pushName: null, message: { conversation: text }, ...extra });

test('persona group: other members writing (before or during the run) neither cancel nor discard the reply', async () => {
  let s;
  s = personaSetup({ core: { personaDelayMs: () => DELAY }, reply: async () => { await pmsg(s, ['x@lid'], 'jajaja', { pushName: 'Julián' }); return { bubbles: ['ni tú te la crees'], handoff: null, implement: null }; } });
  await pmsg(s, ['ana@lid'], 'te va a salir mal');
  await pmsg(s, ['x@lid'], 'uff', { pushName: 'Julián' });
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(PGRP), ['ni tú te la crees']);
  assert.deepEqual(s.calls.reply[0].transcript.map((e) => e.author), ['Ana', 'Julián']);
});

test('persona group: the owner writing still cancels the pending reply', async () => {
  const s = personaSetup({ core: { personaDelayMs: () => DELAY } });
  await pmsg(s, ['ana@lid'], 'te va a salir mal');
  await pmsg(s, ['me@lid'], 'ya cállate', { fromMe: true });
  await s.advance(DELAY * 2);
  assert.equal(s.calls.reply.length, 0);
});

test('persona chats wait personaDelayMs, other chats replyDelayMs', async () => {
  const s = personaSetup({ core: { personaDelayMs: () => DELAY, replyDelayMs: () => DELAY * 100 } });
  await pmsg(s, ['ana@lid'], 'hola');
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.equal(s.calls.reply.length, 1);
  assert.equal(s.calls.reply[0].contact.name, 'Familia');
});

test('anyHour: answered out of hours (live); other contacts still deferred', async () => {
  const s = setup({ contacts: [...contacts, { ...PERSONA, persona: undefined, anyHour: true }], state: { shadow: false }, core: { isWithinHours: () => false } });
  await s.msg(ROBIN, 'hola');
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.deepEqual(s.calls.reply.map((r) => r.contact.name), ['Robin']);
  assert.deepEqual(s.toContact(ROBIN), ['hola']);
});

test('live: replied for real under global shadow; other contacts still drafted', async () => {
  const s = setup({ contacts: [...contacts, { ...PERSONA, persona: undefined, live: true }], state: { shadow: true } });
  await s.msg(ROBIN, 'hola');
  await s.msg(BEA, 'hola');
  await s.advance(DELAY);
  assert.deepEqual(s.toContact(ROBIN), ['hola']);
  assert.deepEqual(s.toContact(BEA), []);
  assert.ok(s.toSelf().some((t) => t.startsWith('[sombra]')), 'Bea drafted');
});

test('live: hours apply again unless anyHour', async () => {
  for (const [anyHour, sent] of [[false, []], [true, ['hola']]]) {
    const s = setup({ contacts: [...contacts, { ...PERSONA, persona: undefined, live: true, anyHour }], state: { shadow: true }, core: { isWithinHours: () => false } });
    await s.msg(ROBIN, 'hola');
    await s.advance(DELAY);
    assert.deepEqual(s.toContact(ROBIN), sent);
  }
});
