import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPatch, createLearner, MAX_SHOWN, parseProposal, skillPaths } from './learn.js';
import example from '../../config/example.config.js';

const PROFILE = example.profile; // neutral owner fixture (Alex / OWNER)
const { files: SKILL_FILES } = skillPaths(PROFILE.skill);

const INPUT = { contact: { name: 'Contacto B', register: 'usted', tenant: 'demo', chatType: 'direct' }, transcript: [{ author: 'CONTACTO', text: 'oiga y el botón de exportar?', at: 1 }] };
const PAIRS = [
  { id: 3, contactName: 'Contacto B', chatType: 'direct', verdict: 'edited', draftBubbles: ['Buen día Gael', 'el botón te sale'], sentTexts: ['Buen día Gael, el botón creo que te sale'], draftHandoff: null, createdAt: 1, input: INPUT },
  { id: 2, contactName: 'Contacto B', chatType: 'direct', verdict: 'ignored', draftBubbles: ['disculpa que no te contestaron'], sentTexts: [], draftHandoff: 'follow-up', createdAt: 0, input: null },
  { id: 1, contactName: 'Contacto B', chatType: 'direct', verdict: 'verbatim', draftBubbles: ['va lo checo'], sentTexts: ['va lo checo'], draftHandoff: null, createdAt: 0, input: null },
];

const patch = (path, body = '-viejo\n+nuevo\n') => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n${body}`;
const VOICE = 'skills/example-support/references/voice.md';
const GOOD = patch(VOICE, ' contexto\n--- separador\n-viejo\n+nuevo\n+-- otra regla\n');
const SUMMARY = 'Reglas: Alex agrega "creo que" cuando no está seguro.\nAntes: "te sale" / Después: "creo que te sale".\nGael: le contesta él mismo las dudas de permisos.';

const EVIDENCE = 'EVIDENCE:\nrule-1: 3, 2, 1\n';
function setup({ pairs = PAIRS, output = `SUMMARY:\n${SUMMARY}\n${EVIDENCE}DIFF:\n\`\`\`diff\n${GOOD}\`\`\`\n`, git = {}, gate = { ok: true, text: 'evaluación: propuesta 0.70 >= actual 0.60' }, profile = PROFILE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-learn-'));
  const repoDir = join(dir, 'repo');
  for (const f of skillPaths(profile.skill).context) {
    mkdirSync(join(repoDir, f, '..'), { recursive: true });
    writeFileSync(join(repoDir, f), `contenido de ${f}\n`);
  }
  const proposalsDir = join(dir, 'state', 'proposals');
  const reviewed = [];
  const feedback = { list: ({ unreviewed }) => (unreviewed ? pairs.filter((p) => !reviewed.includes(p.id)) : pairs), markReviewed: (ids) => reviewed.push(...ids) };
  const prompts = [];
  const agent = { runLearn: async ({ prompt }) => { prompts.push(prompt); return output; } };
  const gitCalls = [];
  const replies = { 'rev-parse --abbrev-ref HEAD': 'main\n', 'status --porcelain': '', 'rev-parse --short HEAD': 'abc1234\n', ...git };
  const evalRuns = [];
  let duringEval = () => {};
  const evaluator = { run: async (x) => { duringEval(); evalRuns.push({ ...x, proposedVoice: readFileSync(join(x.proposedDir, profile.skill.learnable[0]), 'utf8') }); await x.say('evaluando 1 casos…'); return gate; } };
  const tmpCalls = [];
  const execFile = async (cmd, args) => {
    assert.equal(cmd, 'git');
    // repoDir applies the patch; the skill dir commits and pushes (it may be its own repo); anything else is the eval's temp skill copy.
    if (args[1] !== repoDir && args[1] !== join(repoDir, skillPaths(profile.skill).dir)) return tmpCalls.push(args) && { stdout: '', stderr: '' };
    assert.equal(args[0], '-C');
    gitCalls.push(args.slice(2));
    const key = Object.keys(replies).find((k) => args.slice(2).join(' ').startsWith(k));
    const r = key === undefined ? '' : replies[key];
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: '' };
  };
  const said = [];
  const learner = createLearner({ profile, feedback, agent, execFile, repoDir, proposalsDir, evaluator, leaks: (s) => s.includes('ghp_'), now: () => Date.parse('2026-10-15T18:00:00Z') });
  const handle = (arg) => learner.handle(arg, async (t) => { said.push(t); });
  return { handle, prompts, gitCalls, reviewed, proposalsDir, said, evalRuns, tmpCalls, onEval: (fn) => { duringEval = fn; } };
}

