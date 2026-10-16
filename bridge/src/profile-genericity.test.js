// Nothing about the owner is hardcoded: the profile drives the reply and archivist prompts and the hours. Each prompt is
// built for the example and for a second profile (profiles.fixture.js) and must name only its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAgent } from './agent.js';
import { createArchivist } from './archivist.js';
import { isWithinHours, nextOpening } from './core/hours.js';
import { example, other, foreignValues } from './profiles.fixture.js';

const { profile, knowledge, pipeline } = example;

async function replyPrompt({ profile, workspace, knowledge }) {
  let prompt;
  const spawn = (cmd, args) => {
    prompt = args[args.indexOf('-p') + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: 'ok', is_error: false })}\n`)); child.emit('close', 0); });
    return child;
  };
  await createAgent({ spawn, readFile: () => '', profile, workspace, knowledge }).runReply({
    contact: { jid: 'p@s', name: 'P', register: 'tu' }, transcript: [{ author: profile.tag, text: 'hi', at: 1 }], health: [], topics: [], note: 'ask',
  });
  return prompt;
}

test('reply prompt speaks of its own owner only', async () => {
  const prompt = await replyPrompt(example);
  assert.match(prompt, /what Alex knows/);
  assert.match(prompt, /request from Alex themselves/);
  assert.match(prompt, /"from":"owner"/);
  assert.deepEqual(foreignValues(prompt, example), []);
  const bea = await replyPrompt(other);
  assert.match(bea, /what Bea knows/);
  assert.match(bea, /"from":"bea"/);
  assert.deepEqual(foreignValues(bea, other), []);
});

async function archivistPrompt({ profile }) {
  let prompt;
  const archivist = createArchivist({
    profile, topics: { visibleTopics: () => [], apply: () => ({ applied: 0, rejected: [] }) }, leaks: () => false, now: () => 0,
    run: async (p) => { prompt = p; return { text: '{"ops":[]}', costUsd: 0 }; },
  });
  const key = profile.tag.toLowerCase();
  await archivist.archive({ chat: { jid: 'c@s', name: 'C', kind: 'private' }, entries: [{ author: profile.tag, name: key, person: key, text: 'x', at: 0 }], knownPeople: [] });
  return prompt;
}

test('archivist prompt speaks of its own owner and language only', async () => {
  const prompt = await archivistPrompt(example);
  assert.match(prompt, /You are Alex's archivist/);
  assert.match(prompt, /Facts in English/);
  assert.ok(prompt.includes(`Alex ${example.profile.context.chats}; `) && prompt.includes(example.profile.context.facts) && prompt.includes(`(include ${example.profile.context.ids})`));
  assert.doesNotMatch(prompt, /government|folios|convocatorias/);
  assert.doesNotMatch(prompt, /spanish/i);
  assert.deepEqual(foreignValues(prompt, example), []);
  const bea = await archivistPrompt(other);
  assert.match(bea, /You are Bea's archivist/);
  assert.match(bea, /Facts in Spanish/);
  assert.deepEqual(foreignValues(bea, other), []);
});

test('office hours follow the example time zone and hours', () => {
  // Monday 2026-10-05, New York is UTC-4: 13:30Z = 09:30 open (07:30 at UTC-6), 22:30Z = 18:30 closed.
  assert.equal(isWithinHours(new Date('2026-10-05T13:30:00Z'), profile), true);
  assert.equal(isWithinHours(new Date('2026-10-05T22:30:00Z'), profile), false);
  assert.equal(nextOpening(new Date('2026-10-10T16:00:00Z'), profile).toISOString(), '2026-10-12T13:00:00.000Z');
});

test('portal page is served with the example owner tokens', async () => {
  const { portalPage } = await import('./portal.js');
  const page = portalPage(profile, { tenants: knowledge.tenants, repos: pipeline.repos }).toString('utf8');
  assert.match(page, /last\.author === 'OWNER'/);
  assert.match(page, /const ACTORS = \{ owner: 'Tú'/);
  assert.match(page, /const TENANTS = \{ demo: 'Demo' \};/);
  assert.match(page, /Se valida que pueda escribir en web\. /);
  assert.doesNotMatch(page, /__(OWNER|TENANTS|REPOS)/);
  assert.deepEqual(foreignValues(page, example), []);
  const bea = portalPage(other.profile, { tenants: other.knowledge.tenants, repos: other.pipeline.repos }).toString('utf8');
  assert.match(bea, /last\.author === 'BEA'/);
  assert.match(bea, /const TENANTS = \{ zeta: 'Zeta' \};/);
  assert.match(bea, /Se valida que pueda escribir en shop\. /);
  assert.deepEqual(foreignValues(bea, other), []);
});
