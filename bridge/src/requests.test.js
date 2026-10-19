import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor, createRequests, TRANSITIONS } from './requests.js';
import { REDACTED } from './run-log.js';
import { createSecretGuard } from './secrets.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const BEA = 'bea@s.whatsapp.net';
const DALIA = 'dalia@s.whatsapp.net';
const bea = { name: 'Bea', tenant: 'demo' };
const fr = (summary, fields = {}) => ({ type: 'feature-request', blocking: false, fields: { type: 'feature-request', summary, ...fields } });

function setup() {
  let t = 1000;
  const r = createRequests({ profile: PROFILE, file: ':memory:', now: () => t, leaks: createSecretGuard({ readFile: () => '', secrets: ['SUPERSECRET'] }) });
  return { r, tick: (ms = 1) => { t += ms; } };
}

test('fromHandoff creates a nueva request with the brief as evidence and one bridge event', () => {
  const { r } = setup();
  const got = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia', { evidence: 'problema: no ven el avance', next: 'ver con equipo' }), { shadow: false });
  assert.deepEqual({ ...got, id: 1 }, { id: 1, status: 'nueva', summary: 'reporte de becas por colonia', merged: false, handoffCount: 1 });
  const d = r.detail(got.id);
  assert.equal(d.request.contactName, 'Bea');
  assert.equal(d.request.tenant, 'demo');
  assert.equal(d.request.shadow, false);
  assert.deepEqual(d.evidence.map((b) => [b.summary, b.evidence, b.next, b.at]), [['reporte de becas por colonia', 'problema: no ven el avance', 'ver con equipo', 1000]]);
  assert.deepEqual(d.events.map((e) => [e.seq, e.actor, e.kind]), [[1, 'bridge', 'status']]);
  assert.deepEqual(d.request.actions, ['approve', 'reject', 'ask', 'merge']);
});

test('same chat + similar summary while nueva: merges evidence, bumps the count, no new request', () => {
  const { r, tick } = setup();
  const a = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false });
  tick();
  const b = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia y municipio', { evidence: 'mas datos' }), { shadow: false });
  assert.equal(b.id, a.id);
  assert.equal(b.merged, true);
  assert.equal(b.handoffCount, 2);
  assert.equal(r.list().length, 1);
  assert.deepEqual(r.detail(a.id).evidence.map((e) => e.evidence), [null, 'mas datos']);
});

test('merge into info_pedida reopens it as nueva, with an event', () => {
  const { r } = setup();
  const a = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false });
  r.act(a.id, 'ask', { text: 'cuantos registros?' });
  assert.equal(r.get(a.id).status, 'info_pedida');
  const b = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false });
  assert.equal(b.id, a.id);
  assert.equal(b.status, 'nueva');
  const evs = r.detail(a.id).events;
  assert.deepEqual(evs.filter((e) => e.kind === 'status').map((e) => e.toStatus), ['nueva', 'info_pedida', 'nueva']);
});

test('a different summary, another chat, a closed request or another shadow flag -> a new request', () => {
  const { r } = setup();
  const a = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false });
  assert.notEqual(r.fromHandoff(BEA, bea, fr('agregar campo curp al registro de eventos'), { shadow: false }).id, a.id);
  assert.notEqual(r.fromHandoff(DALIA, { name: 'Dalia' }, fr('reporte de becas por colonia'), { shadow: false }).id, a.id);
  const s = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: true });
  assert.notEqual(s.id, a.id);
  assert.equal(r.get(s.id).shadow, true);
  r.act(a.id, 'approve', {});
  assert.notEqual(r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false }).id, a.id);
});

test('TRANSITIONS: legal chain works, illegal throws and leaves the status unchanged', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('x'), { shadow: false });
  assert.throws(() => r.transition(id, 'implementando', { actor: 'bridge' }), { code: 'ILLEGAL_TRANSITION' });
  assert.equal(r.get(id).status, 'nueva');
  for (const s of ['aprobada', 'planificando', 'implementando', 'en_revision', 'implementando', 'en_revision', 'en_preprod', 'listo_para_entregar']) {
    r.transition(id, s, { actor: 'bridge' });
  }
  assert.equal(r.get(id).status, 'listo_para_entregar');
  assert.throws(() => r.transition(id, 'aprobada', { actor: 'bridge' }), { code: 'ILLEGAL_TRANSITION' });
  for (const s of ['aprobada', 'planificando', 'implementando', 'en_revision', 'en_preprod']) assert.ok(TRANSITIONS[s].includes('fallida'), s);
  assert.deepEqual(TRANSITIONS.fallida, ['aprobada', 'fusionada']);
  assert.ok(TRANSITIONS.planificando.includes('info_pedida'));
  assert.throws(() => r.transition(999, 'aprobada', { actor: 'bridge' }), { code: 'NOT_FOUND' });
});

