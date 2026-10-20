import { linkGroupOf } from './contact-links.js';
import { lookupContact } from './core/allowlist.js';
import { CHANNEL_LABEL, channelOf } from './core/channel.js';
import { contactKey } from './topics.js';

// One JSON object per line; a torn or hand-edited line is skipped, never fatal.
export function parseHistory(text) {
  return text.split('\n').flatMap((line) => {
    try {
      const e = JSON.parse(line);
      return e && typeof e === 'object' && !Array.isArray(e) ? [e] : [];
    } catch {
      return [];
    }
  });
}

// history: jid -> parsed history file. Chats from before it existed fall back to the store (last 30 messages / 20 handoffs).
function entries({ store, history }, jid) {
  const h = history[jid];
  if (!h) return { messages: store.transcripts?.[jid] ?? [], handoffs: store.handoffs?.[jid] ?? [] };
  return { messages: h.filter((e) => !e.kind), handoffs: h.filter((e) => e.kind === 'handoff').map(({ kind, ...x }) => x) };
}

const jidsOf = ({ store, history }) =>
  new Set([store.transcripts, store.handoffs, store.pending, history].flatMap((o) => Object.keys(o ?? {})));

function summarize(view, jid) {
  const { store, contacts } = view;
  const c = lookupContact(contacts, jid);
  const { messages, handoffs } = entries(view, jid);
  // Open = the owner has not written in the chat since the handoff.
  const open = handoffs.filter((h) => h.at > (store.lastManual?.[jid] ?? -Infinity));
  const last = messages.at(-1) ?? null;
  return {
    jid,
    name: c?.name ?? 'desconocido',
    register: c?.register ?? null,
    tenant: c?.tenant ?? null,
    channel: channelOf(jid),
    group: c?.type === 'group' || jid.endsWith('@g.us') || /^tg:-/.test(jid),
    autoApprove: c?.autoApprove === true,
    canTriggerImplementation: c?.canTriggerImplementation === true,
    lastMessage: last,
    messageCount: messages.length,
    lastActivity: Math.max(last?.at ?? 0, handoffs.at(-1)?.at ?? 0),
    pending: store.pending?.[jid] ?? null,
    jobQueued: (store.jobs ?? []).some((j) => j.jid === jid),
    handoffs: open,
    needsIntervention: open.length > 0,
    blocking: open.some((h) => h.blocking),
  };
}

const rank = (c) => (c.blocking ? 0 : c.needsIntervention ? 1 : 2);

export function chatList(view) {
  const { store, contacts } = view;
  return {
    state: store.state ?? {},
    jobs: (store.jobs ?? []).map((j) => ({ jid: j.jid, name: lookupContact(contacts, j.jid)?.name ?? 'desconocido', summary: j.implement?.summary ?? '' })),
    chats: [...jidsOf(view)].map((jid) => summarize(view, jid)).sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity),
  };
}

export function chatDetail(view, jid) {
  if (!jidsOf(view).has(jid)) return null;
  const { messages, handoffs } = entries(view, jid);
  // Stable sort: a handoff with the same timestamp as a message stays after it.
  const timeline = [...messages.map((m) => ({ kind: 'message', ...m })), ...handoffs.map((h) => ({ kind: 'handoff', ...h }))]
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { chat: summarize(view, jid), timeline };
}

// --- agent runs: rows of state/agent-runs.db (see run-log.js) ---

// A redacted or torn JSON column stays the raw string.
const parseJson = (s) => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
};
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// One row of the chat's run list; row.tool_count comes from the query.
export function runRow(row) {
  const d = parseJson(row.decision_json);
  const h = isObject(d) && isObject(d.handoff) ? d.handoff : null;
  return {
    id: row.id, kind: row.kind, mode: row.mode, startedAt: row.started_at, durationMs: row.duration_ms, costUsd: row.cost_usd,
    outcome: row.outcome, status: row.status, toolCount: row.tool_count,
    handoff: h && { type: h.type, blocking: h.blocking },
    // Jobs carry their USER_MESSAGE bubbles too.
    preview: isObject(d) && typeof d.bubbles?.[0] === 'string' ? d.bubbles[0] : null,
    // All of them: the portal shows unsent (shadow/discarded) drafts inline in the chat.
    bubbles: isObject(d) && Array.isArray(d.bubbles) ? d.bubbles.filter((b) => typeof b === 'string') : [],
  };
}

