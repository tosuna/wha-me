import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const PREPROD_DOWN = 'waiting for the preprod db'; // a MigrationTarget's hold text
import { createPreprodStep } from './preprod-step.js';
import { createRepoOps } from './repo-ops.js';
import { createRequests } from './requests.js';
import { createSecretGuard } from './secrets.js';
import example from '../../config/example.config.js';
import { PIPELINE, pipelineWith, workspaceAt } from './pipeline.fixture.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)

const TOKEN = 'ghp_' + 'TESTtoken0123456789abcdefghijklmnopqrs' // fake, split so scanners don't flag it;
const BEA = 'bea@s.whatsapp.net';
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' }).trim();
const commit = (wt, files, msg = 'c') => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(wt, f)), { recursive: true }); writeFileSync(join(wt, f), text); }
  g(wt, 'add', '-A');
  g(wt, 'commit', '-qm', msg);
};

// A bare "GitHub" remote with main + stage, a clone at <work>/acme-api and the block worktree on pet/<id>-api with
// one commit. Every pipeline repo maps to the same bare remote.
const MIG = 'scripts/migrations/001_presets.sql';
const YAML = 'projects:\n  - id: acme-api\n    path: acme-api\n    package_manager: npm\n    verify_commands:\n      - cmd: "npm test"\n        blocking: true\n';
const TARGETS = [{ author: 'demo', database: 'app' }, { author: 'demo2', database: 'shop' }];
function setup(t, {
  files = { 'src/presets.js': 'export const presets = [];\n' }, project = 'acme-api', token = TOKEN, conclusion = 'success',
  migrations = [{ project, summary: 'tabla presets', file: MIG, targets: TARGETS }], apply, clash, before, gate,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-preprod-'));
  const work = join(dir, 'work');
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = join(work, 'acme-api');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) g(repo, 'config', k, v);
  commit(repo, { 'README.md': 'hola\n', 'src/app.js': 'app\n' }, 'init');
  g(repo, 'push', '-q', 'origin', 'main', 'main:stage');
  before?.(repo);
  const requests = createRequests({ profile: PROFILE, file: ':memory:' });
  const { id } = requests.fromHandoff(BEA, { name: 'Bea', tenant: 'demo' }, { type: 'feature-request', fields: { summary: 'presets de reportes' } });
  const branch = `pet/${id}-api`;
  const worktree = join(work, 'acme-api-worktrees', `pet-${id}-api`);
  g(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'origin/main');
  commit(worktree, files, 'feat: presets');
  const block = {
    key: 'api', project, base: 'main', branch, worktree, commits: [], verdict: 'ok', findings: ['falta un test de borde'],
    gate: [{ cmd: 'npm test', code: 0, failures: [] }], pr_url: null,
  };
  requests.patch(id, {
    plan: { blocks: [{ key: 'api', project, goal: 'endpoint de presets', depends_on: [], spec: '' }], migrations, e2e: [], risks: [] },
    blocks: [block],
  });

  let held = false;
  const lockLog = [];
  const stageLock = async (fn) => { held = true; try { return await fn(); } finally { held = false; } };
  const real = createRepoOps({ pipeline: PIPELINE, token: () => token, leaks: createSecretGuard({ readFile: () => '', secrets: () => [TOKEN] }), remoteUrl: () => bare });
  const prs = [];
  const watched = [];
  const order = [];
  const applied = [];
  const db = {
    apply: async (a) => {
      applied.push(a);
      order.push(`apply ${a.author}/${a.database}`);
      return apply ? apply(a) : { skipped: false, kind: 'additive', dumpPath: null };
    },
  };
  const clashes = [];
  const clashCheck = async (a) => { clashes.push(a); order.push('clash'); return clash ?? { ok: true }; };
  const ops = {
    push: async (a) => { lockLog.push([a.ref, held]); order.push(`push ${a.ref}`); return real.push(a); },
    ensurePr: async (a) => {
      const open = prs.find((p) => p.repo === a.repo && p.head === a.head);
      if (open) { open.body = a.body; return { url: open.url, created: false }; }
      prs.push({ ...a, url: `https://github.com/${a.repo}/pull/${prs.length + 1}` });
      return { url: prs.at(-1).url, created: true };
    },
    watchRun: async (a) => { watched.push([a.sha, held, a.workflow]); return { conclusion, html_url: 'https://github.com/o/r/actions/runs/9' }; },
  };
  const deploys = [];
  const deployWeb = async (a) => { deploys.push([a.worktree, a.sha, held]); return { sha: a.sha, web: 'index-web1.js', admin: 'index-admin1.js' }; };
  const said = [];
  const gates = [];
  const installs = [];
  const step = createPreprodStep({
    profile: PROFILE, workspace: workspaceAt(work), pipeline: pipelineWith(deployWeb), requests, ops, token: () => token, stageLock, leaks: createSecretGuard({ readFile: () => '', secrets: () => [TOKEN] }), db, clashCheck,
    projectsYaml: () => YAML, install: async (a) => { installs.push(a); },
    gate: async (a) => { gates.push([a.worktree, a.commands, held]); return gate ? gate(a) : a.commands.map((cmd) => ({ cmd, code: 0, failures: [] })); },
  });
  const run = () => step({ request: requests.get(id), signal: new AbortController().signal, say: async (s) => { said.push(s); } });
  const events = () => requests.detail(id).events.filter((e) => e.actor === 'agent:preprod').map((e) => [e.kind, e.text]);
  const tmp = join(work, `${project}-worktrees`, `stage-pet-${id}`);
  t.after(() => requests.close());
  return { id, bare, repo, worktree, branch, requests, prs, watched, lockLog, said, run, events, tmp, order, applied, clashes, gates, installs, deploys };
}
const remote = (s, ref) => { try { return g(s.bare, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };

test('acme-api without migrations: branch + draft PR, merge into stage under the lock, deploy watched outside it', async (t) => {
  const s = setup(t);
  const tip = g(s.worktree, 'rev-parse', 'HEAD');
  const out = await s.run();
  assert.equal(remote(s, s.branch), tip);
  const stage = remote(s, 'stage');
  assert.equal(g(s.bare, 'rev-list', '--parents', '-n', '1', stage).split(' ').length, 3, 'a --no-ff merge commit');
  g(s.bare, 'merge-base', '--is-ancestor', tip, stage);
  assert.equal(remote(s, 'main'), g(s.repo, 'rev-parse', 'origin/main'), 'main untouched');
  assert.deepEqual(s.lockLog, [[`refs/heads/${s.branch}`, false], ['refs/heads/stage', true]]);
  assert.deepEqual(s.watched, [[stage, false, 'deploy-preprod.yml']]);
  assert.ok(!existsSync(s.tmp), 'temp stage worktree removed');

  const [pr] = s.prs;
  assert.deepEqual([pr.repo, pr.base, pr.head, pr.title], ['acme/api', 'main', s.branch, `Petición #${s.id}: endpoint de presets`]);
  for (const x of ['presets de reportes', 'endpoint de presets', 'src/presets.js', 'npm test', 'falta un test de borde', 'Pendiente antes de producción', 'tabla presets', 'E2E', 'pipeline de peticiones de Alex']) {
    assert.ok(pr.body.includes(x), x);
  }
  assert.doesNotMatch(pr.body, /claude|anthropic|\bIA\b|\bAI\b/i);
  assert.equal(s.requests.detail(s.id).blocks[0].pr_url, pr.url);
  const ev = s.events();
  assert.deepEqual(ev.map((e) => e[0]), ['push', 'pr', 'push', 'note']);
  assert.ok(ev[1][1].includes(pr.url));
  assert.ok(ev[3][1].includes('https://github.com/o/r/actions/runs/9'));
  assert.deepEqual(s.said, [`PETICIÓN #${s.id} lista para entregar: ${pr.url}`]);
  assert.ok(out.result.includes(pr.url));
});

test('retry: no second PR, no re-merge into stage that already has the tip, the deploy of that sha is watched again', async (t) => {
  const s = setup(t);
  await s.run();
  const stage = remote(s, 'stage');
  await s.run();
  assert.equal(s.prs.length, 1);
  assert.equal(remote(s, 'stage'), stage);
  assert.deepEqual(s.lockLog.filter(([ref]) => ref === 'refs/heads/stage').length, 1);
  assert.deepEqual(s.watched.map(([sha]) => sha), [stage, stage]);
});

const SQL = 'CREATE TABLE presets (id INT);\n';
test('migrations in the diff: applied to every target after the PR and before stage is pushed; then stage + deploy as usual', async (t) => {
  const s = setup(t, { files: { [MIG]: SQL } });
  await s.run();
  assert.deepEqual(s.order, ['clash', `push refs/heads/${s.branch}`, 'apply demo/app', 'apply demo2/shop', 'push refs/heads/stage']);
  assert.deepEqual(s.applied.map((a) => [a.requestId, a.project, a.file, a.sql]), [[s.id, 'acme-api', MIG, SQL], [s.id, 'acme-api', MIG, SQL]]);
  assert.equal(s.clashes.length, 1, 'clash check runs once, before any push');
  const fp = { files: [MIG], tables: ['demo/app/presets', 'demo2/shop/presets'] };
  assert.deepEqual(s.clashes[0].blocks.map((b) => b.footprint), [fp]);
  assert.deepEqual(s.requests.detail(s.id).blocks[0].footprint, fp, 'footprint stored for other requests');
  assert.equal(s.watched.length, 1);
  const ev = s.events();
  assert.deepEqual(ev.map((e) => e[0]), ['push', 'pr', 'migration', 'migration', 'push', 'note']);
  assert.ok(ev[2][1].includes(`${MIG} → demo/app`));
  for (const x of ['tabla presets', MIG, 'demo/app', 'demo2/shop', 'aditiva', 'fase 2']) assert.ok(s.prs[0].body.includes(x), x);
  assert.doesNotMatch(s.prs[0].body, /Q1|a mano/);
});

test('cross-database migration: the extra databases show in the PR line', async (t) => {
  const s = setup(t, { files: { [MIG]: 'CREATE VIEW app_data.vw_x AS SELECT 1;\n' }, migrations: [{ project: 'acme-api', summary: 'vista', file: MIG, targets: [TARGETS[0]] }] });
  await s.run();
  assert.ok(s.prs[0].body.includes('demo/app (también toca app_data)'), s.prs[0].body);
});

test('migration already applied (ledger skip) and a destructive one with its dump: both noted, stage still pushed', async (t) => {
  const s = setup(t, { files: { [MIG]: SQL }, apply: (a) => (a.author === 'demo2' ? { skipped: true, kind: 'additive', dumpPath: null } : { skipped: false, kind: 'destructive', dumpPath: '/d/x.sql.gz' }) });
  await s.run();
  const notes = s.events().filter(([k]) => k === 'migration').map(([, x]) => x);
  assert.match(notes[0], /destructiva, respaldo \/d\/x\.sql\.gz/);
  assert.match(notes[1], /ya aplicada/);
  assert.equal(s.watched.length, 1);
});

test('migrations without declared targets (plan saved before B11a): stop with a note, never guess, stage untouched', async (t) => {
  const s = setup(t, { files: { [MIG]: SQL }, migrations: [{ project: 'acme-api', summary: 'tabla presets' }] });
  const stage = remote(s, 'stage');
  await assert.rejects(s.run(), /sin bases destino declaradas en el plan/);
  assert.deepEqual([s.applied, s.watched, remote(s, 'stage'), s.prs.length], [[], [], stage, 1]);
  assert.ok(s.events().some(([k, x]) => k === 'note' && x.includes(MIG)));
  assert.ok(s.prs[0].body.includes('sin bases destino declaradas'));
});

test('preprod database down: the step holds (waiting) instead of failing; nothing merged into stage', async (t) => {
  const s = setup(t, { files: { [MIG]: SQL }, apply: () => { throw Object.assign(new Error(PREPROD_DOWN), { code: 'PREPROD_DOWN' }); } });
  const stage = remote(s, 'stage');
  assert.deepEqual(await s.run(), { hold: PREPROD_DOWN, wait: true });
  assert.deepEqual([remote(s, 'stage'), s.watched, s.said], [stage, [], []]);
});

test('clash: held before anything is pushed or applied (no attempt spent: a hold, not an error)', async (t) => {
  const s = setup(t, { files: { [MIG]: SQL }, clash: { ok: false, hold: 'choque con #3: tabla presets' } });
  const stage = remote(s, 'stage');
  assert.deepEqual(await s.run(), { hold: 'choque con #3: tabla presets', clash: true });
  assert.deepEqual([s.applied, s.watched, s.prs, remote(s, s.branch), remote(s, 'stage'), s.said], [[], [], [], null, stage, []]);
});

test('acme-web: merged into stage, then deployed by the bridge itself (no GitHub workflow watched), outside the stage lock', async (t) => {
  const s = setup(t, { project: 'acme-web' });
  const tip = g(s.worktree, 'rev-parse', 'HEAD');
  await s.run();
  assert.deepEqual([s.prs[0].repo, s.prs[0].base], ['acme/web', 'master']);
  assert.equal(g(s.bare, 'merge-base', '--is-ancestor', tip, 'stage'), '');
  const stage = remote(s, 'stage');
  assert.deepEqual(s.deploys, [[s.worktree, stage, false]]);
  assert.deepEqual(s.watched, []);
  assert.ok(!existsSync(s.tmp));
  assert.deepEqual(s.events().at(-1), ['note', `api: deploy a preprod (local, stage ${stage.slice(0, 7)}) ok: web-preprod index-web1.js · admin-preprod index-admin1.js`]);
});

test('projects without a preprod deploy: branch + PR to their prod branch, never stage', async (t) => {
  const s = setup(t, { project: 'acme-site' });
  const stage = remote(s, 'stage');
  await s.run();
  assert.deepEqual([s.prs[0].repo, s.prs[0].base], ['acme/site', 'main']);
  assert.equal(remote(s, 'stage'), stage);
  assert.deepEqual(s.lockLog.map(([ref]) => ref), [`refs/heads/${s.branch}`]);
});

test('merge conflict with stage: aborted, step fails, PR kept, stage untouched, temp worktree removed', async (t) => {
  const s = setup(t, { files: { 'src/app.js': 'mine\n' } });
  const other = join(dirname(s.repo), 'other');
  execFileSync('git', ['clone', '-q', '-b', 'stage', s.bare, other], { stdio: 'ignore' });
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) g(other, 'config', k, v);
  commit(other, { 'src/app.js': 'theirs\n' });
  g(other, 'push', '-q', 'origin', 'stage');
  const stage = remote(s, 'stage');
  await assert.rejects(s.run(), /conflicto al mezclar/);
  assert.equal(remote(s, 'stage'), stage);
  assert.equal(s.prs.length, 1);
  assert.ok(!existsSync(s.tmp));
  assert.deepEqual(s.watched, []);
});

test('deploy-preprod not successful: the step fails with the run URL', async (t) => {
  const s = setup(t, { conclusion: 'failure' });
  await assert.rejects(s.run(), /deploy a preprod \(deploy-preprod\.yml\) terminó en failure: https:\/\/github\.com\/o\/r\/actions\/runs\/9/);
  assert.deepEqual(s.said, []);
});

test('secret in the diff: nothing is pushed', async (t) => {
  const s = setup(t, { files: { 'src/cfg.js': `const t = '${TOKEN}';\n` } });
  await assert.rejects(s.run(), /posible secreto en el diff de api/);
  assert.equal(remote(s, s.branch), null);
  assert.deepEqual([s.prs, s.lockLog], [[], []]);
});

test('preconditions: missing token, unknown project, dirty worktree, HEAD off the branch tip -> fail before any push', async (t) => {
  await assert.rejects(setup(t, { token: null }).run(), { message: 'falta el token de GitHub (Ajustes)' });
  await assert.rejects(setup(t, { project: 'unknown-repo' }).run(), /no sé a qué repo de GitHub subir unknown-repo/);
  const dirty = setup(t);
  writeFileSync(join(dirty.worktree, 'src/app.js'), 'edited\n');
  await assert.rejects(dirty.run(), /cambios sin commit/);
  const off = setup(t);
  g(off.worktree, 'checkout', '-q', '--detach', 'HEAD~1');
  await assert.rejects(off.run(), /no está en la punta de/);
  for (const s of [dirty, off]) assert.deepEqual([remote(s, s.branch), s.lockLog], [null, []]);
});

// master<->stage drift (real case #2, acme-web): main bumps package.json + lock, stage gets that bump cherry-picked, main
// bumps again, then the pet branch is cut from main. stageOnly: stage's change is its own work, not a cherry-pick.
const DEPS = ['package.json', 'pnpm-lock.yaml'];
const deps = (v) => Object.fromEntries(DEPS.map((f) => [f, `${f} ${v}\n`]));
const drift = ({ stageOnly = false } = {}) => (repo) => {
  commit(repo, deps('v1'), 'deps v1');
  g(repo, 'push', '-q', 'origin', 'main', 'main:stage');
  commit(repo, deps('v2'), 'deps v2');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'checkout', '-q', '-b', 'st', 'origin/stage');
  if (stageOnly) commit(repo, deps('v2-stage'), 'stage deps');
  else g(repo, 'cherry-pick', '-x', 'main');
  const picked = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'push', '-q', 'origin', 'st:stage');
  g(repo, 'checkout', '-q', 'main');
  commit(repo, deps('v3'), 'deps v3');
  g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'fetch', '-q', 'origin');
  drift.picked = picked;
};

