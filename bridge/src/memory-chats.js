import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Memory-only chats: [{ jid, name, kind: 'private'|'group' }]. Their messages feed the topic memory (archivist) but the
// bridge never answers them. Read fresh on every use, so edits (portal or by hand) apply without a restart.
export function createMemoryChats({ file, log = console.error }) {
  function list() {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch (e) {
      if (e.code !== 'ENOENT') log(`memory-chats: ${file} unreadable, treated as empty: ${e.message}`);
      return [];
    }
  }
  function save(chats) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(chats, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }
  function add({ jid, name, kind }) {
    if (typeof jid !== 'string' || !jid.trim()) throw new Error('memory chat needs a jid');
    if (typeof name !== 'string' || !name.trim()) throw new Error('memory chat needs a name');
    if (kind !== 'private' && kind !== 'group') throw new Error(`memory chat kind must be private or group, got ${kind}`);
    save([...list().filter((c) => c.jid !== jid), { jid, name: name.trim(), kind }]);
  }
  return { list, add, remove: (jid) => save(list().filter((c) => c.jid !== jid)) };
}
