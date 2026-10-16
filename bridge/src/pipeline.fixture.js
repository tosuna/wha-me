// Workspace and pipeline for the step unit tests (plan, implement, review, clash, preprod), shaped like config/example.config.js:
// three neutral repos (an API with a workflow deploy, a web app with a local stage deploy, a site without one) and a fake
// migration target (authors demo and demo2).
import example from '../../config/example.config.js';
import { githubWorkflow, none } from './deploy.js';

export const ROOT = '/home/alex/work';
export const workspaceAt = (root) => ({
  root, projectsYaml: `${root}/arch/projects.yaml`, requestsDir: `${root}/wha-me-requests`, worktreesDir: (repo) => `${root}/${repo}-worktrees`,
  prodCodeDir: `${root}/wha-me-prod-code`, prodMirrors: { 'acme-web': 'master', 'acme-api': 'main', 'acme-ui': 'main' },
});
export const WORKSPACE = workspaceAt(ROOT);
// A stage target over a fake deploy fn -> { sha, web, admin } (two built sites).
export const localTarget = (deploy) => ({
  stage: true,
  async run({ worktree, sha, signal }) {
    const d = await deploy({ worktree, sha, signal });
    return `(local, stage ${d.sha.slice(0, 7)}) ok: web-preprod ${d.web} · admin-preprod ${d.admin}`;
  },
});
// MigrationTarget (migrations.js): author demo -> databases app and app_data, author demo2 -> shop. open() is never called by
// the tests that use it (they inject db).
const DBS = { demo: ['app', 'app_data'], demo2: ['shop'] };
export const MIGRATIONS = {
  planRules: ['- migrations: one entry per schema change; targets: { author, database }: demo -> app, app_data; demo2 -> shop. Never app_central.'],
  planTarget: '{ "author": "demo"|"demo2", "database": string }',
  allowed: (t) => Object.hasOwn(DBS, t?.author ?? '') && DBS[t.author].includes(t?.database),
  open: () => null,
};
// The example config's generic playbook.
export const PLAYBOOK = example.pipeline.playbook;
export const pipelineWith = (webDeploy = async ({ sha }) => ({ sha, web: 'index-web.js', admin: 'index-admin.js' })) => ({
  branchPrefix: 'pet/',
  repos: {
    'acme-api': { github: 'acme/api', prodBranch: 'main', deploy: githubWorkflow({ workflow: 'deploy-preprod.yml' }) },
    'acme-web': { github: 'acme/web', prodBranch: 'master', deploy: localTarget(webDeploy) },
    'acme-site': { github: 'acme/site', prodBranch: 'main', deploy: none() },
  },
  migrations: MIGRATIONS,
  playbook: PLAYBOOK,
});
export const PIPELINE = pipelineWith();