test('every transition appends one event (append-only, seq per request) with actor, ip and text', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('x'), { shadow: false });
  r.act(id, 'approve', { ip: '1.2.3.4' });
  r.act(id, 'cancel', { ip: '1.2.3.4' });
  r.act(id, 'retry', {});
  const evs = r.detail(id).events;
  assert.deepEqual(evs.map((e) => [e.seq, e.actor, e.toStatus, e.ip]), [
    [1, 'bridge', 'nueva', null], [2, 'owner', 'aprobada', '1.2.3.4'], [3, 'owner', 'fallida', '1.2.3.4'], [4, 'owner', 'aprobada', null],
  ]);
  assert.ok(r.get(id).approvedAt);
});

test('act: only the actions valid for the state; reject keeps the reason, ask keeps the question', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('x'), { shadow: false });
  for (const a of ['cancel', 'retry']) assert.throws(() => r.act(id, a, {}), { code: 'ILLEGAL_TRANSITION' }, a);
  assert.throws(() => r.act(id, 'nope', {}), { code: 'UNKNOWN_ACTION' });
  r.act(id, 'ask', { text: 'cuantos son?' });
  assert.equal(r.get(id).question, 'cuantos son?');
  assert.deepEqual(actionsFor('info_pedida'), ['merge']);
  const b = r.fromHandoff(DALIA, { name: 'Dalia' }, fr('y'), { shadow: false });
  r.act(b.id, 'reject', { text: 'no aplica' });
  assert.equal(r.get(b.id).status, 'rechazada');
  assert.ok(r.get(b.id).doneAt);
  assert.equal(r.detail(b.id).events.at(-1).text, 'no aplica');
  assert.deepEqual(actionsFor('implementando'), ['cancel']);
  assert.deepEqual(actionsFor('fallida'), ['retry', 'merge']);
});

test('list filters: activas | por_revisar | listas | cerradas, newest first; unknown filter = all', () => {
  const { r, tick } = setup();
  const mk = (s) => { tick(); return r.fromHandoff(`${s}@s`, { name: s }, fr(s), { shadow: false }).id; };
  const nueva = mk('nueva');
  const aprob = mk('aprobada');
  r.act(aprob, 'approve', {});
  const rech = mk('rechazada');
  r.act(rech, 'reject', {});
  const lista = mk('lista');
  for (const s of ['aprobada', 'planificando', 'implementando', 'en_revision', 'en_preprod', 'listo_para_entregar']) r.transition(lista, s, { actor: 'bridge' });
  const ids = (f) => r.list(f).map((x) => x.id);
  assert.deepEqual(ids('por_revisar'), [nueva]);
  assert.deepEqual(ids('activas'), [aprob]);
  assert.deepEqual(ids('listas'), [lista]);
  assert.deepEqual(ids('cerradas'), [rech]);
  assert.deepEqual(ids(), [lista, rech, aprob, nueva]);
  const item = r.list('por_revisar')[0];
  for (const k of ['id', 'status', 'contactName', 'summary', 'createdAt', 'updatedAt', 'handoffCount', 'shadow', 'costUsd']) assert.ok(k in item, k);
});

test('entregada: only from listo_para_entregar, terminal, listed under cerradas', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('x'), { shadow: false });
  assert.throws(() => r.transition(id, 'entregada', { actor: 'owner' }), { code: 'ILLEGAL_TRANSITION' });
  for (const s of ['aprobada', 'planificando', 'implementando', 'en_revision', 'en_preprod', 'listo_para_entregar', 'entregada']) r.transition(id, s, { actor: 'owner' });
  assert.deepEqual(TRANSITIONS.entregada, []);
  assert.deepEqual(r.list('cerradas').map((x) => x.id), [id]);
  assert.deepEqual(r.list('listas'), []);
});

test('secrets in summary, evidence, questions and event text are stored redacted', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('token ghp_abc123', { evidence: 'clave SUPERSECRET aqui' }), { shadow: false });
  r.act(id, 'ask', { text: 'manda github_pat_xyz' });
  const d = r.detail(id);
  assert.equal(d.request.summary, REDACTED);
  assert.equal(d.evidence[0].evidence, REDACTED);
  assert.equal(d.request.question, REDACTED);
  assert.ok(!JSON.stringify(d).includes('SUPERSECRET'));
  assert.ok(!JSON.stringify(d).includes('ghp_abc'));
});

test('fromHandoff never throws into the bridge (DB closed -> null)', () => {
  const { r } = setup();
  r.close();
  assert.equal(r.fromHandoff(BEA, bea, fr('x'), { shadow: false }), null);
});

