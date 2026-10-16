import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { jaccard } from './feedback.js';
import { REDACTED, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';

// Peticiones (feature requests) raised by `feature-request` handoffs. Same database as the
// run log. Every stored text passes the secret guard first; request_events is append-only.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, jid TEXT NOT NULL, contact_name TEXT, tenant TEXT, status TEXT NOT NULL,
  summary TEXT NOT NULL, evidence TEXT NOT NULL, handoff_count INTEGER NOT NULL DEFAULT 1, shadow INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT, blocks_json TEXT, step TEXT, step_session TEXT, step_attempt INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, budget_usd REAL NOT NULL DEFAULT 30,
  question TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, approved_at INTEGER, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_jid_status ON requests (jid, status);
CREATE TABLE IF NOT EXISTS request_events (
  request_id INTEGER NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT, run_id INTEGER, PRIMARY KEY (request_id, seq)
);
CREATE TABLE IF NOT EXISTS preprod_migrations (
  request_id INTEGER NOT NULL, project TEXT NOT NULL, file TEXT NOT NULL, author TEXT NOT NULL, "database" TEXT NOT NULL,
  sha256 TEXT NOT NULL, kind TEXT NOT NULL, dump_path TEXT, server_id TEXT, hostname TEXT, applied_at INTEGER NOT NULL,
  result TEXT NOT NULL, error TEXT, extra_databases TEXT
);`;
// Additive: the target status of a `status` event, and the owner's cf-connecting-ip; the review step's hold reason (waiting
// for the owner's preprod OK) and whether the one fix round was used; the preprod step's cross-request clash check (clash.js);
// the request a `fusionada` one was merged into.
const migrate = (db) => {
  const cols = db.prepare('PRAGMA table_info(request_events)').all().map((c) => c.name);
  for (const c of ['to_status', 'ip']) if (!cols.includes(c)) db.exec(`ALTER TABLE request_events ADD COLUMN ${c} TEXT`);
  const rcols = db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name);
  if (!rcols.includes('hold')) db.exec('ALTER TABLE requests ADD COLUMN hold TEXT');
  if (!rcols.includes('fix_round')) db.exec('ALTER TABLE requests ADD COLUMN fix_round INTEGER NOT NULL DEFAULT 0');
  if (!rcols.includes('clash_json')) db.exec('ALTER TABLE requests ADD COLUMN clash_json TEXT');
  if (!rcols.includes('merged_into')) db.exec('ALTER TABLE requests ADD COLUMN merged_into INTEGER');
};

const RUNNING = ['planificando', 'implementando', 'en_revision', 'en_preprod']; // a pipeline step owns the request
const ACTIVE = ['aprobada', ...RUNNING];
export const TRANSITIONS = {
  nueva: ['aprobada', 'rechazada', 'info_pedida', 'fusionada'],
  info_pedida: ['nueva', 'fusionada'],
  aprobada: ['planificando', 'fallida'],
  planificando: ['implementando', 'info_pedida', 'fallida'],
  implementando: ['en_revision', 'fallida'],
  en_revision: ['en_preprod', 'implementando', 'fallida'], // implementando: the one fix round (enforced by the runtime)
  en_preprod: ['listo_para_entregar', 'fallida'],
  fallida: ['aprobada', 'fusionada'],
  listo_para_entregar: [],
  rechazada: [],
  fusionada: [], // merged into another request by the owner (merge below)
};
export const FILTERS = {
  activas: ACTIVE,
  por_revisar: ['nueva', 'info_pedida', 'fallida'],
  listas: ['listo_para_entregar'],
  cerradas: ['rechazada', 'fusionada'],
};
// The owner's portal actions: the states each one starts from, and where it goes. cancel = fallida (retry brings it back).
// held(hold): only while the request waits on such a hold (sensitive diff, review step; clash, preprod step). to null: no
// transition (clash-ok clears the hold and acknowledges the overlap set, clash.js).
export const CLASH_HOLD = 'choque con ';
export const ACTIONS = {
  approve: { from: ['nueva'], to: 'aprobada' },
  reject: { from: ['nueva'], to: 'rechazada' },
  ask: { from: ['nueva'], to: 'info_pedida' },
  cancel: { from: ACTIVE, to: 'fallida' },
  retry: { from: ['fallida'], to: 'aprobada' },
  'preprod-ok': { from: ['en_revision'], to: 'en_preprod', held: (h) => !!h },
  'clash-ok': { from: ['en_preprod'], to: null, held: (h) => !!h?.startsWith(CLASH_HOLD) },
  merge: { from: ['nueva', 'info_pedida', 'fallida'], to: 'fusionada' }, // needs a target, see merge()
};
export const actionsFor = (status, hold = null) => Object.keys(ACTIONS).filter((a) => ACTIONS[a].from.includes(status) && (!ACTIONS[a].held || ACTIONS[a].held(hold)));

const DEDUPE = 0.5; // summary token Jaccard
const fail = (code, message) => Object.assign(new Error(message), { code });
const parse = (s) => {
  try { return JSON.parse(s); } catch { return []; }
};

// queuePosition: 1 = next for the pipeline (aprobada only, by approval time), else null.
const requestRow = (r, queuePosition = null) => ({
  id: r.id, jid: r.jid, contactName: r.contact_name, tenant: r.tenant, status: r.status, summary: r.summary,
  handoffCount: r.handoff_count, shadow: !!r.shadow, step: r.step, stepSession: r.step_session, stepAttempt: r.step_attempt,
  queuePosition, costUsd: r.cost_usd, budgetUsd: r.budget_usd,
  question: r.question, error: r.error, hold: r.hold, fixRound: !!r.fix_round, mergedInto: r.merged_into ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, approvedAt: r.approved_at, doneAt: r.done_at,
  actions: actionsFor(r.status, r.hold),
});
const eventRow = (e) => ({ seq: e.seq, at: e.at, actor: e.actor, kind: e.kind, toStatus: e.to_status, text: e.text, ip: e.ip, runId: e.run_id });

// profile: the owner; tag.toLowerCase() is the actor of the owner's portal actions in request_events.
export function createRequests({
  profile, file = fileURLToPath(new URL(`../state/${RUNS_DB}`, import.meta.url)), now = Date.now, leaks = createSecretGuard(),
}) {
  const owner = profile.tag.toLowerCase();
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  const safe = (s) => (s == null ? null : leaks(String(s)) ? REDACTED : String(s));
  const raw = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  const QUEUE = "SELECT * FROM requests WHERE status = 'aprobada' ORDER BY approved_at, id";
  const position = (r) => (r.status === 'aprobada' ? db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'aprobada'
    AND (approved_at < ? OR (approved_at = ? AND id <= ?))`).get(r.approved_at, r.approved_at, r.id).n : null);
  const row = (r) => requestRow(r, position(r));

  function event(id, { actor, kind = 'note', text = null, toStatus = null, ip = null, runId = null }) {
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM request_events WHERE request_id = ?').get(id).n;
    db.prepare('INSERT INTO request_events (request_id, seq, at, actor, kind, text, run_id, to_status, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, seq, now(), actor, kind, safe(text), runId, toStatus, ip);
  }

  // Throws ILLEGAL_TRANSITION (anything outside TRANSITIONS) or NOT_FOUND; one `status` event per transition. Clears a hold.
  function transition(id, to, { actor, text = null, ip = null, runId = null, question } = {}) {
    const r = raw(id);
    if (!r) throw fail('NOT_FOUND', `petición ${id} no encontrada`);
    if (!TRANSITIONS[r.status]?.includes(to)) throw fail('ILLEGAL_TRANSITION', `no se puede pasar de ${r.status} a ${to}`);
    const t = now();
    db.prepare(`UPDATE requests SET status = ?, updated_at = ?, approved_at = CASE WHEN ? = 'aprobada' THEN ? ELSE approved_at END,
      fix_round = CASE WHEN ? = 'aprobada' THEN 0 ELSE fix_round END,
      done_at = CASE WHEN ? IN ('rechazada', 'listo_para_entregar', 'fusionada') THEN ? ELSE done_at END, question = COALESCE(?, question), hold = NULL WHERE id = ?`)
      .run(to, t, to, t, to, to, t, question === undefined ? null : safe(question), id);
    event(id, { actor, kind: 'status', toStatus: to, text, ip, runId });
    return row(raw(id));
  }

  function brief(handoff) {
    const { type, blocking, summary, evidence, next, ...rest } = handoff.fields ?? {};
    return {
      at: now(), summary: safe(summary ?? ''), evidence: safe(evidence), next: safe(next),
      fields: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, safe(v)])),
    };
  }

  const openOf = (jid, shadow) => db.prepare(`SELECT * FROM requests WHERE jid = ? AND shadow = ? AND status IN ('nueva', 'info_pedida')
    ORDER BY updated_at DESC, id DESC`).all(jid, shadow ? 1 : 0);

  // A feature-request handoff -> new request, or merged into an open one of the same chat: the one its `same_as` names
  // (untrusted agent output: digits only, and only an open request of this chat), else one with a similar summary.
  // Never throws into the bridge: null on a DB error.
  function fromHandoff(jid, contact, handoff, { shadow = false } = {}) {
    try {
      const summary = safe(handoff.fields?.summary || 'sin resumen');
      const b = brief(handoff);
      const open = openOf(jid, shadow);
      const sameAs = /^[1-9]\d{0,9}$/.test(handoff.fields?.same_as ?? '') ? Number(handoff.fields.same_as) : null;
      const same = open.find((r) => r.id === sameAs) ?? open.find((r) => jaccard(r.summary, summary) >= DEDUPE);
      if (same) {
        db.prepare('UPDATE requests SET evidence = ?, handoff_count = handoff_count + 1, updated_at = ? WHERE id = ?')
          .run(JSON.stringify([...parse(same.evidence), b]), now(), same.id);
        event(same.id, { actor: 'contact', kind: 'note', text: 'agregó contexto en un aviso nuevo' });
        if (same.status === 'info_pedida') transition(same.id, 'nueva', { actor: 'contact' });
        const r = raw(same.id);
        return { id: r.id, status: r.status, summary: r.summary, merged: true, handoffCount: r.handoff_count };
      }
      const t = now();
      const id = Number(db.prepare(`INSERT INTO requests (jid, contact_name, tenant, status, summary, evidence, shadow, created_at, updated_at)
        VALUES (?, ?, ?, 'nueva', ?, ?, ?, ?, ?)`).run(jid, contact?.name ?? null, contact?.tenant ?? null, summary, JSON.stringify([b]), shadow ? 1 : 0, t, t).lastInsertRowid);
      event(id, { actor: 'bridge', kind: 'status', toStatus: 'nueva' });
      return { id, status: 'nueva', summary, merged: false, handoffCount: 1 };
    } catch (e) {
      console.error('requests fromHandoff failed:', e.message);
      return null;
    }
  }

  // The owner's portal "Fusionar en #N": source (nueva/info_pedida/fallida) -> fusionada, its evidence (tagged from) and
  // handoff count added to target (any chat; not rechazada/fusionada), an event on both, in one transaction. Cost stays.
  function merge(sourceId, targetId, { ip = null } = {}) {
    const s = raw(sourceId);
    const t = raw(targetId);
    if (!s) throw fail('NOT_FOUND', `petición ${sourceId} no encontrada`);
    if (!ACTIONS.merge.from.includes(s.status)) throw fail('ILLEGAL_TRANSITION', `no se puede fusionar en ${s.status}`);
    if (!t) throw fail('NOT_FOUND', `petición ${targetId} no encontrada`);
    if (t.id === s.id || ['rechazada', 'fusionada'].includes(t.status)) throw fail('ILLEGAL_TRANSITION', `no se puede fusionar en #${t.id} (${t.status})`);
    db.exec('BEGIN');
    try {
      const moved = parse(s.evidence).map((b) => ({ ...b, from: `#${s.id}` }));
      db.prepare('UPDATE requests SET evidence = ?, handoff_count = handoff_count + ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify([...parse(t.evidence), ...moved]), s.handoff_count, now(), t.id);
      event(t.id, { actor: owner, text: `fusionó #${s.id}: ${s.summary}`, ip });
      db.prepare('UPDATE requests SET merged_into = ? WHERE id = ?').run(t.id, s.id);
      const r = transition(s.id, 'fusionada', { actor: owner, text: `fusionada en #${t.id}`, ip });
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // The owner's portal action (see ACTIONS); text = reject reason or ask question, target = merge's. Throws like transition,
  // or UNKNOWN_ACTION.
  function act(id, action, { text = null, ip = null, target } = {}) {
    const a = ACTIONS[action];
    if (!a) throw fail('UNKNOWN_ACTION', `acción desconocida: ${action}`);
    const r = raw(id);
    if (!r) throw fail('NOT_FOUND', `petición ${id} no encontrada`);
    if (!actionsFor(r.status, r.hold).includes(action)) throw fail('ILLEGAL_TRANSITION', `no se puede ${action} en ${r.status}`);
    if (action === 'merge') return merge(id, target, { ip });
    if (!a.to) {
      const c = r.clash_json ? parse(r.clash_json) : null;
      patch(id, { hold: null, clash: c && { ...c, acked: c.signature } });
      event(id, { actor: owner, text: 'sigue pese al choque', ip });
      return row(raw(id));
    }
    return transition(id, a.to, { actor: owner, text, ip, ...(action === 'ask' && { question: text }) });
  }

  // Pipeline bookkeeping (see pipeline.js): the step in flight, its session and attempt, the failure reason, and the
  // validated plan and its blocks (plan-step.js), stored as JSON.
  const PATCH = {
    step: 'step', stepSession: 'step_session', stepAttempt: 'step_attempt', error: 'error', plan: 'plan_json', blocks: 'blocks_json', hold: 'hold', fixRound: 'fix_round', clash: 'clash_json',
  };
  const value = (k, v) => (k === 'error' || k === 'hold' ? safe(v) : ['plan', 'blocks', 'clash'].includes(k) ? safe(v == null ? null : JSON.stringify(v)) : k === 'fixRound' ? (v ? 1 : 0) : v ?? null);
  function patch(id, fields) {
    const keys = Object.keys(fields).filter((k) => Object.hasOwn(PATCH, k));
    db.prepare(`UPDATE requests SET ${keys.map((k) => `${PATCH[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => value(k, fields[k])), now(), id);
  }

  // Migrations applied to preprod (the MigrationTarget, migrations.js): find = the last ok row of a file on one database.
  const ledger = {
    find: ({ project, file, author, database }) => db.prepare(`SELECT * FROM preprod_migrations WHERE project = ? AND file = ? AND author = ? AND "database" = ?
      AND result = 'ok' ORDER BY applied_at DESC, rowid DESC LIMIT 1`).get(project, file, author, database),
    record: (r) => db.prepare(`INSERT INTO preprod_migrations (request_id, project, file, author, "database", sha256, kind, dump_path, server_id, hostname,
      applied_at, result, error, extra_databases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.requestId, r.project, r.file, r.author, r.database,
      r.sha256, r.kind, r.dumpPath ?? null, r.serverId ?? null, r.hostname ?? null, now(), r.result, safe(r.error), r.extraDatabases?.join(',') || null),
  };

  return {
    fromHandoff, transition, act, merge, event, patch, ledger,
    // The chat's open requests, for the reply agent's prompt (same_as). Never throws into the bridge: [] on a DB error.
    open: (jid, { shadow = false } = {}) => {
      try { return openOf(jid, shadow).map((r) => ({ id: r.id, status: r.status, summary: r.summary })); } catch { return []; }
    },
    addCost: (id, usd) => db.prepare('UPDATE requests SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, id),
    // The pipeline's waiting line (aprobada, oldest approval first) and the request in a step, if any. A held request
    // (waiting for the owner's preprod OK) is not current: the driver never re-runs it and the queue moves on meanwhile.
    queue: () => db.prepare(QUEUE).all().map(row),
    current: () => { const r = db.prepare(`SELECT * FROM requests WHERE status IN (${RUNNING.map(() => '?').join(', ')}) AND hold IS NULL ORDER BY updated_at, id LIMIT 1`).get(...RUNNING); return r ? row(r) : null; },
    get: (id) => { const r = raw(id); return r ? row(r) : null; },
    list: (filter) => {
      const states = FILTERS[filter];
      const rows = states
        ? db.prepare(`SELECT * FROM requests WHERE status IN (${states.map(() => '?').join(', ')}) ORDER BY updated_at DESC, id DESC LIMIT 500`).all(...states)
        : db.prepare('SELECT * FROM requests ORDER BY updated_at DESC, id DESC LIMIT 500').all();
      return rows.map(row);
    },
    detail: (id) => {
      const r = raw(id);
      if (!r) return null;
      return {
        request: row(r), evidence: parse(r.evidence), plan: r.plan_json ? parse(r.plan_json) : null, blocks: r.blocks_json ? parse(r.blocks_json) : [],
        clash: r.clash_json ? parse(r.clash_json) : null,
        events: db.prepare('SELECT * FROM request_events WHERE request_id = ? ORDER BY seq').all(id).map(eventRow),
      };
    },
    close: () => db.close(),
  };
}

export const noRequests = { fromHandoff: () => null, open: () => [] };
