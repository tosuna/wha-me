import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillDir } from './agent.js';
import example from '../../config/example.config.js';

const ROOT = '/home/alex/work';
const SKILL_DIR = skillDir(example.profile);
import { createConsoleTrace } from './console-trace.js';

const contact = { jid: 'bea@s.whatsapp.net', name: 'Bea', register: 'tu', tenant: 'demo', canTriggerImplementation: true };

function setup(turn = {}) {
  const lines = [];
  const trace = createConsoleTrace({ log: (s) => lines.push(...String(s).split('\n')), now: () => Date.parse('2026-10-13T15:00:00Z'), root: ROOT, skill: SKILL_DIR });
  const t = trace.turn({ mode: 'sim', contact, jid: contact.jid, inbound: ['oye', 'no carga el boton'], ...turn });
  return { t, lines, last: () => lines.at(-1) };
}

test('turn header: timestamp, mode, contact name, register, tenant and jid; then the inbound text', () => {
  const { lines } = setup({ mode: 'real', jid: 'bea@lid' });
  assert.match(lines[0], /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
  for (const s of ['real', 'Bea', 'tu', 'demo', 'bea@lid']) assert.ok(lines[0].includes(s), s);
  assert.deepEqual(lines.slice(1), ['[real Bea] entrada: oye', '[real Bea] entrada: no carga el boton']);
});

test('memory: each recalled topic as one JSON line, "(sin memoria)", or the error message', () => {
  const { t, lines } = setup();
  const n = lines.length;
  t.memory([{ id: 1, title: 'boton' }, { id: 2, title: 'deploy' }]);
  t.memory([]);
  t.memory(new Error('topics: db locked'));
  assert.deepEqual(lines.slice(n), [
    '[sim Bea] memoria: {"id":1,"title":"boton"}',
    '[sim Bea] memoria: {"id":2,"title":"deploy"}',
    '[sim Bea] memoria: (sin memoria)',
    '[sim Bea] memoria: error: topics: db locked',
  ]);
});

test('health: ok count and the failing checks', () => {
  const { t, last } = setup();
  t.health([{ url: 'https://a', status: 200 }, { url: 'https://b', status: 502 }, { url: 'https://c', error: 'timeout' }, { url: 'https://d', status: 200, jsonOk: false }]);
  assert.equal(last(), '[sim Bea] health: 1/4 ok; falla: https://b (502), https://c (timeout), https://d (200, sin JSON)');
});

test('thinking summary is printed in full, every line prefixed; text too', () => {
  const { t, lines } = setup();
  const n = lines.length;
  const long = 'x'.repeat(2000);
  t.event({ kind: 'thinking', text: `Pregunta de estado.\n${long}` });
  t.event({ kind: 'text', text: 'REPLY:\nhola' });
  assert.deepEqual(lines.slice(n), ['[sim Bea] piensa: Pregunta de estado.', `[sim Bea] piensa: ${long}`, '[sim Bea] texto: REPLY:', '[sim Bea] texto: hola']);
});

test('tool line on its result: name, relative clipped arg and outcome (ok + size / DENEGADO / error)', () => {
  const { t, lines } = setup();
  const n = lines.length;
  t.event({ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${SKILL_DIR}references/flows/system-status.md` } });
  t.event({ kind: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${ROOT}/acme-api/.env` } });
  t.event({ kind: 'tool_use', id: 't3', name: 'Glob', input: { pattern: 'x'.repeat(300) } });
  assert.equal(lines.length, n, 'nothing printed before the result');
  t.event({ kind: 'tool_result', id: 't1', status: 'ok', size: 2100 });
  t.event({ kind: 'tool_result', id: 't2', status: 'denied', size: 0 });
  t.event({ kind: 'tool_result', id: 't3', status: 'error', size: 4 });
  t.event({ kind: 'tool_result', id: 'unknown', status: 'ok', size: 1 });
  const out = lines.slice(n);
  assert.deepEqual(out.slice(0, 2), ['[sim Bea] tool: Read references/flows/system-status.md (ok, 2.1k)', '[sim Bea] tool: Read acme-api/.env (DENEGADO)']);
  assert.match(out[2], /^\[sim Bea\] tool: Glob "x+… \(error\)$/);
  assert.ok(out[2].length < 160);
  assert.equal(out.length, 3, 'a result without its tool_use is ignored');
});

test('decision: bubbles, HANDOFF, IMPLEMENT, duration and cost from the result event', () => {
  const { t, lines } = setup();
  t.event({ kind: 'result', durationMs: 7800, costUsd: 0.0571, isError: false });
  const n = lines.length;
  t.decision({ bubbles: ['hola', 'ya lo reviso'], handoff: { type: 'bug', blocking: true, fields: { summary: 'no carga el boton' } }, implement: { summary: 'fix boton', spec: 's' } });
  assert.deepEqual(lines.slice(n), [
    '[sim Bea] REPLY: hola',
    '[sim Bea] REPLY: ya lo reviso',
    '[sim Bea] HANDOFF: bug (blocking: true) no carga el boton',
    '[sim Bea] IMPLEMENT: fix boton',
    '[sim Bea] fin: 7.8s, $0.06',
  ]);
});

test('decision with no bubbles/handoff/implement, and an error; unknown duration and cost', () => {
  const { t, lines } = setup();
  const n = lines.length;
  t.decision({ bubbles: [], handoff: null, implement: null });
  t.decision({ error: new Error('Malformed output: no REPLY') });
  assert.deepEqual(lines.slice(n), [
    '[sim Bea] REPLY: (sin respuesta)',
    '[sim Bea] HANDOFF: none',
    '[sim Bea] IMPLEMENT: none',
    '[sim Bea] fin: ?s, $?',
    '[sim Bea] error: Malformed output: no REPLY',
    '[sim Bea] fin: ?s, $?',
  ]);
});