test('checkPatch accepts voice.md and contacts.md and counts +/- per file (content lines starting with -- are not headers)', () => {
  assert.deepEqual(checkPatch(GOOD, SKILL_FILES), { files: [{ path: VOICE, added: 2, removed: 2 }], error: null });
  const two = GOOD + patch('skills/example-support/references/contacts.md', '+x\n');
  assert.deepEqual(checkPatch(two, SKILL_FILES).files.map((f) => f.path), [VOICE, 'skills/example-support/references/contacts.md']);
  assert.deepEqual(SKILL_FILES, [VOICE, 'skills/example-support/references/contacts.md']);
});

test('/aprender uses the configured skill: its name, SKILL.md and learnable files (profile.skill), nothing hardcoded', async () => {
  const skill = { dir: 'owner/my-skill', name: 'my-skill', learnable: ['notes/style.md', 'notes/people.md'] };
  assert.deepEqual(skillPaths(skill), { dir: 'owner/my-skill', files: ['owner/my-skill/notes/style.md', 'owner/my-skill/notes/people.md'], context: ['owner/my-skill/SKILL.md', 'owner/my-skill/notes/style.md', 'owner/my-skill/notes/people.md'] });
  const style = 'owner/my-skill/notes/style.md';
  const s = setup({ profile: { ...PROFILE, skill }, output: `SUMMARY:\nx\n${EVIDENCE}DIFF:\n${patch(style)}` });
  const reply = await s.handle('');
  const [prompt] = s.prompts;
  assert.ok(prompt.startsWith('Mode: learning run for the my-skill skill'), prompt.slice(0, 80));
  for (const f of skillPaths(skill).context) assert.ok(prompt.includes(`contenido de ${f}`), f);
  assert.ok(prompt.includes(`editing ONLY ${style}, owner/my-skill/notes/people.md.`));
  assert.ok(!prompt.includes('voice.md') && !prompt.includes('example-support'));
  assert.ok(reply.includes(`${style} +1 -1`), reply);
  assert.ok(checkPatch(patch(VOICE), skillPaths(skill).files).error, 'the default skill files are not editable');
  await s.handle('si');
  assert.ok(s.evalRuns[0].proposedDir.endsWith('owner/my-skill'));
  assert.ok(s.gitCalls.some((c) => c[0] === 'commit' && c.at(-1) === 'notes/style.md'));
});

for (const [name, diff] of [
  ['another path', patch('bridge/contacts.json')],
  ['another skill file', patch('skills/example-support/references/database.md')],
  // SKILL.md holds the agent's security rules: learned voice data never edits it (it is context only).
  ['SKILL.md', patch('skills/example-support/SKILL.md')],
  ['a path escaping through ..', patch('skills/example-support/../../bridge/src/agent.js')],
  ['a new file', `diff --git a/${VOICE} b/${VOICE}\nnew file mode 100644\n--- /dev/null\n+++ b/${VOICE}\n@@ -0,0 +1 @@\n+x\n`],
  ['a mode change', `diff --git a/${VOICE} b/${VOICE}\nold mode 100644\nnew mode 100755\n`],
  ['a rename', `diff --git a/${VOICE} b/x.md\nrename from ${VOICE}\nrename to x.md\n`],
  ['nothing', ''],
]) {
  test(`checkPatch refuses ${name}`, () => assert.ok(checkPatch(diff, SKILL_FILES).error, name));
}

