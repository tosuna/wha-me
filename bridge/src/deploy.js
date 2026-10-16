// DeployTarget: how a pipeline repo's stage branch reaches preprod (config pipeline.repos[id].deploy). Duck-typed:
//   stage: boolean — the repo has a stage branch the preprod step merges each block into and pushes (repo-ops.js allowPush,
//     clash.js stage commits). false: the step stops at the draft PR.
//   run(ctx) -> Promise<string> — only when stage; called after stage is pushed. ctx: { repo: 'owner/name', sha: the pushed
//     stage sha, worktree: the block's worktree, signal, ops: repo-ops.js, leaks: the secret guard, onSecret(value|null): adds
//     a runtime secret to the guard while the deploy holds it }. Resolves a one-line summary for the request events
//     ("(<how>) ok: <where>"); throws when the deploy did not succeed.
// Targets keep their state in closures: loadConfig freezes them.

// No preprod deploy.
export const none = () => ({ stage: false });

// A push to stage deploys through this GitHub Actions workflow; waits for its run of the stage sha (repo-ops.js watchRun,
// which fails at once when the workflow is disabled).
export const githubWorkflow = ({ workflow }) => ({
  stage: true,
  workflow,
  async run({ repo, sha, signal, ops }) {
    const run = await ops.watchRun({ repo, sha, workflow, signal });
    if (run.conclusion !== 'success') throw new Error(`deploy a preprod (${workflow}) terminó en ${run.conclusion}: ${run.html_url}`);
    return `(${workflow}) ok: ${run.html_url}`;
  },
});
