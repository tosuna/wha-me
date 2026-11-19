import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

// Investigations: a reply run of a contacts.json `investigate` contact that ends with a bug/outage handoff launches, in the
// background, a longer run that can read production infrastructure (agent.js runInvestigation, infra-mcp.js). Its reply is
// a draft posted to the self-chat; only `/investigar si <n>` sends it to the contact.
const TRIGGERS = new Set(['bug', 'outage']);
const STATE_LABEL = { running: 'corriendo', 'pending-credential': 'esperando AWS', failed: 'falló', draft: 'borrador listo' };
const USAGE = 'uso: /investigar (lista), /investigar <n> (reintenta), /investigar si <n> (envía el borrador), /investigar no <n> (lo descarta)';
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];

// AWS credential check before each run: the infra MCP uses the same CLI session.
export const awsPreflight = () => promisify(nodeExecFile)('aws', ['sts', 'get-caller-identity'], { timeout: 20_000 });

// parse: core.parseAgentOutput with the bridge's options; send(jid, bubbles) -> false if blocked (bridge sendBubbles);
// paused: () => the owner's /pausa; hasInfra(contact): its tenant has knowledge.tenants.<t>.infra.
export function createInvestigations({ agent, parse, say, notify, trace, runLog, send, paused, hasInfra, preflight = awsPreflight, log }) {
  // ponytail: in memory, numbered per process; a restart loses open drafts (the owner answers by hand). Persist if that matters.
  const open = new Map(); // n -> { n, jid, contact, handoff, transcript, health, topics, state, bubbles }
  let next = 0;

  async function waitForAws(i, line) {
    i.state = 'pending-credential';
    notify({ title: 'wha-me', message: 'AWS vencido: investigación en espera', key: 'investigation-aws' });
    await say(`INVESTIGACIÓN en espera · ${i.contact.name}: la sesión de AWS se venció o no responde (${line}). Corre \`aws login\` en la Mac y manda /investigar ${i.n} para reintentar.`);
  }

  async function launch(i) {
    i.state = 'running';
    try {
      await preflight();
    } catch (e) {
      return waitForAws(i, firstLine(e));
    }
    const { n, jid, contact } = i;
    await say(`INVESTIGANDO ${n} · ${contact.name} (${String(i.handoff.fields?.summary || i.handoff.type).slice(0, 120)}). Lo ves en vivo con: tail -f ~/Library/Logs/wha-me.log | grep "investiga ${contact.name}"`);
    const t = trace.turn({ mode: 'investiga', contact, jid });
    const run = runLog.start({ kind: 'investigation', mode: 'real', contact, jid });
    let r;
    let out;
    try {
      const onEvent = (e) => { t.event(e); run.event(e); };
      r = await agent.runInvestigation({ contact, transcript: i.transcript, health: i.health, topics: i.topics, handoff: i.handoff, onEvent });
      out = parse(r.result);
    } catch (e) {
      t.decision({ error: e });
      run.fail(e);
      i.state = 'failed';
      return say(`INVESTIGACIÓN ${n} falló · ${contact.name}: ${e.message}. Manda /investigar ${n} para reintentar.`);
    }
    t.decision(out);
    const evidence = out.handoff?.fields?.evidence ?? '';
    const expired = evidence.match(/CREDENCIAL_VENCIDA:[^\n]*/);
    run.finish({ result: r.result, decision: out, outcome: expired ? 'credential' : out.bubbles.length ? 'draft' : 'no_draft' });
    if (expired) return waitForAws(i, expired[0]);
    if (!out.bubbles.length) {
      open.delete(n);
      return say(`INVESTIGACIÓN ${n} · ${contact.name}: sin borrador.\nEvidencia: ${evidence || '(ninguna)'}`);
    }
    Object.assign(i, { state: 'draft', bubbles: out.bubbles });
    return say([`BORRADOR ${n} · ${contact.name}`, ...out.bubbles, `Evidencia: ${evidence || '(ninguna)'}`,
      `Manda /investigar si ${n} para enviarlo o /investigar no ${n} para descartarlo.`].join('\n\n'));
  }

  const start = (i) => void launch(i).catch((e) => log(`investigación ${i.n} (${i.contact.name}): ${e.message}`));

  return {
    // After a reply run (bridge.js reply), shadow or live. Never awaits the investigation.
    maybeStart({ jid, contact, handoff, transcript, health, topics }) {
      if (!contact.investigate || !TRIGGERS.has(handoff?.type) || !hasInfra(contact)) return;
      const running = [...open.values()].find((i) => i.jid === jid && i.state === 'running');
      if (running) return log(`[${contact.name}] investigación ${running.n} en curso: se ignora el nuevo ${handoff.type}`);
      const i = { n: ++next, jid, contact, handoff, transcript, health, topics };
      open.set(i.n, i);
      start(i);
    },
    // /investigar <arg> -> reply text, or null when launch() posts its own messages.
    async handle(arg) {
      if (arg === '') {
        if (!open.size) return 'no hay investigaciones abiertas';
        return ['investigaciones abiertas:', ...[...open.values()].map((i) => `${i.n} · ${i.contact.name} · ${STATE_LABEL[i.state]}`)].join('\n');
      }
      const m = arg.match(/^(?:(si|sí|no)\s+)?(\d+)$/);
      if (!m) return USAGE;
      const [, verb, num] = m;
      const i = open.get(Number(num));
      if (!i) return `no hay investigación ${num}; manda /investigar para ver las abiertas`;
      const is = `la investigación ${i.n} está ${STATE_LABEL[i.state]}`;
      if (verb === 'no') {
        if (i.state === 'running') return `${is}; espera a que termine`;
        open.delete(i.n);
        return `listo, descarté la investigación ${i.n} (${i.contact.name})`;
      }
      if (verb) {
        if (i.state !== 'draft') return `${is}; no hay borrador que enviar`;
        // The owner approved: sent now, regardless of shadow and hours; never while paused.
        if (paused()) return `estás en pausa: no envié el borrador ${i.n}. Manda /sigue y luego /investigar si ${i.n}`;
        if (!(await send(i.jid, i.bubbles))) return `no envié el borrador ${i.n}: lo bloqueó el filtro de secretos`;
        open.delete(i.n);
        return 'enviado';
      }
      if (i.state !== 'pending-credential' && i.state !== 'failed') return `${is}; solo se reintenta una en espera o fallida`;
      start(i);
      return null;
    },
  };
}
