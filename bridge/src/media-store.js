import { readdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const MAX_NAME = 100;
// C0/C1 controls and bidi overrides (a U+202E name spoofs its extension in the notice).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

// Sender-chosen file name -> one safe path segment: basename only, no controls, no leading dots, extension kept.
export function safeFileName(name) {
  let n = String(name ?? '').split(/[/\\]/).pop().replace(UNSAFE, '').trim().replace(/^\.+/, '');
  if (n.length > MAX_NAME) {
    const ext = /\.[^.]{1,10}$/.exec(n)?.[0] ?? '';
    n = n.slice(0, MAX_NAME - ext.length) + ext;
  }
  return n || 'documento';
}

// Received documents on disk: <dir>/<YYYY-MM-DD local>/<msgId>-<name>, dirs 0700, files 0600.
// The date comes from the message time, so the same msgId always maps to the same path; an existing file is never rewritten.
export function createMediaStore({ dir }) {
  const root = resolve(dir);
  return {
    async save({ id, fileName, at, buf }) {
      const folder = join(root, new Date(at).toLocaleDateString('sv-SE'));
      const path = join(folder, `${String(id).replace(/[^\w-]/g, '') || 'msg'}-${safeFileName(fileName)}`);
      if (!path.startsWith(folder + sep)) throw new Error('unsafe media path');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, buf, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      return path;
    },
  };
}

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

// Temporary media (state/media-tmp): removes the <YYYY-MM-DD> folders more than `days` days old, by folder name (the
// message's local date, as save() names them). Anything else in dir is left alone; a missing dir is a no-op.
export function pruneOldDays({ dir, days = 10, now = Date.now() }) {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const e of entries) if (e.isDirectory() && DAY_DIR.test(e.name) && e.name < cutoff) rmSync(join(dir, e.name), { recursive: true, force: true });
}
