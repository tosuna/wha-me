// Nothing about the owner's workspace or repos is hardcoded: the example config drives the plan prompt, the worktrees and the
// preprod step, whose stage deploy goes through the repo's DeployTarget (deploy.js). Prompts are also built for a second
// profile (profiles.fixture.js) and must name only their own workspace, repos and tenants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createAgent, skillDir } from './agent.js';
import { createPlanStep } from './plan-step.js';
import { createPreprodStep } from './preprod-step.js';
import { example, other, foreignValues } from './profiles.fixture.js';

const { profile, workspace, pipeline, knowledge } = example;
const yamlOf = (repo) => `projects:\n  - id: ${repo}\n    path: ${repo}\n    package_manager: npm\n`;
const YAML = yamlOf('web');
const SPEC = ['## Project', '## Goal', '## Files', '## Acceptance criteria', '## Verify command', '## Context hints', '## Out of scope', '## Read budget',
  example.pipeline.playbook.specRule.check].join('\n');

// One plan step run for config c on its first repo: the prompt and the git commands.
async function planRun(c) {
  let prompt;
  const exec = [];
  const [repo] = Object.keys(c.pipeline.repos);
  const requests = { detail: () => ({ evidence: [], plan: null }), patch: () => {} };
  const plan = { question: null, blocks: [{ key: 'ui', project: repo, goal: 'g', depends_on: [], spec: SPEC }], migrations: [], e2e: [], risks: [] };
  await createPlanStep({
    profile: c.profile, workspace: c.workspace, pipeline: c.pipeline, requests, prodCode: { fresh: async () => {} }, projectsYaml: () => yamlOf(repo), requestsDir: mkdtempSync(join(tmpdir(), 'wa-gen-')),
    runStep: async (a) => { prompt = a.prompt; return { result: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, costUsd: 0 }; },
    execFile: async (cmd, args) => { exec.push([cmd, ...args].join(' ')); return { stdout: '' }; }, exists: () => false, copyFile: () => {},
  })({ request: { id: 7, summary: 's' }, budgetUsd: 1, timeoutMs: 1 });
  return { prompt, exec };
}

test('plan step: prompt, branch and worktree come from the example workspace and repo', async () => {
  const { prompt, exec } = await planRun(example);
  assert.match(prompt, /Read first: \/home\/alex\/work\/CLAUDE\.md/);
  assert.match(prompt, /each block branches from its production base: web \(base main\)/);
  assert.match(prompt, /production mirrors at \/home\/alex\/work\/wha-me-prod-code\/<repo> \(web\)/);
  assert.match(prompt, /e\.g\. \/home\/alex\/work\/web-worktrees\/<task>/);
  assert.ok(prompt.includes(pipeline.playbook.plan({ root: '/home/alex/work' }).join('\n')));
  assert.ok(prompt.includes(pipeline.playbook.specRule.text));
  assert.doesNotMatch(prompt, /Paso|edges\.yaml|tuteo|convocatorias/);
  assert.deepEqual(foreignValues(prompt, example), []);
  assert.ok(exec.includes('git -C /home/alex/work/web worktree add -b pet/7-ui /home/alex/work/web-worktrees/pet-7-ui origin/main'), exec.join('\n'));
});

test('plan step: a second profile gets its own workspace and repo, nothing of the example', async () => {
  const { prompt, exec } = await planRun(other);
  assert.match(prompt, /Read first: \/srv\/bea\/code\/CLAUDE\.md/);
  assert.match(prompt, /each block branches from its production base: shop \(base trunk\)/);
  assert.match(prompt, /production mirrors at \/srv\/bea\/code\/mirrors\/<repo> \(shop\)/);
  assert.deepEqual(foreignValues(prompt, other), []);
  assert.ok(exec.includes('git -C /srv/bea/code/shop worktree add -b req/7-ui /srv/bea/code/shop-worktrees/req-7-ui origin/trunk'), exec.join('\n'));
});

