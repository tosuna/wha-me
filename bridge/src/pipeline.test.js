import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipeline, createStageLock, STEPS } from './pipeline.js';
import { createRequests } from './requests.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const BEA = 'bea@s.whatsapp.net';
const fr = (summary) => ({ type: 'feature-request', blocking: false, fields: { summary } });
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Step functions that hand control to the test: each call is recorded and waits for ok(result) / ko(error).
function fakeSteps() {
  const calls = [];
  const fn = (step) => (args) => new Promise((resolve, reject) => {
    calls.push({ step, ...args, ok: (v = {}) => resolve(v), ko: (e) => reject(e) });
  });
  return { calls, steps: { plan: fn('plan'), implement: fn('implement'), review: fn('review'), preprod: fn('preprod') }, last: () => calls[calls.length - 1] };
}

function setup({ file = ':memory:', requests, state = {}, enabled = true, steps } = {}) {
  let t = 1000;
  requests ??= createRequests({ profile: PROFILE, file, now: () => (t += 1) });
  const st = { paused: false, locked: false, shadow: false, ...state };
  const said = [];
  const runs = [];
  const runLog = { start: (a) => { const r = { ...a, id: runs.length + 1, events: [], event: (e) => r.events.push(e), finish: () => { r.done = 'ok'; }, fail: (e) => { r.done = e.message; } }; runs.push(r); return r; } };
  const fake = fakeSteps();
  let sessions = 0;
  const flag = { enabled };
  const pipeline = createPipeline({
    requests, runLog, state: () => st, enabled: () => flag.enabled, say: async (s) => { said.push(s); }, steps: steps ?? fake.steps,
    newSession: () => `S${++sessions}`,
  });
  const add = (summary) => {
    const { id } = requests.fromHandoff(BEA, { name: 'Bea', tenant: 'demo' }, fr(summary));
    requests.act(id, 'approve', {});
    return id;
  };
  return { requests, pipeline, st, said, runs, flag, add, ...fake };
}
const status = (s, id) => s.requests.get(id).status;

test('queue: one request at a time, in approval order; the others wait in aprobada with their position', async () => {
  const s = setup();
  const [a, b, c] = [s.add('reporte de becas'), s.add('campo curp en eventos'), s.add('exportar padrón')];
  s.pipeline.kick();
  await flush();
  assert.equal(status(s, a), 'planificando');
  assert.deepEqual([status(s, b), status(s, c)], ['aprobada', 'aprobada']);
  assert.deepEqual([s.requests.get(a).queuePosition, s.requests.get(b).queuePosition, s.requests.get(c).queuePosition], [null, 1, 2]);
  assert.deepEqual(s.requests.list('activas').map((r) => [r.id, r.queuePosition]).sort(), [[a, null], [b, 1], [c, 2]]);
  assert.equal(s.calls.length, 1);
  for (const step of ['plan', 'implement', 'review', 'preprod']) {
    assert.equal(s.last().step, step);
    assert.equal(s.last().request.id, a);
    s.last().ok({ costUsd: 1 });
    await flush();
  }
  assert.equal(status(s, a), 'listo_para_entregar');
  assert.equal(status(s, b), 'planificando');
  assert.equal(s.requests.get(c).queuePosition, 1);
});

