export const JOB_RESULTS = ['deployed', 'failed', 'rolled-back', 'blocked-credentials', 'not-small'];
export const HANDOFF_TYPES = [
  'outage', 'bug', 'feature-request', 'action', 'follow-up', 'approval',
  'identity', 'unknown', 'credentials', 'incident', 'deploy-report',
];

const fail = (msg) => { throw new Error(`Malformed output: ${msg}`); };

const lines = (text) => String(text).replace(/\r\n?/g, '\n').split('\n');

// Index of the first line at/after `from` that starts with `label:`; -1 if none.
const findLabel = (ls, label, from = 0) => {
  const re = new RegExp(`^\\s*${label}:`);
  for (let i = from; i < ls.length; i++) if (re.test(ls[i])) return i;
  return -1;
};

const requireLabel = (ls, label, from) => {
  const i = findLabel(ls, label, from);
  if (i === -1) fail(`missing "${label}:" line`);
  return i;
};

const inline = (line) => line.slice(line.indexOf(':') + 1).trim();

// Section body: inline value (if any) + following lines up to `end`.
const section = (ls, start, end) => {
  const first = inline(ls[start]);
  const body = ls.slice(start + 1, end === -1 ? ls.length : end);
  return first ? [first, ...body] : body;
};

const isNone = (ls) => ls.join('\n').trim() === '(none)';

function bubbles(ls) {
  if (isNone(ls)) return [];
  const out = [[]];
  for (const l of ls) {
    if (l.trim() === '---') out.push([]);
    else out[out.length - 1].push(l.trim());
  }
  return out.map((b) => b.join('\n').trim()).filter(Boolean);
}

// `LABEL: none` -> null; `LABEL: <other>` -> Error; `LABEL:` -> body lines.
function block(ls, start, end, label) {
  const v = inline(ls[start]);
  if (v === 'none') return null;
  if (v) fail(`"${label}:" must be "none" or start a block`);
  return ls.slice(start + 1, end === -1 ? ls.length : end);
}

function parseHandoff(ls) {
  const fields = {};
  for (const l of ls) {
    const i = l.indexOf(':');
    if (i > 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  if (!HANDOFF_TYPES.includes(fields.type)) fail(`HANDOFF type must be one of ${HANDOFF_TYPES.join('|')}`);
  if (fields.blocking !== undefined && fields.blocking !== 'true' && fields.blocking !== 'false') {
    fail('HANDOFF blocking must be "true" or "false"');
  }
  return { type: fields.type, blocking: fields.blocking === 'true', fields, raw: ls.join('\n').trim() };
}

function parseImplement(ls) {
  const s = findLabel(ls, 'summary');
  const p = findLabel(ls, 'spec');
  const summary = s === -1 ? '' : inline(ls[s]);
  if (!summary) fail('IMPLEMENT summary is empty');
  const spec = p === -1 ? '' : section(ls, p, -1).join('\n').replace(/^\n+/, '').trimEnd();
  if (!spec.trim()) fail('IMPLEMENT spec is empty');
  return { summary, spec };
}

const MAX_APPROVE = 5;

// `APPROVE: <id>, <id>` lines anywhere except inside an IMPLEMENT spec (free text); idPattern: the ActionAdapter's (actions.js).
// One valid line with 1 to 5 distinct ids -> { folios }; malformed, more than 5, repeated, more than one line or no idPattern
// -> { folios: null, error } so the bridge refuses instead of sending a success reply.
function approveOf(all, idPattern) {
  const i = findLabel(all, 'IMPLEMENT');
  const specFrom = i !== -1 && inline(all[i]) !== 'none' ? i : all.length;
  const isApprove = (l, k) => k < specFrom && /^\s*APPROVE:/.test(l);
  const found = all.filter(isApprove).map(inline);
  const rest = all.filter((l, k) => !isApprove(l, k));
  if (!found.length) return { rest, approve: null };
  const bad = (error) => ({ rest, approve: { folios: null, error } });
  if (!idPattern) return bad('no APPROVE action configured');
  if (found.length > 1) return bad('more than one APPROVE line');
  const folios = found[0].split(',').map((f) => f.trim());
  if (!folios.every((f) => idPattern.test(f))) return bad('malformed APPROVE folio');
  if (folios.length > MAX_APPROVE) return bad(`more than ${MAX_APPROVE} APPROVE folios`);
  if (new Set(folios).size !== folios.length) return bad('repeated APPROVE folio');
  return { rest, approve: { folios } };
}

// idPattern: the ActionAdapter's id pattern (config actions.idPattern); absent: every APPROVE line is malformed.
export function parseAgentOutput(text, { idPattern = null } = {}) {
  const { rest: ls, approve } = approveOf(lines(text), idPattern);
  const r = requireLabel(ls, 'REPLY', 0);
  if (ls.slice(0, r).join('').trim()) fail('unexpected text before "REPLY:"');
  const h = requireLabel(ls, 'HANDOFF', r + 1);
  const i = requireLabel(ls, 'IMPLEMENT', h + 1);
  const handoff = block(ls, h, i, 'HANDOFF');
  const implement = block(ls, i, -1, 'IMPLEMENT');
  return {
    bubbles: bubbles(section(ls, r, h)),
    handoff: handoff && parseHandoff(handoff),
    implement: implement && parseImplement(implement),
    approve,
  };
}

export function parseJobOutput(text) {
  const ls = lines(text);
  const r = findLabel(ls, 'RESULT');
  const result = r === -1 ? undefined : inline(ls[r]);
  if (!JOB_RESULTS.includes(result)) {
    fail(`RESULT must be one of ${JOB_RESULTS.join('|')}, got ${JSON.stringify(result)}`);
  }
  const p = requireLabel(ls, 'REPORT', r + 1);
  const u = requireLabel(ls, 'USER_MESSAGE', p + 1);
  const msg = section(ls, u, -1);
  if (result !== 'deployed' && !isNone(msg)) fail('USER_MESSAGE must be "(none)" unless RESULT is deployed');
  const out = bubbles(msg);
  if (result === 'deployed' && !out.length) fail('USER_MESSAGE needs at least one bubble when RESULT is deployed');
  return { result, report: section(ls, p, u).join('\n').trim(), bubbles: out };
}
