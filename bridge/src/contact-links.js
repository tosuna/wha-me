import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lookupContact } from './core/allowlist.js';

const normalize = (jid) => String(jid).replace(/:\d+@/, '@');

// The link group holding jid (device suffix ignored), or null.
export const linkGroupOf = (groups, jid) => groups.find((g) => g.jids.some((j) => normalize(j) === normalize(jid))) ?? null;

// Explicit identity across channels: [{ jids: [...] }], each group ONE person, a jid in at most one group. Names never link
// anyone: a WhatsApp and a Telegram "Carlos" stay two people until the owner links them in the portal. Read fresh on every
// use (like memory-chats.json), so a portal edit reaches the bridge without a restart. Errors are UI text (portal 400s).
export function createContactLinks({ file, log = console.error }) {
  function list() {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(v) ? v.filter((g) => Array.isArray(g?.jids)) : [];
    } catch (e) {
      if (e.code !== 'ENOENT') log(`contact-links: ${file} unreadable, treated as empty: ${e.message}`);
      return [];
    }
  }
  function save(groups) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(groups, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
  // known: [{ jid, kind | type }] the chats the owner can see; a link is between people, never a group.
  // ponytail: pairs only (a linked jid is refused); a person on 3+ accounts needs groups that grow, add when it happens.
  function link(a, b, known) {
    for (const j of [a, b]) {
      const c = typeof j === 'string' ? lookupContact(known, j) : null;
      if (!c) throw new Error(`chat desconocido: ${j}`);
      if (c.kind === 'group' || c.type === 'group') throw new Error('un grupo no se enlaza: el enlace es entre personas');
    }
    if (normalize(a) === normalize(b)) throw new Error('no se puede enlazar un chat consigo mismo');
    const groups = list();
    const taken = [a, b].find((j) => linkGroupOf(groups, j));
    if (taken) throw new Error(`${taken} ya está enlazado; desenlázalo primero`);
    save([...groups, { jids: [a, b] }]);
  }
  function unlink(jid) {
    const groups = list();
    const g = linkGroupOf(groups, jid);
    if (!g) return false;
    save(groups.filter((x) => x !== g));
    return true;
  }
  return { list, link, unlink, groupOf: (jid) => linkGroupOf(list(), jid) };
}
