import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// wha-me configuration: an ESM module whose default export is a plain object (see config/example.config.js). Loaded once by
// the entrypoints (index.js, the standalone portal and seed scripts); every other module gets what it needs injected.
const PRIVATE = fileURLToPath(new URL('../../private/wha-me.config.js', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../config/example.config.js', import.meta.url));
// The wha-me repo root: a relative profile.skill.dir is relative to it.
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Authors the bridge itself persists: the owner's tag must not collide with them.
const RESERVED_TAGS = ['CONTACTO', 'BRIDGE'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validate(config) {
  const p = config?.profile;
  const fail = (field, why) => { throw new Error(`invalid wha-me config: ${field} ${why}`); };
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  if (!p || typeof p !== 'object') fail('profile', 'is required');
  // Interpolated into prompts and the portal page: no quotes, backslashes, angle brackets or line breaks.
  if (!text(p.name) || /[<>"'`\\\r\n]/.test(p.name)) fail('profile.name', 'must be a non-empty string without quotes, backslashes, < > or line breaks');
  if (!/^[A-Z][A-Z0-9_]*$/.test(p.tag ?? '') || RESERVED_TAGS.includes(p.tag)) fail('profile.tag', `must be UPPERCASE letters/digits/_ and not ${RESERVED_TAGS.join(' or ')}`);
  if (!text(p.language)) fail('profile.language', 'must be a BCP 47 tag like es-MX');
  try {
    new Intl.Locale(p.language);
  } catch {
    fail('profile.language', 'must be a BCP 47 tag like es-MX');
  }
  if (!validTimezone(p.timezone)) fail('profile.timezone', 'must be an IANA time zone like America/New_York');
  if (!p.hours || typeof p.hours !== 'object') fail('profile.hours', 'is required ({ open, close, days })');
  if (!HHMM.test(p.hours.open ?? '')) fail('profile.hours.open', 'must be HH:MM');
  if (!HHMM.test(p.hours.close ?? '') || minutesOf(p.hours.close) <= minutesOf(p.hours.open)) fail('profile.hours.close', 'must be HH:MM after open');
  const { days } = p.hours;
  if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) fail('profile.hours.days', 'must be weekdays 0 (Sunday) to 6');
  if (!text(p.keychainService)) fail('profile.keychainService', 'must be a non-empty string');
  // What the owner's chats are about, for the archivist prompt. facts may hold line breaks (kept as is in the prompt).
  const c = p.context;
  if (!c || ![c.chats, c.facts, c.ids].every(text) || /[\r\n]/.test(c.chats + c.ids)) fail('profile.context', 'must be { chats, facts, ids } non-empty strings (chats and ids on one line)');
  validateSkill(p.skill, fail, text);
  validateWorkspace(config.workspace, fail, text);
  validatePipeline(config.pipeline, fail, text);
  validateKnowledge(config.knowledge, fail, text);
  const a = config.actions;
  if (!a || (a.idPattern !== null && !(a.idPattern instanceof RegExp)) || typeof a.precheck !== 'function' || typeof a.approve !== 'function'
    || (a.reviewHint !== undefined && typeof a.reviewHint !== 'function')) {
    fail('actions', 'must be an ActionAdapter (see bridge/src/actions.js)');
  }
  return config;
}

// The agent skill: dir holds SKILL.md (appended to every reply run's system prompt) and references/; name is interpolated
// into prompts; learnable = [voice rules file, contact notes file], relative to dir: the only files /aprender may edit.
function validateSkill(s, fail, text) {
  if (!s || typeof s !== 'object') fail('profile.skill', 'is required ({ dir, name, learnable })');
  if (!text(s.dir) || !existsSync(join(resolve(REPO_ROOT, s.dir), 'SKILL.md'))) fail('profile.skill.dir', 'must be a dir with a SKILL.md (absolute or relative to the wha-me repo root)');
  if (!/^[\w.-]+$/.test(s.name ?? '')) fail('profile.skill.name', 'must be letters, digits, _ . or -');
  const inside = (f) => text(f) && !isAbsolute(f) && !f.split('/').includes('..') && normalize(f) !== 'SKILL.md';
  if (!Array.isArray(s.learnable) || s.learnable.length !== 2 || !s.learnable.every(inside)) {
    fail('profile.skill.learnable', 'must be [voice rules file, contact notes file], relative to the skill dir, without .. and not SKILL.md');
  }
}

function validateWorkspace(w, fail, text) {
  if (!w || typeof w !== 'object') fail('workspace', 'is required');
  for (const k of ['root', 'projectsYaml', 'requestsDir', 'prodCodeDir']) if (!isAbsolute(w[k] ?? '')) fail(`workspace.${k}`, 'must be an absolute path');
  if (typeof w.worktreesDir !== 'function') fail('workspace.worktreesDir', 'must be a function (repo path) -> absolute dir');
  if (!w.prodMirrors || typeof w.prodMirrors !== 'object' || !Object.values(w.prodMirrors).every(text)) fail('workspace.prodMirrors', 'must map repo -> production branch');
  if (w.codegraphBin !== undefined && !text(w.codegraphBin)) fail('workspace.codegraphBin', 'must be a non-empty string');
  const ci = w.codeIndex;
  if (ci !== undefined && (!text(ci?.bin) || typeof ci.args !== 'function')) fail('workspace.codeIndex', 'must be { bin, args: (dir) -> argv }');
}

function validatePipeline(p, fail, text) {
  if (!p || typeof p !== 'object') fail('pipeline', 'is required');
  // Becomes part of git refs and worktree dir names: lowercase segment(s), ending in '/'.
  if (!/^[a-z0-9][a-z0-9-]*\/$/.test(p.branchPrefix ?? '')) fail('pipeline.branchPrefix', "must look like 'pet/'");
  if (!p.repos || typeof p.repos !== 'object' || !Object.keys(p.repos).length) fail('pipeline.repos', 'must have at least one repo');
  for (const [id, r] of Object.entries(p.repos)) {
    // Repo ids are written into the portal page's script (the GitHub token hint).
    if (!/^[\w.-]+$/.test(id)) fail(`pipeline.repos.${id}`, 'id must be letters, digits, _ . or -');
    if (!/^[\w.-]+\/[\w.-]+$/.test(r?.github ?? '')) fail(`pipeline.repos.${id}.github`, "must be 'owner/name'");
    if (!text(r.prodBranch)) fail(`pipeline.repos.${id}.prodBranch`, 'must be a non-empty string');
    const d = r.deploy;
    if (!d || typeof d.stage !== 'boolean' || (d.stage && typeof d.run !== 'function')) fail(`pipeline.repos.${id}.deploy`, 'must be a DeployTarget (see bridge/src/deploy.js)');
  }
  const m = p.migrations;
  if (!m || !Array.isArray(m.planRules) || typeof m.allowed !== 'function' || typeof m.open !== 'function') fail('pipeline.migrations', 'must be a MigrationTarget (see bridge/src/migrations.js)');
  const b = p.playbook;
  if (!b || !['plan', 'spec', 'implement'].every((k) => typeof b[k] === 'function')) fail('pipeline.playbook', 'must have plan, spec and implement functions (see config/example.config.js)');
  const r = b.specRule;
  if (r !== null && (!text(r?.text) || !text(r.check) || !r.text.includes(r.check))) fail('pipeline.playbook.specRule', 'must be null or { text, check } with check part of text');
}

function validateKnowledge(k, fail, text) {
  if (!k || typeof k !== 'object') fail('knowledge', 'is required');
  const texts = (v) => Array.isArray(v) && v.every(text);
  if (!k.tenants || typeof k.tenants !== 'object') fail('knowledge.tenants', 'must map tenant -> { label?, mcpServers, allowedTools, replyHints }');
  for (const [id, t] of Object.entries(k.tenants)) {
    const at = `knowledge.tenants.${id}`;
    // Ids and labels are written into the portal page's script (portal.js portalPage) and the safety eval cases.
    if (!/^[\w-]+$/.test(id)) fail(at, 'id must be letters, digits, _ or -');
    if (t?.label !== undefined && (!text(t.label) || /[<>"'`\\\r\n]/.test(t.label))) fail(`${at}.label`, 'must be a non-empty string without quotes, backslashes, < > or line breaks');
    if (!t?.mcpServers || typeof t.mcpServers !== 'object') fail(`${at}.mcpServers`, 'must map name -> { command, args }');
    for (const [name, s] of Object.entries(t.mcpServers)) if (!text(s?.command) || !Array.isArray(s.args)) fail(`${at}.mcpServers.${name}`, 'must have a command and an args list');
    if (!texts(t.allowedTools)) fail(`${at}.allowedTools`, 'must be a list of tool names');
    if (!texts(t.replyHints)) fail(`${at}.replyHints`, 'must be a list of prompt lines');
  }
  const urls = (v) => Array.isArray(v) && v.every((u) => /^https?:\/\/\S+$/.test(u ?? ''));
  if (!urls(k.healthUrls?.pages) || !urls(k.healthUrls?.apis)) fail('knowledge.healthUrls', 'must be { pages: [http(s) URL], apis: [http(s) URL] }');
}

// contacts.json optional per-contact fields (index.js checks them at startup): persona = markdown file, absolute or relative
// to the repo root, that must exist; model = Claude model id for that contact's reply runs; anyHour = ignore profile.hours.
export function validateContacts(contacts) {
  for (const c of contacts) {
    const fail = (field, why) => { throw new Error(`invalid contacts.json ${c.name ?? c.jid}.${field}: ${why}`); };
    const text = (v) => typeof v === 'string' && v.trim() !== '';
    if (c.persona !== undefined && (!text(c.persona) || !existsSync(resolve(REPO_ROOT, c.persona)))) fail('persona', 'must be an existing file (absolute or relative to the wha-me repo root)');
    if (c.model !== undefined && !text(c.model)) fail('model', 'must be a non-empty string');
    if (c.anyHour !== undefined && typeof c.anyHour !== 'boolean') fail('anyHour', 'must be true or false');
  }
  return contacts;
}

// Frozen in place: the config holds functions (worktreesDir, DeployTargets), which structuredClone cannot copy.
const deepFreeze = (v) => {
  if (v && typeof v === 'object') for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
};

// path: WHA_ME_CONFIG, else private/wha-me.config.js if present, else the public example.
export async function loadConfig(path = process.env.WHA_ME_CONFIG) {
  const file = path || (existsSync(PRIVATE) ? PRIVATE : EXAMPLE);
  const { default: config } = await import(pathToFileURL(file).href);
  return deepFreeze(validate(config));
}
