import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeRunner, createArchivist } from './archivist.js';
import { canonicalChat } from './bridge.js';
import { isPersona } from './core/allowlist.js';
import { portalToken } from './portal.js';
import { createRunLog, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';
import { createSettings } from './settings.js';
import { contactKey, createTopics, opaqueKey } from './topics.js';

// One-off seed of the topic memory from the owner's cleaned chat exports (private/conversaciones-limpias/*.txt); OWNER is the
// profile tag:
//   # Chat de trabajo...: OWNER (yo) con CONTACTO (<Name>)
//   ===== YYYY-MM-DD =====
//   CONTACTO:            (or OWNER:) alone on a line, then one message per line
// Exports carry no times: a day's messages get 12:00 local, 1 s apart. Only the last WINDOW_DAYS go to the archivist.
const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
// 60 messages per Haiku call: 185 timed out at 60 s, and 107 already hit the 40-op cap.
const BATCH = 60;
const DAY_RE = /^=====\s*(\d{4})-(\d{2})-(\d{2})\s*=====$/;

// The name inside the header's last (balanced) parentheses group, cut at the first comma. null if none.
export function headerName(line) {
  const end = line.lastIndexOf(')');
  for (let i = end, depth = 0; i >= 0; i--) {
    if (line[i] === ')') depth++;
    else if (line[i] === '(' && --depth === 0) return line.slice(i + 1, end).split(',')[0].trim() || null;
  }
  return null;
}

// owner: the profile tag, the owner's speaker label in the export.
export function parseExport(text, owner) {
  const speaker = new RegExp(`^(CONTACTO|${owner}):$`);
  const [head = '', ...lines] = text.split(/\r?\n/);
  const messages = [];
  let day = null;
  let author = null;
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const d = line.match(DAY_RE);
    if (d) { day = [Number(d[1]), Number(d[2]) - 1, Number(d[3])]; author = null; n = 0; continue; }
    const s = line.match(speaker);
    if (s) { author = s[1]; continue; }
    if (line && day && author) messages.push({ author, text: line, at: new Date(day[0], day[1], day[2], 12, 0, n++).getTime() });
  }
  return { name: head.startsWith('#') ? headerName(head) : null, messages };
}

// `contacto_0001.txt` -> the contacts.json private chat whose number ends in 0001, under the bridge's canonical key;
// no match -> `export:<file>` with the header name; a persona contact -> null (never fed to the memory).
function chatFor(file, name, contacts) {
  const suffix = basename(file, '.txt').match(/_(\d+)$/)?.[1];
  const c = suffix && contacts.find((x) => x.type !== 'group' && String(x.jid).split('@')[0].endsWith(suffix));
  if (isPersona(c)) return null;
  return c ? canonicalChat(c.jid, contacts) : { jid: `export:${file}`, name: name || basename(file, '.txt'), kind: 'private' };
}

const readSeeded = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
};

// Prints one summary line per file; never message text (an archivist error can quote the model output: not printed,
// it goes to the run log through its secret guard). A file is marked seeded only when all its batches succeed.
export async function seedMemory({ profile, dir, contacts, archivist, runLog, stateFile, force = false, batch = BATCH, now = Date.now, log = console.log }) {
  const knownPeople = [...new Set([...contacts.filter((c) => c.type !== 'group').map((c) => c.name), ...contacts.flatMap((c) => (c.respondTo ?? []).map((m) => m.name))])]
    .map((name) => ({ name, key: contactKey(name) }));
  const since = now() - WINDOW_DAYS * DAY;
  const ownerKey = profile.tag.toLowerCase();
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    const seeded = readSeeded(stateFile);
    if (seeded.includes(file) && !force) { log(`${file}: ya sembrado, se salta (usa --force para repetir)`); continue; }
    const { name, messages } = parseExport(readFileSync(join(dir, file), 'utf8'), profile.tag);
    const chat = chatFor(file, name, contacts);
    if (!chat) { log(`${file}: chat con persona, no alimenta la memoria`); continue; }
    // An export not mapped to contacts.json is nobody we know: its contact gets an opaque key, never its header name.
    const contact = chat.jid.startsWith('export:') ? opaqueKey(chat.jid) : contactKey(chat.name);
    const entries = messages.filter((m) => m.at >= since)
      .map((m) => ({ author: m.author, name: m.author === profile.tag ? ownerKey : chat.name, person: m.author === profile.tag ? ownerKey : contact, text: m.text, at: m.at }));
    let applied = 0;
    let rejected = 0;
    let cost = 0;
    let failed = 0;
    for (let i = 0; i < entries.length; i += batch) {
      const run = runLog.start({ kind: 'archive', mode: 'real', contact: { name: chat.name } });
      const r = await archivist.archive({ chat, entries: entries.slice(i, i + batch), knownPeople });
      run.event({ kind: 'result', costUsd: r.costUsd ?? null, model: 'haiku' });
      cost += r.costUsd ?? 0;
      if (r.error) { failed++; run.fail(new Error(r.error)); continue; }
      applied += r.applied;
      rejected += r.rejected.length;
      run.finish({ outcome: 'archived', decision: { applied: r.applied, rejected: r.rejected.length } });
    }
    total += cost;
    const n = entries.length;
    log(`${file} → ${chat.name}: ${n} ${n === 1 ? 'mensaje' : 'mensajes'} en ventana, ${applied} ops aplicadas, ${rejected} rechazadas, $${cost.toFixed(4)}`
      + (failed ? `, ${failed} lote(s) fallaron (detalle en el run log; se reintenta en la próxima corrida)` : ''));
    if (failed) continue;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(`${stateFile}.tmp`, `${JSON.stringify([...new Set([...readSeeded(stateFile), file])], null, 2)}\n`);
    renameSync(`${stateFile}.tmp`, stateFile);
  }
  log(`total: $${total.toFixed(4)}`);
}

// npm run seed-memory [-- --force] [-- <dir>]; default dir: wha-me/private/conversaciones-limpias. Same model runner, secret guard and
// state files as the bridge (topics.db, agent-runs.db).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const BRIDGE = dirname(dirname(fileURLToPath(import.meta.url)));
  const { profile } = await (await import('./config.js')).loadConfig(); // entrypoint: loads the config itself
  const args = process.argv.slice(2);
  const stateDir = join(BRIDGE, 'state');
  const settings = createSettings({ stateDir, service: profile.keychainService });
  await settings.load();
  const leaks = createSecretGuard({ secrets: () => [portalToken(stateDir), settings.token()] });
  const topics = createTopics({ profile, file: join(stateDir, 'topics.db') });
  const runLog = createRunLog({ file: join(stateDir, RUNS_DB), leaks });
  await seedMemory({
    profile, dir: args.find((a) => !a.startsWith('--')) ?? join(BRIDGE, '..', 'private', 'conversaciones-limpias'),
    contacts: JSON.parse(readFileSync(join(BRIDGE, 'contacts.json'), 'utf8')),
    archivist: createArchivist({ profile, topics, run: claudeRunner(), leaks }),
    runLog, stateFile: join(stateDir, 'seeded-exports.json'), force: args.includes('--force'),
  });
  topics.close();
  runLog.close();
}