test('parseProposal splits SUMMARY and DIFF and strips code fences', () => {
  assert.deepEqual(parseProposal(`SUMMARY:\nhola\nDIFF:\n\`\`\`diff\n${GOOD}\`\`\``), { summary: 'hola', evidence: [], diff: GOOD });
  assert.deepEqual(parseProposal('SUMMARY:\nnada que cambiar\nDIFF:\n'), { summary: 'nada que cambiar', evidence: [], diff: '' });
  assert.throws(() => parseProposal('lo que sea'));
});

test('/aprender builds the prompt from unreviewed pairs + current skill files, stores the proposal, reports summary + diffstat', async () => {
  const s = setup();
  const reply = await s.handle('');
  const [prompt] = s.prompts;
  for (const x of ['<pairs>', '"verdict":"edited"', 'creo que te sale', '"contact":"Contacto B"', 'contenido de skills/example-support/references/voice.md',
    'contenido de skills/example-support/references/contacts.md', 'contenido de skills/example-support/SKILL.md', 'untrusted', 'SUMMARY:', 'DIFF:',
    'autoApprove', '"id":3', 'oiga y el botón de exportar?', '"register":"usted"', 'EVIDENCE:', 'at least 3 pairs']) assert.ok(prompt.includes(x), x);
  assert.match(s.said[0], /3 pares/);
  assert.ok(reply.includes(SUMMARY));
  assert.ok(reply.includes(`${VOICE} +2 -2`));
  // Alex approves the actual lines, not only the model's own summary of them.
  for (const line of ['-viejo', '+nuevo', '+-- otra regla']) assert.ok(reply.includes(line), line);
  assert.match(reply, /\/aprender si/);
  const pending = JSON.parse(readFileSync(join(s.proposalsDir, 'pending.json'), 'utf8'));
  assert.deepEqual(pending.pairIds, [3, 2, 1]);
  assert.equal(readFileSync(join(s.proposalsDir, pending.diff), 'utf8'), GOOD);
  assert.ok(readFileSync(join(s.proposalsDir, pending.summary), 'utf8').includes(SUMMARY));
  assert.deepEqual(s.gitCalls, []);
});

test('/aprender with no unreviewed pairs does not run the agent', async () => {
  const s = setup({ pairs: [] });
  assert.match(await s.handle(''), /no hay pares nuevos/);
  assert.equal(s.prompts.length, 0);
});

test('/aprender: a proposal matching a secret pattern is never stored', async () => {
  const s = setup({ output: `SUMMARY:\ntoken ghp_x\nDIFF:\n${GOOD}` });
  assert.match(await s.handle(''), /secreto/);
  assert.ok(!existsSync(join(s.proposalsDir, 'pending.json')));
});

test('/aprender si applies, commits only the skill files, pushes main and marks the pairs reviewed', async () => {
  const s = setup();
  await s.handle('');
  const reply = await s.handle('si');
  const diffFile = s.gitCalls.find((c) => c[0] === 'apply').at(-1);
  assert.ok(diffFile.endsWith('.diff'));
  assert.deepEqual(s.gitCalls, [
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['status', '--porcelain', '--', 'references/voice.md'],
    ['apply', '--check', '--recount', diffFile],
    ['apply', '--recount', diffFile],
    ['commit', '-m', 'feat(skill): learn from shadow feedback (3 pairs)', '--', 'references/voice.md'],
    ['rev-parse', '--short', 'HEAD'],
    ['push', 'origin', 'main'],
  ]);
  assert.deepEqual(s.reviewed, [3, 2, 1]);
  assert.match(reply, /abc1234/);
  assert.match(reply, /propuesta 0\.70/, 'the eval result is reported');
  assert.ok(!existsSync(join(s.proposalsDir, 'pending.json')));
  assert.match(await s.handle('si'), /no hay propuesta pendiente/);
});

