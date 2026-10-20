import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatDetail, chatList, costTotals, linkView, parseHistory, preprodOf, runDetail, runRow, stationOf, subagents } from './portal-view.js';

const BEA = 'bea@s.whatsapp.net';
const BEA_LID = 'bea@lid';
const DALIA = 'dalia@s.whatsapp.net';
const contacts = [
  { jid: BEA, name: 'Bea', register: 'tu', tenant: 'demo' },
  { jid: DALIA, name: 'Dalia', register: 'usted', tenant: 'demo2' },
  { jid: BEA_LID, name: 'Bea', register: 'tu', tenant: 'demo' },
];
const msg = (author, text, at) => ({ author, text, at });
const ho = (summary, at, extra = {}) => ({ type: 'bug', blocking: false, summary, at, shadow: false, ...extra });
const store = (over = {}) => ({ transcripts: {}, lastManual: {}, state: { paused: false, locked: false, shadow: true }, jobs: [], pending: {}, ...over });
const byJid = (v, jid) => v.chats.find((c) => c.jid === jid);

test('needsIntervention: handoff later than Alex\'s last message; cleared once he writes', () => {
  const data = store({ transcripts: { [BEA]: [msg('CONTACTO', 'oye', 10)] }, handoffs: { [BEA]: [ho('no carga', 20)] }, lastManual: { [BEA]: 5 } });
  const open = byJid(chatList({ store: data, contacts, history: {} }), BEA);
  assert.equal(open.needsIntervention, true);
  assert.deepEqual(open.handoffs.map((h) => h.summary), ['no carga']);
  data.lastManual[BEA] = 30;
  const closed = byJid(chatList({ store: data, contacts, history: {} }), BEA);
  assert.equal(closed.needsIntervention, false);
  assert.deepEqual(closed.handoffs, []);
});

test('sort: blocking interventions, then other interventions, then by last activity', () => {
  const data = store({
    transcripts: { a: [msg('CONTACTO', 'x', 100)], b: [msg('CONTACTO', 'x', 50)], c: [msg('CONTACTO', 'x', 10)], d: [msg('CONTACTO', 'x', 60)] },
    handoffs: { b: [ho('nb', 51)], c: [ho('blk', 11, { blocking: true })] },
  });
  assert.deepEqual(chatList({ store: data, contacts, history: {} }).chats.map((c) => c.jid), ['c', 'b', 'a', 'd']);
});

test('contacts: unknown jid is "desconocido"; a person under 2 jids resolves to the name on both', () => {
  const data = store({ transcripts: { [BEA]: [msg('CONTACTO', 'a', 1)], [BEA_LID]: [msg('CONTACTO', 'b', 2)], 'x@s.whatsapp.net': [msg('CONTACTO', 'c', 3)] } });
  const v = chatList({ store: data, contacts, history: {} });
  assert.equal(byJid(v, BEA).name, 'Bea');
  assert.equal(byJid(v, BEA_LID).name, 'Bea');
  assert.equal(byJid(v, BEA_LID).tenant, 'demo');
  assert.equal(byJid(v, 'x@s.whatsapp.net').name, 'desconocido');
});

test('contact flags for the portal: group, autoApprove, canTriggerImplementation (false when absent)', () => {
  const G = 'g1@g.us';
  const cs = [...contacts, { jid: G, name: 'Grupo', type: 'group', tenant: 'demo2', autoApprove: true, canTriggerImplementation: true }];
  const data = store({ transcripts: { [BEA]: [msg('CONTACTO', 'a', 1)], [G]: [msg('Dalia', 'b', 2)], 'z@g.us': [msg('Nico', 'c', 3)] } });
  const v = chatList({ store: data, contacts: cs, history: {} });
  const flags = (c) => [c.group, c.autoApprove, c.canTriggerImplementation];
  assert.deepEqual(flags(byJid(v, G)), [true, true, true]);
  assert.deepEqual(flags(byJid(v, BEA)), [false, false, false]);
  assert.deepEqual(flags(byJid(v, 'z@g.us')), [true, false, false], 'unknown group jid');
});

