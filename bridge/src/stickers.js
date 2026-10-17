import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The owner's stickers as WhatsApp Desktop for macOS keeps them: Sticker.sqlite (stickers and packs, Core Data),
// BackedUpKeyValue.sqlite (favorites fs.v2, recents rs.v2) and the unencrypted webp files under stickers/. WhatsApp keeps
// the databases open (WAL): opened read-only per call, never written.
export const DEFAULT_ROOT = join(homedir(), 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared');

// Sticker id = its sha256 file hash (ZFILEHASH, standard base64) as base64url: 32 bytes -> 43 chars.
const ID = /^[A-Za-z0-9_-]{43}$/;
const toId = (hash) => Buffer.from(hash, 'base64').toString('base64url');
const toHash = (id) => Buffer.from(id, 'base64url').toString('base64');
const isWebp = (buf) => buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
const EMPTY = Object.freeze({ available: false, favorites: [], recents: [], packs: [] });

// Minimal protobuf reader: [{ no, wire, value }] (value: number for varints, Buffer for length-delimited). Throws on
// truncated input or an unknown wire type.
function fields(buf) {
  const out = [];
  let pos = 0;
  const varint = () => {
    let v = 0;
    for (let mul = 1; ; mul *= 128) {
      if (pos >= buf.length) throw new Error('truncated protobuf');
      const b = buf[pos++];
      v += (b & 0x7f) * mul; // multiply, not shift: ms timestamps exceed 32 bits
      if (b < 0x80) return v;
    }
  };
  while (pos < buf.length) {
    const key = varint();
    const no = Math.floor(key / 8);
    const wire = key % 8;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5) pos += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const len = varint();
      if (pos + len > buf.length) throw new Error('truncated protobuf');
      value = buf.subarray(pos, pos += len);
    } else throw new Error(`protobuf wire type ${wire}`);
    out.push({ no, wire, value });
  }
  return out;
}

// rs.v2 blob: repeated Entry (field 1) { 1: file hash, 2: float32 weight, 3: timestamp ms }, already ordered.
const recentHashes = (blob) => fields(blob).filter((f) => f.no === 1 && f.wire === 2)
  .map((e) => fields(e.value).find((f) => f.no === 1 && f.wire === 2)?.value.toString('utf8')).filter(Boolean);

function withDb(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function createStickerStore({ root = DEFAULT_ROOT } = {}) {
  const stickerDb = join(root, 'Sticker.sqlite');
  const kvDb = join(root, 'BackedUpKeyValue.sqlite');
  const dir = join(root, 'stickers');

  // Absolute path of a ZRELATIVEIMAGEPATH only when it exists and resolves (symlinks included) inside <root>/stickers/.
  const pathOf = (rel) => {
    try {
      const real = realpathSync(join(dir, String(rel)));
      return real.startsWith(realpathSync(dir) + sep) ? real : null;
    } catch {
      return null;
    }
  };
  const sticker = (r) => ({ id: toId(r.ZFILEHASH), emojis: (r.ZEMOJIS ?? '').split(/\s+/).filter(Boolean) });

  function list() {
    if (!existsSync(stickerDb)) return EMPTY;
    try {
      const { rows, packs } = withDb(stickerDb, (db) => ({
        rows: db.prepare('SELECT ZFILEHASH, ZEMOJIS, ZRELATIVEIMAGEPATH, ZSTICKERPACK FROM ZWACDSTICKER WHERE ZFILEHASH IS NOT NULL ORDER BY ZSORT, Z_PK').all(),
        packs: db.prepare('SELECT Z_PK, ZNAME, ZSTICKERPACKID FROM ZWACDABSTRACTSTICKERPACK ORDER BY ZORDER, Z_PK').all(),
      }));
      const onDisk = rows.filter((r) => pathOf(r.ZRELATIVEIMAGEPATH));
      const byHash = new Map();
      for (const r of onDisk) if (!byHash.has(r.ZFILEHASH)) byHash.set(r.ZFILEHASH, sticker(r));
      const known = (hashes) => hashes.map((h) => byHash.get(h)).filter(Boolean);
      const kv = existsSync(kvDb) ? withDb(kvDb, (db) => ({
        favorites: db.prepare("SELECT ZKEY FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'fs.v2' ORDER BY ZSORT DESC").all().map((r) => r.ZKEY),
        recents: db.prepare("SELECT ZVALUE FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'rs.v2' AND ZKEY = 'ordered_regular_recent_stickers_data'").get()?.ZVALUE,
      })) : {};
      return {
        available: true,
        favorites: known(kv.favorites ?? []),
        recents: kv.recents ? known(recentHashes(Buffer.from(kv.recents))) : [],
        packs: packs.map((p) => ({ id: p.ZSTICKERPACKID ?? String(p.Z_PK), name: p.ZNAME ?? '', stickers: onDisk.filter((r) => r.ZSTICKERPACK === p.Z_PK).map(sticker) }))
          .filter((p) => p.stickers.length),
      };
    } catch (e) {
      // A WhatsApp update that reshapes the store must not break the portal: no stickers, logged.
      console.error(`stickers: could not read the WhatsApp Desktop store (${e.message})`);
      return EMPTY;
    }
  }

  // The webp bytes of a sticker id, or null. The path comes only from the database, never from the caller.
  function file(id) {
    if (!ID.test(String(id)) || !existsSync(stickerDb)) return null;
    try {
      const rels = withDb(stickerDb, (db) => db.prepare('SELECT ZRELATIVEIMAGEPATH FROM ZWACDSTICKER WHERE ZFILEHASH = ?').all(toHash(id)));
      for (const { ZRELATIVEIMAGEPATH } of rels) {
        const path = pathOf(ZRELATIVEIMAGEPATH);
        const buf = path && readFileSync(path);
        if (buf && isWebp(buf)) return buf;
      }
    } catch (e) {
      console.error(`stickers: could not read sticker ${id} (${e.message})`);
    }
    return null;
  }

  return { list, file };
}
