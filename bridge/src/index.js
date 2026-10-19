import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as activity from './core/activity.js';
import * as allowlist from './core/allowlist.js';
import * as debounce from './core/debounce.js';
import * as delays from './core/delays.js';
import * as hours from './core/hours.js';
import * as parse from './core/parse.js';
import * as stateFns from './core/state.js';
import { createAgent, skillDir } from './agent.js';
import { claudeRunner, createArchivist } from './archivist.js';
import { createBridge } from './bridge.js';
import { createClashCheck } from './clash.js';
import { loadConfig, validateContacts } from './config.js';
import { createConsoleTrace } from './console-trace.js';
import { createFeedback } from './feedback.js';
import { checkHealth } from './health.js';
import { createLearner } from './learn.js';
import { createMediaStore, pruneOldDays } from './media-store.js';
import { createMemoryChats } from './memory-chats.js';
import { createNotifier, createWaAlerts } from './notify.js';
import { createPipeline, createStageLock, DEFAULT_STEPS } from './pipeline.js';
import { createImplementStep } from './implement-step.js';
import { createMigrationWait } from './migrations.js';
import { createPlanStep } from './plan-step.js';
import { createPreprodStep } from './preprod-step.js';
import { createReviewStep } from './review-step.js';
import { loginLink, portalToken, startPortal } from './portal.js';
import { createProdCode, withFreshCode } from './prod-code.js';
import { createRepoOps } from './repo-ops.js';
import { createRequests } from './requests.js';
import { createRunLog, RUNS_DB } from './run-log.js';
import { createSecretGuard } from './secrets.js';
import { createSeenChats } from './seen-chats.js';
import { createSettings } from './settings.js';
import { createStore } from './store.js';
import { createTopics } from './topics.js';
import { connectWa } from './wa.js';
import { quietSignalDumps } from './quiet-signal.js';

quietSignalDumps();

// The owner profile, workspace, pipeline repos, knowledge tools and domain actions (see config/example.config.js), injected into every module that needs them.
const { profile, workspace, pipeline: pipelineConfig, knowledge, actions } = await loadConfig();

const BRIDGE = dirname(dirname(fileURLToPath(import.meta.url)));
const core = { ...activity, ...allowlist, ...debounce, ...delays, ...hours, ...parse, ...stateFns };

// Production code mirrors read by reply runs: refreshed now, every 30 min, and right before each reply run (withFreshCode).
const prodCode = createProdCode({ workspace });
prodCode.start();

