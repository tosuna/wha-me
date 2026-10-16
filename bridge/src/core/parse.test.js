import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentOutput, parseJobOutput } from './parse.js';

test('bubbles split by ---, none blocks', () => {
  const out = parseAgentOutput('REPLY:\nhola\n---\nya quedó\nsegunda linea\nHANDOFF: none\nIMPLEMENT: none\n');
  assert.deepEqual(out, { bubbles: ['hola', 'ya quedó\nsegunda linea'], handoff: null, implement: null, approve: null });
});

test('REPLY: (none) -> []', () => {
  const out = parseAgentOutput('REPLY: (none)\nHANDOFF: none\nIMPLEMENT: none');
  assert.deepEqual(out.bubbles, []);
});

test('tolerates CRLF and surrounding spaces', () => {
  const out = parseAgentOutput('  \r\nREPLY:\r\n hola \r\n  ---  \r\nadios\r\nHANDOFF:  none \r\nIMPLEMENT: none  \r\n');
  assert.deepEqual(out.bubbles, ['hola', 'adios']);
  assert.equal(out.handoff, null);
  assert.equal(out.implement, null);
});

test('handoff block', () => {
  const out = parseAgentOutput([
    'REPLY: (none)',
    'HANDOFF:',
    'type: identity',
    'blocking: true',
    'contact: Dalia',
    'summary: preguntó si soy bot: dice "x"',
    'IMPLEMENT: none',
  ].join('\n'));
  assert.equal(out.handoff.type, 'identity');
  assert.equal(out.handoff.blocking, true);
  assert.deepEqual(out.handoff.fields, {
    type: 'identity', blocking: 'true', contact: 'Dalia', summary: 'preguntó si soy bot: dice "x"',
  });
  assert.equal(out.handoff.raw, 'type: identity\nblocking: true\ncontact: Dalia\nsummary: preguntó si soy bot: dice "x"');
});

test('handoff blocking false', () => {
  const out = parseAgentOutput('REPLY:\nok\nHANDOFF:\ntype: bug\nblocking: false\nIMPLEMENT: none');
  assert.equal(out.handoff.blocking, false);
});

test('implement block keeps multiline spec with code fences', () => {
  const spec = [
    '## Project',
    'acme-web @ /x (branch y)',
    '',
    '```',
    'npm test',
    '---',
    'REPLY: not a block',
    '```',
    '  indented line',
  ].join('\n');
  const out = parseAgentOutput(`REPLY:\nva\nHANDOFF: none\nIMPLEMENT:\nsummary: fix label\nspec:\n${spec}\n`);
  assert.deepEqual(out.implement, { summary: 'fix label', spec });
});

test('missing REPLY throws', () => {
  assert.throws(() => parseAgentOutput('HANDOFF: none\nIMPLEMENT: none'), /REPLY/);
  assert.throws(() => parseAgentOutput(''), /REPLY/);
});

test('IMPLEMENT without spec throws', () => {
  assert.throws(() => parseAgentOutput('REPLY: (none)\nHANDOFF: none\nIMPLEMENT:\nsummary: x'), /spec/);
});

test('parseJobOutput deployed', () => {
  const out = parseJobOutput('RESULT: deployed\r\nREPORT:\nmerged PR 12\nCI green\nUSER_MESSAGE:\nListo ya quedó\n---\nme confirmas?\n');
  assert.deepEqual(out, { result: 'deployed', report: 'merged PR 12\nCI green', bubbles: ['Listo ya quedó', 'me confirmas?'] });
});

test('parseJobOutput failed with no user message', () => {
  const out = parseJobOutput('RESULT: failed\nREPORT:\ntests broke\nUSER_MESSAGE: (none)');
  assert.deepEqual(out, { result: 'failed', report: 'tests broke', bubbles: [] });
});

