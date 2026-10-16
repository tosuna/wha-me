import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRunLog } from './run-log.js';

const contact = { name: 'Bea', jid: 'bea@s.whatsapp.net' };
const leaks = (s) => s.includes('ghp_');

function setup(over = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-runs-')), 'state', 'agent-runs.db');
  let t = 1_000;
  const log = createRunLog({ file, now: () => (t += 10), skillCommit: 'abc1234', leaks, ...over });
  const read = (sql, ...p) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(sql).all(...p); } finally { db.close(); }
  };
  return { log, file, read };
}

const quiet = async (fn) => {
  const orig = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return seen;
};

test('start -> events -> finish stores the run with tokens, cost, model, outcome and ordered events', () => {
  const { log, read } = setup();
  const r = log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
  assert.equal(read('SELECT status FROM runs')[0].status, 'running');
  r.event({ kind: 'thinking', text: 'Pregunta de estado.' });
  r.event({ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/x.md' } });
  r.event({ kind: 'tool_result', id: 't1', status: 'ok', size: 120 });
  r.event({ kind: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/.env' } });
  r.event({ kind: 'text', text: 'REPLY:\nhola' });
  r.event({ kind: 'tool_result', id: 't2', status: 'denied', size: 0 });
  r.event({ kind: 'result', durationMs: 7796, costUsd: 0.0571, isError: false, model: 'claude-opus-5-5',
    usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 400 } });
  r.finish({ result: 'REPLY:\nhola', decision: { bubbles: ['hola'], handoff: null }, outcome: 'sent' });

  const [run] = read('SELECT * FROM runs');
  assert.deepEqual({ ...run }, {
    id: 1, kind: 'reply', mode: 'real', contact_name: 'Bea', jid: contact.jid, started_at: 1010, ended_at: run.ended_at,
    duration_ms: 7796, cost_usd: 0.0571, input_tokens: 10, output_tokens: 200, cache_read_tokens: 3000, cache_creation_tokens: 400,
    model: 'claude-opus-5-5', skill_commit: 'abc1234', request_id: null, status: 'ok', outcome: 'sent', result_text: 'REPLY:\nhola',
    decision_json: JSON.stringify({ bubbles: ['hola'], handoff: null }), error: null,
  });
  assert.ok(run.ended_at > run.started_at);
  const events = read('SELECT seq, kind, name, input_json, status, size, text FROM events WHERE run_id = 1 ORDER BY seq').map((e) => ({ ...e }));
  assert.deepEqual(events, [
    { seq: 1, kind: 'thinking', name: null, input_json: null, status: null, size: null, text: 'Pregunta de estado.' },
    { seq: 2, kind: 'tool_use', name: 'Read', input_json: '{"file_path":"/a/x.md"}', status: 'ok', size: 120, text: null },
    { seq: 3, kind: 'tool_use', name: 'Read', input_json: '{"file_path":"/a/.env"}', status: 'denied', size: 0, text: null },
    { seq: 4, kind: 'text', name: null, input_json: null, status: null, size: null, text: 'REPLY:\nhola' },
  ]);
});

test('without a result event the duration is the wall time', () => {
  const { log, read } = setup();
  log.start({ kind: 'job', mode: 'sim', contact, jid: contact.jid }).finish({ result: 'x', outcome: 'sim' });
  assert.equal(read('SELECT duration_ms FROM runs')[0].duration_ms, 10);
});

test('a tool result content is never stored', () => {
  const { log, read } = setup();
  const r = log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
  r.event({ kind: 'tool_use', id: 't1', name: 'mcp__acme-db__find_rows', input: { table: 'usuarios' } });
  r.event({ kind: 'tool_result', id: 't1', status: 'ok', size: 9, content: 'FILA_PRIVADA curp=XXXX' });
  r.finish({ result: 'REPLY:\nok', outcome: 'sent' });
  assert.doesNotMatch(JSON.stringify(read('SELECT * FROM events')) + JSON.stringify(read('SELECT * FROM runs')), /FILA_PRIVADA/);
});

test('leaks() redaction applies to thinking, text, tool input, result, decision and error', () => {
  const { log, read } = setup();
  const r = log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
  r.event({ kind: 'thinking', text: 'el token es ghp_abc' });
  r.event({ kind: 'text', text: 'ghp_abc' });
  r.event({ kind: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'ghp_' } });
  r.finish({ result: 'REPLY:\nghp_abc', decision: { bubbles: ['ghp_abc'] }, outcome: 'blocked' });
  const r2 = log.start({ kind: 'job', mode: 'real', contact, jid: contact.jid });
  r2.fail(new Error('boom ghp_abc'));
  const all = JSON.stringify([read('SELECT * FROM events'), read('SELECT * FROM runs')]);
  assert.doesNotMatch(all, /ghp_/);
  assert.equal(all.split('[redactado: patrón de secreto]').length - 1, 6);
});

test('fail sets status error with the message', () => {
  const { log, read } = setup();
  log.start({ kind: 'job', mode: 'real', contact: null, jid: 'x@s' }).fail(new Error('claude timed out'));
  const [run] = read('SELECT status, error, outcome, contact_name, ended_at FROM runs');
  assert.deepEqual({ ...run, ended_at: !!run.ended_at }, { status: 'error', error: 'claude timed out', outcome: null, contact_name: null, ended_at: true });
});

test('a DB error never throws to the caller', async () => {
  const seen = await quiet(() => {
    // Unopenable file: the parent "directory" is a regular file.
    const parent = join(mkdtempSync(join(tmpdir(), 'wa-runs-')), 'file');
    writeFileSync(parent, '');
    const broken = createRunLog({ file: join(parent, 'x.db'), leaks });
    const h = broken.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
    h.event({ kind: 'text', text: 'x' });
    h.finish({ result: 'x', outcome: 'sent' });
    h.fail(new Error('x'));
    // Closed mid-run.
    const { log } = setup();
    const r = log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
    log.close();
    r.event({ kind: 'text', text: 'x' });
    r.event({ kind: 'result', durationMs: 1, costUsd: 0, isError: false, usage: null, model: null });
    r.finish({ result: 'x', outcome: 'sent' });
    r.fail(new Error('x'));
    log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid }).finish({});
  });
  assert.ok(seen.length >= 2, 'errors are logged');
});

