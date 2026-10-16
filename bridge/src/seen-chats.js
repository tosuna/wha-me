import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_SEEN = 200;

// Chats the bridge saw but neither answers nor archives (not in contacts.json nor memory-chats.json), so the owner can pick
// them in the portal. Only { jid, name, kind, lastAt, count }: never message text. Newest first, capped.
// ponytail: the whole file is read and rewritten per message; fine at a few hundred entries.
export function createSeenChats({ file }) {
  function list() {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function save(chats) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(chats.slice(0, MAX_SEEN), null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
  function record({ jid, name, kind, at }) {
    const all = list();
    const old = all.find((c) => c.jid === jid);
    const entry = { jid, name: name || old?.name || null, kind, lastAt: Math.max(at, old?.lastAt ?? 0), count: (old?.count ?? 0) + 1 };
    save([entry, ...all.filter((c) => c.jid !== jid)].sort((a, b) => b.lastAt - a.lastAt));
  }
  return { list, record, remove: (jid) => save(list().filter((c) => c.jid !== jid)) };
}
