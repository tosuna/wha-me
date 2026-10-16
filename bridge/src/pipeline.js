import { randomUUID } from 'node:crypto';
import { TRANSITIONS } from './requests.js';
import { noRunLog } from './run-log.js';

// Peticiones pipeline driver: one approved request at a time walks
// aprobada -> planificando -> implementando -> en_revision -> en_preprod -> listo_para_entregar. The state lives in the
// requests table (status, step, step_session, step_attempt, cost_usd), so a restart re-enters the step it was in.
const MIN = 60 * 1000;
// Status -> the step that runs in it. The preprod step takes the stage lock itself, only around its merge + push.
export const STEPS = {
  planificando: { step: 'plan', next: 'implementando', timeoutMs: 20 * MIN, capUsd: 4 },
  implementando: { step: 'implement', next: 'en_revision', timeoutMs: 120 * MIN, capUsd: 20 },
  en_revision: { step: 'review', next: 'en_preprod', timeoutMs: 30 * MIN, capUsd: 4 },
  en_preprod: { step: 'preprod', next: 'listo_para_entregar', timeoutMs: 75 * MIN, capUsd: 5 },
};
const MAX_ATTEMPTS = 2;
// The real steps come in B8–B11; until then an approved request fails with this reason instead of hanging.
const pending = (block) => async () => { throw new Error(`pendiente: ${block}`); };
export const DEFAULT_STEPS = { plan: pending('B8'), implement: pending('B9'), review: pending('B9'), preprod: pending('B10') };