test('/aprender si refuses a patch touching anything outside the three skill files: no git, nothing reviewed', async () => {
  const s = setup({ output: `SUMMARY:\nx\n${EVIDENCE}DIFF:\n${GOOD}${patch('bridge/contacts.json')}` });
  await s.handle('');
  assert.match(await s.handle('si'), /rechaz/i);
  assert.deepEqual([s.gitCalls, s.reviewed], [[], []]);
  assert.ok(existsSync(join(s.proposalsDir, 'pending.json')), 'still pending: /aprender no discards it');
});

test('/aprender si refuses off main or with uncommitted changes in the skill files', async () => {
  for (const git of [{ 'rev-parse --abbrev-ref HEAD': 'feat/x\n' }, { 'status --porcelain': ' M skills/example-support/references/voice.md\n' }]) {
    const s = setup({ git });
    await s.handle('');
    assert.match(await s.handle('si'), /no apliqué/);
    assert.ok(!s.gitCalls.some((c) => c[0] === 'apply' || c[0] === 'commit'));
    assert.deepEqual(s.reviewed, []);
  }
});

test('/aprender si: git apply --check failing stops before applying', async () => {
  const s = setup({ git: { 'apply --check': new Error('patch does not apply') } });
  await s.handle('');
  assert.match(await s.handle('si'), /patch does not apply/);
  assert.ok(!s.gitCalls.some((c) => c[0] === 'commit'));
  assert.deepEqual(s.reviewed, []);
});

test('/aprender si: a failed push still reports the local commit and marks the pairs reviewed', async () => {
  const s = setup({ git: { push: new Error('rejected') } });
  await s.handle('');
  const reply = await s.handle('si');
  assert.match(reply, /abc1234/);
  assert.match(reply, /rejected/);
  assert.deepEqual(s.reviewed, [3, 2, 1]);
});

test('/aprender no discards the proposal and marks the pairs reviewed; unknown args get the usage', async () => {
  const s = setup();
  await s.handle('');
  assert.match(await s.handle('no'), /descart/);
  assert.deepEqual(s.reviewed, [3, 2, 1]);
  assert.ok(!existsSync(join(s.proposalsDir, 'pending.json')));
  assert.ok(readdirSync(s.proposalsDir).some((f) => f.endsWith('.diff')), 'the diff stays as an archive');
  assert.match(await s.handle('quizas'), /\/aprender si/);
});

test('/aprender tells the model the review size limit, so the proposal fits instead of being dropped unseen', async () => {
  const s = setup();
  await s.handle('');
  assert.ok(s.prompts[0].includes(`at most ${MAX_SHOWN} characters`), 'the limit is in the prompt');
  assert.match(s.prompts[0], /most evidence/);
});

test('/aprender: a diff too long to review on WhatsApp is not offered (nothing pending)', async () => {
  const big = patch(VOICE, `${'+regla larga de voz\n'.repeat(Math.ceil(MAX_SHOWN / 10))}`);
  const s = setup({ output: `SUMMARY:\nx\n${EVIDENCE}DIFF:\n${big}` });
  assert.match(await s.handle(''), /demasiado grande/);
  assert.ok(!existsSync(join(s.proposalsDir, 'pending.json')));
});

test('/aprender si refuses a diff that changed after it was shown', async () => {
  const s = setup();
  await s.handle('');
  const pending = JSON.parse(readFileSync(join(s.proposalsDir, 'pending.json'), 'utf8'));
  writeFileSync(join(s.proposalsDir, pending.diff), GOOD.replace('+nuevo', '+otra cosa'));
  assert.match(await s.handle('si'), /cambió/);
  assert.deepEqual([s.gitCalls, s.reviewed], [[], []]);
});

// --- minimum evidence: each rule in the diff cites >= 3 pairs (contact notes >= 2), checked deterministically ---