test('drift: conflicts only on files the request does not touch, stage side cherry-picked from main -> main side, gate, pushed', async (t) => {
  const s = setup(t, { before: drift() });
  const tip = g(s.worktree, 'rev-parse', 'HEAD');
  await s.run();
  const stage = remote(s, 'stage');
  assert.equal(g(s.bare, 'rev-list', '--parents', '-n', '1', stage).split(' ').length, 3, 'a merge commit');
  g(s.bare, 'merge-base', '--is-ancestor', tip, stage);
  for (const f of DEPS) assert.equal(g(s.bare, 'show', `${stage}:${f}`), `${f} v3`);
  assert.equal(g(s.bare, 'log', '-1', '--format=%s', stage), `merge: ${s.branch} into stage (package.json, pnpm-lock.yaml from main)`);
  assert.deepEqual(s.gates, [[s.tmp, ['npm test'], true]], 'gate on the temp worktree, under the lock');
  assert.deepEqual(s.installs.map((a) => [a.worktree, a.packageManager]), [[s.tmp, 'npm']]);
  assert.deepEqual(s.watched.map(([sha]) => sha), [stage]);
  assert.ok(!existsSync(s.tmp));
  const ev = s.events();
  assert.deepEqual(ev.map((e) => e[0]), ['push', 'pr', 'note', 'push', 'note']);
  for (const x of ['package.json', 'pnpm-lock.yaml', drift.picked.slice(0, 7), 'main']) assert.ok(ev[2][1].includes(x), x);
});

