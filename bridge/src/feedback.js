import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { REDACTED, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';

// Learning pairs: each agent draft next to what the owner really sent in that chat afterwards. A pair stays open
// (verdict NULL) until the contact's next message or WINDOW_MS, then gets a deterministic verdict. Lives in the
// run-log database; every stored text passes the secret guard first. Each pair also keeps its input (what the reply run
// saw: the last INPUT_ENTRIES transcript entries + the contact meta) so /aprender and its eval can replay it.
export const WINDOW_MS = 2 * 3600 * 1000;
export const FEEDBACK_TABLE = 'feedback_pairs';
export const INPUT_ENTRIES = 10;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback_pairs (
  id INTEGER PRIMARY KEY, run_id INTEGER, jid TEXT NOT NULL, contact_name TEXT, chat_type TEXT,
  draft_bubbles TEXT NOT NULL, draft_handoff TEXT, sent_texts TEXT NOT NULL DEFAULT '[]', verdict TEXT,
  created_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS feedback_open ON feedback_pairs (jid, verdict);`;
// Additive migration: rows from before it keep input NULL.
const migrate = (db) => {
  if (!db.prepare('PRAGMA table_info(feedback_pairs)').all().some((c) => c.name === 'input')) db.exec('ALTER TABLE feedback_pairs ADD COLUMN input TEXT');
};

// Reply-run outcomes whose draft is worth comparing; superseded/deferred/blocked runs never reached the owner as a draft.
const RECORDED = new Set(['shadow', 'sent', 'discarded', 'silent', 'no_reply']);
const EDITED = 0.5; // token Jaccard

export const normalize = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (s) => new Set(normalize(s).split(' ').filter(Boolean));
export const jaccard = (a, b) => {
  const x = tokens(a);
  const y = tokens(b);
  const both = [...x].filter((t) => y.has(t)).length;
  return x.size + y.size === both ? 1 : both / (x.size + y.size - both);
};

// verbatim | edited | rewritten | ignored | missed (no draft bubbles, the owner wrote) | null (no draft and nothing sent: no pair).
// edited: the whole text overlaps, or every message the owner sent is close to one draft bubble (they dropped or merged bubbles).
export function verdictOf(draft, sent) {
  if (!draft.length) return sent.length ? 'missed' : null;
  if (!sent.length) return 'ignored';
  if (normalize(draft.join(' ')) === normalize(sent.join(' '))) return 'verbatim';
  const close = jaccard(draft.join(' '), sent.join(' ')) >= EDITED || sent.every((s) => draft.some((d) => jaccard(d, s) >= EDITED));
  return close ? 'edited' : 'rewritten';
}

const parse = (s) => {
  try { return JSON.parse(s); } catch { return s; }
};
export const pairRow = (r) => ({
  id: r.id, runId: r.run_id, jid: r.jid, contactName: r.contact_name, chatType: r.chat_type, draftBubbles: parse(r.draft_bubbles),
  draftHandoff: r.draft_handoff, sentTexts: parse(r.sent_texts), verdict: r.verdict, createdAt: r.created_at, reviewedAt: r.reviewed_at,
  input: r.input ? parse(r.input) : null,
});
export const LIST_SQL = (unreviewed) =>
  `SELECT * FROM feedback_pairs WHERE verdict IS NOT NULL${unreviewed ? ' AND reviewed_at IS NULL' : ''} ORDER BY id DESC LIMIT 500`;

export const noFeedback = { draft() {}, manual() {}, contact() {}, sweep() {}, list: () => [], markReviewed() {}, close() {} };

// Never throws into the bridge: a DB error is logged and the message goes on.
export function createFeedback({
  file = fileURLToPath(new URL(`../state/${RUNS_DB}`, import.meta.url)), now = Date.now, leaks = createSecretGuard(),
} = {}) {
  let db;
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    migrate(db);
  } catch (e) {
    console.error(`feedback disabled (${file}): ${e.message}`);
    return noFeedback;
  }
  const safe = (s) => (leaks(String(s)) ? REDACTED : String(s));
  const guard = (what, fn) => (...a) => {
    try { return fn(...a); } catch (e) { console.error(`feedback ${what} failed:`, e.message); }
  };
  const open = (jid) => db.prepare('SELECT * FROM feedback_pairs WHERE jid = ? AND verdict IS NULL').all(jid);
  function finalize(row) {
    const v = verdictOf(JSON.parse(row.draft_bubbles), JSON.parse(row.sent_texts));
    if (v) db.prepare('UPDATE feedback_pairs SET verdict = ? WHERE id = ?').run(v, row.id);
    else db.prepare('DELETE FROM feedback_pairs WHERE id = ?').run(row.id);
  }
  // Group entries keep the member name (author) and respondTo; the contact's permissions are not part of it.
  const inputOf = (contact, transcript) => (transcript ? JSON.stringify({
    contact: { name: contact?.name ?? null, register: contact?.register ?? null, tenant: contact?.tenant ?? null, chatType: contact?.type === 'group' ? 'group' : 'direct' },
    transcript: transcript.slice(-INPUT_ENTRIES).map((e) => ({
      author: safe(e.author), text: safe(e.text), ...(e.at != null && { at: e.at }), ...(e.respondTo !== undefined && { respondTo: !!e.respondTo }),
    })),
  }) : null);
  const sweep = () => db.prepare('SELECT * FROM feedback_pairs WHERE verdict IS NULL AND closes_at <= ?').all(now()).forEach(finalize);

  return {
    // A finished reply run (see bridge.js reply), with the transcript it saw. Group drafts are recorded the same way.
    draft: guard('draft', ({ runId, jid, contact, out, outcome, transcript }) => {
      if (!RECORDED.has(outcome)) return;
      const t = now();
      db.prepare(`INSERT INTO feedback_pairs (run_id, jid, contact_name, chat_type, draft_bubbles, draft_handoff, created_at, closes_at, input)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId ?? null, jid, contact?.name ?? null, contact?.type === 'group' ? 'group' : 'direct',
        JSON.stringify((out?.bubbles ?? []).map(safe)), out?.handoff?.type ?? null, t, t + WINDOW_MS, inputOf(contact, transcript));
    }),
    // The owner wrote in the chat themselves (never the bridge's own sends).
    manual: guard('manual', (jid, text, at) => {
      for (const row of open(jid)) {
        if (row.closes_at <= at) finalize(row);
        else db.prepare('UPDATE feedback_pairs SET sent_texts = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(row.sent_texts), safe(text)]), row.id);
      }
    }),
    // The contact (or a respondTo group member) wrote: every open draft window of that chat closes.
    contact: guard('contact', (jid) => open(jid).forEach(finalize)),
    sweep: guard('sweep', sweep),
    list: guard('list', ({ unreviewed = false } = {}) => {
      sweep();
      return db.prepare(LIST_SQL(unreviewed)).all().map(pairRow);
    }),
    markReviewed: guard('markReviewed', (ids) => {
      const q = db.prepare('UPDATE feedback_pairs SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL');
      for (const id of ids) q.run(now(), id);
    }),
    close: guard('close', () => db.close()),
  };
}