test('parseJobOutput accepts all results', () => {
  for (const r of ['failed', 'rolled-back', 'blocked-credentials', 'not-small']) {
    assert.equal(parseJobOutput(`RESULT: ${r}\nREPORT:\nx\nUSER_MESSAGE: (none)`).result, r);
  }
  assert.equal(parseJobOutput('RESULT: deployed\nREPORT:\nx\nUSER_MESSAGE:\nListo').result, 'deployed');
});

test('parseJobOutput invalid result throws', () => {
  assert.throws(() => parseJobOutput('RESULT: maybe\nREPORT:\nx\nUSER_MESSAGE: (none)'), /RESULT/);
  assert.throws(() => parseJobOutput('REPORT:\nx'), /RESULT/);
});

// --- review corrections ---
const A = (s) => () => parseAgentOutput(s);

test('missing HANDOFF or IMPLEMENT, or wrong order, throws', () => {
  assert.throws(A('REPLY:\nhola\nIMPLEMENT: none'), /HANDOFF/);
  assert.throws(A('REPLY:\nhola\nHANDOFF: none'), /IMPLEMENT/);
  assert.throws(A('REPLY:\nhola\nIMPLEMENT: none\nHANDOFF: none'), /HANDOFF|IMPLEMENT/);
});

test('non-empty text before REPLY throws', () => {
  assert.throws(A('claro, aqui va:\nREPLY: (none)\nHANDOFF: none\nIMPLEMENT: none'), /before/);
});

test('handoff type required and validated', () => {
  assert.throws(A('REPLY: (none)\nHANDOFF:\nblocking: true\nIMPLEMENT: none'), /type/);
  assert.throws(A('REPLY: (none)\nHANDOFF:\ntype: party\nIMPLEMENT: none'), /type/);
});

test('handoff blocking optional but strict', () => {
  const out = parseAgentOutput('REPLY: (none)\nHANDOFF:\ntype: action\nIMPLEMENT: none');
  assert.equal(out.handoff.blocking, false);
  assert.throws(A('REPLY: (none)\nHANDOFF:\ntype: bug\nblocking: yes\nIMPLEMENT: none'), /blocking/);
  assert.throws(A('REPLY: (none)\nHANDOFF:\ntype: bug\nblocking: TRUE\nIMPLEMENT: none'), /blocking/);
});

test('inline HANDOFF value other than none throws', () => {
  assert.throws(A('REPLY: (none)\nHANDOFF: type: bug\nIMPLEMENT: none'), /HANDOFF/);
});

test('implement requires non-empty summary and spec', () => {
  assert.throws(A('REPLY: (none)\nHANDOFF: none\nIMPLEMENT:\nspec:\nx'), /summary/);
  assert.throws(A('REPLY: (none)\nHANDOFF: none\nIMPLEMENT:\nsummary:   \nspec:\nx'), /summary/);
  assert.throws(A('REPLY: (none)\nHANDOFF: none\nIMPLEMENT:\nsummary: x\nspec:\n  \n'), /spec/);
});

test('only exact (none) means no reply', () => {
  assert.deepEqual(parseAgentOutput('REPLY:\nnone\nHANDOFF: none\nIMPLEMENT: none').bubbles, ['none']);
  assert.deepEqual(parseAgentOutput('REPLY: None\nHANDOFF: none\nIMPLEMENT: none').bubbles, ['None']);
});

test('parseJobOutput requires REPORT and USER_MESSAGE', () => {
  assert.throws(() => parseJobOutput('RESULT: failed\nUSER_MESSAGE: (none)'), /REPORT/);
  assert.throws(() => parseJobOutput('RESULT: failed\nREPORT:\nx'), /USER_MESSAGE/);
});

test('parseJobOutput user message only when deployed', () => {
  assert.throws(() => parseJobOutput('RESULT: failed\nREPORT:\nx\nUSER_MESSAGE:\nya quedo'), /USER_MESSAGE/);
  assert.throws(() => parseJobOutput('RESULT: deployed\nREPORT:\nx\nUSER_MESSAGE: (none)'), /USER_MESSAGE/);
});

