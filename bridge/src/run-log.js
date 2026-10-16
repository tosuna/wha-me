import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSecretGuard } from './secrets.js';

// Durable history of every agent run (reply/job, real/sim) for the portal. Tool RESULTS are never stored (they can
// carry DB rows): only their status and size. Every stored text passes the secret guard first.
export const RUNS_DB = 'agent-runs.db';
export const REDACTED = '[redactado: patrón de secreto]';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, contact_name TEXT, jid TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER, cost_usd REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  model TEXT, skill_commit TEXT, status TEXT NOT NULL, outcome TEXT, result_text TEXT, decision_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS runs_jid_started ON runs (jid, started_at);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
CREATE TABLE IF NOT EXISTS events (
  run_id INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, input_json TEXT, status TEXT, size INTEGER, text TEXT, PRIMARY KEY (run_id, seq)
);`;
// Additive: the Peticiones request a pipeline step run belongs to (see pipeline.js); a tool call's id and, for a subagent's
// events, the id of the Agent call that spawned it (the portal groups an implement run's tool calls per block).
const migrate = (db) => {
  if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'request_id')) db.exec('ALTER TABLE runs ADD COLUMN request_id INTEGER');
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  for (const c of ['tool_use_id', 'parent_tool_use_id']) if (!cols.includes(c)) db.exec(`ALTER TABLE events ADD COLUMN ${c} TEXT`);
};

const NOOP_RUN = { id: null, event() {}, finish() {}, fail() {} };
export const noRunLog = { start: () => NOOP_RUN, close() {} };

// start({ kind: reply|job|request-<step>, mode: real|sim, contact, jid, requestId }) -> { id, event(e), finish({ result, decision, outcome }), fail(error) }.
// event takes the agent's normalized live events (see agent.js). Never throws: a DB error is logged and the run goes on.
export function createRunLog({
  file = fileURLToPath(new URL(`../state/${RUNS_DB}`, import.meta.url)), now = Date.now, skillCommit = null, leaks = createSecretGuard(),
} = {}) {
  let db;
  let q;
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    migrate(db);
    q = {
      start: db.prepare("INSERT INTO runs (kind, mode, contact_name, jid, started_at, skill_commit, status, request_id) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)"),
      event: db.prepare(`INSERT INTO events (run_id, seq, at, kind, name, input_json, status, size, text, tool_use_id, parent_tool_use_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      toolResult: db.prepare('UPDATE events SET status = ?, size = ? WHERE run_id = ? AND seq = ?'),
      usage: db.prepare(`UPDATE runs SET duration_ms = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_creation_tokens = ?, model = ? WHERE id = ?`),
      end: db.prepare(`UPDATE runs SET ended_at = ?, duration_ms = COALESCE(duration_ms, ? - started_at), status = ?, outcome = ?,
        result_text = ?, decision_json = ?, error = ? WHERE id = ?`),
    };
  } catch (e) {
    console.error(`run log disabled (${file}): ${e.message}`);
    return noRunLog;
  }
  const safe = (s) => (s == null ? null : leaks(String(s)) ? REDACTED : String(s));
  const guard = (what, fn) => (...a) => {
    try { fn(...a); } catch (e) { console.error(`run log ${what} failed:`, e.message); }
  };

  function start({ kind, mode, contact, jid, requestId = null }) {
    let id;
    try {
      id = q.start.run(kind, mode, contact?.name ?? null, jid ?? null, now(), skillCommit, requestId).lastInsertRowid;
    } catch (e) {
      console.error('run log start failed:', e.message);
      return NOOP_RUN;
    }
    let seq = 0;
    const tools = new Map(); // tool_use id -> its event seq; a tool_result updates that row
    const end = (status, outcome, result, decision, error) => {
      const t = now();
      q.end.run(t, t, status, outcome ?? null, safe(result), decision == null ? null : safe(JSON.stringify(decision)), safe(error), id);
    };
    return {
      id: Number(id),
      event: guard('event', (e) => {
        const parent = e.parent ?? null;
        if (e.kind === 'thinking' || e.kind === 'text') q.event.run(id, ++seq, now(), e.kind, null, null, null, null, safe(e.text), null, parent);
        else if (e.kind === 'approval') q.event.run(id, ++seq, now(), 'approval', null, null, e.status ?? null, null, safe(e.text), null, null); // bridge-side APPROVE outcome
        else if (e.kind === 'tool_use') {
          tools.set(e.id, ++seq);
          q.event.run(id, seq, now(), 'tool_use', e.name ?? null, safe(JSON.stringify(e.input ?? null)), 'missing', 0, null, e.id ?? null, parent);
        } else if (e.kind === 'tool_result' && tools.has(e.id)) q.toolResult.run(e.status ?? null, e.size ?? 0, id, tools.get(e.id));
        else if (e.kind === 'result') {
          const u = e.usage ?? {};
          q.usage.run(e.durationMs ?? null, e.costUsd ?? null, u.inputTokens ?? null, u.outputTokens ?? null, u.cacheReadTokens ?? null,
            u.cacheCreationTokens ?? null, e.model ?? null, id);
        }
      }),
      finish: guard('finish', ({ result, decision, outcome } = {}) => end('ok', outcome, result, decision, null)),
      fail: guard('fail', (error) => end('error', null, null, null, error?.message ?? error)),
    };
  }

  return { start, close: guard('close', () => db.close()) };
}