test('steps: each transition in request_events with its run; step/session/attempt persisted; cost accumulates; self-chat only on listo', async () => {
  const s = setup();
  const id = s.add('reporte de becas');
  s.pipeline.kick();
  await flush();
  const r = s.requests.get(id);
  assert.deepEqual([r.step, r.stepSession, r.stepAttempt], ['plan', 'S1', 1]);
  assert.deepEqual([s.last().sessionId, s.last().resume, s.last().budgetUsd, s.last().timeoutMs], ['S1', undefined, 4, STEPS.planificando.timeoutMs]);
  assert.ok(s.last().signal instanceof AbortSignal);
  assert.deepEqual(s.runs[0], { ...s.runs[0], kind: 'request-plan', mode: 'real', jid: BEA, requestId: id });
  s.last().onEvent({ kind: 'text', text: 'hola' });
  assert.deepEqual(s.runs[0].events, [{ kind: 'text', text: 'hola' }]);
  for (let i = 0; i < 4; i++) { s.last().ok({ costUsd: 1.5, result: 'x' }); await flush(); }
  const d = s.requests.detail(id);
  assert.equal(d.request.costUsd, 6);
  assert.equal(d.request.step, null);
  assert.deepEqual(d.events.filter((e) => e.kind === 'status').map((e) => e.toStatus),
    ['nueva', 'aprobada', 'planificando', 'implementando', 'en_revision', 'en_preprod', 'listo_para_entregar']);
  assert.deepEqual(d.events.filter((e) => e.kind === 'note' && e.runId).map((e) => e.runId), [1, 2, 3, 4]);
  assert.deepEqual(s.runs.map((x) => [x.kind, x.done]), [['request-plan', 'ok'], ['request-implement', 'ok'], ['request-review', 'ok'], ['request-preprod', 'ok']]);
  assert.equal(s.said.length, 1);
  assert.match(s.said[0], /^PETICIÓN #\d+ lista para entregar · Bea: reporte de becas/);
});

test('approve in the portal: self-chat line with the queue position and the driver picks it up', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  await s.pipeline.onAction(a, 'approve');
  await flush();
  assert.equal(status(s, a), 'planificando');
  const b = s.add('campo curp en eventos');
  await s.pipeline.onAction(b, 'approve');
  assert.match(s.said[0], /^PETICIÓN #\d+ aprobada · Bea: reporte de becas/);
  assert.match(s.said[1], /en cola, posición 1/);
});

test('resume: a crash mid-step re-enters the same step with its session; attempt > 2 -> fallida', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wa-pipe-')), 'agent-runs.db');
  const first = setup({ file });
  const id = first.add('reporte de becas');
  first.pipeline.kick();
  await flush();
  first.last().ok({ costUsd: 1 }); // plan done
  await flush();
  assert.equal(first.last().step, 'implement'); // never settles: the bridge "dies" here
  const session = first.requests.get(id).stepSession;

  const second = setup({ requests: createRequests({ profile: PROFILE, file }) });
  second.pipeline.resume();
  await flush();
  assert.equal(second.calls.length, 1);
  assert.deepEqual([second.last().step, second.last().resume, second.last().sessionId], ['implement', session, session]);
  assert.deepEqual([status(second, id), second.requests.get(id).stepAttempt], ['implementando', 2]);

  const third = setup({ requests: createRequests({ profile: PROFILE, file }) });
  third.pipeline.resume();
  await flush();
  assert.equal(third.calls.length, 0);
  const r = third.requests.get(id);
  assert.equal(r.status, 'fallida');
  assert.match(r.error, /reintentos agotados en implement/);
  assert.match(third.said[0], /^PETICIÓN #\d+ fallida · Bea: reintentos agotados/);
});

test('budget: the step gets min(step cap, remaining); exceeding the budget -> fallida presupuesto', async () => {
  const s = setup();
  const id = s.add('reporte de becas');
  s.pipeline.kick();
  await flush();
  s.last().ok({ costUsd: 25 });
  await flush();
  assert.equal(s.last().step, 'implement');
  assert.equal(s.last().budgetUsd, 5);
  s.last().ok({ costUsd: 6 });
  await flush();
  const r = s.requests.get(id);
  assert.equal(r.status, 'fallida');
  assert.equal(r.costUsd, 31);
  assert.match(r.error, /presupuesto/);
  assert.equal(s.calls.length, 2);
});

test('a failing step -> fallida with its reason; its cost still counts', async () => {
  const s = setup();
  const id = s.add('reporte de becas');
  s.pipeline.kick();
  await flush();
  s.last().ko(Object.assign(new Error('claude exited 1'), { costUsd: 0.5 }));
  await flush();
  const r = s.requests.get(id);
  assert.deepEqual([r.status, r.error, r.costUsd, r.step], ['fallida', 'claude exited 1', 0.5, null]);
});

test('cancel in the portal aborts the active step -> fallida cancelada, and the next request starts', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  const b = s.add('campo curp en eventos');
  s.pipeline.kick();
  await flush();
  const plan = s.last();
  s.requests.act(a, 'cancel', {});
  await s.pipeline.onAction(a, 'cancel');
  await flush();
  assert.equal(plan.signal.aborted, true);
  const r = s.requests.get(a);
  assert.deepEqual([r.status, r.error, r.step], ['fallida', 'cancelada', null]);
  assert.equal(s.requests.detail(a).events.filter((e) => e.toStatus === 'fallida').length, 1);
  assert.match(s.said[0], /^PETICIÓN #\d+ fallida · Bea: cancelada/);
  assert.equal(status(s, b), 'planificando');
  plan.ok({ costUsd: 1 }); // a late result changes nothing
  await flush();
  assert.equal(status(s, a), 'fallida');
});

test('timeout: a step past its time is aborted -> fallida', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s = setup();
    const id = s.add('reporte de becas');
    s.pipeline.kick();
    await flush();
    mock.timers.tick(STEPS.planificando.timeoutMs);
    await flush();
    assert.equal(s.last().signal.aborted, true);
    assert.deepEqual([status(s, id), s.requests.get(id).error], ['fallida', 'tiempo agotado en plan']);
  } finally {
    mock.timers.reset();
  }
});

