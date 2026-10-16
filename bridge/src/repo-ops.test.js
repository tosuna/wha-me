import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubWorkflow, none } from './deploy.js';
import { allowPush, createRepoOps } from './repo-ops.js';
import { createSecretGuard } from './secrets.js';

const TOKEN = 'ghp_' + 'TESTtoken0123456789abcdefghijklmnopqrs' // fake, split so scanners don't flag it;
const PIPELINE = {
  branchPrefix: 'pet/',
  repos: {
    api: { github: 'acme/api', prodBranch: 'main', deploy: githubWorkflow({ workflow: 'deploy-staging.yml' }) },
    web: { github: 'acme/web', prodBranch: 'master', deploy: { stage: true, run: async () => 'ok' } },
    docs: { github: 'acme/docs', prodBranch: 'main', deploy: none() },
  },
};
const AA = PIPELINE.repos.api.github;
const AW = PIPELINE.repos.web.github;
const SHA = 'a'.repeat(40);
const leaks = createSecretGuard({ readFile: () => '', secrets: () => [TOKEN] });

test('allowlist: <branchPrefix><id>-<key> anywhere, stage only on repos whose DeployTarget has a stage; main/master/tags/force/delete refused', () => {
  allowPush(PIPELINE, AA, 'HEAD', 'refs/heads/pet/2-presets-api');
  allowPush(PIPELINE, AW, SHA, 'refs/heads/pet/12-ui');
  allowPush(PIPELINE, AA, SHA, 'refs/heads/stage');
  allowPush(PIPELINE, AW, SHA, 'refs/heads/stage');
  const refused = [
    [AA, 'HEAD', 'refs/heads/main'], [AW, 'HEAD', 'refs/heads/master'], [AA, 'HEAD', 'refs/heads/feature/x'],
    [AA, 'HEAD', 'refs/tags/v1.0.0'], [AA, '+HEAD', 'refs/heads/pet/2-api'], [AA, '', 'refs/heads/pet/2-api'],
    [PIPELINE.repos.docs.github, 'HEAD', 'refs/heads/stage'], [AA, 'HEAD', 'refs/heads/pet/x-api'], [AA, 'HEAD', 'refs/heads/pet/2-API'],
    [AA, 'HEAD', 'refs/heads/pet/2-api:refs/heads/main'], [AA, 'main', 'refs/heads/pet/2-api'], [AA, 'HEAD', 'main'],
  ];
  for (const [repo, src, ref] of refused) assert.throws(() => allowPush(PIPELINE, repo, src, ref), /push rechazado/, `${repo} ${src}:${ref}`);
});

test('push: token only in the env (extraheader), hooks and credential helpers off; a refused ref never runs git', async () => {
  const calls = [];
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, exec: async (file, args, opts) => { calls.push({ file, args, opts }); return { code: 0, stdout: '', stderr: '' }; } });
  await ops.push({ worktree: '/wt', repo: AA, src: SHA, ref: 'refs/heads/pet/2-api' });
  const [{ file, args, opts }] = calls;
  assert.equal(file, 'git');
  assert.deepEqual(args, ['-C', '/wt', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'push', '--no-verify',
    `https://github.com/${AA}.git`, `${SHA}:refs/heads/pet/2-api`]);
  assert.ok(!JSON.stringify(args).includes(TOKEN));
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(opts.env.GIT_CONFIG_COUNT, '1');
  assert.equal(opts.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(opts.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  for (const ref of ['refs/heads/main', 'refs/heads/master', 'refs/tags/v1']) {
    await assert.rejects(ops.push({ worktree: '/wt', repo: AA, src: 'HEAD', ref }), /push rechazado/);
  }
  await assert.rejects(ops.push({ worktree: '/wt', repo: AA, src: '+HEAD', ref: 'refs/heads/pet/2-api' }), /push rechazado/);
  assert.equal(calls.length, 1);
});

test('push: a failure never carries the token in the thrown error', async () => {
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, exec: async () => ({ code: 128, stdout: '', stderr: `fatal: auth failed for ${TOKEN}` }) });
  const err = await ops.push({ worktree: '/wt', repo: AA, src: 'HEAD', ref: 'refs/heads/pet/2-api' }).catch((e) => e);
  assert.match(err.message, /git push falló/);
  assert.ok(!err.message.includes(TOKEN));
  const plain = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, exec: async () => ({ code: 1, stdout: '', stderr: '! [rejected] (non-fast-forward)' }) });
  await assert.rejects(plain.push({ worktree: '/wt', repo: AA, src: 'HEAD', ref: 'refs/heads/stage' }), /non-fast-forward/);
});

test('push: real git to a local bare remote (URL mapped)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-repo-ops-'));
  const g = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  g('init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
  g('init', '-q', '-b', 'main', join(dir, 'wt'));
  writeFileSync(join(dir, 'wt', 'a.txt'), 'a');
  g('-C', join(dir, 'wt'), 'add', '.');
  g('-C', join(dir, 'wt'), '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'a');
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, remoteUrl: () => join(dir, 'origin.git') });
  await ops.push({ worktree: join(dir, 'wt'), repo: AA, src: 'HEAD', ref: 'refs/heads/pet/2-api' });
  assert.equal(g('-C', join(dir, 'origin.git'), 'rev-parse', 'pet/2-api'), g('-C', join(dir, 'wt'), 'rev-parse', 'HEAD'));
  await assert.rejects(ops.push({ worktree: join(dir, 'wt'), repo: AA, src: 'HEAD', ref: 'refs/heads/main' }), /push rechazado/);
  assert.throws(() => g('-C', join(dir, 'origin.git'), 'rev-parse', '--verify', '-q', 'main'));
});

