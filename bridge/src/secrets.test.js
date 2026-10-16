import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretGuard, npmrcToken } from './secrets.js';

const npmrc = 'registry=x\n//npm.pkg.github.com/:_authToken=s3cr3tvalue42\n';

test('npmrcToken reads the GitHub Packages token, null when absent', () => {
  assert.equal(npmrcToken(() => npmrc), 's3cr3tvalue42');
  assert.equal(npmrcToken(() => 'registry=x\n'), null);
  assert.equal(npmrcToken(() => { throw new Error('ENOENT'); }), null);
});

test('guard flags common secret patterns and the literal .npmrc token', () => {
  const leaks = createSecretGuard({ readFile: () => npmrc });
  for (const s of [
    'toma ghp_abcdef', 'github_pat_11ABC', '-----BEGIN OPENSSH PRIVATE KEY-----', 'AKIA' + 'ABCDEFGHIJKLMNOP',
    'xoxb-123', 'xoxp-123', '//npm.pkg.github.com/:_authToken=x', 'el token es s3cr3tvalue42 ok',
  ]) assert.equal(leaks(s), true, s);
  for (const s of ['Listo ya quedó', 'akia minúsculas', 'Buen dia, si esta funcionando']) assert.equal(leaks(s), false, s);
});

test('guard works without ~/.npmrc', () => {
  const leaks = createSecretGuard({ readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(leaks('hola'), false);
  assert.equal(leaks('ghp_x'), true);
});

test('extra secrets (the portal token) are matched literally; empty ones are ignored', () => {
  const leaks = createSecretGuard({ readFile: () => '', secrets: ['s3cr3tToken', '', null] });
  assert.equal(leaks('x s3cr3tToken y'), true);
  assert.equal(leaks('nada aqui'), false);
});

test('secrets can be a function, re-read on every check (a GitHub token set later is caught)', () => {
  let token = null;
  const leaks = createSecretGuard({ readFile: () => '', secrets: () => ['portalTok', token] });
  assert.equal(leaks('xx ghtokenvalue99 yy'), false);
  token = 'ghtokenvalue99';
  assert.equal(leaks('xx ghtokenvalue99 yy'), true);
  assert.equal(leaks('portalTok'), true);
});
