import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProdCode, REFRESH_EVERY, FRESH_FOR, FRESH_WAIT, withFreshCode } from './prod-code.js';

const V = '/home/alex/work';
const WORKSPACE = { root: V, prodCodeDir: `${V}/wha-me-prod-code`, prodMirrors: { web: 'master', api: 'main', lib: 'main' }, codeIndex: { bin: 'indexer', args: (dir) => ['index', '--cwd', dir] } };
const M = WORKSPACE.prodCodeDir;

// Fake execFile: records "cmd args..." lines; `rev-parse HEAD` answers from heads[mirror] (shifted per call).
function setup({ existing = [], heads = {}, fail = () => false, indexBin = '/bin/indexer', workspace = WORKSPACE, hang = false, now = () => 0 } = {}) {
  const calls = [];
  const logs = [];
  const timers = [];
  const execFile = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (hang) return new Promise(() => {});
    if (fail(line)) throw new Error(`boom: ${line}`);
    if (args.includes('rev-parse')) return { stdout: `${heads[args[1]].shift()}\n` };
    return { stdout: '' };
  };
  const prod = createProdCode({
    workspace, execFile, exists: (p) => existing.includes(p), codegraph: '/bin/codegraph', indexBin,
    clock: { setTimer: (fn, ms) => timers.push({ fn, ms }), now }, log: (m) => logs.push(m),
  });
  return { prod, calls, logs, timers };
}

test('missing mirror: fetch the prod branch, then worktree add --detach at origin/<branch>, then the code index command', async () => {
  const { prod, calls } = setup();
  await prod.refresh();
  for (const [r, b] of [['web', 'master'], ['api', 'main'], ['lib', 'main']]) {
    const fetch = calls.indexOf(`git -C ${V}/${r} fetch --quiet origin ${b}`);
    const add = calls.indexOf(`git -C ${V}/${r} worktree add --detach ${M}/${r} origin/${b}`);
    const init = calls.indexOf(`/bin/indexer index --cwd ${M}/${r}`);
    assert.ok(fetch >= 0 && fetch < add && add < init, r);
  }
  assert.ok(!calls.some((c) => / (checkout|reset|stash|switch) /.test(c) && !c.includes(M)), 'never touches the dev checkouts');
});

test('missing mirror with the index command not on PATH, or none configured: no index, mirror still created', async () => {
  for (const { prod, calls } of [setup({ indexBin: null }), setup({ workspace: { ...WORKSPACE, codeIndex: undefined }, indexBin: undefined })]) {
    await prod.refresh();
    assert.ok(calls.includes(`git -C ${V}/web worktree add --detach ${M}/web origin/master`));
    assert.ok(!calls.some((c) => c.includes('index')));
  }
});

test('existing mirror: fetch + checkout --detach --force origin/<branch>; codegraph sync only if HEAD changed and indexed', async () => {
  const webM = `${M}/web`;
  const apiM = `${M}/api`;
  const libM = `${M}/lib`;
  const { prod, calls } = setup({
    existing: [webM, apiM, libM, `${webM}/.codegraph`, `${apiM}/.codegraph`],
    heads: { [webM]: ['a', 'b'], [apiM]: ['c', 'c'], [libM]: ['d', 'e'] }, // lib changed but has no .codegraph
  });
  await prod.refresh();
  assert.ok(calls.includes(`git -C ${V}/web fetch --quiet origin master`));
  assert.ok(calls.includes(`git -C ${webM} checkout --quiet --detach --force origin/master`));
  assert.ok(calls.includes(`git -C ${apiM} checkout --quiet --detach --force origin/main`));
  assert.ok(calls.includes(`git -C ${libM} checkout --quiet --detach --force origin/main`));
  assert.deepEqual(calls.filter((c) => c.includes('codegraph')), [`/bin/codegraph sync --quiet ${webM}`]);
  assert.ok(!calls.some((c) => c.includes('worktree add')));
});

test('a failing repo is logged and does not stop the others or throw', async () => {
  const { prod, calls, logs } = setup({ fail: (l) => l.includes('web fetch') });
  await prod.refresh();
  assert.ok(!calls.some((c) => c.includes('worktree add') && c.includes('web')), 'keeps the previous mirror');
  assert.ok(calls.some((c) => c.includes(`worktree add --detach ${M}/api`)));
  assert.equal(logs.filter((m) => /web.*boom/.test(m)).length, 1);
});

test('start refreshes now and then every 30 min, scheduling only after the previous refresh ends', async () => {
  const { prod, calls, timers } = setup({ fail: () => true });
  await prod.start();
  assert.equal(REFRESH_EVERY, 30 * 60 * 1000);
  assert.deepEqual(timers.map((t) => t.ms), [REFRESH_EVERY]);
  const n = calls.length;
  assert.ok(n > 0);
  await timers[0].fn();
  assert.ok(calls.length > n);
  assert.equal(timers.length, 2);
});

// Reply runs refresh the mirrors first, so a deploy is visible right away instead of up to 30 min later.
const fetches = (calls) => calls.filter((c) => c.includes(' fetch ')).length;

test('fresh: refreshes before a reply, skips if the last refresh ended < FRESH_FOR ago', async () => {
  let t = 0;
  const { prod, calls } = setup({ fail: (l) => l.includes('rev-parse'), now: () => t });
  await prod.fresh();
  assert.equal(fetches(calls), 3);
  t += FRESH_FOR - 1;
  await prod.fresh();
  assert.equal(fetches(calls), 3);
  t += 2;
  await prod.fresh();
  assert.equal(fetches(calls), 6);
});

test('fresh: concurrent callers share one refresh', async () => {
  const { prod, calls } = setup({ fail: (l) => l.includes('rev-parse') });
  await Promise.all([prod.fresh(), prod.fresh(), prod.fresh()]);
  assert.equal(fetches(calls), 3);
});

test('fresh: never waits more than FRESH_WAIT for a hung refresh', async () => {
  const { prod, timers } = setup({ hang: true });
  let done = false;
  const p = prod.fresh().then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  const w = timers.find((x) => x.ms === FRESH_WAIT);
  assert.ok(w, 'a FRESH_WAIT timer bounds the wait');
  w.fn();
  await p;
  assert.equal(done, true);
});

test('withFreshCode: runReply and runReplyTrace wait for fresh(); other methods untouched', async () => {
  const order = [];
  const agent = {
    runReply: async (a) => { order.push(['reply', a]); return 'r'; },
    runReplyTrace: async (a) => { order.push(['trace', a]); return 't'; },
    runJob: async () => 'j',
  };
  const wrapped = withFreshCode(agent, { fresh: async () => { order.push(['fresh']); } });
  assert.equal(await wrapped.runReply(1), 'r');
  assert.equal(await wrapped.runReplyTrace(2), 't');
  assert.equal(wrapped.runJob, agent.runJob);
  assert.deepEqual(order, [['fresh'], ['reply', 1], ['fresh'], ['trace', 2]]);
});
