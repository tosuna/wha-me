import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveBin } from './agent.js';

export const REFRESH_EVERY = 30 * 60 * 1000;
// Reply runs refresh first (a deploy shows up right away); a refresh newer than FRESH_FOR is reused, and a reply never
// waits more than FRESH_WAIT for a slow one (it then reads the previous mirror while the refresh finishes).
export const FRESH_FOR = 60 * 1000;
export const FRESH_WAIT = 20 * 1000;
const GIT_TIMEOUT = 5 * 60 * 1000;
const INDEX_TIMEOUT = 30 * 60 * 1000;

// Keeps <workspace.prodCodeDir>/<repo> = a detached worktree of <workspace.root>/<repo> at origin/<prod branch>, for every
// repo in workspace.prodMirrors. Only `fetch` and `worktree add` touch the source repo (refs/metadata), never its working tree
// or branch. Failures are logged and leave the previous mirror in place; CodeGraph is best effort (Grep still works without
// an index). workspace.codeIndex (optional): the command that builds a new mirror's index, run only if its bin is on PATH.
export function createProdCode({
  workspace, execFile = promisify(nodeExecFile), exists = existsSync, clock = { setTimer: setTimeout, now: Date.now }, log = console.error,
  codegraph = resolveBin('codegraph', workspace.codegraphBin ?? 'codegraph'),
  indexBin = workspace.codeIndex && resolveBin(workspace.codeIndex.bin, null),
}) {
  const { root, prodCodeDir, prodMirrors } = workspace;
  const sh = (cmd, args, timeout = GIT_TIMEOUT) => execFile(cmd, args, { timeout });
  const head = async (dir) => (await sh('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();

  async function refreshRepo(repo, branch) {
    const mirror = join(prodCodeDir, repo);
    const ref = `origin/${branch}`;
    await sh('git', ['-C', join(root, repo), 'fetch', '--quiet', 'origin', branch]);
    if (!exists(mirror)) {
      await sh('git', ['-C', join(root, repo), 'worktree', 'add', '--detach', mirror, ref]);
      log(`prod-code ${repo}: created at ${ref}`);
      if (indexBin) await sh(indexBin, workspace.codeIndex.args(mirror), INDEX_TIMEOUT);
      return;
    }
    const before = await head(mirror);
    await sh('git', ['-C', mirror, 'checkout', '--quiet', '--detach', '--force', ref]);
    if ((await head(mirror)) === before) return;
    log(`prod-code ${repo}: updated to ${ref}`);
    if (exists(join(mirror, '.codegraph'))) await sh(codegraph, ['sync', '--quiet', mirror], INDEX_TIMEOUT);
  }

  let running = null;
  let doneAt = -Infinity;
  const refresh = () => (running ??= refreshAll().finally(() => { running = null; doneAt = clock.now(); }));

  async function fresh() {
    if (!running && clock.now() - doneAt < FRESH_FOR) return;
    await Promise.race([refresh(), new Promise((r) => clock.setTimer(r, FRESH_WAIT))]);
  }

  async function refreshAll() {
    for (const [repo, branch] of Object.entries(prodMirrors)) {
      try {
        await refreshRepo(repo, branch);
      } catch (e) {
        log(`prod-code ${repo}: refresh failed, keeping the previous mirror: ${e.message}`);
      }
    }
  }

  // Next run is scheduled when the previous one ends, so slow fetches/indexing never overlap.
  const start = () => refresh().finally(() => clock.setTimer(start, REFRESH_EVERY));
  return { refresh, fresh, start };
}

// The agent as seen by the bridge: reply runs (real and /simular) read freshly refreshed mirrors.
export const withFreshCode = (agent, prodCode) => ({
  ...agent,
  runReply: async (a) => { await prodCode.fresh(); return agent.runReply(a); },
  runReplyTrace: async (a) => { await prodCode.fresh(); return agent.runReplyTrace(a); },
});
