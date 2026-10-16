import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedback, verdictOf, WINDOW_MS } from './feedback.js';
import { createRunLog } from './run-log.js';

const GAEL = 'gael@s.whatsapp.net';
const contact = { name: 'Contacto B', type: undefined };
const leaks = (s) => s.includes('ghp_');

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-fb-')), 'state', 'agent-runs.db');
  let t = 1_000_000;
  const fb = createFeedback({ file, now: () => t, leaks });
  const draft = (bubbles, outcome = 'shadow', jid = GAEL) => fb.draft({ runId: 7, jid, contact, out: { bubbles, handoff: null }, outcome });
  return { fb, file, draft, at: (ms = 0) => (t += ms), now: () => t };
}

test('verdictOf: verbatim ignores case, accents, punctuation and whitespace', () => {
  assert.equal(verdictOf(['Buen día Gael', 'va lo checo'], ['buen dia gael,  va lo checo!']), 'verbatim');
});

test('verdictOf: edited (high token overlap), rewritten (different), ignored (nothing sent), missed (silent draft, Alex wrote)', () => {
  const draft = ['el botón de exportar sale en el menú de reportes solo si eres editor, si eres lector no se muestra'];
  assert.equal(verdictOf(draft, ['el botón de exportar sale en el menú de reportes solo si eres editor, pero creo que si eres lector no se muestra, para qué lo ocupas?']), 'edited');
  assert.equal(verdictOf(draft, ['ok, lo veo en la tarde y te aviso']), 'rewritten');
  assert.equal(verdictOf(draft, []), 'ignored');
  assert.equal(verdictOf([], ['ya quedó']), 'missed');
  assert.equal(verdictOf([], []), null);
});

test('window closes on the contact next message: Alex texts before it are the pair, after it are not', () => {
  const { fb, draft, at } = setup();
  draft(['hola Gael', 'disculpa la demora']);
  fb.manual(GAEL, 'Hola Gael', at(60_000));
  fb.contact(GAEL, at(60_000));
  fb.manual(GAEL, 'otra cosa', at(60_000));
  const [p] = fb.list();
  assert.deepEqual([p.verdict, p.sentTexts, p.draftBubbles, p.contactName, p.runId], ['edited', ['Hola Gael'], ['hola Gael', 'disculpa la demora'], 'Contacto B', 7]);
  assert.equal(p.reviewedAt, null);
});

test('window closes after 2 h: a later Alex message is not part of the pair, the sweep finalizes it as ignored', () => {
  const { fb, draft, at } = setup();
  draft(['perdón que no te contestaron']);
  at(WINDOW_MS - 1);
  assert.deepEqual(fb.list(), [], 'still open: not listed');
  at(2);
  fb.manual(GAEL, 'perdón que no te contestaron', at());
  assert.deepEqual(fb.list().map((p) => [p.verdict, p.sentTexts]), [['ignored', []]]);
});

test('sweep finalizes expired pairs on a timer/startup; open pairs stay unlisted', () => {
  const { fb, draft, at, file } = setup();
  draft(['uno']);
  at(WINDOW_MS + 1);
  const again = createFeedback({ file, now: () => at(), leaks }); // a restart: same DB
  again.sweep();
  assert.deepEqual(again.list().map((p) => p.verdict), ['ignored']);
});

test('silent run: missed when Alex wrote, dropped when he did not; superseded/deferred runs are not recorded', () => {
  const { fb, draft, at } = setup();
  draft([], 'silent');
  fb.manual(GAEL, 'yo le contesto', at(1000));
  fb.contact(GAEL, at(1000));
  draft([], 'silent');
  fb.contact(GAEL, at(1000));
  draft(['x'], 'superseded');
  draft(['x'], 'deferred');
  fb.contact(GAEL, at(1000));
  assert.deepEqual(fb.list().map((p) => [p.verdict, p.sentTexts]), [['missed', ['yo le contesto']]]);
});

test('verbatim and rewritten end to end, other chats untouched', () => {
  const { fb, draft, at } = setup();
  draft(['Va, sí se me hace buena idea']);
  draft(['hola Dalia'], 'shadow', 'dalia@s');
  fb.manual(GAEL, 'va si se me hace buena idea', at(1000));
  fb.contact(GAEL, at(1000));
  draft(['te refieres a textos guardados?']);
  fb.manual(GAEL, 'déjame ver cómo lo agrego entonces', at(1000));
  fb.contact(GAEL, at(1000));
  assert.deepEqual(fb.list().map((p) => p.verdict), ['rewritten', 'verbatim']);
});

