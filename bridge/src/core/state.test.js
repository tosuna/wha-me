import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyCommand } from './state.js';

test('initialState', () => {
  assert.deepEqual(initialState(), { paused: false, locked: false, shadow: true });
});

test('pausa / sigue', () => {
  const r = applyCommand(initialState(), '/pausa');
  assert.equal(r.state.paused, true);
  assert.equal(r.reply, 'listo, en pausa');
  assert.equal(applyCommand(r.state, ' /sigue ').state.paused, false);
});

test('desbloquear', () => {
  const s = { ...initialState(), locked: true };
  assert.equal(applyCommand(s, '/desbloquear').state.locked, false);
});

test('sombra on/off', () => {
  const off = applyCommand(initialState(), '/sombra off');
  assert.equal(off.state.shadow, false);
  assert.equal(applyCommand(off.state, '/SOMBRA ON').state.shadow, true);
});

test('estado does not change state and reports it', () => {
  const s = initialState();
  const r = applyCommand(s, '/estado');
  assert.deepEqual(r.state, s);
  assert.equal(typeof r.reply, 'string');
  assert.ok(r.reply.length > 0);
});

test('non-command -> null', () => {
  assert.equal(applyCommand(initialState(), 'hola'), null);
  assert.equal(applyCommand(initialState(), '/otro'), null);
  assert.equal(applyCommand(initialState(), 'pausa'), null);
});

test('does not mutate input and replies have no inverted marks', () => {
  const s = initialState();
  const frozen = Object.freeze({ ...s });
  for (const c of ['/pausa', '/sigue', '/desbloquear', '/sombra on', '/sombra off', '/sombra', '/estado']) {
    const r = applyCommand(frozen, c);
    assert.ok(r, c);
    assert.doesNotMatch(r.reply, /[¿¡]/);
  }
  assert.deepEqual(frozen, s);
});
