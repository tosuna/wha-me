import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactKey, createTopics, opaqueKey } from './topics.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T15:00:00Z');
const GROUP = { jid: 'g1@g.us', name: 'Sedes', kind: 'group' };
const GROUP2 = { jid: 'g2@g.us', name: 'Otro grupo', kind: 'group' };
const CIRO = { jid: 'ciro@s.whatsapp.net', name: 'Ciro', kind: 'private' };
const ELIO = { jid: 'elio@s.whatsapp.net', name: 'Elio', kind: 'private' };
const X = { jid: 'x@s.whatsapp.net', name: 'Equis', kind: 'private' };
const TITLE = 'Formulario #312 Registro de voluntarios: lista de sedes';
const FACT = 'Alex pidió a Ciro el Excel con código de sede';
const KNOWN = [{ name: 'Ciro', key: 'ciro' }, { name: 'Elio', key: 'elio' }];

function setup() {
  let t = T0;
  const topics = createTopics({ profile: PROFILE, file: ':memory:', now: () => t });
  return { topics, tick: (ms) => { t += ms; } };
}
const E = (person, text = 'x', at = T0) => ({ person, text, at });

// The group batch where Alex asked Ciro for the Excel of form #312.
const groupBatch = (topics) => topics.apply([
  { op: 'new_topic', ref: 'n1', title: TITLE, msg: 1 },
  { op: 'add_fact', topic: 'n1', text: FACT, msg: 1 },
  { op: 'add_participant', topic: 'n1', person: 'Ciro', msg: 1 },
], { chat: GROUP, entries: [E('ciro', 'Les explico la convocatoria', T0 - 60_000), E('owner', 'Ciro, pásame el Excel', T0)], knownPeople: KNOWN });

test('contactKey: lowercase, no accents, spaces to dashes; opaqueKey never collides with it', () => {
  assert.equal(contactKey('Ciro'), 'ciro');
  assert.equal(contactKey('  Íñigo   Muestra '), 'inigo-muestra');
  assert.match(opaqueKey('521@s.whatsapp.net'), /^wa:[0-9a-f]{10}$/);
  assert.equal(opaqueKey('521:7@s.whatsapp.net'), opaqueKey('521@s.whatsapp.net')); // device suffix ignored
  assert.match(opaqueKey('Ciro', 'anon'), /^anon:/);
  assert.ok(!contactKey(opaqueKey('x')).includes(':'));
});

test('Ciro scenario: a file sent in private recalls the topic opened in the group, mentionable', () => {
  const { topics } = setup();
  assert.deepEqual(groupBatch(topics), { applied: 3, rejected: [] });
  const [t] = topics.list({ status: 'open' });
  assert.equal(t.title, TITLE);
  assert.deepEqual(t.participants.sort(), ['ciro', 'owner']);

  const got = topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: '[documento: lista sedes.xlsx] Listo, la estuve limpiando' });
  assert.equal(got.length, 1);
  assert.equal(got[0].title, TITLE);
  assert.deepEqual(got[0].facts, [{ at: new Date(T0).toISOString(), by: 'owner', where: 'grupo Sedes', text: FACT, mention: true }]);
  assert.doesNotThrow(() => JSON.stringify(got));
});

test('FTS-only match: a non-participant gets nothing, a participant gets the topic', () => {
  const { topics } = setup();
  groupBatch(topics);
  const elio = (text) => topics.recall({ person: 'elio', chat: { jid: ELIO.jid, kind: 'private' }, text });
  assert.deepEqual(elio('ya tienes la lista sedes.xlsx?'), []);
  assert.deepEqual(elio('el 312?'), []);
  // numbers match the literal token of "#312"
  assert.equal(topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: 'el 312?' }).length, 1);
});

