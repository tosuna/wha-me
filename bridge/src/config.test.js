import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateContacts } from './config.js';

const EXAMPLE = fileURLToPath(new URL('../../config/example.config.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'wa-config-'));
let n = 0;
// Writes a config module: the example with `patch` applied to its `section` (undefined values remove the field; function
// values are written as source, so they must not close over anything).
const src = (v) => (v === undefined ? 'undefined' : typeof v === 'function' ? v.toString() : JSON.stringify(v));
async function withPatch(section, patch) {
  const file = join(dir, `c${++n}.config.js`);
  writeFileSync(file, [
    `import base from ${JSON.stringify(EXAMPLE)};`,
    `const patch = { ${Object.entries(patch).map(([k, v]) => `${JSON.stringify(k)}: ${src(v)}`).join(', ')} };`,
    `const merged = Object.fromEntries(Object.entries({ ...base[${JSON.stringify(section)}], ...patch }).filter(([, v]) => v !== undefined));`,
    `export default { ...base, ${JSON.stringify(section)}: merged };`,
  ].join('\n'));
  return file;
}
const withProfile = (patch) => withPatch('profile', patch);

test('loadConfig: loads the example config', async () => {
  const c = await loadConfig(EXAMPLE);
  assert.equal(c.profile.name, 'Alex');
  assert.equal(c.profile.tag, 'OWNER');
  assert.equal(c.profile.timezone, 'America/New_York');
  assert.deepEqual(c.profile.hours.days, [1, 2, 3, 4, 5]);
});

test('loadConfig: the result is deeply frozen', async () => {
  const c = await loadConfig(EXAMPLE);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.profile) && Object.isFrozen(c.profile.hours) && Object.isFrozen(c.profile.hours.days));
});

test('loadConfig: WHA_ME_CONFIG is the default path', async () => {
  const prev = process.env.WHA_ME_CONFIG;
  process.env.WHA_ME_CONFIG = await withProfile({ name: 'Env Owner' });
  try {
    assert.equal((await loadConfig()).profile.name, 'Env Owner');
  } finally {
    if (prev === undefined) delete process.env.WHA_ME_CONFIG; else process.env.WHA_ME_CONFIG = prev;
  }
});

test('loadConfig: rejects missing or invalid fields with the field name', async () => {
  const cases = [
    [{ name: undefined }, /profile\.name/],
    [{ name: "O'Neil" }, /profile\.name/],
    [{ name: 'A</script>' }, /profile\.name/],
    [{ tag: undefined }, /profile\.tag/],
    [{ tag: 'owner' }, /profile\.tag/],
    [{ tag: 'BRIDGE' }, /profile\.tag/],
    [{ language: undefined }, /profile\.language/],
    [{ timezone: 'Nowhere/City' }, /profile\.timezone/],
    [{ hours: undefined }, /profile\.hours/],
    [{ hours: { open: '8', close: '17:30', days: [1] } }, /profile\.hours\.open/],
    [{ hours: { open: '08:00', close: '07:00', days: [1] } }, /profile\.hours\.close/],
    [{ hours: { open: '08:00', close: '17:30', days: [7] } }, /profile\.hours\.days/],
    [{ keychainService: '' }, /profile\.keychainService/],
  ];
  for (const [patch, re] of cases) await assert.rejects(loadConfig(await withProfile(patch)), re, JSON.stringify(patch));
});

test('loadConfig: the example skill is the public example-support skill', async () => {
  const c = await loadConfig(EXAMPLE);
  assert.deepEqual(c.profile.skill, { dir: 'skills/example-support', name: 'example-support', learnable: ['references/voice.md', 'references/contacts.md'] });
});

