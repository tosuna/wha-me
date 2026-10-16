import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubWorkflow, none } from './deploy.js';

test('none(): no stage deploy and nothing to run', () => {
  assert.deepEqual(none(), { stage: false });
});

test('githubWorkflow: waits for the workflow run of the stage sha and summarizes it', async () => {
  const calls = [];
  const ops = { watchRun: async (a) => { calls.push(a); return { conclusion: 'success', html_url: 'https://gh/run/1' }; } };
  const target = githubWorkflow({ workflow: 'deploy-staging.yml' });
  assert.equal(target.stage, true);
  const signal = new AbortController().signal;
  assert.equal(await target.run({ repo: 'acme/web', sha: 'c'.repeat(40), worktree: '/wt', signal, ops }), '(deploy-staging.yml) ok: https://gh/run/1');
  assert.deepEqual(calls, [{ repo: 'acme/web', sha: 'c'.repeat(40), workflow: 'deploy-staging.yml', signal }]);
});

test('githubWorkflow: a run that did not succeed throws with its conclusion and url', async () => {
  const ops = { watchRun: async () => ({ conclusion: 'failure', html_url: 'https://gh/run/2' }) };
  await assert.rejects(githubWorkflow({ workflow: 'd.yml' }).run({ repo: 'acme/web', sha: 'c', ops }), /deploy a preprod \(d\.yml\) terminó en failure: https:\/\/gh\/run\/2/);
});

test('githubWorkflow: a disabled workflow fails fast (repo-ops watchRun error passes through)', async () => {
  const ops = { watchRun: async () => { throw new Error('d.yml está desactivado en GitHub (disabled_manually); no hay deploy que esperar'); } };
  await assert.rejects(githubWorkflow({ workflow: 'd.yml' }).run({ repo: 'acme/web', sha: 'c', ops }), /desactivado/);
});