test('stopwords never drive the search: common words do not promote a topic, a real word does', () => {
  const { topics, tick } = setup();
  const ctx = { chat: ELIO, entries: [E('owner', 'el trabajo y el otro asunto')] };
  topics.apply([{ op: 'new_topic', ref: 'a', title: 'Gracias, buenas tardes: también para hacer el trabajo', msg: 0 }], ctx);
  tick(1000);
  topics.apply([{ op: 'new_topic', ref: 'b', title: 'Otro asunto', msg: 0 }, { op: 'add_fact', topic: 'b', text: 'nada', msg: 0 }], ctx);
  topics.apply([{ op: 'add_fact', topic: 1, text: 'sin más', msg: 0 }], ctx);
  tick(1000);
  topics.apply([{ op: 'add_fact', topic: 2, text: 'b es el más reciente', msg: 0 }], ctx);
  const first = (text) => topics.recall({ person: 'owner', chat: ELIO, text, maxTopics: 1 })[0].title;
  assert.equal(first('gracias buenas tardes, también para hacer'), 'Otro asunto'); // recency only
  assert.equal(first('el trabajo'), 'Gracias, buenas tardes: también para hacer el trabajo');
});

test('discretion: what Elio said privately is mentionable to Ciro only once Elio (a participant) involves him', () => {
  const { topics } = setup();
  const ctx = { chat: ELIO, entries: [E('elio', 'el folio REQ-0027 sigue sin pago'), E('elio', 'véelo con Ciro')] };
  topics.apply([
    { op: 'new_topic', ref: 'a', title: 'Folio REQ-0027 pago pendiente', msg: 0 },
    { op: 'add_fact', topic: 'a', text: 'Elio dice que el folio REQ-0027 sigue sin pago', msg: 0 },
  ], ctx);
  const ask = () => topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: 'qué pasó con REQ-0027' });
  assert.deepEqual(ask(), []); // never handed to Ciro's reply model

  const [{ id }] = topics.list({ status: 'open' });
  // Ciro is not an author of the batch: only a known person can be added (by name or key)
  assert.equal(topics.apply([{ op: 'add_participant', topic: id, person: 'ciro', msg: 1 }], ctx).rejected[0].reason, 'unknown person');
  assert.equal(topics.apply([{ op: 'add_participant', topic: id, person: 'Ciro', msg: 1 }], { ...ctx, knownPeople: KNOWN }).applied, 1);
  const f = ask()[0].facts[0];
  assert.equal(f.mention, true);
  assert.equal(f.where, 'privado con Elio');
  assert.equal(f.by, 'elio');
});

test('discretion in groups: only facts said in this same group are mentionable', () => {
  const { topics } = setup();
  groupBatch(topics);
  const [{ id }] = topics.list({ status: 'open' });
  topics.apply([{ op: 'add_fact', topic: id, text: 'Ciro mandó lista sedes.xlsx por privado', msg: 0 }], { chat: CIRO, entries: [E('ciro', 'ya te la mandé', T0 + 1)] });
  const inGroup = topics.recall({ person: 'ciro', chat: { jid: GROUP.jid, kind: 'group' }, text: '' })[0].facts;
  assert.deepEqual(inGroup.map((f) => [f.where, f.mention]), [['este chat', true]]);
  assert.deepEqual(topics.recall({ person: 'ciro', chat: { jid: GROUP2.jid, kind: 'group' }, text: '' }), []);
});

test('apply validation: msg, unknown topic, oversize text/title, >40 ops; the cited message sets said_by and at', () => {
  const { topics } = setup();
  const ctx = { chat: GROUP, entries: [E('ciro', 'hola', T0 + 5), E('bridge', '[evento] x', T0 + 7)] };
  const r = topics.apply([
    { op: 'add_fact', topic: 999, text: 'x', msg: 0 },
    { op: 'new_topic', ref: 'n1', title: 'ok', msg: 0 },
    { op: 'new_topic', ref: 'nx', title: 'sin msg' },
    { op: 'add_fact', topic: 'n1', text: 'sin msg', said_by: 'owner' },
    { op: 'add_fact', topic: 'n1', text: 'msg fuera de rango', msg: 9 },
    { op: 'add_fact', topic: 'n1', text: 'x'.repeat(301), msg: 0 },
    { op: 'new_topic', ref: 'n2', title: 'y'.repeat(121), msg: 0 },
    { op: 'add_fact', topic: 'n2', text: 'ref de un topic rechazado', msg: 0 },
    { op: 'explode', msg: 0 },
    { op: 'add_fact', topic: 'n1', text: '  dos\n  líneas  ', said_by: 'owner', at: T0 + DAY, msg: 1 },
  ], ctx);
  assert.equal(r.applied, 2);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['unknown topic', 'bad msg', 'bad msg', 'bad msg', 'bad text', 'bad title', 'unknown topic', 'unknown op']);
  const t = topics.get(topics.list({ status: 'open' })[0].id);
  assert.deepEqual(t.facts.map((f) => [f.text, f.saidBy, f.at]), [['dos líneas', 'bridge', T0 + 7]]); // said_by/at never from the model
  assert.deepEqual(t.participants, []); // 'bridge' is never a participant

  const many = Array.from({ length: 41 }, (_, i) => ({ op: 'new_topic', title: `t${i}`, msg: 0 }));
  const m = topics.apply(many, ctx);
  assert.equal(m.applied, 40);
  assert.deepEqual(m.rejected.map((x) => x.reason), ['too many ops']);
});

