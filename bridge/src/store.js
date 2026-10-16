import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHistory } from './portal-view.js';

const MAX_TRANSCRIPT = 30;
const MAX_SENT_IDS = 1000;
const MAX_HANDOFFS = 20;

// Full per-chat history (transcript entries + {kind:'handoff'} lines), append-only; read only to feed the archivist.
export const historyFile = (dir, jid) => join(dir, 'history', `${encodeURIComponent(jid)}.jsonl`);
export const historyJid = (file) => decodeURIComponent(file.replace(/\.jsonl$/, ''));

// ponytail: whole state in one JSON file rewritten on each change; fine for a handful of chats.
export function createStore(dir, { initialState }) {
  mkdirSync(join(dir, 'history'), { recursive: true });
  const file = join(dir, 'store.json');
  const data = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { transcripts: {}, lastManual: {}, sentIds: [], state: initialState(), jobs: [] };
  data.pending ??= {}; // jid -> due time (ms) of a scheduled reply
  data.handoffs ??= {};
  const sent = new Set(data.sentIds);

  function save() {
    data.sentIds = [...sent].slice(-MAX_SENT_IDS);
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  }

  const record = (jid, entry) => appendFileSync(historyFile(dir, jid), `${JSON.stringify(entry)}\n`);

  return {
    getTranscript: (jid) => data.transcripts[jid] ?? [],
    appendTranscript(jid, entry) {
      data.transcripts[jid] = [...(data.transcripts[jid] ?? []), entry].slice(-MAX_TRANSCRIPT);
      save();
      record(jid, entry);
    },
    getHistory: (jid) => (existsSync(historyFile(dir, jid)) ? parseHistory(readFileSync(historyFile(dir, jid), 'utf8')) : []),
    getHandoffs: (jid) => data.handoffs[jid] ?? [],
    addHandoff(jid, handoff) {
      data.handoffs[jid] = [...(data.handoffs[jid] ?? []), handoff].slice(-MAX_HANDOFFS);
      save();
      record(jid, { kind: 'handoff', ...handoff });
    },
    getLastManualFromMeAt: (jid) => data.lastManual[jid] ?? null,
    setLastManualFromMeAt(jid, ms) { data.lastManual[jid] = ms; save(); },
    isSentId: (id) => sent.has(id),
    addSentId(id) { sent.add(id); save(); },
    getState: () => data.state,
    setState(state) { data.state = state; save(); },
    getJobs: () => data.jobs,
    setJobs(jobs) { data.jobs = jobs; save(); },
    getPending: () => data.pending,
    setPending(jid, dueMs) { data.pending[jid] = dueMs; save(); },
    clearPending(jid) { delete data.pending[jid]; save(); },
  };
}