test('unreviewed filter and markReviewed', () => {
  const { fb, draft, at } = setup();
  draft(['a']);
  fb.contact(GAEL, at(1000));
  draft(['b']);
  fb.contact(GAEL, at(1000));
  const [newest, oldest] = fb.list();
  fb.markReviewed([oldest.id]);
  assert.deepEqual(fb.list({ unreviewed: true }).map((p) => p.id), [newest.id]);
  assert.equal(fb.list().find((p) => p.id === oldest.id).reviewedAt, at());
});

test('draft bubbles and sent texts pass the secret guard before storage', () => {
  const { fb, draft, at } = setup();
  draft(['toma ghp_abc', 'ok']);
  fb.manual(GAEL, 'mi token ghp_zzz', at(1000));
  fb.contact(GAEL, at(1000));
  const [p] = fb.list();
  assert.ok(!JSON.stringify(p).includes('ghp_'));
  assert.equal(p.draftBubbles[1], 'ok');
});

test('shares the run-log database file; the run log exposes its run id', () => {
  const { file } = setup();
  const log = createRunLog({ file, leaks });
  const run = log.start({ kind: 'reply', mode: 'real', contact, jid: GAEL });
  assert.equal(typeof run.id, 'number');
  log.close();
});

// --- input: what the reply run saw (transcript slice + contact meta), stored with the pair ---

test('a pair stores its input: the last 10 transcript entries (author, text, at, respondTo) and the contact meta', () => {
  const { fb, at } = setup();
  const transcript = Array.from({ length: 12 }, (_, i) => ({ author: i % 2 ? 'OWNER' : 'CONTACTO', text: `m${i}`, at: i }));
  transcript.push({ author: 'Iker', text: 'ya quedó?', at: 12, respondTo: true });
  const meta = { name: 'Contacto B', register: 'usted', tenant: 'demo', type: 'group', autoApprove: true, user_id: 9, respondTo: [{ name: 'x', jids: ['j'] }] };
  fb.draft({ runId: 7, jid: GAEL, contact: meta, out: { bubbles: ['va'] }, outcome: 'shadow', transcript });
  fb.contact(GAEL, at(1000));
  const [p] = fb.list();
  assert.deepEqual(p.input.contact, { name: 'Contacto B', register: 'usted', tenant: 'demo', chatType: 'group' });
  assert.equal(p.input.transcript.length, 10);
  assert.deepEqual(p.input.transcript.at(-1), { author: 'Iker', text: 'ya quedó?', at: 12, respondTo: true });
  assert.deepEqual(p.input.transcript[0], { author: 'OWNER', text: 'm3', at: 3 });
});

test('input passes the secret guard like the other fields', () => {
  const { fb, at } = setup();
  fb.draft({ runId: 7, jid: GAEL, contact, out: { bubbles: ['ok'] }, outcome: 'shadow', transcript: [{ author: 'CONTACTO', text: 'mi token ghp_abc', at: 1 }] });
  fb.contact(GAEL, at(1000));
  const [p] = fb.list();
  assert.ok(!JSON.stringify(p).includes('ghp_'));
  assert.equal(p.input.transcript.length, 1);
});

test('rows from before the input column still list (input null); the column is added to an old table', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-fb-')), 'agent-runs.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE feedback_pairs (
  id INTEGER PRIMARY KEY, run_id INTEGER, jid TEXT NOT NULL, contact_name TEXT, chat_type TEXT,
  draft_bubbles TEXT NOT NULL, draft_handoff TEXT, sent_texts TEXT NOT NULL DEFAULT '[]', verdict TEXT,
  created_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, reviewed_at INTEGER);
  INSERT INTO feedback_pairs (run_id, jid, draft_bubbles, sent_texts, verdict, created_at, closes_at) VALUES (1, 'x', '["a"]', '["a"]', 'verbatim', 1, 2);`);
  old.close();
  const fb = createFeedback({ file, now: () => 10, leaks });
  fb.draft({ runId: 2, jid: GAEL, contact, out: { bubbles: ['b'] }, outcome: 'shadow', transcript: [{ author: 'CONTACTO', text: 'hola', at: 1 }] });
  fb.contact(GAEL, 11);
  assert.deepEqual(fb.list().map((p) => [p.runId, p.input?.transcript?.[0]?.text ?? null]), [[2, 'hola'], [1, null]]);
  const again = createFeedback({ file, now: () => 12, leaks }); // reopening an already migrated table
  assert.equal(again.list().length, 2);
});