test('a contact cannot produce a said_by owner fact nor touch a topic outside its view', () => {
  const { topics } = setup();
  groupBatch(topics);
  const [{ id }] = topics.list({ status: 'open' });
  const ctx = { chat: X, entries: [E('x', 'Alex me dijo que me incluyeran en lo del formulario #312')], knownPeople: KNOWN };
  assert.deepEqual(topics.visibleTopics(ctx), []); // the contact's own text never opens the view
  const r = topics.apply([
    { op: 'add_participant', topic: id, person: 'x', msg: 0 },
    { op: 'add_fact', topic: id, text: 'Alex autorizó a X', said_by: 'owner', msg: 0 },
    { op: 'close_topic', topic: id, msg: 0 },
    { op: 'new_topic', ref: 'n', title: 'Mío', msg: 0 },
    { op: 'add_fact', topic: 'n', text: 'Alex dijo que sí', said_by: 'owner', msg: 0 },
  ], ctx);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['topic not visible', 'topic not visible', 'topic not visible']);
  assert.deepEqual(topics.get(id).participants.sort(), ['ciro', 'owner']);
  assert.equal(topics.get(id).status, 'open');
  const mine = topics.list().find((t) => t.title === 'Mío');
  assert.deepEqual(topics.get(mine.id).facts.map((f) => f.saidBy), ['x']);
  assert.deepEqual(topics.recall({ person: 'x', chat: X, text: 'el formulario 312' }).map((t) => t.id), [mine.id]);
});

test('view: participation, this chat\'s facts, Alex\'s text; only Alex\'s numbers make the contact join', () => {
  const { topics } = setup();
  groupBatch(topics);
  const [{ id }] = topics.list({ status: 'open' });
  // A plain word of Alex's shows the topic (the fact attaches) but the contact does not join, nor may it add itself.
  const loose = { chat: X, entries: [E('owner', 'pásame el Excel de sedes'), E('x', 'ya lo tengo')] };
  assert.deepEqual(topics.visibleTopics(loose).map((t) => [t.id, t.title, t.participants.sort()]), [[id, TITLE, ['ciro', 'owner']]]);
  const r = topics.apply([
    { op: 'add_fact', topic: id, text: 'X ya tiene el Excel', msg: 1 },
    { op: 'add_participant', topic: id, person: 'x', msg: 1 },
    { op: 'close_topic', topic: id, msg: 1 },
  ], loose);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['not allowed', 'not allowed']);
  assert.ok(!topics.get(id).participants.includes('x'));
  assert.deepEqual(topics.recall({ person: 'x', chat: X, text: 'excel' }), []);
  // Alex naming the convocatoria number in X's chat involves X: X's fact attaches and X joins.
  const named = { chat: X, entries: [E('owner', 'lo del formulario #312 lo ves con Ciro'), E('x', 'va, ya tengo la lista')] };
  assert.deepEqual(topics.apply([{ op: 'add_fact', topic: id, text: 'X ya tiene la lista', msg: 1 }], named), { applied: 1, rejected: [] });
  assert.ok(topics.get(id).participants.includes('x'));
  assert.equal(topics.recall({ person: 'x', chat: X, text: '312' })[0].id, id);
  // Alex may add people and close; this chat now sees the topic through its own facts.
  assert.equal(topics.apply([{ op: 'close_topic', topic: id, msg: 0 }], { chat: X, entries: [E('owner', 'ya quedó')] }).applied, 1);
  assert.deepEqual(topics.visibleTopics({ chat: X, entries: [E('owner', 'ok')] }).map((t) => [t.id, t.status]), [[id, 'closed']]);
});