test('patch stores the plan and its blocks; detail returns them (null/[] before)', () => {
  const { r } = setup();
  const { id } = r.fromHandoff(BEA, bea, fr('comentarios del revisor'), { shadow: false });
  assert.deepEqual([r.detail(id).plan, r.detail(id).blocks], [null, []]);
  const plan = { question: null, blocks: [{ key: 'api', project: 'acme-api', goal: 'g', depends_on: [], spec: '## Project\nx' }], migrations: [], e2e: [], risks: [] };
  const blocks = [{ key: 'api', project: 'acme-api', base: 'main', branch: 'pet/1-api', worktree: '/w', commits: [], verdict: null, pr_url: null }];
  r.patch(id, { plan, blocks });
  assert.deepEqual([r.detail(id).plan, r.detail(id).blocks], [plan, blocks]);
});

test('retry (fallida -> aprobada) resets the fix round', () => {
  const r = createRequests({ profile: PROFILE, file: ':memory:' });
  const { id } = r.fromHandoff('a@s.whatsapp.net', { name: 'A', tenant: 'demo' }, { type: 'feature-request', fields: { summary: 's' } });
  r.transition(id, 'aprobada', { actor: 'owner' });
  r.patch(id, { fixRound: true });
  r.transition(id, 'fallida', { actor: 'bridge' });
  assert.equal(r.get(id).fixRound, true);
  r.transition(id, 'aprobada', { actor: 'owner' });
  assert.equal(r.get(id).fixRound, false);
});

// --- same_as (the reply agent names the open request) and Alex's merge ---

const S3 = 'Cargar la lista de sedes en el nuevo formulario de registro de voluntarios, con la lista numerada de personas que se muestre según el código de sede (como en el registro de asistentes)';
const S4 = 'Precargar en el nuevo formulario de registro de voluntarios por sede la lista de personas a contactar, filtrada por codigo de sede, y agregar validacion para que no acepten telefonos con digitos repetidos';

test('fromHandoff same_as: merges into that open request of the chat even below the Jaccard threshold', () => {
  const { r } = setup();
  const a = r.fromHandoff(BEA, bea, fr(S3), { shadow: false });
  assert.notEqual(r.fromHandoff(BEA, bea, fr(S4), { shadow: false }).id, a.id, 'without same_as: Jaccard < 0.5, a new request');
  const { r: r2 } = setup();
  const b = r2.fromHandoff(BEA, bea, fr(S3), { shadow: false });
  r2.act(b.id, 'ask', { text: 'cuantos?' });
  const got = r2.fromHandoff(BEA, bea, fr(S4, { same_as: String(b.id), evidence: 'telefonos repetidos' }), { shadow: false });
  assert.deepEqual([got.id, got.merged, got.handoffCount, got.status], [b.id, true, 2, 'nueva']);
  assert.equal(r2.list().length, 1);
  assert.deepEqual(r2.detail(b.id).evidence.map((e) => e.evidence), [null, 'telefonos repetidos']);
});

test('fromHandoff same_as: another chat, another shadow flag, a closed/active request, a missing id or garbage -> ignored (Jaccard)', () => {
  const { r } = setup();
  const dalia = r.fromHandoff(DALIA, { name: 'Dalia' }, fr('reporte de becas por colonia'), { shadow: false }).id;
  const sh = r.fromHandoff(BEA, bea, fr('otra cosa sombra'), { shadow: true }).id;
  const act = r.fromHandoff(BEA, bea, fr('campo curp en eventos'), { shadow: false }).id;
  r.act(act, 'approve', {});
  const rej = r.fromHandoff(BEA, bea, fr('algo rechazado distinto'), { shadow: false }).id;
  r.act(rej, 'reject', {});
  const open = r.fromHandoff(BEA, bea, fr(S3), { shadow: false }).id;
  for (const same of [dalia, sh, act, rej, 999, `${open}; DROP`, '-1', `${open}.5`, `#${open}`, '', '0']) {
    const got = r.fromHandoff(BEA, bea, fr(S4, { same_as: String(same) }), { shadow: false });
    assert.equal(got.merged, false, String(same));
    assert.ok(![dalia, sh, act, rej, open].includes(got.id), String(same));
    r.act(got.id, 'reject', {}); // keep the next round from Jaccard-merging into it
  }
  // garbage still falls back to Jaccard: a similar summary merges into the open one
  assert.equal(r.fromHandoff(BEA, bea, fr(S3, { same_as: 'abc' }), { shadow: false }).id, open);
});

