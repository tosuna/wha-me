import { test } from 'node:test';
import assert from 'node:assert/strict';
import { none } from './actions.js';

test('actions none(): no id pattern, every APPROVE refused (static gate and approve alike), never throws', async () => {
  const a = none();
  const contact = { name: 'Contacto A', autoApprove: true, user_id: 7 };
  assert.equal(a.idPattern, null);
  assert.match(a.precheck(contact, { folios: ['X-1'] }), /aprobación automática no configurada/);
  assert.deepEqual(await a.approve({ contact, approve: { folios: ['X-1'] } }), { ok: false, reason: 'aprobación automática no configurada' });
});

test('actions none(): the refused-approval handoff asks the owner to review it, naming no system', () => {
  assert.equal(none().reviewHint({ name: 'Alex' }), 'Alex revisa la solicitud');
});