export function runDetail(run, events) {
  return {
    id: run.id, kind: run.kind, mode: run.mode, contactName: run.contact_name, jid: run.jid, startedAt: run.started_at, endedAt: run.ended_at,
    durationMs: run.duration_ms, costUsd: run.cost_usd,
    tokens: { input: run.input_tokens, output: run.output_tokens, cacheRead: run.cache_read_tokens, cacheCreation: run.cache_creation_tokens },
    model: run.model, skillCommit: run.skill_commit, status: run.status, outcome: run.outcome, resultText: run.result_text,
    decision: parseJson(run.decision_json), error: run.error, requestId: run.request_id ?? null,
    events: events.map((e) => ({
      seq: e.seq, at: e.at, kind: e.kind, name: e.name, input: parseJson(e.input_json), status: e.status, size: e.size, text: e.text,
      toolUseId: e.tool_use_id ?? null, parentToolUseId: e.parent_tool_use_id ?? null,
    })),
  };
}

// --- Fábrica: the Peticiones pipeline as an engineering org (portal Peticiones > Fábrica) ---

const STATION = {
  nueva: 'intake', info_pedida: 'intake', aprobada: 'planning', planificando: 'planning', implementando: 'engineering',
  en_revision: 'review', en_preprod: 'signoff', listo_para_entregar: 'signoff', fallida: 'blocked', rechazada: 'closed',
};
// request row (requests.js) + its request_events -> { station, failedAt }. A review hold waits for the owner, so it is their
// sign-off; a failed request is `blocked`, failedAt = the station of the last status it had before failing.
export function stationOf(r, events = []) {
  if (r.status === 'en_revision' && r.hold) return { station: 'signoff', failedAt: null };
  const station = STATION[r.status] ?? 'closed';
  if (station !== 'blocked') return { station, failedAt: null };
  const before = events.filter((e) => e.kind === 'status' && e.toStatus && e.toStatus !== 'fallida').at(-1)?.toStatus;
  const at = STATION[before];
  return { station, failedAt: at && at !== 'blocked' && at !== 'closed' ? at : null };
}

