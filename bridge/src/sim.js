import { skillDir } from './agent.js';
import { noRunLog } from './run-log.js';

// /simular sandbox: The owner writes in the self-chat as a contact and sees what the reply run would answer and
// decide. Memory only; never sends to anyone else, never enqueues jobs, never touches the contact's real state.

const TRACE_CHUNK = 3500;
const TRACE_HEAD = '[sim traza]';
const JOB_HEAD = '[sim job]';
// Progressive sim job trace: post when this many calls finished, or this long passed with at least one.
const JOB_FLUSH_CALLS = 25;
const JOB_FLUSH_MS = 60_000;
const yn = (v) => (v ? 'si' : 'no');
const words = (s) => ` ${s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
// contacts.json has one entry per jid (phone + LID), so a person can appear twice; keep the first.
const byName = (contacts) => contacts.filter((c, i) => contacts.findIndex((o) => o.name === c.name) === i);

// Name contains the query at a word start, case- and accent-insensitive ("inigo" -> "Íñigo Muestra").
function findContacts(contacts, query) {
  const q = words(query);
  return q.trim() ? byName(contacts).filter((c) => words(c.name).includes(q)) : [];
}

const kb = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// trim: path prefixes removed, in order (see trimOf).
const relative = (s, trim) => trim.reduce((out, p) => out.replaceAll(p, ''), s);
// skill: the skill dir (agent.js skillDir); root: workspace.root, or undefined. Paths under them print relative.
export const trimOf = (skill, root) => [skill, ...(root ? [`${root}/`] : [])];
const callArg = (name, i = {}) =>
  name === 'Read' ? String(i.file_path)
    : name === 'Bash' ? String(i.command).replace(/\s+/g, ' ')
    : i.pattern !== undefined ? `"${i.pattern}"${i.path ? ` in ${i.path}` : ''}`
      : JSON.stringify(i);
const outcome = (c) => (c.status === 'ok' ? `ok, ${kb(c.size)}` : { denied: 'DENEGADO', error: 'error' }[c.status] ?? 'sin resultado');

// "Read references/x.md (ok, 2.1k)": short path, clipped arg, outcome. Also used by the console trace. trim: see relative.
export const callLine = (c, trim) => {
  const bash = c.name === 'Bash';
  return `${c.name}${bash ? ':' : ''} ${clip(relative(callArg(c.name, c.input), trim), bash ? 160 : 120)} (${outcome(c)})`;
};
// calls[i] is numbered i + 1 + offset.
const callLines = (calls, trim, offset = 0) => calls.map((c, i) => `${i + 1 + offset}. ${callLine(c, trim)}`);
export const cost = (usd) => `$${usd == null ? '?' : usd.toFixed(2)}`;

// Self-chat messages of at most TRACE_CHUNK chars, each starting with head.
function chunk(head, lines) {
  const chunks = [head];
  for (const l of lines) {
    if (chunks.at(-1).length + 1 + l.length > TRACE_CHUNK) chunks.push(head);
    chunks[chunks.length - 1] += `\n${l}`;
  }
  return chunks;
}

const fmtTrace = ({ calls, durationMs, costUsd }, trim) => chunk(TRACE_HEAD, [
  ...callLines(calls, trim),
  `${calls.length} llamadas, ${durationMs == null ? '?' : (durationMs / 1000).toFixed(1)}s, ${cost(costUsd)}`,
]);

const wouldQueue = (contact, locked) => (!contact.canTriggerImplementation ? 'no (canTriggerImplementation false)' : locked ? 'no (locked)' : 'si');

function fmtJobResult({ result, calls, durationMs, costUsd }, parseJob) {
  let head;
  try {
    const out = parseJob(result);
    head = [`${JOB_HEAD} RESULT: ${out.result}`, out.report];
  } catch {
    head = [`${JOB_HEAD} RESULT: (salida sin formato)`, clip(String(result), 1500)];
  }
  const would = String(result).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('WOULD RUN:') && !head[1].includes(l));
  const min = durationMs == null ? '?' : (durationMs / 60_000).toFixed(1);
  return [...head, ...would, `${calls.length} llamadas, ${min} min, ${cost(costUsd)}`].join('\n');
}

// Each bubble is its own self-chat message, exactly as the contact would get it; then one decision message.
function fmtResult(contact, { bubbles, handoff, implement }, locked) {
  const queued = wouldQueue(contact, locked);
  const decision = [
    bubbles.length ? `[sim ${contact.name}] ` : `[sim ${contact.name}] (sin respuesta)\n`,
    handoff ? `HANDOFF: ${handoff.type} (blocking: ${handoff.blocking}) ${handoff.fields?.summary ?? ''}`.trimEnd() : 'HANDOFF: none',
    implement ? `\nIMPLEMENT: ${implement.summary} → se encolaría: ${queued}\nspec:\n${implement.spec}` : '\nIMPLEMENT: none',
  ].join('');
  return [...bubbles, decision];
}

// say: secret-guarded self-chat post. agent.runReplyTrace: the real reply run, streamed (see agent.js).
// agent.runJobSim / agent.snapshotRepos: the real job run in the OS sandbox + repo worktrees/branches (see agent.js).
// recall(contact, text): read-only topics for this turn (see topics.js recall); the sim never feeds the archivist.
// trace: console tracer (see console-trace.js), local stdout only. runLog: durable run record (see run-log.js), mode sim.
// root: workspace.root, trimmed from the paths in the traces.
export function createSim({ profile, contacts, agent, health, parse, parseJob, say, now, isLocked, recall, trace, runLog = noRunLog, root }) {
  const trim = trimOf(skillDir(profile), root);
  let session = null; // { contact, transcript, implement }
  let queue = Promise.resolve(); // one sim run at a time
  let job = null; // AbortController of the running sim job

  function start(query) {
    if (words(query) === ' fin') {
      session = null;
      job?.abort();
      return say('[sim] fin');
    }
    if (words(query) === ' job') return runJob();
    const found = findContacts(contacts, query);
    if (found.length !== 1) {
      return say(`[sim] no hay un contacto unico para "${query}". Contactos: ${byName(contacts).map((c) => c.name).join(', ')}`);
    }
    const [c] = found;
    session = { contact: c, transcript: [] };
    return say(`[sim] simulando a ${c.name} (${c.register}, ${c.tenant}, implementa: ${yn(c.canTriggerImplementation)}). Escribe como si fueras el/ella. /simular fin para salir`);
  }

  async function run(s, text) {
    if (s !== session) return; // ended or replaced while queued
    s.transcript.push({ author: 'CONTACTO', text, at: now() });
    const t = trace.turn({ mode: 'sim', contact: s.contact, jid: s.contact.jid, inbound: [text] });
    const r = runLog.start({ kind: 'reply', mode: 'sim', contact: s.contact, jid: s.contact.jid });
    try {
      const results = await health();
      const topics = await recall(s.contact, text);
      t.memory(topics);
      t.health(results);
      const onEvent = (e) => { t.event(e); r.event(e); };
      const run = await agent.runReplyTrace({ contact: s.contact, transcript: [...s.transcript], health: results, topics, onEvent });
      if (s !== session) return r.finish({ result: run.result, outcome: 'sim' });
      for (const m of fmtTrace(run, trim)) await say(m);
      const out = parse(run.result);
      t.decision(out);
      r.finish({ result: run.result, decision: out, outcome: 'sim' });
      if (out.implement) s.implement = out.implement;
      s.transcript.push(...out.bubbles.map((b) => ({ author: profile.tag, text: b, at: now() })));
      for (const m of fmtResult(s.contact, out, isLocked())) await say(m);
    } catch (e) {
      t.decision({ error: e });
      r.fail(e);
      await say(`[sim] error: ${e.message}`);
    }
  }

  // Never touches the real job queue, the store or any contact chat: only agent + say.
  async function runJob() {
    if (!session?.implement) return say('[sim] no hay spec para correr');
    if (job) return say('[sim] ya hay un job simulado corriendo');
    const ctrl = new AbortController();
    job = ctrl;
    const { contact, implement } = session;
    let posted = 0;
    let lastPost = now();
    let latest = [];
    let posting = Promise.resolve();
    // Post calls[posted..upTo) in order; they never change after posting.
    const post = (calls, upTo) => {
      const lines = callLines(calls.slice(posted, upTo), trim, posted);
      posted = upTo;
      lastPost = now();
      posting = posting.then(async () => { for (const m of chunk(JOB_HEAD, lines)) await say(m); });
    };
    const onCalls = (calls) => {
      latest = calls;
      const done = calls.findIndex((c) => c.status === 'missing');
      const ready = done === -1 ? calls.length : done; // finished prefix
      if (ready - posted >= JOB_FLUSH_CALLS || (ready > posted && now() - lastPost >= JOB_FLUSH_MS)) post(calls, ready);
    };
    try {
      await say(`${JOB_HEAD} arrancando en sandbox (red cerrada, sin credenciales)\n${contact.name}: ${implement.summary}\nel real se encolaría: ${wouldQueue(contact, isLocked())}`);
      const before = await agent.snapshotRepos();
      const r = runLog.start({ kind: 'job', mode: 'sim', contact, jid: contact.jid });
      try {
        const trace = await agent.runJobSim({ contact, implement, onCalls, onEvent: r.event, signal: ctrl.signal });
        r.finish({ result: trace.result, outcome: 'sim' });
        if (trace.calls.length > posted) post(trace.calls, trace.calls.length);
        await posting;
        await say(fmtJobResult(trace, parseJob));
      } catch (e) {
        r.fail(e);
        if (latest.length > posted) post(latest, latest.length);
        await posting;
        await say(ctrl.signal.aborted ? `${JOB_HEAD} cancelado` : `${JOB_HEAD} error: ${e.message}`);
      }
      const after = new Set(await agent.snapshotRepos());
      for (const x of before) after.delete(x);
      await say(`${JOB_HEAD} quedaron:${after.size ? `\n${[...after].map((s) => relative(s, trim)).join('\n')}` : ' nada'}`);
    } catch (e) {
      await say(`${JOB_HEAD} error: ${e.message}`);
    } finally {
      job = null;
    }
  }

  return {
    start,
    active: () => session?.contact.name ?? null,
    // Resolves when this message's run is done.
    message(text) {
      const s = session;
      queue = queue.then(() => run(s, text));
      return queue;
    },
  };
}