// Promise mutex: runs fn after every earlier holder settled; a failing holder never wedges the lock.
export function createStageLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// requests: requests.js store; state(): bridge state ({paused, locked}; shadow is ignored); enabled(): PIPELINE_ENABLED
// (settings.js); say(text): self-chat line; steps[step]({ request, budgetUsd, sessionId, resume, timeoutMs, signal, onEvent, say })
// -> { costUsd, result, question?, next?, hold? } (a thrown error may carry costUsd too). question: the step needs the contact's
// answer, so the request goes to info_pedida with it instead of next (the owner decides from the portal whether to ask).
// next: a status other than the step's default (the review fix round), checked against TRANSITIONS. hold: the request stays
// in its status waiting for the owner (preprod-ok in the portal); requests.current() skips it, so the queue moves on. wait: the
// hold waits on something else (preprod down), cleared by whoever watches it (preprod-db.js createPreprodWait). clash: the hold
// is a clash with another request (clash.js), cleared by the owner's clash-ok.
export function createPipeline({
  requests, runLog = noRunLog, state, enabled, say = async () => {}, steps = DEFAULT_STEPS, newSession = randomUUID,
}) {
  let loop = null;
  let active = null; // { id, controller } of the step in flight
  const blocked = () => !enabled() || !!state().paused || !!state().locked;
  const name = (r) => r.contactName ?? r.jid;

  async function fail(id, reason) {
    requests.patch(id, { step: null, error: reason });
    if (requests.get(id).status !== 'fallida') requests.transition(id, 'fallida', { actor: 'bridge', text: reason });
    await say(`PETICIÓN #${id} fallida · ${name(requests.get(id))}: ${reason}`);
  }

  async function runStep(r, attempt, resume) {
    const def = STEPS[r.status];
    const remaining = r.budgetUsd - r.costUsd;
    if (remaining <= 0) return fail(r.id, `presupuesto agotado ($${r.costUsd.toFixed(2)} de $${r.budgetUsd.toFixed(2)})`);
    const session = resume ?? newSession();
    requests.patch(r.id, { step: def.step, stepSession: session, stepAttempt: attempt, error: null });
    const run = runLog.start({ kind: `request-${def.step}`, mode: 'real', contact: { name: r.contactName }, jid: r.jid, requestId: r.id });
    requests.event(r.id, { actor: `agent:${def.step}`, text: `paso ${def.step}, intento ${attempt}`, runId: run.id });
    const controller = new AbortController();
    active = { id: r.id, controller };
    const timer = setTimeout(() => controller.abort(`tiempo agotado en ${def.step}`), def.timeoutMs);
    timer.unref?.(); // the step itself (a claude child) keeps the bridge alive, not this timer
    // A step that ignores its signal still loses the race: cancel and timeout never wait for it.
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(controller.signal.reason)), { once: true }));
    const call = () => steps[def.step]({
      request: r, budgetUsd: Math.min(def.capUsd, remaining), sessionId: session, resume, timeoutMs: def.timeoutMs, signal: controller.signal, onEvent: run.event, say,
    });
    let out;
    let err;
    try {
      out = await Promise.race([call(), aborted]);
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
      active = null;
    }
    if (err) run.fail(err); else run.finish({ result: out?.result, outcome: 'ok' });
    const cost = Number((out ?? err)?.costUsd) || 0;
    if (cost) {
      requests.addCost(r.id, cost);
      requests.event(r.id, { actor: 'bridge', kind: 'cost', text: `${def.step}: $${cost.toFixed(2)}`, runId: run.id });
    }
    const now = requests.get(r.id);
    if (now.status !== r.status) return; // cancelled from the portal meanwhile
    if (now.costUsd > now.budgetUsd) return fail(r.id, `presupuesto excedido ($${now.costUsd.toFixed(2)} de $${now.budgetUsd.toFixed(2)})`);
    if (err) return fail(r.id, err.message);
    requests.patch(r.id, { step: null });
    if (out?.question) {
      requests.transition(r.id, 'info_pedida', { actor: `agent:${def.step}`, runId: run.id, question: out.question });
      return say(`PETICIÓN #${r.id} necesita info · ${name(now)}: ${out.question}`);
    }
    if (out?.hold) {
      const text = out.wait ? `en espera: ${out.hold}` : out.clash ? `detenida por ${out.hold}` : `requiere tu OK para preprod: ${out.hold}`;
      requests.patch(r.id, { hold: out.hold });
      requests.event(r.id, { actor: `agent:${def.step}`, text, runId: run.id });
      return say(`PETICIÓN #${r.id} ${text}`);
    }
    const to = out?.next ?? def.next;
    if (!TRANSITIONS[r.status].includes(to)) return fail(r.id, `el paso ${def.step} pidió pasar a ${to}`);
    requests.transition(r.id, to, { actor: `agent:${def.step}`, runId: run.id });
    if (to === 'listo_para_entregar') await say(`PETICIÓN #${r.id} lista para entregar · ${name(now)}: ${now.summary}`);
  }

  // A request found mid-step (step set) was interrupted by a restart: re-enter it with its session.
  async function drive() {
    while (!blocked()) {
      const cur = requests.current();
      if (cur && !cur.step) await runStep(cur, 1);
      else if (cur && cur.stepAttempt >= MAX_ATTEMPTS) await fail(cur.id, `reintentos agotados en ${cur.step}`);
      else if (cur) await runStep(cur, cur.stepAttempt + 1, cur.stepSession);
      else {
        const [next] = requests.queue();
        if (!next) return;
        requests.transition(next.id, 'planificando', { actor: 'bridge' });
      }
    }
  }

  function kick() {
    loop ??= drive().catch((e) => console.error('pipeline failed:', e.message)).finally(() => { loop = null; });
    return loop;
  }

  async function cancel(id) {
    requests.patch(id, { step: null, error: 'cancelada' });
    if (active?.id === id) active.controller.abort('cancelada');
    await say(`PETICIÓN #${id} fallida · ${name(requests.get(id))}: cancelada`);
  }

  return {
    kick,
    // At startup, after the bridge restored its pending replies.
    resume: kick,
    // After the owner's portal action succeeded (requests.act already moved the request).
    async onAction(id, action) {
      if (action === 'cancel') await cancel(id);
      if (action === 'approve' || action === 'retry') {
        const r = requests.get(id);
        const where = enabled() ? `en cola, posición ${r.queuePosition}` : 'motor de peticiones apagado (en construcción): queda en cola';
        await say(`PETICIÓN #${id} aprobada · ${name(r)}: ${r.summary}\n${where}`);
      }
      kick();
    },
  };
}