test('open(jid, shadow): id/status/summary of that chat\'s nueva/info_pedida requests only', () => {
  const { r, tick } = setup();
  const a = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false }).id;
  tick();
  const b = r.fromHandoff(BEA, bea, fr('campo curp en eventos'), { shadow: false }).id;
  r.act(b, 'ask', { text: 'x?' });
  const c = r.fromHandoff(BEA, bea, fr('presets de reportes guardados'), { shadow: false }).id;
  r.act(c, 'approve', {});
  r.fromHandoff(DALIA, { name: 'Dalia' }, fr('otra de dalia'), { shadow: false });
  r.fromHandoff(BEA, bea, fr('de sombra'), { shadow: true });
  assert.deepEqual(r.open(BEA, { shadow: false }), [{ id: b, status: 'info_pedida', summary: 'campo curp en eventos' }, { id: a, status: 'nueva', summary: 'reporte de becas por colonia' }]);
  assert.deepEqual(r.open(BEA, { shadow: true }).map((x) => x.summary), ['de sombra']);
  r.close();
  assert.deepEqual(r.open(BEA), [], 'never throws into the bridge');
});

test('merge: evidence (tagged from) and handoff_count move to the target, events on both, source fusionada + mergedInto', () => {
  const { r } = setup();
  const t = r.fromHandoff(BEA, bea, fr(S3, { evidence: 'e1' }), { shadow: false }).id;
  r.fromHandoff(BEA, bea, fr(S3, { evidence: 'e2' }), { shadow: false });
  const s = r.fromHandoff(DALIA, { name: 'Dalia' }, fr(S4, { evidence: 'e3' }), { shadow: false }).id; // cross-chat is allowed
  r.addCost(s, 1.5);
  const got = r.merge(s, t, { ip: '1.2.3.4' });
  assert.deepEqual([got.status, got.mergedInto, got.actions], ['fusionada', t, []]);
  const dt = r.detail(t);
  assert.deepEqual(dt.evidence.map((e) => [e.evidence, e.from]), [['e1', undefined], ['e2', undefined], ['e3', `#${s}`]]);
  assert.equal(dt.request.handoffCount, 3);
  assert.deepEqual(dt.events.at(-1), { ...dt.events.at(-1), actor: 'owner', kind: 'note', text: `fusionó #${s}: ${S4}`, ip: '1.2.3.4' });
  const ds = r.detail(s);
  assert.deepEqual(ds.events.at(-1), { ...ds.events.at(-1), actor: 'owner', kind: 'status', toStatus: 'fusionada', text: `fusionada en #${t}`, ip: '1.2.3.4' });
  assert.equal(ds.request.costUsd, 1.5);
  assert.equal(dt.request.costUsd, 0);
  assert.ok(ds.request.doneAt);
  assert.deepEqual(r.list('cerradas').map((x) => x.id), [s]);
  assert.ok(!r.list('por_revisar').some((x) => x.id === s));
  assert.deepEqual(r.open(DALIA), []);
  // through act() too (the portal's path), from fallida
  const f = r.fromHandoff(BEA, bea, fr('presets de reportes'), { shadow: false }).id;
  r.act(f, 'approve', {});
  r.act(f, 'cancel', {});
  assert.deepEqual(actionsFor('fallida'), ['retry', 'merge']);
  assert.equal(r.act(f, 'merge', { target: t }).status, 'fusionada');
});

test('merge rejects: same id, an active/closed source, a rejected/fusionada/missing target; nothing changes', () => {
  const { r } = setup();
  const a = r.fromHandoff(BEA, bea, fr('reporte de becas por colonia'), { shadow: false }).id;
  const act = r.fromHandoff(BEA, bea, fr('campo curp en eventos'), { shadow: false }).id;
  r.act(act, 'approve', {});
  const rej = r.fromHandoff(BEA, bea, fr('algo rechazado distinto'), { shadow: false }).id;
  r.act(rej, 'reject', {});
  const fus = r.fromHandoff(BEA, bea, fr('presets de reportes guardados'), { shadow: false }).id;
  r.merge(fus, a, {});
  const b = r.fromHandoff(DALIA, { name: 'Dalia' }, fr('otra de dalia'), { shadow: false }).id;
  const before = JSON.stringify([r.detail(a), r.detail(b)]);
  assert.throws(() => r.merge(b, b, {}), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => r.merge(act, b, {}), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => r.merge(fus, b, {}), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => r.merge(b, rej, {}), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => r.merge(b, fus, {}), { code: 'ILLEGAL_TRANSITION' });
  assert.throws(() => r.merge(b, 999, {}), { code: 'NOT_FOUND' });
  assert.throws(() => r.merge(999, b, {}), { code: 'NOT_FOUND' });
  assert.equal(JSON.stringify([r.detail(a), r.detail(b)]), before);
  assert.equal(r.merge(b, act, {}).status, 'fusionada', 'an active target is fine');
  assert.deepEqual(actionsFor('nueva'), ['approve', 'reject', 'ask', 'merge']);
  assert.deepEqual(actionsFor('fusionada'), []);
});