test('list item: preview, count, pending, queued job; global state and jobs summary', () => {
  const data = store({
    transcripts: { [BEA]: [msg('CONTACTO', 'hola', 1), msg('OWNER', 'que paso', 2)] },
    pending: { [BEA]: 999 },
    jobs: [{ jid: BEA, implement: { summary: 'arreglar', spec: 'S' } }],
    state: { paused: false, locked: true, shadow: false },
  });
  const v = chatList({ store: data, contacts, history: {} });
  assert.deepEqual(v.state, { paused: false, locked: true, shadow: false });
  assert.deepEqual(v.jobs, [{ jid: BEA, name: 'Bea', summary: 'arreglar' }]);
  const c = byJid(v, BEA);
  assert.deepEqual(c.lastMessage, msg('OWNER', 'que paso', 2));
  assert.equal(c.messageCount, 2);
  assert.equal(c.pending, 999);
  assert.equal(c.jobQueued, true);
  assert.equal(c.lastActivity, 2);
});

test('full history file wins over the capped transcript; chat detail interleaves handoffs by time', () => {
  const full = Array.from({ length: 40 }, (_, i) => msg('CONTACTO', `m${i}`, i * 10));
  const history = { [BEA]: [...full.slice(0, 20), { kind: 'handoff', ...ho('h', 195) }, ...full.slice(20)] };
  const data = store({ transcripts: { [BEA]: full.slice(-30) }, handoffs: { [BEA]: [ho('h', 195)] } });
  const c = byJid(chatList({ store: data, contacts, history }), BEA);
  assert.equal(c.messageCount, 40);
  assert.equal(c.lastMessage.text, 'm39');
  const d = chatDetail({ store: data, contacts, history }, BEA);
  assert.equal(d.timeline.length, 41);
  assert.equal(d.timeline[0].text, 'm0');
  assert.deepEqual(d.timeline.slice(19, 22).map((e) => [e.kind, e.text ?? e.summary]), [['message', 'm19'], ['handoff', 'h'], ['message', 'm20']]);
});

test('chat detail falls back to the stored transcript and handoffs without a history file; unknown chat is null', () => {
  const data = store({ transcripts: { [DALIA]: [msg('CONTACTO', 'buenas', 1)] }, handoffs: { [DALIA]: [ho('x', 2)] } });
  const d = chatDetail({ store: data, contacts, history: {} }, DALIA);
  assert.equal(d.chat.name, 'Dalia');
  assert.deepEqual(d.timeline.map((e) => e.kind), ['message', 'handoff']);
  assert.equal(chatDetail({ store: data, contacts, history: {} }, 'nadie'), null);
});

test('history-only chat (no store entry) is listed', () => {
  const v = chatList({ store: store(), contacts, history: { [DALIA]: [msg('CONTACTO', 'a', 1)] } });
  assert.equal(byJid(v, DALIA).messageCount, 1);
});

test('parseHistory skips malformed lines', () => {
  const text = ['{"author":"CONTACTO","text":"a","at":1}', '{"author":"OWN', '', '42', 'null', '{"kind":"handoff","type":"bug","at":2}'].join('\n');
  assert.deepEqual(parseHistory(text), [{ author: 'CONTACTO', text: 'a', at: 1 }, { kind: 'handoff', type: 'bug', at: 2 }]);
});

test('tolerates an empty / old store file', () => {
  assert.deepEqual(chatList({ store: {}, contacts: [], history: {} }).chats, []);
});

// --- agent runs (rows as read from state/agent-runs.db) ---

test('costTotals groups by the local (UTC-6 zone) day and month, overall and per contact', () => {
  const now = Date.parse('2026-10-13T05:00:00Z'); // Oct 12, 23:00 local
  const rows = [
    { contact_name: 'Dalia', started_at: Date.parse('2026-10-13T04:00:00Z'), cost_usd: 0.25 }, // Oct 12 22:00 local: today
    { contact_name: 'Bea', started_at: Date.parse('2026-10-12T07:00:00Z'), cost_usd: 1.5 }, // Oct 12 01:00: today
    { contact_name: 'Bea', started_at: Date.parse('2026-10-12T05:00:00Z'), cost_usd: 2 }, // Oct 11 23:00: month only
    { contact_name: null, started_at: Date.parse('2026-10-02T12:00:00Z'), cost_usd: null }, // running, no cost yet: month
    { contact_name: 'Dalia', started_at: Date.parse('2026-10-01T05:30:00Z'), cost_usd: 9 }, // Sep 30 23:30 local: neither
  ];
  assert.deepEqual(costTotals(rows, now, 'America/Mexico_City'), {
    today: { costUsd: 1.75, runs: 2, byContact: [{ name: 'Bea', costUsd: 1.5, runs: 1 }, { name: 'Dalia', costUsd: 0.25, runs: 1 }] },
    month: { costUsd: 3.75, runs: 4, byContact: [{ name: 'Bea', costUsd: 3.5, runs: 2 }, { name: 'Dalia', costUsd: 0.25, runs: 1 }, { name: 'desconocido', costUsd: 0, runs: 1 }] },
  });
  assert.deepEqual(costTotals([], now, 'America/Mexico_City'), { today: { costUsd: 0, runs: 0, byContact: [] }, month: { costUsd: 0, runs: 0, byContact: [] } });
});