// request_events -> what the preprod step (preprod-step.js) did: branch pushes, PRs, stage, deploy result. url: the
// github.com link in its text, if any (the page links only those). The driver's own step notes carry a runId: left out.
const GH_URL = /https:\/\/github\.com\/[\w./#?=&%-]+/;
export const preprodOf = (events) => events.filter((e) => e.actor === 'agent:preprod' && ['push', 'pr', 'note'].includes(e.kind) && e.runId == null)
  .map((e) => ({ at: e.at, kind: e.kind, text: e.text, url: String(e.text ?? '').match(GH_URL)?.[0] ?? null }));

const AGENT_TOOLS = ['Agent', 'Task'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The whole token: pet/9-api must not match pet/9-api-v2.
const mentions = (text, s) => !!s && new RegExp(`${escapeRe(s)}(?![\\w-])`).test(text);
// The plan block an implementer prompt is about: its spec path, else its branch or worktree (the spec's ## Project line).
const blockOf = (prompt, blocks) => {
  const p = String(prompt ?? '');
  const spec = p.match(/specs\/([a-z0-9-]{1,30})\.md/)?.[1];
  return blocks.find((b) => b.key === spec)?.key ?? blocks.find((b) => mentions(p, b.branch) || mentions(p, b.worktree))?.key ?? spec ?? null;
};

// runDetail events (or just the tool_use ones) -> one entry per Agent/Task call: its subagent, the plan block it works on,
// status (missing = still running), its own tool calls and errors. blocks: the request's blocks_json.
export function subagents(events, blocks = []) {
  return events.filter((e) => e.kind === 'tool_use' && AGENT_TOOLS.includes(e.name) && e.toolUseId).map((e) => {
    const own = events.filter((x) => x.parentToolUseId === e.toolUseId);
    const tools = own.filter((x) => x.kind === 'tool_use');
    const input = isObject(e.input) ? e.input : {};
    return {
      toolUseId: e.toolUseId, seq: e.seq, at: e.at, lastAt: own.at(-1)?.at ?? e.at,
      subagentType: input.subagent_type ?? null, description: input.description ?? null, block: blockOf(input.prompt, blocks),
      status: e.status, toolCount: tools.length, errors: tools.filter((x) => x.status === 'error' || x.status === 'denied').length,
    };
  });
}

const localDay = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

// Today / this month in local time (tz: the profile timezone), overall and per contact (most expensive first).
// rows: { contact_name, started_at, cost_usd }.
export function costTotals(rows, now, tz) {
  const today = localDay(now, tz);
  const total = (keep) => {
    const by = new Map();
    let costUsd = 0;
    let runs = 0;
    for (const r of rows) {
      if (!keep(localDay(r.started_at, tz))) continue;
      const name = r.contact_name ?? 'desconocido';
      const c = by.get(name) ?? { name, costUsd: 0, runs: 0 };
      by.set(name, c);
      c.costUsd += r.cost_usd ?? 0;
      c.runs += 1;
      costUsd += r.cost_usd ?? 0;
      runs += 1;
    }
    return { costUsd, runs, byContact: [...by.values()].sort((a, b) => b.costUsd - a.costUsd) };
  };
  return { today: total((d) => d === today), month: total((d) => d.slice(0, 7) === today.slice(0, 7)) };
}

// Every chat the owner can see for Enlazar contactos (contacts.json, memory-only, seen; the first listing of a jid wins),
// groups included so a link to one is refused by kind. -> [{ jid, name, kind, source, channel, label }]
export function knownChats({ contacts, memory, seen }) {
  const all = [
    ...contacts.map((c) => ({ jid: c.jid, name: c.name, kind: c.type === 'group' ? 'group' : 'private', source: 'contacts' })),
    ...memory.map((c) => ({ jid: c.jid, name: c.name, kind: c.kind, source: 'memory' })),
    ...seen.map((c) => ({ jid: c.jid, name: c.name ?? null, kind: c.kind, source: 'seen' })),
  ].filter((c, i, a) => !lookupContact(a.slice(0, i), c.jid));
  return all.map((c) => ({ ...c, channel: channelOf(c.jid), label: CHANNEL_LABEL[channelOf(c.jid)] }));
}

// Same or prefix name once normalized ("Carlos" ~ "Carlos Pérez"): a hint, never identity.
const alike = (a, b) => {
  const [x, y] = [contactKey(a ?? ''), contactKey(b ?? '')];
  return !!x && !!y && (x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`));
};

// The private chats, the current links (members resolved to chats), and WhatsApp<->Telegram pairs with alike names, neither
// linked yet: only SUGGESTED, the owner confirms each one. A contacts.json person listed under several WhatsApp jids (phone +
// LID, same name) is suggested once.
export function linkView({ contacts, memory, seen, links }) {
  const all = knownChats({ contacts, memory, seen });
  const chats = all.filter((c) => c.kind === 'private');
  const member = (jid) => lookupContact(all, jid) ?? { jid, name: null, channel: channelOf(jid), label: CHANNEL_LABEL[channelOf(jid)] };
  const free = chats.filter((c) => !linkGroupOf(links, c.jid));
  const seenPairs = new Set();
  const suggestions = free.filter((a) => a.channel === 'whatsapp').flatMap((a) => free.filter((b) => b.channel === 'telegram' && alike(a.name, b.name)).map((b) => ({ a, b })))
    .filter(({ a, b }) => {
      const k = `${a.source === 'contacts' ? contactKey(a.name) : a.jid}|${b.jid}`;
      return !seenPairs.has(k) && seenPairs.add(k);
    });
  return { chats, links: links.map((g) => ({ jids: g.jids, members: g.jids.map(member) })), suggestions };
}
