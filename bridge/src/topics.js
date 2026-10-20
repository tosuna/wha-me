import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Cross-chat topic memory (asuntos): every chat's archivist writes facts here, every reply run recalls from here.
// topic_search holds one row per topic (title + all fact texts, rowid = topic id), rebuilt whenever the topic changes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (topic_id INTEGER NOT NULL, person TEXT NOT NULL, UNIQUE (topic_id, person));
CREATE INDEX IF NOT EXISTS participants_person ON participants (person);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, text TEXT NOT NULL, said_by TEXT NOT NULL,
  chat_jid TEXT, chat_name TEXT, chat_kind TEXT, at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_topic ON facts (topic_id, at);
CREATE TABLE IF NOT EXISTS cursors (chat_jid TEXT PRIMARY KEY, last_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS topic_search USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');`;

const DAY = 24 * 60 * 60 * 1000;
const MAX_OPS = 40;
const MAX_TEXT = 300;
const MAX_TITLE = 120;
const RECENT_DAYS = 60;
const MAX_QUERY_TOKENS = 40;
const MAX_SCAN = 200; // facts per topic scanned for mentionable ones
const MAX_VISIBLE = 60; // topics one archivist batch may see and touch
const TEXT_HITS = 5; // FTS hits per the owner / bridge message

// Stable id per person: contacts.json lists each person under two jids with the same name.
export const contactKey = (name) => String(name).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Identity for anyone outside contacts.json (a jid) or a legacy entry with only a display name (prefix 'anon'). The colon
// keeps it apart from every contactKey; display names never become identity.
export const opaqueKey = (s, prefix = 'wa') =>
  `${prefix}:${createHash('sha256').update(String(s).replace(/:\d+@/, '@')).digest('hex').slice(0, 10)}`;

const oneLine = (s, max) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t && t.length <= max ? t : null;
};

// Common Spanish chat words (accentless, >= 4 chars: shorter ones never reach the query).
const STOPWORDS = new Set(`para como este esta estas estos esto pero porque cuando donde tambien tiene tienen tengo hacer hace favor
gracias buenas buenos tardes dias noches listo bien entonces ahora ahorita bueno pues sobre todo todos todas nada algo
estoy estas esta estan eres ella ellos hola saludos claro okey vale aqui alli mucho muchas muchos poco mismo misma
puede puedes puedo quiero quieres solo sigue sale va dale oye mira tambien desde hasta entre segun cual quien sera
habia hay creo igual mejor antes despues luego mientras siempre nunca otra otro otros otras`.split(/\s+/));

// Literal search tokens from untrusted text: alphanumeric runs with a digit (294, 0027) or >= 4 chars, minus stopwords;
// numbers = only runs with a digit and >= 3 chars (#312, REQ-0027). Each is quoted, so no FTS5 syntax ever reaches MATCH.
// ponytail: plain OR + bm25.
const ftsQuery = (text, numbers = false) => {
  const words = String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const keep = numbers ? (w) => /\d/.test(w) && w.length >= 3 : (w) => /\d/.test(w) || (w.length >= 4 && !STOPWORDS.has(w));
  const tokens = [...new Set(words.filter(keep))].slice(0, MAX_QUERY_TOKENS);
  return tokens.map((w) => `"${w}"`).join(' OR ');
};

