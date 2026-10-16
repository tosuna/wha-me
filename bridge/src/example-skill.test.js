import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillDir } from './agent.js';
import { HANDOFF_TYPES, JOB_RESULTS } from './core/parse.js';
import example from '../../config/example.config.js';

// The public example skill (config/example.config.js profile.skill) must teach exactly the contract core/parse.js accepts.
const dir = skillDir(example.profile);
const read = (f) => readFileSync(join(dir, f), 'utf8');
const sectionOf = (md, heading) => md.split(/^## /m).find((s) => s.startsWith(`${heading}\n`)) ?? '';

test('example skill: SKILL.md frontmatter names it as the config does', () => {
  assert.match(read('SKILL.md'), new RegExp(`^---\\nname: ${example.profile.skill.name}\\n`));
});

test('example skill: the Output Contract and output.md mention every reply keyword and handoff type parse.js accepts', () => {
  const contract = sectionOf(read('SKILL.md'), 'Output Contract');
  for (const k of ['REPLY:', 'HANDOFF: none', 'HANDOFF:', 'IMPLEMENT: none', 'IMPLEMENT:', 'APPROVE:', 'type:', 'blocking: true | false', 'summary:', 'spec:', '---', ...HANDOFF_TYPES]) {
    assert.ok(contract.includes(k), `SKILL.md § Output Contract: ${k}`);
  }
  const output = read('references/output.md');
  for (const k of ['REPLY: (none)', 'HANDOFF: none', 'IMPLEMENT: none', 'APPROVE: ', '`---`', 'same_as', ...HANDOFF_TYPES.map((t) => `\`${t}\``)]) {
    assert.ok(output.includes(k), `output.md: ${k}`);
  }
});

test('example skill: the job output section mentions every RESULT parse.js accepts and its blocks', () => {
  const job = sectionOf(read('references/flows/implementation.md'), 'Job output');
  for (const k of ['RESULT:', 'REPORT:', 'USER_MESSAGE:', 'USER_MESSAGE: (none)', ...JOB_RESULTS]) assert.ok(job.includes(k), `implementation.md § Job output: ${k}`);
});

test('example skill: every reference the code and SKILL.md point at exists', () => {
  for (const f of [...example.profile.skill.learnable, 'references/output.md', 'references/knowledge.md',
    ...['bug-report', 'approval', 'large-request', 'implementation', 'system-status'].map((n) => `references/flows/${n}.md`)]) assert.ok(read(f).trim(), f);
});