// In-memory GitHub REST: pulls (list/create/update) and deploy-preprod runs.
function fakeGithub({ runs = () => [], state = 'active' } = {}) {
  const prs = [];
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (u.pathname.endsWith('/actions/workflows/deploy-preprod.yml')) return reply(200, { state });
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(pulls|actions\/workflows\/deploy-preprod\.yml\/runs)(?:\/(\d+))?$/);
    if (!m) return reply(404, {});
    const repo = `${m[1]}/${m[2]}`;
    if (m[3] !== 'pulls') return reply(200, { workflow_runs: runs(u.searchParams.get('head_sha')) });
    if (method === 'GET') return reply(200, prs.filter((p) => p.repo === repo && p.state === 'open' && `${m[1]}:${p.head}` === u.searchParams.get('head') && p.base === u.searchParams.get('base')));
    if (method === 'POST') {
      const p = { ...body, repo, state: 'open', number: prs.length + 1, html_url: `https://github.com/${repo}/pull/${prs.length + 1}` };
      prs.push(p);
      return reply(201, p);
    }
    const p = prs.find((x) => x.number === Number(m[4]));
    Object.assign(p, body);
    return reply(200, p);
  };
  return { fetch, prs, calls };
}

test('ensurePr: creates a draft PR with the token in the Authorization header; an open one is reused and its body updated', async () => {
  const gh = fakeGithub();
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, fetch: gh.fetch });
  const a = await ops.ensurePr({ repo: AA, base: 'main', head: 'pet/2-api', title: 'Petición #2: x', body: 'uno' });
  assert.deepEqual(a, { url: `https://github.com/${AA}/pull/1`, created: true });
  assert.deepEqual(gh.prs[0], { ...gh.prs[0], title: 'Petición #2: x', head: 'pet/2-api', base: 'main', draft: true, body: 'uno' });
  assert.equal(gh.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(gh.calls[0].query.head, 'acme:pet/2-api');
  const b = await ops.ensurePr({ repo: AA, base: 'main', head: 'pet/2-api', title: 'Petición #2: x', body: 'dos' });
  assert.deepEqual(b, { url: `https://github.com/${AA}/pull/1`, created: false });
  assert.equal(gh.prs.length, 1);
  assert.equal(gh.prs[0].body, 'dos');
});

test('ensurePr: a GitHub error says the status, never the token', async () => {
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, fetch: async () => ({ ok: false, status: 422, json: async () => ({}) }) });
  const err = await ops.ensurePr({ repo: AA, base: 'main', head: 'pet/2-api', title: 't', body: 'b' }).catch((e) => e);
  assert.match(err.message, /422/);
  assert.ok(!err.message.includes(TOKEN));
});

test('watchRun: polls deploy-preprod for the sha until completed; times out after 30 min of injected clock', async () => {
  let t = 0;
  let polls = 0;
  const gh = fakeGithub({ runs: (sha) => (++polls < 3 ? [] : [{ head_sha: sha, status: polls < 4 ? 'in_progress' : 'completed', conclusion: 'success', html_url: 'https://github.com/r/actions/runs/7' }]) });
  const sleeps = [];
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, fetch: gh.fetch, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  const run = await ops.watchRun({ repo: AA, sha: SHA, workflow: 'deploy-preprod.yml' });
  assert.equal(run.conclusion, 'success');
  assert.deepEqual(sleeps, [20000, 20000, 20000]);
  assert.equal(gh.calls[0].path, `/repos/${AA}/actions/workflows/deploy-preprod.yml`, 'workflow state checked first');
  assert.deepEqual(gh.calls[1].query, { branch: 'stage', head_sha: SHA });
  assert.equal(gh.calls[1].path, `/repos/${AA}/actions/workflows/deploy-preprod.yml/runs`);

  t = 0;
  const never = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, fetch: fakeGithub().fetch, now: () => t, sleep: async (ms) => { t += ms; } });
  await assert.rejects(never.watchRun({ repo: AA, sha: SHA, workflow: 'deploy-preprod.yml' }), /deploy-preprod\.yml no terminó en 30 min/);
});

test('watchRun: a disabled workflow fails at once, no polling', async () => {
  const gh = fakeGithub({ state: 'disabled_manually' });
  const sleeps = [];
  let t = 0;
  const ops = createRepoOps({ pipeline: PIPELINE, token: () => TOKEN, leaks, fetch: gh.fetch, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  await assert.rejects(ops.watchRun({ repo: AA, sha: SHA, workflow: 'deploy-preprod.yml' }), { message: 'deploy-preprod.yml está desactivado en GitHub (disabled_manually); no hay deploy que esperar' });
  assert.deepEqual([gh.calls.length, sleeps], [1, []]);
});

test('allowlist: the branch prefix comes from the config', () => {
  const p = { ...PIPELINE, branchPrefix: 'wha/' };
  allowPush(p, AA, 'HEAD', 'refs/heads/wha/2-api');
  assert.throws(() => allowPush(p, AA, 'HEAD', 'refs/heads/pet/2-api'), /push rechazado/);
});
