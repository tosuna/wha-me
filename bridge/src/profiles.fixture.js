// Two owner profiles for the genericity tests: the public example and a second one sharing none of its names. Built by the
// same code, each output must name only its own owner, workspace, repos and tenants: a value of the other profile in it
// means something was hardcoded.
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { githubWorkflow } from './deploy.js';

export const example = await loadConfig(fileURLToPath(new URL('../../config/example.config.js', import.meta.url)));

const ROOT = '/srv/bea/code';
export const other = {
  ...example,
  profile: { ...example.profile, name: 'Bea', tag: 'BEA', language: 'es-ES', timezone: 'Europe/Madrid' },
  workspace: {
    ...example.workspace, root: ROOT, projectsYaml: `${ROOT}/arch/projects.yaml`, requestsDir: `${ROOT}/requests`,
    worktreesDir: (repo) => `${ROOT}/${repo}-worktrees`, prodCodeDir: `${ROOT}/mirrors`, prodMirrors: { shop: 'trunk' },
  },
  pipeline: { ...example.pipeline, branchPrefix: 'req/', repos: { shop: { github: 'acme2/shop', prodBranch: 'trunk', deploy: githubWorkflow({ workflow: 'stage.yml' }) } } },
  knowledge: { ...example.knowledge, tenants: { zeta: { label: 'Zeta', mcpServers: {}, allowedTools: [], replyHints: [] } } },
};

// The names a profile puts in generated text.
const valuesOf = (c) => [
  c.profile.name, c.profile.tag, c.workspace.root,
  ...Object.entries(c.pipeline.repos).flatMap(([id, r]) => [id, r.github]),
  ...Object.entries(c.knowledge.tenants).flatMap(([id, t]) => [id, t.label].filter(Boolean)),
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (text, v) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, 'u').test(text);
// This checkout's own path (prompts name the bridge's files) says where it was cloned, not what the code hardcodes.
const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

// text built from config c -> the other profile's values it names, [] when it names only its own. Whole word, same case:
// 'web' or 'owner' in a comment is not the repo or the tag.
export function foreignValues(text, c) {
  const s = String(text).replaceAll(REPO, '<repo>');
  return valuesOf(c === example ? other : example).filter((v) => named(s, v));
}