test('parseProposal reads the EVIDENCE block: one line per rule/note with its cited pair ids', () => {
  const p = parseProposal(`SUMMARY:\nhola\nEVIDENCE:\nrule-1: 3, 2,1\ncontact-1: 4,4,5\nDIFF:\n${GOOD}`);
  assert.deepEqual(p.evidence, [{ key: 'rule-1', kind: 'rule', ids: [3, 2, 1] }, { key: 'contact-1', kind: 'contact', ids: [4, 5] }]);
  assert.equal(p.diff, GOOD);
});

for (const [name, evidence, re] of [
  ['a rule citing 2 pairs', 'EVIDENCE:\nrule-1: 3,2\n', /rule-1/],
  ['a rule citing unknown or repeated ids', 'EVIDENCE:\nrule-1: 3,3,99\n', /rule-1/],
  ['a diff with no EVIDENCE for voice.md', '', /voice\.md/],
]) {
  test(`/aprender rejects ${name}: nothing pending`, async () => {
    const s = setup({ output: `SUMMARY:\nx\n${evidence}DIFF:\n${GOOD}` });
    const reply = await s.handle('');
    assert.match(reply, /evidencia insuficiente/);
    assert.match(reply, re);
    assert.ok(!existsSync(join(s.proposalsDir, 'pending.json')));
  });
}

test('/aprender: contacts.md notes need >= 2 cited pairs', async () => {
  const CONTACTS = 'skills/example-support/references/contacts.md';
  const ok = setup({ output: `SUMMARY:\nx\nEVIDENCE:\ncontact-1: 3,2\nDIFF:\n${patch(CONTACTS)}` });
  assert.doesNotMatch(await ok.handle(''), /evidencia/);
  const bad = setup({ output: `SUMMARY:\nx\nEVIDENCE:\ncontact-1: 3\nDIFF:\n${patch(CONTACTS)}` });
  assert.match(await bad.handle(''), /evidencia insuficiente: contact-1/);
});

// --- eval gate: /aprender si runs the offline eval on a temp copy of the skill with the diff applied ---

test('/aprender si evaluates the proposal on a patched temp copy of the skill before applying', async () => {
  const s = setup();
  await s.handle('');
  await s.handle('si');
  const [run] = s.evalRuns;
  assert.deepEqual(run.pairs.map((p) => p.id), [3, 2, 1], 'reviewed + unreviewed pairs');
  assert.ok(run.proposedDir.endsWith('skills/example-support'));
  assert.equal(run.proposedVoice, 'contenido de skills/example-support/references/voice.md\n', 'a copy of the skill');
  assert.deepEqual(s.tmpCalls.map((a) => a.slice(2, 4)), [['apply', '--recount']]);
  assert.ok(!existsSync(run.proposedDir), 'the temp copy is removed');
  assert.match(s.said.at(-1), /evaluando/);
});

test('/aprender si: a failed gate applies nothing, keeps the proposal pending and says why', async () => {
  const s = setup({ gate: { ok: false, text: 'no apliqué: la propuesta bajó (0.40 < 0.60)' } });
  await s.handle('');
  const reply = await s.handle('si');
  assert.match(reply, /bajó/);
  assert.ok(!s.gitCalls.some((c) => (c[0] === 'apply' && c[1] !== '--check') || c[0] === 'commit'));
  assert.deepEqual(s.reviewed, []);
  assert.ok(existsSync(join(s.proposalsDir, 'pending.json')));
  assert.match(await s.handle('si forzar'), /\/aprender si/, 'no force option: usage');
});

test('/aprender si: a diff changed while the eval ran is refused (hash re-checked after the gate)', async () => {
  const s = setup();
  await s.handle('');
  const pending = JSON.parse(readFileSync(join(s.proposalsDir, 'pending.json'), 'utf8'));
  s.onEval(() => writeFileSync(join(s.proposalsDir, pending.diff), GOOD.replace('+nuevo', '+otra cosa')));
  assert.match(await s.handle('si'), /cambió/);
  assert.ok(!s.gitCalls.some((c) => (c[0] === 'apply' && c[1] !== '--check') || c[0] === 'commit'));
});