test('preprod step: pushes to the example repo and deploys stage through its DeployTarget', async () => {
  const SHA = 'a'.repeat(40);
  const ops = { calls: [] };
  for (const m of ['push', 'ensurePr', 'watchRun']) {
    ops[m] = async (a) => { ops.calls.push([m, a.repo, a.ref ?? a.base ?? a.workflow]); return m === 'ensurePr' ? { url: 'https://gh/pr/1' } : { conclusion: 'success', html_url: 'https://gh/run/1' }; };
  }
  const events = [];
  const block = { key: 'ui', project: 'web', branch: 'pet/7-ui', base: 'main', worktree: '/home/alex/work/web-worktrees/pet-7-ui' };
  const requests = { detail: () => ({ plan: { blocks: [], migrations: [] }, blocks: [block] }), event: (id, e) => events.push(e.text), patch: () => {} };
  const execFile = async (cmd, args) => ({ stdout: args.includes('rev-parse') ? `${SHA}\n` : '' });
  const r = await createPreprodStep({ profile, workspace, pipeline, requests, ops, token: () => 't', execFile, leaks: () => false, projectsYaml: () => YAML })({ request: { id: 7, summary: 's' } });
  assert.equal(r.result, 'https://gh/pr/1');
  assert.deepEqual(ops.calls, [['push', 'acme/web', 'refs/heads/pet/7-ui'], ['ensurePr', 'acme/web', 'main'], ['watchRun', 'acme/web', 'deploy-staging.yml']]);
  assert.ok(events.includes('ui: deploy a preprod (deploy-staging.yml) ok: https://gh/run/1'), events.join('\n'));
});

test('preprod step: any DeployTarget plugs in (port, not a branch on its kind)', async () => {
  const seen = [];
  const spy = { stage: true, run: async (ctx) => { seen.push({ repo: ctx.repo, sha: ctx.sha, worktree: ctx.worktree, ops: !!ctx.ops, leaks: typeof ctx.leaks }); return '(spy) ok: here'; } };
  const custom = { ...pipeline, repos: { web: { ...pipeline.repos.web, deploy: spy } } };
  const events = [];
  const block = { key: 'ui', project: 'web', branch: 'pet/7-ui', base: 'main', worktree: '/wt/ui' };
  const requests = { detail: () => ({ plan: { blocks: [], migrations: [] }, blocks: [block] }), event: (id, e) => events.push(e.text), patch: () => {} };
  const ops = { push: async () => {}, ensurePr: async () => ({ url: 'u' }), watchRun: async () => { throw new Error('not this target'); } };
  const execFile = async (cmd, args) => ({ stdout: args.includes('rev-parse') ? 'b'.repeat(40) : '' });
  await createPreprodStep({ profile, workspace, pipeline: custom, requests, ops, token: () => 't', execFile, leaks: () => false, projectsYaml: () => YAML })({ request: { id: 7, summary: 's' } });
  assert.deepEqual(seen, [{ repo: 'acme/web', sha: 'b'.repeat(40), worktree: '/wt/ui', ops: true, leaks: 'function' }]);
  assert.ok(events.includes('ui: deploy a preprod (spy) ok: here'));
});

test('preprod step: migrations none() -> a migration file in the diff is listed in the PR and never applied', async () => {
  const SHA = 'a'.repeat(40);
  const bodies = [];
  const ops = { push: async () => {}, ensurePr: async (a) => { bodies.push(a.body); return { url: 'u' }; }, watchRun: async () => ({ conclusion: 'success', html_url: 'r' }) };
  const block = { key: 'ui', project: 'web', branch: 'pet/7-ui', base: 'main', worktree: '/wt/ui' };
  const requests = { detail: () => ({ plan: { blocks: [], migrations: [] }, blocks: [block] }), event: () => {}, patch: () => {} };
  const execFile = async (cmd, args) => ({
    stdout: args.includes('rev-parse') ? `${SHA}\n` : args.includes('--name-only') ? 'db/migrations/001.sql\n' : args.includes('show') ? 'CREATE TABLE t (id INT);' : '',
  });
  const r = await createPreprodStep({ profile, workspace, pipeline, requests, ops, token: () => 't', execFile, leaks: () => false, projectsYaml: () => YAML })({ request: { id: 7, summary: 's' } });
  assert.equal(r.result, 'u');
  assert.match(bodies[0], /db\/migrations\/001\.sql/);
});

