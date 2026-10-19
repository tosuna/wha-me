import { none as noActions, reviewHint } from './actions.js';
import { createConsoleTrace } from './console-trace.js';
import { isPersona, lookupContact, respondToOf } from './core/allowlist.js';
import { noFeedback } from './feedback.js';
import { noRequests } from './requests.js';
import { noRunLog } from './run-log.js';
import { createSim } from './sim.js';
import { contactKey, opaqueKey } from './topics.js';

// WhatsApp composing presence expires after ~10 s, so refresh it while "typing".
const COMPOSING_REFRESH_MS = 8000;
// A chat is archived into the topic memory once it has been quiet this long; with no cursor, catch-up starts this far back.
export const ARCHIVE_QUIET_MS = 3 * 60 * 1000;
const CATCH_UP_MS = 30 * 24 * 60 * 60 * 1000;
// Messages per archivist run: a long backlog (first catch-up) goes in several runs, each one moving the cursor.
export const ARCHIVE_BATCH = 60;
const SHADOW_EVENT = '(sombra: borrador no enviado) ';

// One memory key per chat: a group's jid; for a contacts.json person listed under several jids (phone + LID, same name), the
// first one. A memory-only chat keeps its own jid: its name is a display name, never merged with anyone by it.
// contacts.json wins over memory-chats.json. Also used by seed-memory.js. -> { jid, name, kind } | null
export function canonicalChat(jid, contacts, memory = []) {
  const contact = lookupContact(contacts, jid);
  const c = contact ?? lookupContact(memory, jid);
  if (!c) return null;
  const kind = c.type === 'group' || c.kind === 'group' ? 'group' : 'private';
  const key = kind === 'group' || !contact ? c.jid : contacts.find((p) => p.type !== 'group' && contactKey(p.name) === contactKey(c.name)).jid;
  return { jid: key, name: c.name, kind };
}

// First batch of a time-sorted backlog, cut at a timestamp boundary: the next run reads only at > cursor, so a tie split
// across two batches would be lost. A tie longer than max goes whole.
export function takeBatch(sorted, max) {
  if (sorted.length <= max) return sorted;
  const edge = sorted[max].at;
  const cut = sorted.findIndex((e) => e.at === edge);
  return cut > 0 ? sorted.slice(0, cut) : sorted.filter((e) => e.at === edge);
}