test('paused or locked: no new step starts; shadow is ignored', async () => {
  for (const flag of ['paused', 'locked']) {
    const s = setup({ state: { [flag]: true } });
    const id = s.add('reporte de becas');
    await s.pipeline.kick();
    assert.equal(s.calls.length, 0, flag);
    assert.equal(status(s, id), 'aprobada');
    s.st[flag] = false;
    s.pipeline.kick();
    await flush();
    s.st[flag] = true; // set while plan runs: plan finishes, implement waits
    s.last().ok({ costUsd: 1 });
    await flush();
    assert.equal(s.calls.length, 1, flag);
    assert.deepEqual([status(s, id), s.requests.get(id).step], ['implementando', null]);
    s.st[flag] = false;
    s.pipeline.kick();
    await flush();
    assert.deepEqual([s.last().step, s.requests.get(id).stepAttempt], ['implement', 1]);
  }
  const sh = setup({ state: { shadow: true } });
  sh.add('reporte de becas');
  sh.pipeline.kick();
  await flush();
  assert.equal(sh.calls.length, 1);
});

test('stageLock: holders run one after another; a failing holder does not wedge it', async () => {
  const lock = createStageLock();
  const order = [];
  let release;
  const a = lock(() => new Promise((r) => { order.push('a'); release = r; }));
  const b = lock(async () => { order.push('b'); throw new Error('x'); });
  const c = lock(async () => order.push('c'));
  await flush();
  assert.deepEqual(order, ['a']);
  release();
  await a;
  await assert.rejects(b);
  await c;
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('PIPELINE_ENABLED off: nothing runs, approve says the engine is off; default steps fail with a clear reason', async () => {
  const s = setup({ enabled: false });
  const id = s.add('reporte de becas');
  await s.pipeline.onAction(id, 'approve');
  await s.pipeline.resume();
  assert.equal(s.calls.length, 0);
  assert.equal(status(s, id), 'aprobada');
  assert.match(s.said[0], /motor de peticiones apagado \(en construcción\)/);

  const d = setup({ steps: undefined });
  const real = createPipeline({ requests: d.requests, state: () => ({}), enabled: () => true, say: async () => {} });
  const id2 = d.add('campo curp');
  await real.kick();
  assert.deepEqual([status(d, id2), d.requests.get(id2).error], ['fallida', 'pendiente: B8']);
});

test('a step result with a question -> info_pedida with the question stored; the step gets say; the queue moves on', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  const b = s.add('campo curp en eventos');
  s.pipeline.kick();
  await flush();
  assert.equal(typeof s.last().say, 'function');
  s.last().ok({ costUsd: 0.7, question: '¿Por colonia o por municipio?' });
  await flush();
  const r = s.requests.get(a);
  assert.deepEqual([r.status, r.question, r.step, r.costUsd], ['info_pedida', '¿Por colonia o por municipio?', null, 0.7]);
  assert.match(s.said[0], /^PETICIÓN #\d+ necesita info · Bea: ¿Por colonia o por municipio\?/);
  assert.equal(status(s, b), 'planificando');
});

// Walks request `id` (already planificando) through plan and implement with the fake steps.
async function toReview(s) {
  s.pipeline.kick();
  await flush();
  for (const step of ['plan', 'implement']) { assert.equal(s.last().step, step); s.last().ok({ costUsd: 0 }); await flush(); }
  assert.equal(s.last().step, 'review');
}

test('a step result naming its next status: the fix round (en_revision -> implementando); a next outside TRANSITIONS -> fallida', async () => {
  const s = setup();
  const id = s.add('reporte de becas');
  await toReview(s);
  s.last().ok({ costUsd: 0.5, next: 'implementando' });
  await flush();
  assert.equal(s.last().step, 'implement');
  assert.equal(status(s, id), 'implementando');
  s.last().ok({});
  await flush();
  s.last().ok({ next: 'listo_para_entregar' });
  await flush();
  assert.deepEqual([status(s, id), s.requests.get(id).error], ['fallida', 'el paso review pidió pasar a listo_para_entregar']);
});

test('a hold: the request stays en_revision with its reason, is not re-run and does not block the queue; preprod-ok -> en_preprod', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  const b = s.add('campo curp en eventos');
  await toReview(s);
  const reviews = s.calls.length;
  s.last().ok({ costUsd: 0.5, hold: 'presets-api: package.json (dependencias)' });
  await flush();
  const r = s.requests.get(a);
  assert.deepEqual([r.status, r.step, r.hold, r.actions], ['en_revision', null, 'presets-api: package.json (dependencias)', ['cancel', 'preprod-ok']]);
  assert.ok(s.said.includes(`PETICIÓN #${a} requiere tu OK para preprod: presets-api: package.json (dependencias)`));
  // the held request does not count as the active one: the next one starts, and a kick never re-runs the review
  assert.equal(status(s, b), 'planificando');
  assert.equal(s.last().request.id, b);
  s.pipeline.kick(); // b's plan is still in flight, so this kick joins that loop
  await flush();
  assert.equal(s.calls.filter((c) => c.step === 'review' && c.request.id === a).length, 1);
  assert.equal(s.calls.length, reviews + 1);

  assert.throws(() => s.requests.act(b, 'preprod-ok', {}), { code: 'ILLEGAL_TRANSITION' });
  s.requests.act(a, 'preprod-ok', { ip: '1.2.3.4' });
  assert.deepEqual([status(s, a), s.requests.get(a).hold, s.requests.get(a).actions], ['en_preprod', null, ['cancel']]);
  assert.deepEqual(s.requests.detail(a).events.at(-1), { ...s.requests.detail(a).events.at(-1), actor: 'owner', toStatus: 'en_preprod', ip: '1.2.3.4' });
});

test('a waiting hold (preprod down): held without asking Alex; once cleared the step re-runs from attempt 1', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  await toReview(s);
  s.last().ok({});
  await flush();
  assert.equal(s.last().step, 'preprod');
  s.last().ok({ hold: 'esperando a que preprod esté arriba', wait: true });
  await flush();
  const r = s.requests.get(a);
  assert.deepEqual([r.status, r.step, r.hold, r.actions], ['en_preprod', null, 'esperando a que preprod esté arriba', ['cancel']]);
  assert.ok(s.said.includes(`PETICIÓN #${a} en espera: esperando a que preprod esté arriba`));
  assert.ok(!s.said.some((x) => x.includes('requiere tu OK')));
  s.requests.patch(a, { hold: null });
  s.pipeline.kick();
  await flush();
  assert.deepEqual([s.last().step, s.last().request.id, s.requests.get(a).stepAttempt], ['preprod', a, 1]);
});

