import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quietSignalDumps } from './quiet-signal.js';

test('any session-shaped argument is redacted on every console method; other logs untouched', () => {
  const out = [];
  const con = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((m) => [m, (...a) => out.push([m, ...a])]));
  quietSignalDumps(con);
  const entry = { _chains: {}, currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('secret') } }, indexInfo: {} };
  con.info('Closing session:', entry);
  con.info('Opening session:', entry);
  con.warn('Session already closed', entry);
  con.log('Removing old closed session:', entry);
  con.error('x', { indexInfo: {} });
  con.info('bridge up', { a: 1 });
  assert.deepEqual(out, [
    ['info', 'Closing session:', '[signal session redacted]'],
    ['info', 'Opening session:', '[signal session redacted]'],
    ['warn', 'Session already closed', '[signal session redacted]'],
    ['log', 'Removing old closed session:', '[signal session redacted]'],
    ['error', 'x', '[signal session redacted]'],
    ['info', 'bridge up', { a: 1 }],
  ]);
});