const fmtHandoff = (contact, h) =>
  [
    `HANDOFF · ${contact.name}`,
    `type: ${h.type}`,
    `blocking: ${h.blocking}`,
    ...Object.entries(h.fields ?? {})
      .filter(([k]) => k !== 'type' && k !== 'blocking')
      .map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

// A delivered handoff worth remembering (identity: never; feature-request: remembered as the request).
const handoffEvent = (h, bubbles) => h && h.type !== 'identity' && h.type !== 'feature-request' && bubbles.length;
const fmtHandoffEvent = (h, bubbles, shadow) => `handoff ${h.type}: ${h.fields?.summary ?? h.type}; ${shadow ? 'borrador' : 'respondimos'}: ${bubbles.join(' / ')}`;

const fmtImplement = (i) => `IMPLEMENT: ${i.summary}\nspec:\n${i.spec}`;

const fmtDraft = (tag, contact, { bubbles, handoff, implement }) =>
  [
    `${tag} → ${contact.name}:`,
    ...bubbles,
    ...(handoff ? [fmtHandoff(contact, handoff)] : []),
    ...(implement ? [fmtImplement(implement)] : []),
  ].join('\n\n');

// What an auto-approval contact hears when the approval did not happen (same as the skill's approval ack).
const cannedAck = (contact) => (contact.register === 'usted' ? 'Buen dia, lo checo' : 'Buen dia, va lo checo');
// The directive's ids as one label ("X-27, X-28"), or null when it was malformed.
const folioList = (approve) => approve.folios?.join(', ') ?? null;

// /grupos: every group the owner is in, to fill contacts.json (group jid, respondTo jids).
const fmtGroups = (groups) => {
  const list = Object.values(groups ?? {});
  if (!list.length) return 'no estoy en ningun grupo';
  return list.map((g) => [
    `${g.subject} · ${g.id}`,
    ...(g.participants ?? []).map((p) => `  - ${p.id}${p.phoneNumber ? ` · ${p.phoneNumber}` : ''}${p.lid ? ` · ${p.lid}` : ''}`),
  ].join('\n')).join('\n\n');
};

const SECRET_ALERT = 'ALERT · outbound message blocked: it matched a secret pattern. Nothing was sent; check the agent run.';

// health: () => Promise<health results> (see health.js); leaks: (text) => boolean (see secrets.js);
// topics: cross-chat topic memory (see topics.js), recalled for every reply run; archivist: turns each feeding chat's new
// messages (+ bridge events) into topic ops (see archivist.js); memoryChats: { list() } chats that only feed the memory
// (see memory-chats.js), never answered. Every contacts.json chat feeds it too. seenChats: { record() } registry of the
// chats in neither list (see seen-chats.js), so the portal can offer them; never their text.
// trace: console tracer of every reply run (see console-trace.js), stdout only; silent by default.
// notify: macOS alert for blocking events (see notify.js), real contacts only; no-op by default.
// runLog: durable record of every agent run, real and sim (see run-log.js); no-op by default.
// actions: the ActionAdapter behind an agent `APPROVE:` directive (config actions, see actions.js); refuses by default.
// feedback: draft vs what the owner really sent, per chat (see feedback.js); no-op by default.
// learner: the /aprender self-chat command (see learn.js), handle(arg, say) -> reply text.
// requests: Peticiones store (see requests.js); a feature-request handoff creates or merges one. No-op by default.
// portalLink: () => the portal login link (carries the portal token) or null without a tunnel; for the /portal command.
// stageLock(fn): mutex shared with the Peticiones pipeline (pipeline.js), so a job and a request never push stage together.
// log: short console lines (group silences, unknown group members).
// profile: the owner (config profile): tag is the persisted author of the owner's messages, tag.toLowerCase() their person key.
// workspace: config workspace (its root is trimmed from /simular trace paths).
export function createBridge({
  profile, workspace, wa, store, agent, clock, contacts, selfJid, core, health, leaks, topics, archivist, memoryChats = { list: () => [] }, seenChats = { record() {} }, trace = createConsoleTrace({ log: () => {} }), notify = () => {}, runLog = noRunLog,
  actions = noActions(), feedback = noFeedback,
  learner = { handle: async () => 'aprendizaje no configurado' }, portalLink = () => null, requests = noRequests, stageLock = (fn) => fn(), log = console.log,
}) {
  const OWNER = profile.tag;
  const ownerKey = OWNER.toLowerCase();
  const RESERVED_AUTHORS = new Set([OWNER, 'CONTACTO', 'BRIDGE']);
  // Each bump uses the delay set right before it, so its due time can be persisted (restored on restart).
  let nextDelay = 0;
  const debouncer = core.createDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delayMs: () => nextDelay,
  });
  const unread = new Map(); // jid -> message keys to mark read when we answer
  const busy = new Set(); // jids with a reply run in flight
  const triggers = new Map(); // group jid -> latest respondTo message { key, message }, quoted by the reply
  const spoke = new Map(); // group jid -> count of messages from anyone outside respondTo (the owner included)
  const asked = new Map(); // jid -> count of messages that schedule a reply (contact, or a respondTo member)
  const strangers = new Set(); // group members already logged as not in respondTo
  const notes = new Map(); // jid -> the owner's note (portal "Pedir info") for the next reply run, used once
  let jobRunning = false;

  // Every self-chat message passes the secret guard too (say). Its id is recorded so an echo is never read as the owner's input.
  const post = (text) => wa.sendText(selfJid, text)
    .then((id) => store.addSentId(id))
    .catch((e) => console.error('self-chat send failed:', e.message));
  const say = (text) => post(leaks(text) ? SECRET_ALERT : text);
  const msUntilOpening = () => {
    const now = clock.now();
    return core.nextOpening(now, profile) - now + core.replyDelayMs();
  };
  const sim = createSim({
    profile, contacts, agent, health, parse: (text) => core.parseAgentOutput(text, { idPattern: actions.idPattern }), parseJob: core.parseJobOutput, say, recall: (c, text) => recallTopics(c.jid, c.name, text), trace, runLog,
    now: () => clock.now().getTime(), isLocked: () => store.getState().locked, root: workspace?.root,
  });
  const contactOf = (jid) => core.lookupContact(contacts, jid);
  const memoryChatOf = (jid) => (contactOf(jid) ? null : core.lookupContact(memoryChats.list(), jid)); // contacts.json wins
  const people = contacts.filter((c) => c.type !== 'group');
  // Persona chats never feed the topic memory (archive, events, catch-up) nor the learning pairs.
  const chatOf = (jid) => (isPersona(contactOf(jid)) ? null : canonicalChat(jid, contacts, memoryChats.list()));
  const feedbackOf = (jid) => (isPersona(contactOf(jid)) ? noFeedback : feedback);
  // contacts.json `anyHour: true`: that chat ignores profile.hours.
  const inHours = (jid) => !!contactOf(jid)?.anyHour || core.isWithinHours(clock.now(), profile);
  // contacts.json `live: true`: that chat runs as if shadow were off (trial one chat live while the rest stays in shadow).
  const shadowFor = (jid) => !!store.getState().shadow && !contactOf(jid)?.live;
  const jidsOf = (chat) => (chat.kind === 'group' || !contactOf(chat.jid) ? [chat.jid]
    : people.filter((p) => contactKey(p.name) === contactKey(chat.name)).map((p) => p.jid));
  const alertIncident = (job, contact, reason) => notify({
    title: 'wha-me: bridge bloqueado',
    message: `${reason} · ${contact?.name ?? job.jid}: ${job.implement.summary}`,
    key: `incident:${job.jid}:${job.implement.summary}`,
  });
  // Shadow is for watching the agent: no human-like delay and no business-hours wait (nothing reaches the contact).
  const replyDelay = (jid) => (shadowFor(jid) ? core.shadowDelayMs() : isPersona(contactOf(jid)) ? core.personaDelayMs() : core.replyDelayMs());
  const ownerActive = (jid) => core.isOwnerActive(store.getLastManualFromMeAt(jid), clock.now());

  // --- topic memory ---
  const archiveTimers = new Map(); // chat key -> quiet timer
  const events = new Map(); // chat key -> bridge events waiting for the chat's next archive batch
  const queued = new Set();
  let archiving = Promise.resolve(); // one archive run at a time, globally

  function recallTopics(jid, person, text) {
    try {
      return topics.recall({ person, chat: chatOf(jid), text, now: clock.now().getTime() });
    } catch (e) {
      console.error('topics recall failed:', e.message);
      return [];
    }
  }

  // Every stored message (contact, member, the owner, our bubbles) re-arms its chat's quiet timer.
  function append(jid, entry) {
    store.appendTranscript(jid, entry);
    touchArchive(jid);
  }

  function touchArchive(jid) {
    const chat = chatOf(jid);
    if (!chat) return;
    clock.clearTimer(archiveTimers.get(chat.jid));
    archiveTimers.set(chat.jid, clock.setTimer(() => { archiveTimers.delete(chat.jid); return queueArchive(chat.jid); }, ARCHIVE_QUIET_MS));
  }

  // What happened to the contact because of the bridge, for the archivist. Shadow drafts too, flagged.
  // ponytail: kept in memory; lost on restart if the chat was not archived before. Persist them if that matters.
  function remember(jid, text) {
    const chat = chatOf(jid);
    if (!chat) return;
    const entry = { author: 'BRIDGE', name: 'bridge', person: 'bridge', text: `${shadowFor(jid) ? SHADOW_EVENT : ''}[evento] ${text}`, at: clock.now().getTime() };
    events.set(chat.jid, [...(events.get(chat.jid) ?? []), entry]);
    touchArchive(jid);
  }

  function queueArchive(key) {
    if (!queued.has(key)) {
      queued.add(key);
      archiving = archiving.then(() => { queued.delete(key); return archiveChat(key); });
    }
    return archiving;
  }

  // [{ name, key }] the archivist may add as participants: contacts.json (and respondTo) names first, so they win over an
  // equal memory-only name, which is dropped.
  const knownPeople = () => {
    const seen = new Set();
    return [
      ...[...people, ...contacts.flatMap((c) => c.respondTo ?? [])].map((p) => ({ name: p.name, key: contactKey(p.name) })),
      ...memoryChats.list().filter((m) => m.kind === 'private' && !contactOf(m.jid)).map((m) => ({ name: m.name, key: opaqueKey(m.jid) })),
    ].filter((p) => !seen.has(contactKey(p.name)) && seen.add(contactKey(p.name)));
  };

  // Archive identity of a history entry, from jids only (names are labels): the owner; the bridge's own bubbles; a contacts.json
  // private chat or respondTo member; a group sender whose jid is a contact or any group's respondTo member; else opaque.
  const memberOf = (jid) => core.lookupContact(people, jid) ?? contacts.map((g) => respondToOf(g, [jid])).find(Boolean);
  function personOf(chat, e) {
    if (e.author === OWNER) return e.bot ? 'bridge' : ownerKey;
    if (chat.kind === 'private') return contactOf(chat.jid) ? contactKey(chat.name) : opaqueKey(chat.jid);
    if (e.respondTo) return contactKey(e.author);
    if (!e.by) return opaqueKey(e.author, 'anon'); // legacy entry: only a display name
    const m = memberOf(e.by);
    return m ? contactKey(m.name) : opaqueKey(e.by);
  }

  // The chat's full history after its cursor (all its jids) + pending events -> archivist. The cursor only moves on success.
  // Runs regardless of shadow/paused/hours. Never throws.
  async function archiveChat(key) {
    const chat = chatOf(key);
    if (!chat) return;
    let run;
    try {
      const since = topics.cursor(chat.jid) ?? clock.now().getTime() - CATCH_UP_MS;
      const all = jidsOf(chat).flatMap((j) => store.getHistory(j)).filter((e) => !e.kind && e.at > since).sort((a, b) => a.at - b.at);
      const msgs = takeBatch(all, ARCHIVE_BATCH);
      const evs = events.get(chat.jid) ?? [];
      const name = (e) => (e.author === OWNER ? (e.bot ? 'bridge' : ownerKey) : e.author === 'CONTACTO' ? chat.name : e.author);
      const entries = [...msgs.map((e) => ({ author: e.author, name: name(e), person: personOf(chat, e), text: e.text, at: e.at })), ...evs]
        .sort((a, b) => a.at - b.at);
      if (!entries.length) return;
      run = runLog.start({ kind: 'archive', mode: 'real', contact: { name: chat.name } });
      const r = await archivist.archive({ chat, entries, knownPeople: knownPeople() });
      run.event({ kind: 'result', costUsd: r.costUsd ?? null, model: 'haiku' });
      if (r.error) throw new Error(r.error);
      events.set(chat.jid, (events.get(chat.jid) ?? []).filter((e) => !evs.includes(e)));
      if (msgs.length) topics.setCursor(chat.jid, msgs.at(-1).at);
      run.finish({ outcome: 'archived', decision: { applied: r.applied, rejected: r.rejected.length } });
      if (all.length > msgs.length) queueArchive(chat.jid); // rest of the backlog
    } catch (e) {
      run?.fail(e);
      log(`archive ${chat.name} failed (retries on its next message or restart): ${e.message}`);
    }
  }

  // Startup: every feeding chat (contacts.json + memory-only) catches up from its cursor.
  function catchUpArchive() {
    const keys = new Set([...contacts, ...memoryChats.list()].map((c) => chatOf(c.jid)?.jid).filter(Boolean));
    for (const key of keys) queueArchive(key);
    return drain();
  }

  // Resolves once the archive queue is empty, including runs queued meanwhile.
  async function drain() {
    let p;
    do { p = archiving; await p; } while (p !== archiving);
  }

  async function handleMessage(msg) {
    if (!msg.text) return;
    if (msg.chatJid === selfJid) {
      if (store.isSentId(msg.id)) return;
      const text = msg.text.trim();
      if (/^\/simular(\s|$)/i.test(text)) return sim.start(text.slice('/simular'.length).trim());
      if (/^\/aprender(\s|$)/i.test(text)) return say(await learner.handle(text.slice('/aprender'.length).trim().toLowerCase(), say));
      if (/^\/grupos$/i.test(text)) return say(await wa.fetchGroups().then(fmtGroups, (e) => `ERROR /grupos: ${e.message}`));
      // The one self-chat post exempt from the secret guard: the login link carries the portal token on purpose.
      if (/^\/portal$/i.test(text)) {
        const link = portalLink();
        return link ? post(`Portal (válido hasta que cierres el túnel):\n${link}`) : say('no hay túnel; corre npm run tunnel');
      }
      if (msg.text.startsWith('/')) await command(text);
      else if (sim.active()) await sim.message(msg.text);
      return;
    }
    const jid = msg.chatJid;
    const contact = contactOf(jid);
    if (!contact) return memoryOnly(msg);
    if (contact.type === 'group') return groupMessage(contact, msg);
    if (msg.fromMe) {
      if (store.isSentId(msg.id)) return;
      store.setLastManualFromMeAt(jid, msg.timestamp);
      append(jid, { author: OWNER, text: msg.text, at: msg.timestamp });
      feedbackOf(jid).manual(jid, msg.text, msg.timestamp);
      debouncer.cancel(jid);
      store.clearPending(jid);
      unread.delete(jid);
      return;
    }
    append(jid, { author: 'CONTACTO', text: msg.text, at: msg.timestamp });
    feedbackOf(jid).contact(jid, msg.timestamp);
    asked.set(jid, (asked.get(jid) ?? 0) + 1);
    unread.set(jid, [...(unread.get(jid) ?? []), msg.key]);
    schedule(jid, replyDelay(jid));
  }

  // pushName is set by the member: never let it pose as one of the reserved authors.
  const memberName = (msg) => (RESERVED_AUTHORS.has(msg.pushName) ? null : msg.pushName) || 'MIEMBRO';

  // A memory-only chat: stored for the archivist, nothing else (no reply, handoff, feedback, unread or debounce).
  // A chat in neither list only lands in the seen-chats registry (its pushName is ours when fromMe).
  function memoryOnly(msg) {
    const chat = memoryChatOf(msg.chatJid);
    if (!chat) return seenChats.record({ jid: msg.chatJid, name: msg.fromMe ? null : msg.pushName, kind: 'private', at: msg.timestamp });
    if (msg.fromMe && store.isSentId(msg.id)) return;
    const author = msg.fromMe ? OWNER : chat.kind === 'group' ? memberName(msg) : 'CONTACTO';
    append(msg.chatJid, { author, ...(author !== OWNER && chat.kind === 'group' && { by: msg.participant }), text: msg.text, at: msg.timestamp });
  }

  // Every member's message goes to the transcript; only a respondTo member schedules a reply, anyone else
  // (a teammate or the owner) cancels the pending one: the team already answered. In a persona group only the owner does.
  function groupMessage(group, msg) {
    const jid = msg.chatJid;
    if (msg.fromMe && store.isSentId(msg.id)) return;
    const member = msg.fromMe ? null : respondToOf(group, msg.participantIds);
    if (!member) {
      append(jid, msg.fromMe ? { author: OWNER, text: msg.text, at: msg.timestamp } : { author: memberName(msg), by: msg.participant, text: msg.text, at: msg.timestamp });
      if (msg.fromMe) {
        store.setLastManualFromMeAt(jid, msg.timestamp);
        feedbackOf(jid).manual(jid, msg.text, msg.timestamp);
      } else if (!strangers.has(msg.participant)) {
        strangers.add(msg.participant);
        log(`group ${group.name}: ${(msg.participantIds ?? []).join(' / ')} (${msg.pushName ?? 'sin nombre'}) is not in respondTo`);
      }
      if (!msg.fromMe && isPersona(group)) return; // banter: friends talking is context, not the team answering
      spoke.set(jid, (spoke.get(jid) ?? 0) + 1);
      debouncer.cancel(jid);
      store.clearPending(jid);
      unread.delete(jid);
      triggers.delete(jid);
      return;
    }
    append(jid, { author: member.name, by: msg.participant, text: msg.text, at: msg.timestamp, respondTo: true });
    feedbackOf(jid).contact(jid, msg.timestamp);
    asked.set(jid, (asked.get(jid) ?? 0) + 1);
    unread.set(jid, [...(unread.get(jid) ?? []), msg.key]);
    triggers.set(jid, { key: msg.key, message: msg.message });
    schedule(jid, replyDelay(jid));
  }

  // One pending reply per chat (debounce, next opening, or retry), persisted in the store.
  function schedule(jid, ms) {
    nextDelay = ms;
    store.setPending(jid, clock.now().getTime() + ms);
    debouncer.bump(jid, () => fire(jid));
  }

  const defer = (jid) => schedule(jid, msUntilOpening());

  async function fire(jid) {
    const due = store.getPending()[jid];
    try {
      await reply(jid);
    } catch (e) {
      await say(`ERROR reply · ${contactOf(jid)?.name ?? jid}\n${e.message}`);
    } finally {
      // Cleared only after the run, so a crash mid-run is restored on restart; a reschedule meanwhile keeps its new due.
      if (store.getPending()[jid] === due) store.clearPending(jid);
    }
  }

  async function restorePending() {
    const now = clock.now().getTime();
    const names = [];
    for (const [jid, due] of Object.entries(store.getPending())) {
      const contact = contactOf(jid);
      if (!contact) { store.clearPending(jid); continue; }
      schedule(jid, Math.max(0, due - now)); // overdue -> fire now; reply() defers if out of hours
      names.push(contact.name);
    }
    if (names.length) await say(`restored pending replies: ${names.join(', ')}`);
  }

  async function reply(jid) {
    if (store.getState().paused) return;
    if (!shadowFor(jid) && !inHours(jid)) return defer(jid);
    if (ownerActive(jid)) return;
    if (busy.has(jid)) return schedule(jid, replyDelay(jid));

    const contact = contactOf(jid);
    const group = contact.type === 'group';
    const persona = isPersona(contact);
    const spoke0 = spoke.get(jid) ?? 0;
    const asked0 = asked.get(jid) ?? 0;
    let out;
    let raw;
    let t;
    let run;
    let transcript;
    let label = contact.name;
    busy.add(jid);
    try {
      const results = persona ? [] : await health(); // a persona run gets no health, topics or work data
      transcript = store.getTranscript(jid); // read after the health check, as before: it can take seconds
      const asking = group ? (e) => e.respondTo : (e) => e.author === 'CONTACTO';
      const inbound = transcript.slice(transcript.findLastIndex((e) => !asking(e)) + 1).map((e) => e.text);
      if (group) label = `${contact.name} (grupo, responde a ${transcript.findLast(asking)?.author ?? '?'})`;
      t = trace.turn({ mode: 'real', contact, jid, inbound });
      run = runLog.start({ kind: 'reply', mode: 'real', contact, jid });
      const recalled = persona ? [] : recallTopics(jid, group ? transcript.findLast(asking)?.author : contact.name, inbound.join('\n'));
      t.memory(recalled);
      t.health(results);
      const onEvent = (e) => { t.event(e); run.event(e); };
      const note = notes.get(jid);
      notes.delete(jid);
      const openRequests = requests.open(jid, { shadow: shadowFor(jid) });
      raw = await agent.runReply({ contact, transcript, health: results, topics: recalled, openRequests, onEvent, ...(note && { note }) });
      out = core.parseAgentOutput(raw, { idPattern: actions.idPattern });
      // A persona may only REPLY: anything else (handoff, implement, approve) is no reply at all.
      if (persona && (out.handoff || out.implement || out.approve)) out = { bubbles: [], handoff: null, implement: null, approve: null };
    } catch (e) {
      t?.decision({ error: e });
      run?.fail(e);
      throw e;
    } finally {
      busy.delete(jid);
    }
    t.decision(out);
    // New messages arrived mid-run and a later run is scheduled with all of them: this run's output is stale.
    // (the owner writing after them cleared that run, so the draft still goes out as [descartado] below.)
    if ((asked.get(jid) ?? 0) !== asked0 && store.getPending()[jid] !== undefined) {
      log(`[${label}] superseded: llegaron mensajes nuevos durante la corrida`);
      run.finish({ result: raw, decision: out, outcome: 'superseded' });
      return;
    }
    let outcome;
    try {
      outcome = await act(jid, contact, out, run, { label, teamSpoke: () => (spoke.get(jid) ?? 0) !== spoke0 });
    } catch (e) {
      run.fail(e);
      throw e;
    }
    run.finish({ result: raw, decision: out, outcome });
    feedbackOf(jid).draft({ runId: run.id, jid, contact, out, outcome, transcript });
  }

  // What happens to a parsed reply; resolves its run-log outcome.
  // label: the contact name, or for a group its name + who triggered; teamSpoke: someone outside respondTo wrote meanwhile.
  async function act(jid, contact, out, run, { label = contact.name, teamSpoke = () => false } = {}) {
    let { bubbles, handoff } = out;
    const { implement, approve } = out;
    // Nothing to say = the agent judged it needs no answer (group or 1:1): no draft, no message.
    if (!bubbles.length && !handoff && !implement && !approve) {
      log(`[${contact.name}] silencio: nada que responder`);
      return 'silent';
    }
    // The agent's own blocking judgment (e.g. an incident) always vetoes an APPROVE in the same run.
    const veto = approve && handoff?.blocking ? `el agente marcó el caso como bloqueante (${handoff.type})` : null;
    // Persisted for the portal before any early return, shadow drafts included (never for /simular: the sim has no store).
    if (handoff) store.addHandoff(jid, { type: handoff.type, blocking: handoff.blocking, summary: handoff.fields?.summary ?? '', at: clock.now().getTime(), shadow: shadowFor(jid) });
    // Peticiones: shadow too (flagged), even if the draft is discarded below; never for /simular.
    if (handoff?.type === 'feature-request') {
      const shadow = shadowFor(jid);
      const r = requests.fromHandoff(jid, contact, handoff, { shadow });
      if (r) {
        await say(`${shadow ? '[sombra] ' : ''}PETICIÓN #${r.id} · ${contact.name}: ${r.summary}`);
        remember(jid, `petición #${r.id} registrada: ${r.summary} (${r.status})`);
      }
    }
    if (handoff?.blocking) {
      const summary = handoff.fields?.summary || handoff.type;
      notify({ title: 'wha-me: necesitas intervenir', message: `${shadowFor(jid) ? '(sombra) ' : ''}${contact.name}: ${summary}`, key: `handoff:${jid}:${handoff.type}:${summary}` });
    }

    if (shadowFor(jid)) {
      await say(fmtDraft('[sombra]', { ...contact, name: label }, out));
      if (handoffEvent(handoff, bubbles)) remember(jid, fmtHandoffEvent(handoff, bubbles, true));
      if (implement && contact.canTriggerImplementation) remember(jid, `implementación pendiente: ${implement.summary}`);
      if (approve) {
        const refused = veto ?? actions.precheck(contact, approve);
        await say(refused ? `[sombra] no aprobaría ${folioList(approve) ?? '(folio inválido)'}: ${refused}` : `[sombra] aprobaría ${folioList(approve)}`);
      }
      return 'shadow';
    }

    // Re-check: the agent run takes minutes; the owner may have paused or written meanwhile, or hours may have closed.
    if (store.getState().paused || ownerActive(jid) || teamSpoke()) {
      await say(fmtDraft('[descartado]', { ...contact, name: label }, out));
      return 'discarded';
    }
    if (!inHours(jid)) {
      defer(jid);
      return 'deferred';
    }
    // The agent's reply assumes the approval worked: it is only sent if it did; else the neutral ack + blocking handoff.
    if (veto) {
      // Handoff already persisted and alerted above; only the "ya quedó" reply must not go out.
      run.event({ kind: 'approval', status: 'refused', text: `no se aprobó ${folioList(approve) ?? 'la solicitud'}: ${veto}` });
      bubbles = [cannedAck(contact)];
    } else if (approve) {
      const r = await actions.approve({ contact, approve });
      // Notes even on a mid-way failure: those approvals already happened.
      for (const note of r.done ?? []) {
        run.event({ kind: 'approval', status: 'ok', text: note });
        await say(note);
      }
      if (!r.ok) {
        const summary = `no se aprobó ${folioList(approve) ?? 'la solicitud'} automáticamente: ${r.reason}`;
        run.event({ kind: 'approval', status: 'refused', text: summary });
        handoff = { type: 'approval', blocking: true, fields: { summary, next: (actions.reviewHint ?? reviewHint)(profile) } };
        bubbles = [cannedAck(contact)];
        store.addHandoff(jid, { type: 'approval', blocking: true, summary, at: clock.now().getTime(), shadow: false });
        notify({ title: 'wha-me: necesitas intervenir', message: `${contact.name}: ${summary}`, key: `handoff:${jid}:approval:${summary}` });
      }
    }
    if (bubbles.length && !(await sendBubbles(jid, bubbles))) return 'blocked'; // secret guard: nothing sent
    if (handoff) await say(fmtHandoff(contact, handoff));
    if (handoffEvent(handoff, bubbles)) remember(jid, fmtHandoffEvent(handoff, bubbles));
    if (implement) {
      if (contact.canTriggerImplementation) {
        enqueue({ jid, implement });
        remember(jid, `implementación pendiente: ${implement.summary}`);
      }
      else await say(`HANDOFF · ${contact.name} (cannot trigger implementation)\n${fmtImplement(implement)}`);
    }
    return bubbles.length ? 'sent' : 'no_reply';
  }

  // false = blocked by the secret guard (nothing sent).
  // The first bubble quotes the latest triggering group message, if any.
  async function sendBubbles(jid, bubbles) {
    if (bubbles.some(leaks)) {
      await say(`${SECRET_ALERT}\nTo: ${contactOf(jid)?.name ?? jid}`);
      return false;
    }
    const keys = unread.get(jid);
    unread.delete(jid);
    let quoted = triggers.get(jid);
    triggers.delete(jid);
    if (keys?.length) await wa.markRead(keys);
    for (const text of bubbles) {
      for (let left = core.typingMs(text); left > 0; left -= COMPOSING_REFRESH_MS) {
        await wa.sendPresence(jid, 'composing');
        await clock.sleep(Math.min(left, COMPOSING_REFRESH_MS));
      }
      const id = await (quoted ? wa.sendText(jid, text, { quoted }) : wa.sendText(jid, text));
      quoted = null;
      store.addSentId(id);
      append(jid, { author: OWNER, bot: true, text, at: clock.now().getTime() }); // the agent's words, not the owner's
      await clock.sleep(core.bubbleGapMs());
    }
    return true;
  }

  // The owner replying from the portal: exactly like typing on their phone (no typing simulation), so it is their manual text for
  // activity, the transcript and the learning pairs; the ids are recorded so the fromMe echoes are ignored.
  async function sendManual(jid, bubbles) {
    if (bubbles.some(leaks)) return { ok: false, reason: 'un mensaje coincide con un patrón de secreto; no se envió nada' };
    return sendAsOwner(jid, bubbles.map((text) => [{ text }, () => wa.sendText(jid, text)]));
  }

  // A portal sticker: the same manual send. The text stays '[sticker]' (how wa.js labels one) for the agent and the learning
  // pairs; `sticker` (its store id, stickers.js) is extra, for the portal's chat view only. An image: no text secret guard.
  const sendManualSticker = (jid, buffer, sticker) => sendAsOwner(jid, [[{ text: '[sticker]', sticker }, () => wa.sendSticker(jid, buffer)]]);

  // sends: [{ text, sticker? } recorded in the transcript, () => message id].
  async function sendAsOwner(jid, sends) {
    // The self-chat (portal «Tú», e.g. to try a sticker): just sent, no contact activity. The ids are recorded so the echoes are
    // never read as the owner's commands (handleMessage skips sent ids before parsing). Only these portal sends land in the
    // self-chat's history, read by the portal alone: the self-chat is never a reply, archive or memory chat.
    if (jid === selfJid) {
      for (const [entry, send] of sends) {
        store.addSentId(await send());
        store.appendTranscript(jid, { author: OWNER, ...entry, at: clock.now().getTime() });
      }
      return { ok: true, sent: sends.length };
    }
    const group = contactOf(jid)?.type === 'group';
    debouncer.cancel(jid);
    store.clearPending(jid);
    triggers.delete(jid);
    const keys = unread.get(jid);
    unread.delete(jid);
    if (keys?.length) await wa.markRead(keys);
    for (const [entry, send] of sends) {
      store.setLastManualFromMeAt(jid, clock.now().getTime()); // set before sending: a run in flight is discarded
      const id = await send();
      const at = clock.now().getTime();
      store.addSentId(id);
      append(jid, { author: OWNER, ...entry, at });
      feedbackOf(jid).manual(jid, entry.text, at);
      if (group) spoke.set(jid, (spoke.get(jid) ?? 0) + 1);
    }
    return { ok: true, sent: sends.length };
  }

  // Portal "Pedir info": a normal reply run now, whose prompt carries the owner's trusted note; it goes through reply() and
  // act(), so pause, shadow, hours, owner-active and the secret guard all apply.
  function askContact(jid, note) {
    if (!contactOf(jid)) throw new Error('chat no encontrado');
    notes.set(jid, note);
    schedule(jid, 0);
  }

  async function command(text) {
    const r = core.applyCommand(store.getState(), text);
    if (!r) return;
    store.setState(r.state);
    const simulating = /^\/estado$/i.test(text) && sim.active();
    await say(simulating ? `${r.reply}, simulando: ${simulating}` : r.reply);
    void processQueue();
  }

  function enqueue(job) {
    store.setJobs([...store.getJobs(), job]);
    void processQueue();
  }

  async function processQueue() {
    const st = store.getState();
    if (jobRunning || st.locked || st.paused || st.shadow) return;
    const [job, ...rest] = store.getJobs();
    if (!job) return;
    jobRunning = true;
    // Dequeue before running: a crash mid-job must never re-run a deploy on restart.
    store.setJobs(rest);
    const contact = contactOf(job.jid);
    const run = runLog.start({ kind: 'job', mode: 'real', contact, jid: job.jid });
    try {
      let out;
      let raw;
      try {
        raw = await stageLock(() => agent.runJob({ contact, implement: job.implement, onEvent: run.event }));
        out = core.parseJobOutput(raw);
      } catch (e) {
        run.fail(e);
        // Timeout, crash or unreadable output: the job may have deployed anything. Treat as incident.
        store.setState({ ...store.getState(), locked: true });
        alertIncident(job, contact, 'resultado desconocido');
        await say(`INCIDENT · job outcome unknown · ${contact?.name ?? job.jid}: ${job.implement.summary}\n${e.message}\nVerify prod manually, then send /desbloquear when done.`);
      }
      if (out) {
        run.finish({ result: raw, decision: out, outcome: out.result });
        await finishJob(job, contact, out);
      }
    } catch (e) {
      await say(`JOB ERROR · ${contact?.name ?? job.jid}: ${job.implement.summary}\n${e.message}`);
    } finally {
      jobRunning = false;
    }
    return processQueue();
  }

  async function finishJob(job, contact, { result, report, bubbles }) {
    const head = `JOB ${result} · ${contact.name}: ${job.implement.summary}`;
    const ok = result === 'deployed';
    remember(job.jid, ok ? `desplegado: ${job.implement.summary}` : `falló el job (${result}): ${job.implement.summary}`);
    if (result === 'rolled-back') {
      store.setState({ ...store.getState(), locked: true });
      alertIncident(job, contact, 'rolled-back');
      return say(`INCIDENT · ${head}\nBridge locked; send /desbloquear to resume.\n${report}`);
    }
    await say(`${head}\n${report}`);
    // The contact only ever hears about successes.
    if (ok) await deliver(job.jid, contact, bubbles);
  }

  async function deliver(jid, contact, bubbles) {
    if (!bubbles?.length) return;
    const st = store.getState();
    // Held for the owner to send themselves; ownerActive = they are handling the chat right now.
    if (shadowFor(jid) || st.paused || ownerActive(jid)) return say([`[no enviado] → ${contact.name}:`, ...bubbles].join('\n\n'));
    if (!inHours(jid)) {
      clock.setTimer(() => deliver(jid, contact, bubbles).catch((e) => say(`ERROR deliver · ${contact.name}\n${e.message}`)), msUntilOpening());
      return;
    }
    await sendBubbles(jid, bubbles);
  }

  return { handleMessage, processQueue, restorePending, sendManual, sendManualSticker, askContact, say, catchUpArchive };
}