const contacts = validateContacts(JSON.parse(readFileSync(join(BRIDGE, 'contacts.json'), 'utf8')));
const stateDir = join(BRIDGE, 'state');
const store = createStore(stateDir, { initialState: core.initialState });
// The portal token is a secret too: only the /portal self-chat reply may carry it (see bridge.js). So is the GitHub token
// from Ajustes (Keychain), read now and re-read by the guard after the owner pastes a new one. So is any runtime secret a
// DeployTarget holds during a deploy (deploy.js onSecret).
const settings = createSettings({ stateDir, service: profile.keychainService, pipeline: pipelineConfig });
await settings.load();
let deploySecret = null;
const leaks = createSecretGuard({ secrets: () => [portalToken(stateDir), settings.token(), deploySecret] });
const notifier = createNotifier({ leaks });
// Commit of the wha-me repo (the skill lives in it), recorded on every agent run.
const skillCommit = (() => {
  try {
    return execFileSync('git', ['-C', dirname(BRIDGE), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
})();
const runLog = createRunLog({ file: join(stateDir, RUNS_DB), skillCommit, leaks });
// Learning pairs in the same DB; windows that expired while the bridge was down close now, the rest every 10 min.
const feedback = createFeedback({ file: join(stateDir, RUNS_DB), leaks });
feedback.sweep();
setInterval(() => feedback.sweep(), 10 * 60 * 1000).unref();
const requests = createRequests({ profile, file: join(stateDir, RUNS_DB), leaks });
// Cross-chat topic memory: fed by every contacts.json chat and the memory-only chats (state/memory-chats.json).
const topics = createTopics({ profile, file: join(stateDir, 'topics.db') });
const memoryChats = createMemoryChats({ file: join(stateDir, 'memory-chats.json') });
// Chats in neither list (no text), offered in the portal's Memoria view.
const seenChats = createSeenChats({ file: join(stateDir, 'seen-chats.json') });

// The portal starts first so it can show the QR while WhatsApp is not linked yet.
const port = Number(process.env.PORTAL_PORT ?? 4747);
let bridge = null; // replies from the portal go through it once WhatsApp is up
const sendMessage = async (jid, bubbles) => {
  if (!bridge) throw new Error('WhatsApp todavía no está conectado');
  return bridge.sendManual(jid, bubbles);
};
const sendSticker = async (jid, buffer, id) => {
  if (!bridge) throw new Error('WhatsApp todavía no está conectado');
  return bridge.sendManualSticker(jid, buffer, id);
};
// Peticiones pipeline (pipeline.js), created once the bridge can post to the self-chat; behind PIPELINE_ENABLED (Ajustes).
let pipeline = null;
const stageLock = createStageLock();
const askContact = (jid, note) => {
  if (!bridge) throw new Error('WhatsApp todavía no está conectado');
  return bridge.askContact(jid, note);
};
const portal = await startPortal({ profile, knowledge, pipeline: pipelineConfig, stateDir, requestsDir: workspace.requestsDir, contactsFile: join(BRIDGE, 'contacts.json'), port, sendMessage, sendSticker, selfJid: () => (bridge ? wa.selfJid : null), requests, askContact, settings, leaks,
  onRequestAction: (id, action) => pipeline?.onAction(id, action), topics, memoryChats, seenChats })
  .catch((e) => console.error(`portal did not start (${e.message}); the QR is still printed here.`));
const url = `http://127.0.0.1:${portal?.address().port ?? port}`;
if (portal) console.log(`portal en ${url}`);

// Images to describe (wa.js describeImage) stay on disk 10 days, then go; the description stays in the transcript.
const mediaTmp = join(stateDir, 'media-tmp');
const imageStore = createMediaStore({ dir: mediaTmp });
const pruneMediaTmp = () => {
  try { pruneOldDays({ dir: mediaTmp, days: 10 }); } catch (e) { console.error('media-tmp prune failed:', e.message); }
};
pruneMediaTmp();
setInterval(pruneMediaTmp, 24 * 60 * 60 * 1000).unref();
// Before connectWa: images that arrive right after linking are described with it.
const agent = withFreshCode(createAgent({ profile, workspace, knowledge }), prodCode);

const waFile = join(stateDir, 'wa.json');
const waAlerts = createWaAlerts({ alert: notifier.alert, url });
const wa = await connectWa({
  authDir: join(BRIDGE, 'auth'),
  onStatus: (s) => {
    writeFileSync(`${waFile}.tmp`, JSON.stringify(s));
    renameSync(`${waFile}.tmp`, waFile);
    waAlerts(s);
  },
  // Audios are only downloaded/transcribed for allowlisted contacts (the self-chat is always allowed inside wa.js);
  // in an allowlisted group, only for its respondTo members. Memory-only chats: every audio (local STT, no cost).
  // The same gate saves their documents to state/media/ (never read by an agent); the self-chat gets the path.
  shouldTranscribe: (jid, participantIds) => {
    const c = core.lookupContact(contacts, jid);
    if (!c) return !!core.lookupContact(memoryChats.list(), jid);
    return c.type !== 'group' || !!core.respondToOf(c, participantIds);
  },
  allowGroup: (jid) => core.lookupContact(contacts, jid)?.type === 'group' || core.lookupContact(memoryChats.list(), jid)?.kind === 'group',
  onSkippedGroup: (jid, at, subject) => seenChats.record({ jid, name: subject, kind: 'group', at }),
  saveDocument: createMediaStore({ dir: join(stateDir, 'media') }).save,
  // bridge.say runs the secret guard; before the bridge exists the line only goes to the log.
  notice: (text) => (bridge ? bridge.say(text) : console.log(text)),
  nameOf: (jid) => (core.lookupContact(contacts, jid) ?? core.lookupContact(memoryChats.list(), jid))?.name ?? jid,
  // Images are described for 1:1 contacts.json chats only (the self-chat is always allowed inside wa.js): never groups,
  // memory-only or unknown chats. Context: the chat's last 10 transcript entries, read before this message is appended.
  shouldDescribe: (jid) => {
    const c = core.lookupContact(contacts, jid);
    return !!c && c.type !== 'group';
  },
  describeImage: async ({ id, at, chatJid, caption, mimetype, buf }) => {
    const ext = /^image\/(\w+)/.exec(mimetype ?? '')?.[1] ?? 'jpeg';
    const path = await imageStore.save({ id, fileName: `imagen.${ext}`, at, buf });
    return agent.describeImage({ path, caption, context: store.getTranscript(chatJid).slice(-10) });
  },
});

const clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
};

bridge = createBridge({
  profile, workspace, wa, store, agent, clock, contacts, selfJid: wa.selfJid, core,
  health: () => checkHealth(knowledge.healthUrls), leaks, topics, archivist: createArchivist({ profile, topics, run: claudeRunner(), leaks }), memoryChats, seenChats, trace: createConsoleTrace({ root: workspace.root, skill: skillDir(profile) }),
  notify: notifier.alert, runLog, actions,
  feedback, learner: createLearner({ profile, feedback, agent, healthUrls: knowledge.healthUrls, tenants: knowledge.tenants, repoDir: dirname(BRIDGE), proposalsDir: join(stateDir, 'proposals'), leaks }),
  portalLink: () => loginLink(stateDir), requests, stageLock,
});
const steps = {
  ...DEFAULT_STEPS, plan: createPlanStep({ profile, workspace, pipeline: pipelineConfig, runStep: agent.runStep, prodCode, requests }),
  implement: createImplementStep({ profile, workspace, playbook: pipelineConfig.playbook, runStep: agent.runStep, requests, leaks }),
  review: createReviewStep({ profile, workspace, runStep: agent.runStep, requests }),
  preprod: createPreprodStep({
    profile, workspace, pipeline: pipelineConfig, requests, ops: createRepoOps({ pipeline: pipelineConfig, token: settings.token, leaks }), token: settings.token, stageLock, leaks,
    clashCheck: createClashCheck({ profile, workspace, pipeline: pipelineConfig, requests, runStep: agent.runStep }),
    onSecret: (s) => { deploySecret = s; },
  }),
};
pipeline = createPipeline({ requests, runLog, state: () => store.getState(), enabled: settings.pipelineEnabled, say: bridge.say, steps });
wa.onMessage((msg) => bridge.handleMessage(msg).catch((e) => console.error('handleMessage failed:', e)));
await bridge.restorePending();
void bridge.catchUpArchive();
bridge.processQueue();
// Re-enters the step a restart interrupted; the interval picks up unpause/unlock and PIPELINE_ENABLED flips.
pipeline.resume();
setInterval(() => pipeline.kick(), 60 * 1000).unref();
// Requests held because the migration target was down resume once it answers (no-op for a target without reachable()).
const preprodWait = createMigrationWait({ requests, target: pipelineConfig.migrations, kick: () => pipeline.kick() });
setInterval(() => preprodWait.check().catch((e) => console.error('preprod wait failed:', e.message)), 10 * 60 * 1000).unref();
console.log(`bridge up as ${wa.selfJid}; mode ${JSON.stringify(store.getState())}`);