const withApprove = (...approve) => ['REPLY:', 'ya quedo aprobada', 'HANDOFF: none', ...approve, 'IMPLEMENT: none'].join('\n');
// The ActionAdapter's id pattern (actions.js idPattern), here an example one.
const ID = /^REQ-\d{1,8}$/;
const parseApprove = (text) => parseAgentOutput(text, { idPattern: ID });

test('APPROVE without an id pattern (actions none()) -> still taken out of the reply, never valid', () => {
  for (const opts of [undefined, { idPattern: null }]) {
    const out = parseAgentOutput(withApprove('APPROVE: REQ-0026'), opts);
    assert.deepEqual(out.bubbles, ['ya quedo aprobada']);
    assert.equal(out.approve.folios, null);
    assert.match(out.approve.error, /no APPROVE action configured/);
  }
  assert.equal(parseAgentOutput(withApprove()).approve, null);
});

test('APPROVE line -> approve.folios; absent -> approve null', () => {
  const out = parseApprove(withApprove('APPROVE: REQ-0026'));
  assert.deepEqual(out.approve, { folios: ['REQ-0026'] });
  assert.deepEqual(out.bubbles, ['ya quedo aprobada']);
  assert.equal(out.handoff, null);
  assert.equal(parseApprove(withApprove()).approve, null);
});

test('APPROVE after a HANDOFF block is not read as a handoff field', () => {
  const out = parseApprove(['REPLY: (none)', 'HANDOFF:', 'type: follow-up', 'blocking: false', 'APPROVE: REQ-26', 'IMPLEMENT: none'].join('\n'));
  assert.deepEqual(out.approve, { folios: ['REQ-26'] });
  assert.equal(out.handoff.fields.APPROVE, undefined);
});

test('APPROVE after IMPLEMENT: none is still seen (never silently dropped)', () => {
  const out = parseApprove('REPLY:\nya quedo\nHANDOFF: none\nIMPLEMENT: none\nAPPROVE: REQ-0026');
  assert.deepEqual(out.approve, { folios: ['REQ-0026'] });
});

test('APPROVE with a comma-separated list -> every folio, in order', () => {
  assert.deepEqual(parseApprove(withApprove('APPROVE: REQ-0027, REQ-0028')).approve, { folios: ['REQ-0027', 'REQ-0028'] });
  assert.deepEqual(parseApprove(withApprove('APPROVE: REQ-1,REQ-2, REQ-3 , REQ-4,REQ-5')).approve, { folios: ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5'] });
});

test('APPROVE list with more than 5 folios or a repeated folio -> refused', () => {
  const six = parseApprove(withApprove('APPROVE: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5, REQ-6')).approve;
  assert.equal(six.folios, null);
  assert.match(six.error, /more than 5/);
  const dup = parseApprove(withApprove('APPROVE: REQ-0027, REQ-0027')).approve;
  assert.equal(dup.folios, null);
  assert.match(dup.error, /repeated/);
});

test('malformed APPROVE -> no folio, with error', () => {
  for (const bad of ['REQ-', 'REQ-0026 y REQ-0027', 'req-0026', '26', 'REQ-123456789', 'REQ-0026; rm', '', 'REQ-0026,', ', REQ-0026', 'REQ-0026,,REQ-0027', 'REQ-0026, garbage']) {
    const out = parseApprove(withApprove(`APPROVE: ${bad}`));
    assert.equal(out.approve.folios, null, bad);
    assert.match(out.approve.error, /malformed/, bad);
  }
});

test('more than one APPROVE -> none of them is used', () => {
  const out = parseApprove(withApprove('APPROVE: REQ-0026', 'APPROVE: REQ-0001'));
  assert.equal(out.approve.folios, null);
  assert.match(out.approve.error, /more than one/);
});

test('an APPROVE-looking line inside the IMPLEMENT spec is spec text', () => {
  const out = parseApprove('REPLY: (none)\nHANDOFF: none\nIMPLEMENT:\nsummary: x\nspec:\nAPPROVE: REQ-0026');
  assert.equal(out.approve, null);
  assert.equal(out.implement.spec, 'APPROVE: REQ-0026');
});
