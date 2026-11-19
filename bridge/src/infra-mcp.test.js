import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createInfraTools, serve } from './infra-mcp.js';

// Placeholder infra, like a config would declare it.
const INFRA = {
  region: 'xx-test-1', instanceId: 'i-0000example', pm2User: 'deploy', pm2Services: ['api_main', 'web'],
  nginxLog: '/srv/nginx/access.log', wafAcl: 'example-acl', wafRules: ['RateLimit'],
};
const NOW = Date.parse('2026-11-19T23:00:00Z');

// Fake aws CLI: send-command keeps the remote script; get-command-invocation answers `stdout` (or throws `fail`).
function fakeAws({ stdout = 'ok', fail, pending = 0, metrics = [] } = {}) {
  const calls = [];
  const scripts = [];
  const execFile = async (cmd, args) => {
    calls.push({ cmd, args });
    if (fail) { const e = new Error('Command failed'); e.stderr = fail; throw e; }
    if (args[1] === 'send-command') {
      const file = args[args.indexOf('--parameters') + 1].slice('file://'.length);
      scripts.push(JSON.parse(readFileSync(file, 'utf8')).commands.join('\n'));
      return { stdout: 'cmd-1\n' };
    }
    if (args[1] === 'get-command-invocation') {
      return { stdout: JSON.stringify({ Status: pending-- > 0 ? 'InProgress' : 'Success', StandardOutputContent: stdout, StandardErrorContent: '' }) };
    }
    if (args[0] === 'cloudwatch') return { stdout: JSON.stringify({ Datapoints: metrics }) };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { execFile, calls, scripts };
}

const tools = (aws, env = { WHA_ME_INFRA: JSON.stringify(INFRA) }, leaks = () => false) =>
  createInfraTools({ env, execFile: aws.execFile, leaks, sleep: async () => {}, now: () => NOW });
const text = (r) => r.content.map((c) => c.text).join('');

test('tools/list: the four read-only tools with input schemas', () => {
  const list = tools(fakeAws()).list();
  assert.deepEqual(list.map((t) => t.name), ['prod_status', 'nginx_summary', 'pm2_errors', 'waf_blocks']);
  for (const t of list) assert.equal(t.inputSchema.type, 'object');
  assert.match(list.find((t) => t.name === 'pm2_errors').description, /most recent lines only, no timestamps/);
});

for (const [why, env] of [['missing', {}], ['not JSON', { WHA_ME_INFRA: '{' }], ['incomplete', { WHA_ME_INFRA: JSON.stringify({ ...INFRA, pm2Services: 'web' }) }]]) {
  test(`fail closed: config ${why} -> every call is an error, nothing runs`, async () => {
    const aws = fakeAws();
    const r = await tools(aws, env).call('prod_status', {});
    assert.equal(r.isError, true);
    assert.match(text(r), /WHA_ME_INFRA/);
    assert.equal(aws.calls.length, 0);
  });
}

for (const [name, args, re] of [
  ['nginx_summary', { since: 'ayer', until: '2026-11-19T22:00:00Z' }, /since/],
  ['nginx_summary', { since: '2026-11-19T22:00:00Z', until: '2026-11-19T21:00:00Z' }, /after/],
  ['nginx_summary', { since: '2026-11-19T10:00:00Z', until: '2026-11-19T17:00:00Z' }, /6 h/],
  ['nginx_summary', { since: '2026-11-18T22:00:00Z', until: '2026-11-18T23:00:00Z' }, /today/],
  ['nginx_summary', { since: '2026-11-19T22:00:00Z; rm -rf /', until: '2026-11-19T23:00:00Z' }, /since/],
  ['pm2_errors', { service: 'other' }, /service/],
  ['pm2_errors', { service: 'web', lines: 0 }, /lines/],
  ['pm2_errors', { service: 'web', lines: 301 }, /lines/],
  ['pm2_errors', { service: 'web', contains: 'x'.repeat(81) }, /contains/],
  ['waf_blocks', { since: '2026-11-19T22:00:00Z', until: '2026-11-20T05:00:00Z' }, /6 h/],
  ['nope', {}, /unknown tool/],
]) {
  test(`rejects ${name} ${JSON.stringify(args).slice(0, 60)}`, async () => {
    const aws = fakeAws();
    const r = await tools(aws).call(name, args);
    assert.equal(r.isError, true);
    assert.match(text(r), re);
    assert.equal(aws.calls.length, 0);
  });
}

test('prod_status: SSM RunShellScript on the configured instance, pm2 ls as the pm2 user with the nvm node bin', async () => {
  const aws = fakeAws({ stdout: 'pm2 table', pending: 2 });
  const r = await tools(aws).call('prod_status', {});
  assert.equal(r.isError, undefined);
  assert.equal(text(r), 'pm2 table');
  const send = aws.calls[0];
  assert.equal(send.cmd, 'aws');
  for (const [flag, v] of [['--region', 'xx-test-1'], ['--instance-ids', 'i-0000example'], ['--document-name', 'AWS-RunShellScript']]) {
    assert.equal(send.args[send.args.indexOf(flag) + 1], v);
  }
  assert.equal(aws.calls.filter((c) => c.args[1] === 'get-command-invocation').length, 3); // polled past InProgress
  const [s] = aws.scripts;
  assert.match(s, /su - 'deploy' -c /);
  assert.match(s, /\.nvm\/versions\/node \| tail -1/);
  assert.match(s, /pm2 ls/);
  assert.match(s, /ps .*pid=,lstart=/);
  assert.match(s, /uptime/);
  assert.match(s, /free -m/);
});

test('nginx_summary: per-minute awk over the configured log, today\'s date and minute bounds only', async () => {
  const aws = fakeAws({ stdout: '22:00 10 1 0' });
  await tools(aws).call('nginx_summary', { since: '2026-11-19T22:00:00Z', until: '2026-11-19T22:30:00Z' });
  const [s] = aws.scripts;
  assert.match(s, /^awk /);
  assert.ok(s.includes("'d=[19/Nov/2026:'"));
  assert.ok(s.includes("'a=22:00'"));
  assert.ok(s.includes("'b=22:30'"));
  assert.ok(s.endsWith("'/srv/nginx/access.log'"));
});

test('pm2_errors: tail of the service error log (_ -> -), contains filtered locally, never sent', async () => {
  const log = ['boom one', 'fine', 'boom two', 'boom three'].join('\n');
  const aws = fakeAws({ stdout: log });
  const r = await tools(aws).call('pm2_errors', { service: 'api_main', lines: 2, contains: 'boom' });
  assert.equal(text(r), 'boom two\nboom three');
  const [s] = aws.scripts;
  assert.ok(s.includes("getent passwd 'deploy'"));
  assert.ok(s.includes("'api-main-error.log'"));
  assert.match(s, /tail -n 5000/);
  assert.ok(!s.includes('boom'));
  const plain = fakeAws({ stdout: 'x' });
  await tools(plain).call('pm2_errors', { service: 'web' });
  assert.match(plain.scripts[0], /tail -n 100 /);
});

test('waf_blocks: CloudWatch BlockedRequests in us-east-1 per configured rule plus ALL', async () => {
  const aws = fakeAws({ metrics: [{ Timestamp: '2026-11-19T22:05:00Z', Sum: 7 }, { Timestamp: '2026-11-19T22:00:00Z', Sum: 3 }] });
  const r = await tools(aws).call('waf_blocks', { since: '2026-11-19T22:00:00Z', until: '2026-11-19T22:30:00Z' });
  assert.equal(aws.calls.length, 2);
  for (const [i, rule] of ['RateLimit', 'ALL'].entries()) {
    const a = aws.calls[i].args;
    assert.deepEqual(a.slice(0, 2), ['cloudwatch', 'get-metric-statistics']);
    assert.equal(a[a.indexOf('--region') + 1], 'us-east-1');
    assert.equal(a[a.indexOf('--namespace') + 1], 'AWS/WAFV2');
    assert.equal(a[a.indexOf('--metric-name') + 1], 'BlockedRequests');
    assert.equal(a[a.indexOf('--period') + 1], '300');
    assert.deepEqual(a.slice(a.indexOf('--dimensions') + 1, a.indexOf('--dimensions') + 3), ['Name=WebACL,Value=example-acl', `Name=Rule,Value=${rule}`]);
  }
  assert.match(text(r), /RateLimit[\s\S]*2026-11-19T22:00:00Z 3\n2026-11-19T22:05:00Z 7/);
});

test('config values are single-quote escaped for the remote shell', async () => {
  const aws = fakeAws();
  const env = { WHA_ME_INFRA: JSON.stringify({ ...INFRA, pm2User: "o'x" }) };
  await tools(aws, env).call('prod_status', {});
  assert.ok(aws.scripts[0].includes("su - 'o'\\''x' -c"));
});

test('output: secret lines redacted (rest kept), long output truncated with a note', async () => {
  const leaks = (l) => l.includes('ghp_');
  const r = await tools(fakeAws({ stdout: 'line a\ntoken ghp_x\nline c' }), undefined, leaks).call('prod_status', {});
  assert.equal(text(r), 'line a\n[redactado: patrón de secreto]\nline c');
  const long = await tools(fakeAws({ stdout: 'y'.repeat(25_000) })).call('prod_status', {});
  assert.ok(text(long).length < 20_200);
  assert.match(text(long), /truncated/);
});

test('expired AWS session -> CREDENCIAL_VENCIDA: + the CLI error\'s first line', async () => {
  const r = await tools(fakeAws({ fail: 'Your session has expired. Please reauthenticate using \'aws login\'.\nmore' })).call('prod_status', {});
  assert.equal(r.isError, true);
  assert.equal(text(r), "CREDENCIAL_VENCIDA: Your session has expired. Please reauthenticate using 'aws login'.");
  const other = await tools(fakeAws({ fail: 'AccessDenied\nmore' })).call('prod_status', {});
  assert.match(text(other), /^ERROR: AccessDenied$/);
});

test('stdio handshake: initialize echoes the protocol, notifications get no answer, tools/list and tools/call', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = '';
  output.on('data', (d) => { buf += d; });
  const done = serve({ input, output, tools: tools(fakeAws({ stdout: 'up' })) });
  const send = (m) => input.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 't' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'prod_status', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'bogus' });
  input.end();
  await done;
  const msgs = buf.trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id); // calls answer when done: any order
  assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3, 4]);
  assert.equal(msgs[0].result.protocolVersion, '2099-01-01');
  assert.ok(msgs[0].result.capabilities.tools);
  assert.equal(msgs[1].result.tools.length, 4);
  assert.equal(msgs[2].result.content[0].text, 'up');
  assert.equal(msgs[3].error.code, -32601);
});
