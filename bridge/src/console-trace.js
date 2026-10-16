import { callLine, cost, trimOf } from './sim.js';

// Reply-run observability on the bridge's stdout (sim and real): who wrote, recalled memory, health, the agent's
// thinking summary, tool calls and the decision. Local only: nothing here ever goes to WhatsApp.

const healthy = (h) => !h.error && h.status < 400 && h.jsonOk !== false;
const why = (h) => (h.error ? h.error : `${h.status}${h.jsonOk === false ? ', sin JSON' : ''}`);

// root: workspace.root and skill: the skill dir (agent.js skillDir), trimmed from tool call paths.
export function createConsoleTrace({ log = console.log, now = () => new Date(), root, skill = '' } = {}) {
  const trim = trimOf(skill, root);
  // One turn per reply run; its lines carry "[mode name]" so concurrent runs stay readable when interleaved.
  function turn({ mode, contact, jid, inbound = [] }) {
    const tag = `[${mode} ${contact.name}]`;
    const out = (label, text) => log(String(text).split('\n').map((l) => `${tag} ${label}: ${l}`).join('\n'));
    const calls = new Map(); // tool_use id -> { name, input }
    let end = {};
    log(`──── ${new Date(now()).toLocaleString('sv-SE')} · ${mode} · ${contact.name} (${contact.register}, ${contact.tenant}) · ${jid} ────`);
    for (const t of inbound) out('entrada', t);
    return {
      memory(m) {
        if (m instanceof Error) return out('memoria', `error: ${m.message}`);
        if (!m?.length) return out('memoria', '(sin memoria)');
        for (const l of m) out('memoria', typeof l === 'string' ? l : JSON.stringify(l));
      },
      health(results = []) {
        const bad = results.filter((h) => !healthy(h));
        out('health', `${results.length - bad.length}/${results.length} ok${bad.length ? `; falla: ${bad.map((h) => `${h.url} (${why(h)})`).join(', ')}` : ''}`);
      },
      // Pass as the reply run's onEvent. A tool prints once its result arrives (a denial arrives again at the end).
      event(e) {
        if (e.kind === 'thinking') out('piensa', e.text);
        else if (e.kind === 'text') out('texto', e.text);
        else if (e.kind === 'tool_use') calls.set(e.id, { name: e.name, input: e.input });
        else if (e.kind === 'tool_result' && calls.has(e.id)) out('tool', callLine({ ...calls.get(e.id), status: e.status, size: e.size }, trim));
        else if (e.kind === 'result') end = e;
      },
      decision({ bubbles = [], handoff, implement, approve, error }) {
        if (error) out('error', error.message);
        else {
          for (const b of bubbles.length ? bubbles : ['(sin respuesta)']) out('REPLY', b);
          out('HANDOFF', handoff ? `${handoff.type} (blocking: ${handoff.blocking}) ${handoff.fields?.summary ?? ''}`.trimEnd() : 'none');
          out('IMPLEMENT', implement ? implement.summary : 'none');
          if (approve) out('APPROVE', approve.folios?.join(', ') ?? `inválido (${approve.error})`);
        }
        out('fin', `${end.durationMs == null ? '?' : (end.durationMs / 1000).toFixed(1)}s, ${cost(end.costUsd)}`);
      },
    };
  }
  return { turn };
}