const RUN = {
  id: 7, kind: 'reply', mode: 'real', contact_name: 'Bea', jid: BEA, started_at: 100, ended_at: 9000, duration_ms: 7796, cost_usd: 0.05,
  input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4, model: 'm', skill_commit: 'abc', status: 'ok', outcome: 'shadow',
  result_text: 'REPLY:\nhola', decision_json: JSON.stringify({ bubbles: ['hola', 'dos'], handoff: { type: 'bug', blocking: true, fields: { summary: 's' } } }), error: null,
};

test('runRow: list summary with tool count, handoff type/blocking and the first bubble', () => {
  assert.deepEqual(runRow({ ...RUN, tool_count: 3 }), {
    id: 7, kind: 'reply', mode: 'real', startedAt: 100, durationMs: 7796, costUsd: 0.05, outcome: 'shadow', status: 'ok', toolCount: 3,
    handoff: { type: 'bug', blocking: true }, preview: 'hola', bubbles: ['hola', 'dos'],
  });
  // Redacted, missing or non-reply decisions never break the list.
  for (const decision_json of ['[redactado: patrón de secreto]', null, JSON.stringify({ result: 'deployed', bubbles: [] })]) {
    const r = runRow({ ...RUN, decision_json, tool_count: 0 });
    assert.equal(r.handoff, null);
    assert.equal(r.preview, null);
    assert.deepEqual(r.bubbles, []);
  }
});

test('runDetail: run fields, parsed decision and ordered events with parsed input', () => {
  const d = runDetail(RUN, [
    { run_id: 7, seq: 1, at: 1, kind: 'thinking', name: null, input_json: null, status: null, size: null, text: 'pienso' },
    { run_id: 7, seq: 2, at: 2, kind: 'tool_use', name: 'Read', input_json: '{"file_path":"/a"}', status: 'ok', size: 5, text: null },
    { run_id: 7, seq: 3, at: 3, kind: 'tool_use', name: 'Grep', input_json: '[redactado: patrón de secreto]', status: 'error', size: 1, text: null },
  ]);
  assert.deepEqual(d, {
    id: 7, kind: 'reply', mode: 'real', contactName: 'Bea', jid: BEA, startedAt: 100, endedAt: 9000, durationMs: 7796, costUsd: 0.05,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }, model: 'm', skillCommit: 'abc', status: 'ok', outcome: 'shadow',
    resultText: 'REPLY:\nhola', decision: JSON.parse(RUN.decision_json), error: null, requestId: null,
    events: [
      { seq: 1, at: 1, kind: 'thinking', name: null, input: null, status: null, size: null, text: 'pienso', toolUseId: null, parentToolUseId: null },
      { seq: 2, at: 2, kind: 'tool_use', name: 'Read', input: { file_path: '/a' }, status: 'ok', size: 5, text: null, toolUseId: null, parentToolUseId: null },
      { seq: 3, at: 3, kind: 'tool_use', name: 'Grep', input: '[redactado: patrón de secreto]', status: 'error', size: 1, text: null, toolUseId: null, parentToolUseId: null },
    ],
  });
});

test('group chats list and open like any chat; messages keep their author name', () => {
  const G = 'g1@g.us';
  const group = { jid: G, name: 'Grupo Demo', type: 'group', register: 'tu', tenant: 'demo2', respondTo: [{ name: 'Contacto C', jids: ['g@lid'] }] };
  const data = store({ transcripts: { [G]: [msg('Elio', 'link', 1), { ...msg('Contacto C', 'no carga', 2), respondTo: true }, msg('OWNER', 'va', 3)] } });
  const view = { store: data, contacts: [...contacts, group], history: {} };
  assert.equal(byJid(chatList(view), G).name, 'Grupo Demo');
  assert.deepEqual(chatDetail(view, G).timeline.map((e) => e.author), ['Elio', 'Contacto C', 'OWNER']);
});

// --- Fábrica: stations of the Peticiones pipeline and the implement step's subagents ---

