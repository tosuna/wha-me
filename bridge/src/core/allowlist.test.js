import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupContact, respondToOf } from './allowlist.js';

const contacts = [
  { jid: '5210000000111@s.whatsapp.net', name: 'Dalia', register: 'usted', tenant: 'demo', canTriggerImplementation: true },
  { jid: '5210000000822@s.whatsapp.net', name: 'Nico', register: 'tu', tenant: 'demo2', canTriggerImplementation: false },
];

test('exact match', () => {
  assert.equal(lookupContact(contacts, '5210000000822@s.whatsapp.net').name, 'Nico');
});

test('device suffix is ignored', () => {
  assert.equal(lookupContact(contacts, '5210000000111:12@s.whatsapp.net').name, 'Dalia');
});

test('unknown -> null', () => {
  assert.equal(lookupContact(contacts, '5210000000999@s.whatsapp.net'), null);
  assert.equal(lookupContact([], '5210000000111@s.whatsapp.net'), null);
});

test('respondToOf: the member whose jids include any sender id (device suffix ignored), else null', () => {
  const group = { jid: 'g@g.us', type: 'group', respondTo: [{ name: 'Iker', jids: ['1@lid', '521@s.whatsapp.net'] }, { name: 'Ciro', jids: ['2@lid'] }] };
  assert.equal(respondToOf(group, ['9@lid', '521:4@s.whatsapp.net']).name, 'Iker');
  assert.equal(respondToOf(group, ['2@lid']).name, 'Ciro');
  assert.equal(respondToOf(group, ['3@lid']), null);
  assert.equal(respondToOf(group, []), null);
  assert.equal(respondToOf(group, undefined), null);
  assert.equal(respondToOf({ jid: 'g@g.us' }, ['1@lid']), null);
});
