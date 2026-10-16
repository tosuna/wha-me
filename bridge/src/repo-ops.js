import { execCode } from './gate.js';
import { createSecretGuard } from './secrets.js';

// Peticiones pipeline: the only code that writes to GitHub. git push with the
// token only in the env and a ref allowlist checked here, plus the REST calls the preprod step needs (draft PRs, deploy runs).
const API = 'https://api.github.com';
const MIN = 60 * 1000;
const PUSH_TIMEOUT = 5 * MIN;
const SRC = /^(HEAD|[0-9a-f]{40})$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// pipeline: config pipeline (branchPrefix, repos). Throws unless `src:ref` is a plain (no force, no delete) push of HEAD or a
// sha to a <branchPrefix><id>-<key> branch, or to stage on a repo whose DeployTarget has a stage (deploy.js). The prod
// branches, other branches and tags are refused.
export function allowPush(pipeline, repo, src, ref) {
  const block = new RegExp(`^refs/heads/${escape(pipeline.branchPrefix)}\\d+-[a-z0-9-]{1,30}$`);
  const stage = ref === 'refs/heads/stage' && Object.values(pipeline.repos).some((r) => r.github === repo && r.deploy.stage);
  if (!SRC.test(src) || !(block.test(ref) || stage)) throw new Error(`push rechazado: ${repo} ${src}:${ref}`);
}

// pipeline: config pipeline. token(): the GitHub token (settings.token). exec: gate.js execCode. remoteUrl: tests map the repo to a local bare remote.
export function createRepoOps({
  pipeline, token, exec = execCode, fetch = globalThis.fetch, leaks = createSecretGuard(), remoteUrl = (repo) => `https://github.com/${repo}.git`,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const scrub = (s) => (leaks(s) || s.includes(token() ?? '\0') ? '[salida omitida: posible secreto]' : s.trim().slice(-500));

  async function push({ worktree, repo, src, ref, signal }) {
    allowPush(pipeline, repo, src, ref);
    const auth = Buffer.from(`x-access-token:${token()}`).toString('base64');
    const env = {
      ...process.env, GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    };
    const r = await exec('git', ['-C', worktree, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'push', '--no-verify', remoteUrl(repo), `${src}:${ref}`],
      { env, timeout: PUSH_TIMEOUT, signal });
    if (r.code !== 0) throw new Error(`git push falló (${repo} ${ref}): ${scrub(`${r.stderr}${r.stdout}`)}`);
  }

  async function api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'user-agent': 'wha-me', ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} respondió ${res.status}`);
    return res.json();
  }

  // Draft PR head -> base; an open one for that head is reused (body updated). -> { url, created }
  async function ensurePr({ repo, base, head, title, body }) {
    const q = new URLSearchParams({ state: 'open', head: `${repo.split('/')[0]}:${head}`, base });
    const [open] = await api('GET', `/repos/${repo}/pulls?${q}`);
    if (open) {
      await api('PATCH', `/repos/${repo}/pulls/${open.number}`, { body });
      return { url: open.html_url, created: false };
    }
    const pr = await api('POST', `/repos/${repo}/pulls`, { title, body, head, base, draft: true });
    return { url: pr.html_url, created: true };
  }

  // The `workflow` run (deploy.js githubWorkflow) of `sha` on stage, once completed (whatever its conclusion). A disabled
  // workflow never runs: fail at once instead of waiting out the timeout.
  async function watchRun({ repo, sha, workflow, signal, timeoutMs = 30 * MIN, pollMs = 20 * 1000 }) {
    const { state } = await api('GET', `/repos/${repo}/actions/workflows/${workflow}`);
    if (state !== 'active') throw new Error(`${workflow} está desactivado en GitHub (${state}); no hay deploy que esperar`);
    const end = now() + timeoutMs;
    const q = new URLSearchParams({ branch: 'stage', head_sha: sha });
    for (;;) {
      const [run] = (await api('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?${q}`)).workflow_runs ?? [];
      if (run?.status === 'completed') return run;
      if (now() >= end) throw new Error(`${workflow} no terminó en ${timeoutMs / MIN} min${run ? `: ${run.html_url}` : ''}`);
      signal?.throwIfAborted();
      await sleep(pollMs);
    }
  }

  return { push, ensurePr, watchRun };
}