test('stationOf: every request status lands on one station; a hold is your sign-off; a failure remembers where it failed', () => {
  const at = (status, extra = {}) => stationOf({ status, hold: null, ...extra }).station;
  assert.deepEqual(['nueva', 'info_pedida'].map((s) => at(s)), ['intake', 'intake']);
  assert.deepEqual(['aprobada', 'planificando'].map((s) => at(s)), ['planning', 'planning']);
  assert.equal(at('implementando'), 'engineering');
  assert.equal(at('en_revision'), 'review');
  assert.equal(at('en_revision', { hold: 'deps' }), 'signoff');
  assert.deepEqual(['en_preprod', 'listo_para_entregar'].map((s) => at(s)), ['signoff', 'signoff']);
  assert.equal(at('fallida'), 'blocked');
  assert.equal(at('rechazada'), 'closed');
  assert.equal(at('algo_nuevo'), 'closed');
  const ev = (...to) => to.map((toStatus, i) => ({ seq: i + 1, kind: 'status', toStatus }));
  assert.deepEqual(stationOf({ status: 'fallida' }, ev('nueva', 'aprobada', 'planificando', 'implementando', 'fallida')), { station: 'blocked', failedAt: 'engineering' });
  // cancelled from the queue, retried, then failed while planning
  assert.equal(stationOf({ status: 'fallida' }, ev('nueva', 'aprobada', 'fallida', 'aprobada', 'planificando', 'fallida')).failedAt, 'planning');
  assert.equal(stationOf({ status: 'fallida' }, [{ kind: 'note', toStatus: null }]).failedAt, null);
  assert.equal(stationOf({ status: 'implementando' }).failedAt, null);
});

test('subagents: one entry per Agent/Task call with its own tool stream, mapped to the plan block its prompt names', () => {
  const blocks = [
    { key: 'api', branch: 'pet/9-api', worktree: '/w/acme-api-worktrees/pet-9-api' },
    { key: 'api-v2', branch: 'pet/9-api-v2', worktree: '/w/acme-api-worktrees/pet-9-api-v2' },
    { key: 'ui', branch: 'pet/9-ui', worktree: '/w/acme-web-worktrees/pet-9-ui' },
  ];
  const e = (seq, kind, extra = {}) => ({ seq, at: seq * 10, kind, name: null, input: null, status: null, toolUseId: null, parentToolUseId: null, ...extra });
  const events = [
    e(1, 'text', { text: 'delego' }),
    e(2, 'tool_use', { name: 'Agent', toolUseId: 'a1', status: 'ok', input: { subagent_type: 'implementer', description: 'bloque', prompt: '## Project\nacme-api @ /w/acme-api-worktrees/pet-9-api-v2 (branch pet/9-api-v2, base main)' } }),
    e(3, 'tool_use', { name: 'Task', toolUseId: 'a2', status: 'missing', input: { subagent_type: 'implementer', prompt: 'Spec: /r/9/specs/ui.md' } }),
    e(4, 'tool_use', { name: 'Read', toolUseId: 'c1', parentToolUseId: 'a1', status: 'ok' }),
    e(5, 'thinking', { parentToolUseId: 'a1', text: 'pienso' }),
    e(6, 'tool_use', { name: 'Bash', toolUseId: 'c2', parentToolUseId: 'a1', status: 'error' }),
    e(7, 'tool_use', { name: 'Edit', toolUseId: 'c3', parentToolUseId: 'a2', status: 'missing' }),
    e(8, 'tool_use', { name: 'Agent', toolUseId: 'a3', status: 'ok', input: '[redactado: patrón de secreto]' }),
  ];
  assert.deepEqual(subagents(events, blocks), [
    { toolUseId: 'a1', seq: 2, at: 20, lastAt: 60, subagentType: 'implementer', description: 'bloque', block: 'api-v2', status: 'ok', toolCount: 2, errors: 1 },
    { toolUseId: 'a2', seq: 3, at: 30, lastAt: 70, subagentType: 'implementer', description: null, block: 'ui', status: 'missing', toolCount: 1, errors: 0 },
    { toolUseId: 'a3', seq: 8, at: 80, lastAt: 80, subagentType: null, description: null, block: null, status: 'ok', toolCount: 0, errors: 0 },
  ]);
  assert.deepEqual(subagents([e(1, 'tool_use', { name: 'Agent', toolUseId: null })]), [], 'no tool_use id (rows from before the column): nothing to group');
});