test('loadConfig: rejects an invalid profile.skill with the field name', async () => {
  const skill = { dir: 'skills/example-support', name: 'example-support', learnable: ['references/voice.md', 'references/contacts.md'] };
  const cases = [
    [undefined, /profile\.skill/],
    [{ ...skill, dir: '' }, /profile\.skill\.dir/],
    [{ ...skill, dir: 'skills/nope' }, /profile\.skill\.dir/], // no SKILL.md there
    [{ ...skill, name: '' }, /profile\.skill\.name/],
    [{ ...skill, name: 'my "skill"' }, /profile\.skill\.name/],
    [{ ...skill, learnable: 'references/voice.md' }, /profile\.skill\.learnable/],
    [{ ...skill, learnable: ['references/voice.md'] }, /profile\.skill\.learnable/],
    [{ ...skill, learnable: ['/etc/passwd', 'references/contacts.md'] }, /profile\.skill\.learnable/],
    [{ ...skill, learnable: ['../../bridge/src/agent.js', 'references/contacts.md'] }, /profile\.skill\.learnable/],
    [{ ...skill, learnable: ['SKILL.md', 'references/contacts.md'] }, /profile\.skill\.learnable/],
  ];
  for (const [value, re] of cases) await assert.rejects(loadConfig(await withProfile({ skill: value })), re, JSON.stringify(value));
});

test('loadConfig: a module without a profile is rejected', async () => {
  const file = join(dir, 'empty.config.js');
  writeFileSync(file, 'export default {};\n');
  await assert.rejects(loadConfig(file), /profile/);
});

test('loadConfig: the example workspace and pipeline', async () => {
  const { workspace, pipeline } = await loadConfig(EXAMPLE);
  assert.equal(workspace.root, '/home/alex/work');
  assert.equal(workspace.worktreesDir('web'), '/home/alex/work/web-worktrees');
  assert.equal(pipeline.branchPrefix, 'pet/');
  assert.deepEqual(Object.keys(pipeline.repos), ['web']);
  assert.equal(pipeline.repos.web.github, 'acme/web');
  assert.equal(pipeline.repos.web.deploy.stage, true);
  assert.ok(Object.isFrozen(pipeline.repos.web));
});

test('loadConfig: rejects invalid workspace and pipeline fields with the field name', async () => {
  const stage = { stage: true, run: async () => 'ok' };
  const cases = [
    ['workspace', { root: undefined }, /workspace\.root/],
    ['workspace', { root: 'relative/dir' }, /workspace\.root/],
    ['workspace', { projectsYaml: '' }, /workspace\.projectsYaml/],
    ['workspace', { requestsDir: 'x' }, /workspace\.requestsDir/],
    ['workspace', { prodCodeDir: undefined }, /workspace\.prodCodeDir/],
    ['workspace', { worktreesDir: '/home/alex/work/wt' }, /workspace\.worktreesDir/],
    ['workspace', { prodMirrors: { web: '' } }, /workspace\.prodMirrors/],
    ['pipeline', { branchPrefix: 'pet' }, /pipeline\.branchPrefix/],
    ['pipeline', { branchPrefix: '../' }, /pipeline\.branchPrefix/],
    ['pipeline', { repos: {} }, /pipeline\.repos/],
    ['pipeline', { repos: { web: { github: 'web', prodBranch: 'main', deploy: stage } } }, /pipeline\.repos\.web\.github/],
    ['pipeline', { repos: { web: { github: 'acme/web', deploy: stage } } }, /pipeline\.repos\.web\.prodBranch/],
    ['pipeline', { repos: { web: { github: 'acme/web', prodBranch: 'main' } } }, /pipeline\.repos\.web\.deploy/],
    ['pipeline', { repos: { web: { github: 'acme/web', prodBranch: 'main', deploy: { stage: true } } } }, /pipeline\.repos\.web\.deploy/],
  ];
  for (const [section, patch, re] of cases) await assert.rejects(loadConfig(await withPatch(section, patch)), re, `${section} ${JSON.stringify(patch)}`);
});

test('loadConfig: a module without workspace or pipeline is rejected', async () => {
  for (const [missing, keep] of [['workspace', 'pipeline'], ['pipeline', 'workspace']]) {
    const file = join(dir, `no-${missing}.config.js`);
    writeFileSync(file, `import base from ${JSON.stringify(EXAMPLE)};\nexport default { profile: base.profile, ${keep}: base.${keep} };\n`);
    await assert.rejects(loadConfig(file), new RegExp(`${missing} is required`));
  }
});

