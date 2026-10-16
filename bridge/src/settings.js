import { execFile as nodeExecFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Portal "Ajustes": the GitHub token for the Peticiones pipeline. Classic token with the
// `repo` scope for now: the pipeline repos may span several owners (orgs and personal accounts), which a fine-grained token (one
// resource owner) cannot cover; a GitHub App is the later upgrade. Branch limits stay in the bridge push allowlist. The token
// lives only in the macOS Keychain (service = profile.keychainService) and in memory for the secret guard; state/settings.json keeps its
// expiry. Never logged, never returned: errors from `security` carry the command line, so they are replaced.
const ACCOUNT = 'github.token';
// Scopes the pipeline never needs and that would widen a leak (org admin, repo deletion, editing deploy workflows,
// packages, account keys): a token carrying any of them is refused.
const RISKY_SCOPES = ['admin:org', 'delete_repo', 'workflow', 'admin:repo_hook', 'admin:org_hook', 'admin:enterprise', 'write:packages', 'delete:packages', 'user', 'admin:public_key', 'admin:gpg_key'];
const API = 'https://api.github.com';
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

// service: the macOS Keychain service of the token (profile.keychainService). pipeline: config pipeline; the token must be
// able to push to every repo in it.
export function createSettings({ stateDir, service, pipeline, execFile = promisify(nodeExecFile), fetch = globalThis.fetch }) {
  const file = join(stateDir, 'settings.json');
  let token = null;
  const read = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const github = () => {
    const g = read().github;
    return { configured: !!g, expiresAt: g?.expiresAt ?? null, warnings: g?.warnings ?? [] };
  };
  const refuse = (status, error) => ({ ok: false, status, error });

  async function setGithubToken(raw) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!TOKEN_RE.test(t)) return refuse(400, 'eso no parece un token de GitHub');
    const get = (path) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'user-agent': 'wha-me' } });
    let user;
    let scopes;
    try {
      user = await get('/user');
      if (!user.ok) return refuse(400, `GitHub rechazó el token (${user.status})`);
      scopes = (user.headers.get('x-oauth-scopes') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!scopes.includes('repo')) return refuse(400, 'usa un token clásico con el permiso «repo»');
      const risky = scopes.filter((x) => RISKY_SCOPES.includes(x));
      if (risky.length) return refuse(400, `el token trae permisos que el pipeline no necesita: ${risky.join(', ')}. Crea uno solo con «repo»`);
      for (const { github: full } of Object.values(pipeline.repos)) {
        const repo = await get(`/repos/${full}`);
        if (!repo.ok) return refuse(400, `el token no tiene acceso a ${full} (${repo.status})`);
        if ((await repo.json())?.permissions?.push !== true) return refuse(400, `el token no puede escribir en ${full}`);
      }
    } catch {
      return refuse(502, 'no se pudo consultar GitHub');
    }
    const warnings = [];
    const expiresAt = Date.parse(user.headers.get('github-authentication-token-expiration') ?? '') || null;
    try {
      await execFile('security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', t]);
    } catch {
      console.error('settings: could not store the GitHub token in the Keychain');
      return refuse(500, 'no se pudo guardar en el llavero de macOS');
    }
    token = t;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...read(), github: { expiresAt, warnings, setAt: Date.now() } }, null, 2));
    renameSync(`${file}.tmp`, file);
    return { ok: true, github: github() };
  }

  return {
    github,
    // Peticiones pipeline engine (pipeline.js): off until PIPELINE_ENABLED is true in state/settings.json; read on every check.
    pipelineEnabled: () => read().PIPELINE_ENABLED === true,
    setGithubToken,
    token: () => token,
    // At startup: the stored token, for the secret guard. Missing or unreadable = null.
    async load() {
      try {
        token = (await execFile('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'])).stdout.trim() || null;
      } catch {
        token = null;
      }
    },
  };
}