test('drift with stage-only work on the conflicting file: original conflict error naming it, aborted, nothing pushed', async (t) => {
  const s = setup(t, { before: drift({ stageOnly: true }) });
  const stage = remote(s, 'stage');
  await assert.rejects(s.run(), /conflicto al mezclar .* \(stage tiene cambios propios en package\.json, pnpm-lock\.yaml\)/);
  assert.deepEqual([remote(s, 'stage'), s.gates, s.watched], [stage, [], []]);
  assert.ok(!existsSync(s.tmp));
});

test('drift on a file the request itself touches: fails as today', async (t) => {
  const s = setup(t, { before: drift(), files: { 'package.json': 'mine\n' } });
  const stage = remote(s, 'stage');
  await assert.rejects(s.run(), /conflicto al mezclar .*la petición toca package\.json/);
  assert.deepEqual([remote(s, 'stage'), s.gates, s.watched], [stage, [], []]);
  assert.ok(!existsSync(s.tmp));
});

test('drift resolved but the gate fails: nothing pushed, clear error, temp worktree removed', async (t) => {
  const s = setup(t, { before: drift(), gate: ({ commands }) => commands.map((cmd) => ({ cmd, code: 1, failures: ['src/a.test.js'] })) });
  const stage = remote(s, 'stage');
  await assert.rejects(s.run(), /conflicto de deriva master↔stage resuelto con el lado de main pero el gate falló: npm test: src\/a\.test\.js/);
  assert.deepEqual([remote(s, 'stage'), s.watched], [stage, []]);
  assert.ok(!existsSync(s.tmp));
});