test('loadConfig: the example has one labelled tenant without tools, one placeholder health URL and no migration target', async () => {
  const { knowledge, pipeline } = await loadConfig(EXAMPLE);
  assert.deepEqual(knowledge.tenants, { demo: { label: 'Demo', mcpServers: {}, allowedTools: [], replyHints: [] } });
  assert.deepEqual(knowledge.healthUrls, { pages: ['https://example.com/'], apis: [] });
  assert.deepEqual(pipeline.migrations.planRules, []);
  assert.equal(pipeline.migrations.open({ ledger: {} }), null);
});

test('loadConfig: rejects invalid knowledge and migration fields with the field name', async () => {
  const tenant = { mcpServers: { db: { command: '/bin/db', args: [] } }, allowedTools: ['mcp__db__q'], replyHints: ['hint'] };
  const cases = [
    ['knowledge', { tenants: undefined }, /knowledge\.tenants/],
    ['knowledge', { tenants: { demo: { ...tenant, mcpServers: { db: { args: [] } } } } }, /knowledge\.tenants\.demo\.mcpServers\.db/],
    ['knowledge', { tenants: { demo: { ...tenant, mcpServers: { db: { command: '/bin/db', args: 'x' } } } } }, /knowledge\.tenants\.demo\.mcpServers\.db/],
    ['knowledge', { tenants: { demo: { ...tenant, allowedTools: [1] } } }, /knowledge\.tenants\.demo\.allowedTools/],
    ['knowledge', { tenants: { demo: { ...tenant, replyHints: 'hint' } } }, /knowledge\.tenants\.demo\.replyHints/],
    ['knowledge', { tenants: { demo: { ...tenant, label: '' } } }, /knowledge\.tenants\.demo\.label/],
    ['knowledge', { tenants: { demo: { ...tenant, label: "Demo's" } } }, /knowledge\.tenants\.demo\.label/],
    ['knowledge', { tenants: { 'de mo': tenant } }, /knowledge\.tenants\.de mo/],
    ['pipeline', { repos: { "we'b": { github: 'acme/web', prodBranch: 'main', deploy: { stage: false } } } }, /pipeline\.repos\.we'b/],
    ['knowledge', { healthUrls: { pages: ['ftp://x'], apis: [] } }, /knowledge\.healthUrls/],
    ['knowledge', { healthUrls: { pages: [] } }, /knowledge\.healthUrls/],
    ['pipeline', { migrations: undefined }, /pipeline\.migrations/],
    ['pipeline', { migrations: { planRules: [] } }, /pipeline\.migrations/],
  ];
  for (const [section, patch, re] of cases) await assert.rejects(loadConfig(await withPatch(section, patch)), re, `${section} ${JSON.stringify(patch)}`);
  const ok = await loadConfig(await withPatch('knowledge', { tenants: { demo: tenant } }));
  assert.deepEqual(ok.knowledge.tenants.demo, tenant);
});

test('loadConfig: a module without knowledge is rejected', async () => {
  const file = join(dir, 'no-knowledge.config.js');
  writeFileSync(file, `import base from ${JSON.stringify(EXAMPLE)};\nexport default { profile: base.profile, workspace: base.workspace, pipeline: base.pipeline };\n`);
  await assert.rejects(loadConfig(file), /knowledge is required/);
});

test('loadConfig: the example has no domain action (actions.none())', async () => {
  const { actions } = await loadConfig(EXAMPLE);
  assert.equal(actions.idPattern, null);
  assert.match(actions.precheck({ autoApprove: true }, { folios: ['X-1'] }), /no configurada/);
});

test('loadConfig: rejects an invalid or missing ActionAdapter', async () => {
  for (const patch of [{ idPattern: 'X-' }, { idPattern: {} }, { precheck: 'x' }, { approve: undefined }, { reviewHint: 'x' }]) {
    await assert.rejects(loadConfig(await withPatch('actions', patch)), /actions/, JSON.stringify(patch));
  }
  const file = join(dir, 'no-actions.config.js');
  writeFileSync(file, `import base from ${JSON.stringify(EXAMPLE)};\nconst { actions, ...rest } = base;\nexport default rest;\n`);
  await assert.rejects(loadConfig(file), /actions must be an ActionAdapter/);
});

test('loadConfig: the example has a generic chat context, a generic playbook and no code index command', async () => {
  const { profile, pipeline, workspace } = await loadConfig(EXAMPLE);
  assert.match(profile.context.chats, /Acme Civic/);
  assert.ok(profile.context.facts && profile.context.ids);
  const plan = pipeline.playbook.plan({ root: '/r' }).join('\n');
  assert.match(plan, /PLAN step/);
  assert.doesNotMatch(plan, /Paso|edges\.yaml/);
  assert.ok(pipeline.playbook.spec({ worktrees: '/r/web-worktrees' }).join('\n').includes('/r/web-worktrees/<task>'));
  assert.ok(pipeline.playbook.specRule.text.includes(pipeline.playbook.specRule.check));
  assert.match(pipeline.playbook.implement({ root: '/r', id: 7, plan: '/p/plan.json' }).join('\n'), /IMPLEMENT step for request #7[\s\S]*\/p\/plan\.json/);
  assert.equal(workspace.codeIndex, undefined);
});

test('loadConfig: rejects invalid profile.context, pipeline.playbook and workspace.codeIndex with the field name', async () => {
  // Playbook entries are functions inside an object: written as source over the example's playbook.
  const withPlaybook = (fields) => {
    const file = join(dir, `c${++n}.config.js`);
    writeFileSync(file, `import base from ${JSON.stringify(EXAMPLE)};\nexport default { ...base, pipeline: { ...base.pipeline, playbook: { ...base.pipeline.playbook, ${fields} } } };\n`);
    return file;
  };
  const cases = [
    [await withProfile({ context: undefined }), /profile\.context/],
    [await withProfile({ context: { chats: 'x', facts: 'y' } }), /profile\.context/],
    [await withProfile({ context: { chats: 'a\nb', facts: 'y', ids: 'z' } }), /profile\.context/],
    [await withPatch('pipeline', { playbook: undefined }), /pipeline\.playbook/],
    [withPlaybook("plan: 'x'"), /pipeline\.playbook/],
    [withPlaybook("specRule: { text: 'abc', check: 'zz' }"), /pipeline\.playbook\.specRule/],
    [await withPatch('workspace', { codeIndex: { bin: '', args: [] } }), /workspace\.codeIndex/],
    [await withPatch('workspace', { codeIndex: { bin: 'x', args: ['init'] } }), /workspace\.codeIndex/],
  ];
  for (const [file, re] of cases) await assert.rejects(loadConfig(file), re, String(re));
  const ok = await loadConfig(withPlaybook('specRule: null'));
  assert.equal(ok.pipeline.playbook.specRule, null);
});

test('validateContacts: persona must be an existing file (absolute or repo-relative), model a non-empty string, anyHour and live booleans', () => {
  const persona = join(dir, 'persona.md');
  writeFileSync(persona, 'You are Robin.');
  const ok = [{ jid: 'a@s.whatsapp.net', name: 'A' }, { jid: 'g@g.us', name: 'G', type: 'group', persona, model: 'claude-haiku-5-5', effort: 'medium', anyHour: true, live: true }];
  assert.equal(validateContacts(ok), ok);
  assert.doesNotThrow(() => validateContacts([{ jid: 'b', name: 'B', persona: 'config/example.config.js' }]));
  for (const [bad, field] of [
    [{ persona: join(dir, 'missing.md') }, /contacts\.json G\.persona/],
    [{ persona: '' }, /G\.persona/],
    [{ model: '' }, /G\.model/],
    [{ model: 5 }, /G\.model/],
    [{ effort: 'mid' }, /G\.effort/],
    [{ anyHour: 'yes' }, /G\.anyHour/],
    [{ live: 1 }, /G\.live/],
  ]) assert.throws(() => validateContacts([{ jid: 'g@g.us', name: 'G', ...bad }]), field);
});