// One reply run through a fake `claude`: its argv, prompt and --mcp-config.
async function replyRun(k, { profile, workspace } = example, tenant = 'demo') {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ args, opts });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    setImmediate(() => { child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: 'REPLY: ok', is_error: false })}\n`); child.emit('close', 0); });
    return child;
  };
  const agent = createAgent({ profile, workspace, knowledge: k, spawn });
  await agent.runReply({ contact: { name: 'P', tenant }, transcript: [{ author: 'CONTACTO', text: 'hola' }], health: [], topics: [] });
  const { args } = calls[0];
  const after = (flag) => args[args.indexOf(flag) + 1];
  return { args, prompt: after('-p'), mcp: JSON.parse(after('--mcp-config')), settings: JSON.parse(after('--settings')), cwd: calls[0].opts.cwd };
}

test('reply run: the example config adds no knowledge MCP server, tool or prompt line; paths come from the workspace', async () => {
  const r = await replyRun(knowledge);
  assert.deepEqual(Object.keys(r.mcp.mcpServers), ['codegraph']);
  assert.deepEqual(r.settings.permissions.allow, ['mcp__codegraph__codegraph_explore']);
  assert.ok(r.settings.permissions.deny.includes('Read(//home/alex/work/web/**)'));
  assert.ok(r.args.includes('/home/alex/work/wha-me-prod-code') && r.args.includes('/home/alex/work'));
  assert.match(r.prompt, /production mirrors at \/home\/alex\/work\/wha-me-prod-code\/<repo> \(web\)/);
  // The skill dir (this checkout) and the codegraph binary on PATH are machine paths, not config.
  assert.deepEqual(foreignValues(r.prompt.replaceAll(skillDir(example.profile), ''), example), []);
  assert.deepEqual(foreignValues(JSON.stringify(r.settings), example), []);
  const bea = await replyRun(other.knowledge, other, 'zeta');
  assert.ok(bea.settings.permissions.deny.includes('Read(//srv/bea/code/shop/**)'));
  assert.match(bea.prompt, /production mirrors at \/srv\/bea\/code\/mirrors\/<repo> \(shop\)/);
  assert.deepEqual(foreignValues(bea.prompt.replaceAll(skillDir(other.profile), ''), other), []);
  assert.deepEqual(foreignValues(JSON.stringify(bea.settings), other), []);
});

test('reply run: a tenant\'s knowledge MCP servers, tools and hints plug in for that tenant only', async () => {
  const docs = { type: 'stdio', command: '/opt/docs-mcp', args: ['--ro'], env: { DOCS_TENANT: 'demo' } };
  const k = { ...knowledge, tenants: { demo: { mcpServers: { docs }, allowedTools: ['mcp__docs__search'], replyHints: ['The docs MCP is available for demo.'] } } };
  const r = await replyRun(k);
  assert.deepEqual(r.mcp.mcpServers.docs, docs);
  assert.deepEqual(Object.keys(r.mcp.mcpServers), ['codegraph', 'docs']);
  assert.deepEqual(r.settings.permissions.allow, ['mcp__codegraph__codegraph_explore', 'mcp__docs__search']);
  assert.match(r.prompt, /\nThe docs MCP is available for demo\.\n/);
  const other = await replyRun({ ...k, tenants: { acme: k.tenants.demo } });
  assert.deepEqual(Object.keys(other.mcp.mcpServers), ['codegraph']);
});