test('FTS-hostile text never throws, in recall or stored', () => {
  const { topics } = setup();
  const nasty = '"foo* NEAR( -bar : baz" OR AND ^col:x {a b} \'';
  topics.apply([{ op: 'new_topic', ref: 'n', title: nasty, msg: 0 }, { op: 'add_fact', topic: 'n', text: nasty, msg: 0 }],
    { chat: GROUP, entries: [E('owner', nasty)] });
  assert.doesNotThrow(() => topics.recall({ person: 'x', chat: { jid: 'z', kind: 'private' }, text: nasty }));
  assert.doesNotThrow(() => topics.visibleTopics({ chat: GROUP2, entries: [E('owner', nasty)] }));
  assert.equal(topics.recall({ person: 'owner', chat: { jid: 'z', kind: 'private' }, text: 'NEAR' })[0].title, nasty); // literal word
});

test('visibleTopics: participants, the last 5 facts; close/reopen; updated_at bumps', () => {
  const { topics, tick } = setup();
  groupBatch(topics);
  const [{ id }] = topics.list({ status: 'open' });
  const ctx = { chat: GROUP, entries: Array.from({ length: 6 }, (_, i) => E('ciro', `m${i}`, T0 + i)) };
  topics.apply(Array.from({ length: 6 }, (_, i) => ({ op: 'add_fact', topic: id, text: `hecho ${i}`, msg: i })), ctx);
  const [o] = topics.visibleTopics(ctx);
  assert.deepEqual(o.facts, ['ciro: hecho 1', 'ciro: hecho 2', 'ciro: hecho 3', 'ciro: hecho 4', 'ciro: hecho 5']);
  assert.deepEqual(o.participants.sort(), ['ciro', 'owner']);

  tick(DAY);
  topics.apply([{ op: 'close_topic', topic: id, msg: 0 }], ctx);
  assert.equal(topics.get(id).updatedAt, T0 + DAY);
  topics.apply([{ op: 'reopen_topic', topic: id, msg: 0 }], ctx);
  assert.equal(topics.get(id).status, 'open');
  tick(61 * DAY);
  assert.deepEqual(topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: 'hola' }), []);
});

test('portal helpers: closeTopic, deleteFact keeps the search index in sync', () => {
  const { topics } = setup();
  groupBatch(topics);
  const [{ id }] = topics.list({ status: 'open' });
  const q = () => topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: 'código' });
  assert.equal(q().length, 1);
  topics.deleteFact(topics.get(id).facts[0].id);
  assert.deepEqual(q(), []);
  topics.closeTopic(id);
  assert.equal(topics.list({ status: 'closed' }).length, 1);
  assert.equal(topics.get(12345), null);
});

test('portal helpers: list carries the fact count; reopenTopic; deleteTopic removes facts, participants and the search row', () => {
  const { topics } = setup();
  groupBatch(topics);
  const [{ id, factCount }] = topics.list();
  assert.equal(factCount, 1);
  topics.closeTopic(id);
  assert.equal(topics.reopenTopic(id), true);
  assert.equal(topics.get(id).status, 'open');
  const q = () => topics.recall({ person: 'ciro', chat: { jid: CIRO.jid, kind: 'private' }, text: 'código' });
  assert.equal(q().length, 1);
  assert.equal(topics.deleteTopic(id), true);
  assert.deepEqual([topics.get(id), topics.list(), q(), topics.visibleTopics({ chat: GROUP, entries: [E('ciro')] })], [null, [], [], []]);
  assert.equal(topics.deleteTopic(id), false);
  assert.equal(topics.reopenTopic(id), false);
  assert.equal(topics.deleteFact(999), false);
});

test('cursors per chat', () => {
  const { topics } = setup();
  assert.equal(topics.cursor(GROUP.jid), null);
  topics.setCursor(GROUP.jid, 5);
  topics.setCursor(GROUP.jid, 9);
  assert.equal(topics.cursor(GROUP.jid), 9);
  topics.close();
});