test('request steps: start({ kind: request-<step>, requestId }) stores request_id; an older runs table gets the column', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-runs-')), 'agent-runs.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, contact_name TEXT, jid TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, model TEXT, skill_commit TEXT, status TEXT NOT NULL, outcome TEXT, result_text TEXT, decision_json TEXT, error TEXT)");
  old.exec("INSERT INTO runs (kind, mode, started_at, status) VALUES ('reply', 'real', 1, 'ok')");
  old.close();
  const log = createRunLog({ file, leaks });
  const run = log.start({ kind: 'request-plan', mode: 'real', contact, jid: contact.jid, requestId: 7 });
  log.start({ kind: 'reply', mode: 'real', contact, jid: contact.jid });
  log.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT id, kind, request_id FROM runs ORDER BY id').all().map((r) => ({ ...r }));
  db.close();
  assert.deepEqual(rows, [{ id: 1, kind: 'reply', request_id: null }, { id: run.id, kind: 'request-plan', request_id: 7 }, { id: 3, kind: 'reply', request_id: null }]);
});

test('tool_use events keep their tool_use id and every event its parent Agent call (subagent grouping)', () => {
  const { log, read } = setup();
  const r = log.start({ kind: 'request-implement', mode: 'real', contact, jid: contact.jid, requestId: 7 });
  r.event({ kind: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: 'spec' } });
  r.event({ kind: 'thinking', text: 'leo', parent: 'a1' });
  r.event({ kind: 'tool_use', id: 'c1', name: 'Read', input: {}, parent: 'a1' });
  r.event({ kind: 'tool_result', id: 'c1', status: 'ok', size: 3, parent: 'a1' });
  r.event({ kind: 'tool_result', id: 'a1', status: 'ok', size: 9 });
  r.event({ kind: 'text', text: 'RESULT: ok' });
  r.finish({ result: 'RESULT: ok', outcome: 'ok' });
  assert.deepEqual(read('SELECT seq, kind, name, status, tool_use_id, parent_tool_use_id FROM events ORDER BY seq').map((e) => ({ ...e })), [
    { seq: 1, kind: 'tool_use', name: 'Agent', status: 'ok', tool_use_id: 'a1', parent_tool_use_id: null },
    { seq: 2, kind: 'thinking', name: null, status: null, tool_use_id: null, parent_tool_use_id: 'a1' },
    { seq: 3, kind: 'tool_use', name: 'Read', status: 'ok', tool_use_id: 'c1', parent_tool_use_id: 'a1' },
    { seq: 4, kind: 'text', name: null, status: null, tool_use_id: null, parent_tool_use_id: null },
  ]);
});

test('an events table from before the subagent columns is migrated in place (additive)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-runs-old-')), 'agent-runs.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE events (run_id INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
    name TEXT, input_json TEXT, status TEXT, size INTEGER, text TEXT, PRIMARY KEY (run_id, seq))`);
  db.prepare("INSERT INTO events (run_id, seq, at, kind, text) VALUES (1, 1, 1, 'text', 'viejo')").run();
  db.close();
  const log = createRunLog({ file, leaks });
  log.close();
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const cols = check.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    for (const c of ['tool_use_id', 'parent_tool_use_id']) assert.ok(cols.includes(c), c);
    assert.equal(check.prepare('SELECT text FROM events').get().text, 'viejo');
  } finally {
    check.close();
  }
});
