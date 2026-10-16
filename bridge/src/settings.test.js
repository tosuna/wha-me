import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { none } from './deploy.js';
import { createSettings } from './settings.js';

// Neutral pipeline: repos under two owners (the token is checked against each).
const PIPELINE = { branchPrefix: 'pet/', repos: { api: { github: 'acme/api', prodBranch: 'main', deploy: none() }, site: { github: 'alex/site', prodBranch: 'main', deploy: none() } } };
const PIPELINE_REPOS = Object.values(PIPELINE.repos).map((r) => r.github);

const TOKEN = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const EXPIRY = '2026-11-14 18:05:13 -0600';

// Classic token: /user carries x-oauth-scopes; each pipeline repo answers with the token user's permissions.
function fakeGithub({ user = 200, repo = 200, expiry = EXPIRY, scopes = 'repo', push = () => true } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.authorization });
    const full = PIPELINE_REPOS.find((r) => url.endsWith(`/repos/${r}`));
    const status = url.endsWith('/user') ? user : full ? (typeof repo === 'function' ? repo(full) : repo) : 404;
    const headers = new Headers({ ...(expiry && { 'github-authentication-token-expiration': expiry }), ...(scopes != null && { 'x-oauth-scopes': scopes }) });
    return { ok: status === 200, status, headers, json: async () => (full ? { permissions: { push: push(full) } } : { login: 'alex' }) };
  };
  return { fetch, calls };
}

function fakeSecurity({ fail = null, stored = null } = {}) {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, args]);
    if (fail) throw fail;
    if (args[0] === 'find-generic-password') {
      if (!stored) throw new Error('not found');
      return { stdout: `${stored}\n` };
    }
    return { stdout: '' };
  };
  return { execFile, calls };
}

const mk = (o = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'wa-settings-'));
  const gh = fakeGithub(o);
  const sec = fakeSecurity(o);
  return { stateDir, gh, sec, s: createSettings({ service: 'wha-me', pipeline: PIPELINE, stateDir, fetch: gh.fetch, execFile: sec.execFile }) };
};

test('valid token: checked against /user and the pipeline repo, stored in the Keychain via an argument array, expiry saved', async () => {
  const { stateDir, gh, sec, s } = mk();
  assert.deepEqual(s.github(), { configured: false, expiresAt: null, warnings: [] });
  const r = await s.setGithubToken(`  ${TOKEN}\n`);
  assert.deepEqual(r, { ok: true, github: { configured: true, expiresAt: Date.parse('2026-11-15T00:05:13Z'), warnings: [] } });
  assert.deepEqual(gh.calls.map((c) => [c.url, c.auth]), [
    ['https://api.github.com/user', `Bearer ${TOKEN}`],
    ...PIPELINE_REPOS.map((r) => [`https://api.github.com/repos/${r}`, `Bearer ${TOKEN}`]),
  ]);
  assert.deepEqual(sec.calls, [['security', ['add-generic-password', '-U', '-s', 'wha-me', '-a', 'github.token', '-w', TOKEN]]]);
  const file = readFileSync(join(stateDir, 'settings.json'), 'utf8');
  assert.ok(!file.includes(TOKEN));
  assert.equal(JSON.parse(file).github.expiresAt, Date.parse('2026-11-15T00:05:13Z'));
  assert.equal(s.token(), TOKEN);
  assert.deepEqual(s.github(), r.github);
});

test('invalid token (GitHub 401), no access to the pipeline repo, or malformed: 400, nothing stored', async () => {
  for (const [o, input] of [[{ user: 401 }, TOKEN], [{ repo: 404 }, TOKEN], [{ repo: (r) => (r.startsWith('alex/') ? 404 : 200) }, TOKEN],
    [{ push: (r) => !r.includes('api') }, TOKEN], [{ scopes: 'read:org, gist' }, TOKEN], [{ scopes: null }, TOKEN],
    [{}, ''], [{}, 'con espacios adentro'], [{}, 'x'], [{}, 42]]) {
    const { stateDir, sec, s } = mk(o);
    const r = await s.setGithubToken(input);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    assert.equal(sec.calls.length, 0);
    assert.equal(existsSync(join(stateDir, 'settings.json')), false);
    assert.equal(s.token(), null);
  }
});

test('a Keychain failure whose message carries the command line never leaks the token', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const { s } = mk({ fail: new Error(`Command failed: security add-generic-password -w ${TOKEN}`) });
    const r = await s.setGithubToken(TOKEN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  } finally {
    console.error = orig;
  }
  assert.ok(!errors.join('\n').includes(TOKEN));
});

test('load(): reads the token back from the Keychain for the secret guard; missing = null', async () => {
  const a = mk({ stored: TOKEN });
  await a.s.load();
  assert.equal(a.s.token(), TOKEN);
  assert.deepEqual(a.sec.calls, [['security', ['find-generic-password', '-s', 'wha-me', '-a', 'github.token', '-w']]]);
  const b = mk();
  await b.s.load();
  assert.equal(b.s.token(), null);
});

test('no expiry header: configured, expiresAt null', async () => {
  const { s } = mk({ expiry: null });
  assert.deepEqual((await s.setGithubToken(TOKEN)).github, { configured: true, expiresAt: null, warnings: [] });
});

test('risky scopes beyond repo are refused (nothing stored), naming them; harmless extras are accepted', async () => {
  const bad = mk({ scopes: 'repo, admin:org, delete_repo, workflow' });
  const r = await bad.s.setGithubToken(TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /admin:org, delete_repo, workflow/);
  assert.equal(bad.sec.calls.length, 0);
  assert.equal(bad.s.token(), null);
  const ok = mk({ scopes: 'repo, read:org, gist' });
  assert.equal((await ok.s.setGithubToken(TOKEN)).ok, true);
});