test('a clash hold: stopped with the self-chat line, no attempt spent; clash-ok acknowledges the overlap and the step re-runs', async () => {
  const s = setup();
  const a = s.add('reporte de becas');
  await toReview(s);
  s.last().ok({});
  await flush();
  s.requests.patch(a, { clash: { signature: 'sig1', overlaps: [{ ref: '#3' }], verdict: { clash: true }, acked: null } });
  s.last().ok({ hold: 'choque con #3: ambas cambian presets', clash: true });
  await flush();
  const r = s.requests.get(a);
  assert.deepEqual([r.status, r.step, r.hold, r.actions], ['en_preprod', null, 'choque con #3: ambas cambian presets', ['cancel', 'clash-ok']]);
  assert.ok(s.said.includes(`PETICIÓN #${a} detenida por choque con #3: ambas cambian presets`), s.said.join('\n'));
  s.requests.act(a, 'clash-ok', { ip: '1.2.3.4' });
  assert.deepEqual([status(s, a), s.requests.get(a).hold, s.requests.detail(a).clash.acked], ['en_preprod', null, 'sig1']);
  assert.deepEqual(s.requests.detail(a).events.at(-1), { ...s.requests.detail(a).events.at(-1), actor: 'owner', ip: '1.2.3.4' });
  s.pipeline.kick();
  await flush();
  assert.deepEqual([s.last().step, s.last().request.id, s.requests.get(a).stepAttempt], ['preprod', a, 1]);
});