// profile: the owner; tag.toLowerCase() is the owner's person key.
export function createTopics({ profile, file, now = Date.now }) {
  const ownerKey = profile.tag.toLowerCase();
  const SYSTEM = [ownerKey, 'bridge']; // the owner and bridge events
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000'); // seed-memory.js may write while the bridge runs
  db.exec(SCHEMA);

  const topicRow = (id) => db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  const participantsOf = (id) => db.prepare('SELECT person FROM participants WHERE topic_id = ? ORDER BY rowid').all(id).map((p) => p.person);
  const lastFacts = (id, n) => db.prepare('SELECT * FROM facts WHERE topic_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(id, n).reverse();
  const addParticipant = (id, person) => db.prepare('INSERT OR IGNORE INTO participants (topic_id, person) VALUES (?, ?)').run(id, person);
  const reindex = (id) => {
    db.prepare('DELETE FROM topic_search WHERE rowid = ?').run(id);
    const t = topicRow(id);
    if (!t) return;
    const texts = db.prepare('SELECT text FROM facts WHERE topic_id = ? ORDER BY id').all(id).map((f) => f.text);
    db.prepare('INSERT INTO topic_search (rowid, body) VALUES (?, ?)').run(id, [t.title, ...texts].join('\n'));
  };
  const touch = (id, t) => { db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(t, id); reindex(id); };
  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const search = (q, n) => (q ? db.prepare('SELECT rowid AS id FROM topic_search WHERE topic_search MATCH ? ORDER BY rank LIMIT ?').all(q, n).map((r) => r.id) : []);

  // What one chat's archivist batch may see and touch (entries: [{ person, text }], persons set by the bridge): topics a
  // non-owner/bridge author of the batch is in, topics with facts from this chat, and FTS hits on the owner's and the bridge's
  // own text. joinable: hits on numbers the owner wrote (#312, REQ-0027): they involved this chat's people in them.
  // ponytail: a contact's text never widens the view; the owner's plain words only show topics, never let anyone join.
  function view({ chat, entries = [] }) {
    const ids = new Set();
    const joinable = new Set();
    for (const p of new Set(entries.map((e) => e.person))) {
      if (typeof p !== 'string' || SYSTEM.includes(p)) continue;
      for (const r of db.prepare('SELECT topic_id FROM participants WHERE person = ?').all(p)) ids.add(r.topic_id);
    }
    if (chat?.jid) for (const r of db.prepare('SELECT DISTINCT topic_id FROM facts WHERE chat_jid = ?').all(chat.jid)) ids.add(r.topic_id);
    for (const e of entries.filter((x) => SYSTEM.includes(x.person))) {
      for (const id of search(ftsQuery(e.text), TEXT_HITS)) ids.add(id);
      if (e.person === ownerKey) for (const id of search(ftsQuery(e.text, true), TEXT_HITS)) { ids.add(id); joinable.add(id); }
    }
    const shown = [...ids].map(topicRow).filter(Boolean).sort((a, b) => b.updated_at - a.updated_at || b.id - a.id).slice(0, MAX_VISIBLE);
    const visible = new Set(shown.map((t) => t.id));
    return { shown, visible, joinable: new Set([...joinable].filter((id) => visible.has(id))) };
  }

  // The archivist's prompt topics: the batch's view (see view), newest first, with their last 5 facts.
  const visibleTopics = (ctx) => view(ctx).shown
    .map((t) => ({ id: t.id, title: t.title, status: t.status, participants: participantsOf(t.id), facts: lastFacts(t.id, 5).map((f) => `${f.said_by}: ${f.text}`) }));

  // Model ops -> store, in one transaction. ctx: chat {jid, name, kind}; entries = the batch as numbered in the prompt,
  // [{ person, text, at }]; knownPeople = [{ name, key }] that may be added as participants (contacts.json first).
  // Every op cites its message (`msg`): said_by and at come from that entry, never from the model. Only topics in the
  // batch's view (or created by it) can be touched; adding people or closing needs the owner, a participant or a new topic.
  function apply(ops, { chat, entries = [], knownPeople = [], now: t = now() }) {
    const { visible, joinable } = view({ chat, entries });
    const batch = new Set(entries.map((e) => e.person));
    const refs = new Map();
    const created = new Set();
    const rejected = [];
    let applied = 0;
    const resolve = (topic) => {
      if (refs.has(topic)) return refs.get(topic);
      const id = /^\d+$/.test(String(topic)) ? Number(topic) : null; // the model may quote ids
      return id && topicRow(id) ? id : null;
    };
    const cited = (op) => {
      const e = /^\d+$/.test(String(op?.msg)) ? entries[Number(op.msg)] : null;
      return e && typeof e.person === 'string' && e.person ? e : null;
    };
    // add_participant target: a person of the batch by key, or a known person by key or by name. A name that fits more than
    // one person (two unlinked "Carlos" on different channels) is nobody: guessing would join the wrong person's memory.
    const personFor = (p) => {
      const s = String(p ?? '');
      if (batch.has(s)) return s;
      const byKey = knownPeople.find((k) => k.key === s);
      if (byKey) return byKey.key;
      const byName = new Set(knownPeople.filter((k) => contactKey(k.name) === contactKey(s)).map((k) => k.key));
      return byName.size === 1 ? [...byName][0] : null;
    };
    const one = (op, touched) => {
      const known = ['new_topic', 'add_fact', 'add_participant', 'close_topic', 'reopen_topic'].includes(op?.op);
      if (!known) return 'unknown op';
      const e = cited(op);
      if (!e) return 'bad msg';
      if (op.op === 'new_topic') {
        const title = oneLine(op.title, MAX_TITLE);
        if (!title) return 'bad title';
        if (op.ref != null && refs.has(op.ref)) return 'duplicate ref';
        const id = Number(db.prepare("INSERT INTO topics (title, status, created_at, updated_at) VALUES (?, 'open', ?, ?)").run(title, t, t).lastInsertRowid);
        if (op.ref != null) refs.set(op.ref, id);
        created.add(id);
        touched.add(id);
        return null;
      }
      const id = resolve(op.topic);
      if (!id) return 'unknown topic';
      if (!visible.has(id) && !created.has(id)) return 'topic not visible';
      const by = e.person;
      if (op.op === 'add_fact') {
        const text = oneLine(op.text, MAX_TEXT);
        if (!text) return 'bad text';
        db.prepare('INSERT INTO facts (topic_id, text, said_by, chat_jid, chat_name, chat_kind, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, text, by, chat?.jid ?? null, chat?.name ?? null, chat?.kind ?? null, Number.isFinite(e.at) ? e.at : t, t);
        // The author joins only where the owner or this batch put them; otherwise the fact is stored, the author stays out.
        if (by !== 'bridge' && (by === ownerKey || created.has(id) || joinable.has(id))) addParticipant(id, by);
      } else {
        if (by !== ownerKey && !created.has(id) && !participantsOf(id).includes(by)) return 'not allowed';
        if (op.op === 'add_participant') {
          const person = personFor(op.person);
          if (!person || person === 'bridge') return 'unknown person';
          addParticipant(id, person);
        } else {
          db.prepare('UPDATE topics SET status = ? WHERE id = ?').run(op.op === 'close_topic' ? 'closed' : 'open', id);
        }
      }
      touched.add(id);
      return null;
    };
    return tx(() => {
      const touched = new Set();
      (Array.isArray(ops) ? ops : []).forEach((op, i) => {
        const reason = i >= MAX_OPS ? 'too many ops' : one(op, touched);
        if (reason) rejected.push({ op, reason });
        else applied += 1;
      });
      for (const id of touched) touch(id, t);
      return { applied, rejected };
    });
  }

  // Topics for a reply run: FTS hits where `person` participates, then their other recent open topics. Only mentionable
  // facts are returned (the owner's discretion rule): said in this same chat; or, in a private chat, `person` participates and
  // so does the fact's author (or it is the owner/the bridge). The rest never reaches the reply model; topics left empty drop.
  // person: a person key (bridge.js personKey), never a display name: an equal name on another channel is someone else.
  function recall({ person, chat, text, now: t = now(), maxTopics = 6, maxFacts = 8 }) {
    const me = person ?? '';
    const q = ftsQuery(text);
    const hits = search(q, maxTopics * 3);
    const mine = db.prepare(`SELECT t.id FROM topics t JOIN participants p ON p.topic_id = t.id
      WHERE p.person = ? AND t.status = 'open' AND t.updated_at >= ? ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`)
      .all(me, t - RECENT_DAYS * DAY, maxTopics).map((r) => r.id);
    const joined = (id) => participantsOf(id).includes(me);
    const ids = [...new Set([...hits.filter(joined), ...mine])];
    return ids.map((id) => {
      const topic = topicRow(id);
      const participants = participantsOf(id);
      const joinedMe = participants.includes(me);
      const facts = lastFacts(id, MAX_SCAN)
        .filter((f) => f.chat_jid === chat?.jid
          || (chat?.kind === 'private' && joinedMe && (SYSTEM.includes(f.said_by) || participants.includes(f.said_by))))
        .slice(-maxFacts)
        .map((f) => ({
          at: new Date(f.at).toISOString(),
          by: f.said_by,
          where: f.chat_jid === chat?.jid ? 'este chat' : f.chat_kind === 'group' ? `grupo ${f.chat_name}` : `privado con ${f.chat_name}`,
          text: f.text,
          mention: true,
        }));
      return { id, title: topic.title, status: topic.status, participants, facts };
    }).filter((t) => t.facts.length).slice(0, maxTopics);
  }

  const shape = (t) => ({
    id: t.id, title: t.title, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at, participants: participantsOf(t.id),
    factCount: db.prepare('SELECT COUNT(*) AS n FROM facts WHERE topic_id = ?').get(t.id).n,
  });
  // Portal edits; false = no such row.
  const setStatus = (id, status) => !!topicRow(id) && tx(() => { db.prepare('UPDATE topics SET status = ? WHERE id = ?').run(status, id); touch(id, now()); return true; });
  const factShape = (f) => ({
    id: f.id, text: f.text, saidBy: f.said_by, chatJid: f.chat_jid, chatName: f.chat_name, chatKind: f.chat_kind, at: f.at, createdAt: f.created_at,
  });

  return {
    visibleTopics, apply, recall,
    list: ({ status } = {}) => (status
      ? db.prepare('SELECT * FROM topics WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT 500').all(status)
      : db.prepare('SELECT * FROM topics ORDER BY updated_at DESC, id DESC LIMIT 500').all()).map(shape),
    get: (id) => {
      const t = topicRow(id);
      return t ? { ...shape(t), facts: db.prepare('SELECT * FROM facts WHERE topic_id = ? ORDER BY at, id').all(id).map(factShape) } : null;
    },
    closeTopic: (id) => setStatus(id, 'closed'),
    reopenTopic: (id) => setStatus(id, 'open'),
    deleteFact: (id) => tx(() => {
      const f = db.prepare('SELECT topic_id FROM facts WHERE id = ?').get(id);
      if (!f) return false;
      db.prepare('DELETE FROM facts WHERE id = ?').run(id);
      touch(f.topic_id, now());
      return true;
    }),
    deleteTopic: (id) => !!topicRow(id) && tx(() => {
      for (const t of ['facts', 'participants']) db.prepare(`DELETE FROM ${t} WHERE topic_id = ?`).run(id);
      db.prepare('DELETE FROM topics WHERE id = ?').run(id);
      reindex(id); // drops the search row (the topic is gone)
      return true;
    }),
    cursor: (jid) => db.prepare('SELECT last_at FROM cursors WHERE chat_jid = ?').get(jid)?.last_at ?? null,
    setCursor: (jid, at) => db.prepare('INSERT INTO cursors (chat_jid, last_at) VALUES (?, ?) ON CONFLICT (chat_jid) DO UPDATE SET last_at = excluded.last_at').run(jid, at),
    close: () => db.close(),
  };
}