// A real outer repo with the skill in its own nested repo (private/, ignored by the outer one) pushing to a bare remote.
function realGit(output) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-learn-nested-'));
  const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
  const outer = join(dir, 'outer');
  const remote = join(dir, 'private.git');
  const skill = { dir: 'private/skills/owner', name: 'owner', learnable: ['references/voice.md', 'references/contacts.md'] };
  const inner = join(outer, 'private');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'init', '-q', '-b', 'main', outer);
  writeFileSync(join(outer, '.gitignore'), 'private/\n');
  sh(outer, ...id, 'add', '.gitignore');
  sh(outer, ...id, 'commit', '-qm', 'outer');
  sh(dir, 'init', '-q', '-b', 'main', inner);
  for (const f of skillPaths(skill).context) {
    mkdirSync(join(outer, f, '..'), { recursive: true });
    writeFileSync(join(outer, f), 'viejo\n');
  }
  sh(inner, ...id, 'add', '.');
  sh(inner, ...id, 'commit', '-qm', 'skill');
  sh(inner, 'remote', 'add', 'origin', remote);
  sh(inner, 'push', '-q', 'origin', 'main');
  const reviewed = [];
  const feedback = { list: ({ unreviewed }) => (unreviewed ? PAIRS.filter((p) => !reviewed.includes(p.id)) : PAIRS), markReviewed: (ids) => reviewed.push(...ids) };
  const agent = { runLearn: async () => output };
  const evaluator = { run: async () => ({ ok: true, text: 'evaluación ok' }) };
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
  const learner = createLearner({ profile: { ...PROFILE, skill }, feedback, agent, repoDir: outer, proposalsDir: join(dir, 'proposals'), evaluator, leaks: () => false });
  const say = async () => {};
  return { handle: (arg) => learner.handle(arg, say), sh, outer, inner, remote, reviewed };
}

test('/aprender si commits and pushes in the repo that owns the skill, even a nested one the outer repo ignores (real git)', async () => {
  const voice = 'private/skills/owner/references/voice.md';
  const g = realGit(`SUMMARY:\nx\n${EVIDENCE}DIFF:\n${patch(voice)}`);
  await g.handle('');
  const reply = await g.handle('si');
  assert.match(reply, /listo, aprendí de 3 pares/, reply);
  assert.match(reply, /subido a main/, reply);
  assert.equal(readFileSync(join(g.outer, voice), 'utf8'), 'nuevo\n');
  assert.equal(g.sh(g.inner, 'status', '--porcelain'), '', 'the change is committed, nothing left dirty');
  assert.match(g.sh(g.remote, 'log', '-1', '--format=%s'), /learn from shadow feedback \(3 pairs\)/);
  assert.deepEqual(g.reviewed, [3, 2, 1]);
});

test('/aprender si applies a two-file diff the model wrote without `diff --git` lines (real git, --recount)', async () => {
  const [voice, contacts] = ['private/skills/owner/references/voice.md', 'private/skills/owner/references/contacts.md'];
  const diff = `--- a/${voice}\n+++ b/${voice}\n@@ -1,1 +1,2 @@\n viejo\n+regla nueva\n--- a/${contacts}\n+++ b/${contacts}\n@@ -1,1 +1,2 @@\n viejo\n+nota nueva\n`;
  const g = realGit(`SUMMARY:\nx\nEVIDENCE:\nrule-1: 3, 2, 1\ncontact-1: 3, 2\nDIFF:\n${diff}`);
  assert.match(await g.handle(''), /PROPUESTA/);
  const reply = await g.handle('si');
  assert.match(reply, /listo, aprendí de 3 pares/, reply);
  assert.equal(readFileSync(join(g.outer, voice), 'utf8'), 'viejo\nregla nueva\n');
  assert.equal(readFileSync(join(g.outer, contacts), 'utf8'), 'viejo\nnota nueva\n');
  assert.equal(g.sh(g.inner, 'status', '--porcelain'), '');
});