test('runDetail exposes each event\'s tool_use id and parent call (null on rows from before the columns)', () => {
  const run = { id: 1, kind: 'request-implement', mode: 'real', started_at: 1, decision_json: null };
  const [a, b] = runDetail(run, [
    { seq: 1, at: 1, kind: 'tool_use', name: 'Agent', input_json: '{}', status: 'ok', size: 1, text: null, tool_use_id: 'a1', parent_tool_use_id: null },
    { seq: 2, at: 2, kind: 'text', name: null, input_json: null, status: null, size: null, text: 'x' },
  ]).events;
  assert.deepEqual([a.toolUseId, a.parentToolUseId, b.toolUseId, b.parentToolUseId], ['a1', null, null, null]);
});

test('preprodOf: the preprod step\'s push/pr/note events, each with its github.com URL if any; the driver\'s run notes are left out', () => {
  const events = [
    { seq: 1, at: 1, actor: 'agent:preprod', kind: 'note', text: 'paso preprod, intento 1', runId: 7 },
    { seq: 2, at: 2, actor: 'agent:preprod', kind: 'push', text: 'pet/2-api (abc1234) en o/r', runId: null },
    { seq: 3, at: 3, actor: 'agent:preprod', kind: 'pr', text: 'api: https://github.com/o/r/pull/5', runId: null },
    { seq: 4, at: 4, actor: 'agent:preprod', kind: 'note', text: 'api: deploy-preprod ok: https://github.com/o/r/actions/runs/9', runId: null },
    { seq: 5, at: 5, actor: 'bridge', kind: 'note', text: 'https://github.com/x', runId: null },
    { seq: 6, at: 6, actor: 'agent:preprod', kind: 'pr', text: 'api: javascript:alert(1) https://evil.example/pull/1', runId: null },
  ];
  assert.deepEqual(preprodOf(events), [
    { at: 2, kind: 'push', text: 'pet/2-api (abc1234) en o/r', url: null },
    { at: 3, kind: 'pr', text: 'api: https://github.com/o/r/pull/5', url: 'https://github.com/o/r/pull/5' },
    { at: 4, kind: 'note', text: 'api: deploy-preprod ok: https://github.com/o/r/actions/runs/9', url: 'https://github.com/o/r/actions/runs/9' },
    { at: 6, kind: 'pr', text: 'api: javascript:alert(1) https://evil.example/pull/1', url: null },
  ]);
});

test('linkView: private chats by channel (first listing wins), links with their members, WA<->TG name matches only suggested', () => {
  const CWA = '5218111111111@s.whatsapp.net';
  const v = linkView({
    contacts: [{ jid: CWA, name: 'Carlos' }, { jid: 'carlos@lid', name: 'Carlos' }, { jid: 'tg:1', name: 'Carlos Pérez' }, { jid: 'g@g.us', name: 'Obras', type: 'group' },
      { jid: BEA, name: 'Bea' }, { jid: 'tg:2', name: 'Béa' }],
    memory: [{ jid: 'tg:3', name: 'Dalia', kind: 'private' }, { jid: 'tg:-100', name: 'Grupo TG', kind: 'group' }, { jid: CWA, name: 'dup', kind: 'private' }],
    seen: [{ jid: DALIA, name: 'Dalia', kind: 'private' }, { jid: 'tg:4', name: null, kind: 'private' }],
    links: [{ jids: [BEA, 'tg:2'] }],
  });
  assert.deepEqual(v.chats.map((c) => [c.jid, c.name, c.channel, c.label, c.source]), [
    [CWA, 'Carlos', 'whatsapp', 'WA', 'contacts'], ['carlos@lid', 'Carlos', 'whatsapp', 'WA', 'contacts'], ['tg:1', 'Carlos Pérez', 'telegram', 'TG', 'contacts'],
    [BEA, 'Bea', 'whatsapp', 'WA', 'contacts'], ['tg:2', 'Béa', 'telegram', 'TG', 'contacts'], ['tg:3', 'Dalia', 'telegram', 'TG', 'memory'],
    [DALIA, 'Dalia', 'whatsapp', 'WA', 'seen'], ['tg:4', null, 'telegram', 'TG', 'seen'],
  ]);
  assert.deepEqual(v.links.map((g) => g.members.map((m) => [m.jid, m.name, m.label])), [[[BEA, 'Bea', 'WA'], ['tg:2', 'Béa', 'TG']]]);
  // Bea is already linked; the phone + LID Carlos is one suggestion; unnamed chats never match.
  assert.deepEqual(v.suggestions.map((x) => [x.a.jid, x.b.jid]), [[CWA, 'tg:1'], [DALIA, 'tg:3']]);
});
