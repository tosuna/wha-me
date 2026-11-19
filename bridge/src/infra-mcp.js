import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSecretGuard } from './secrets.js';

// Read-only production infrastructure for investigation runs (agent.js runInvestigation): a stdio MCP server
// (newline-delimited JSON-RPC 2.0) with four fixed tools. The model only picks validated parameters; every remote
// command is built here from the WHA_ME_INFRA config (JSON: { region, instanceId, pm2User, pm2Services, nginxLog, wafAcl,
// wafRules }) and run through `aws ssm send-command` (AWS-RunShellScript). Missing or invalid config: every call fails.

const WAF_REGION = 'us-east-1'; // CloudFront WebACL metrics only live here
const MAX_WINDOW_MS = 6 * 3600 * 1000;
const SSM_TIMEOUT_MS = 60 * 1000;
const SSM_POLL_MS = 1500;
const MAX_OUT = 20_000;
const ERROR_FETCH = 5000; // pm2_errors lines fetched when filtering by `contains`
const REDACTED = '[redactado: patrón de secreto]';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EXPIRED = /expired|ExpiredToken|reauthenticate|aws login/i;

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // single-quoted for the remote shell
const NVM_PATH = 'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin:$PATH"';

// Per-minute "HH:MM total 5xx 499" for one UTC day's minutes [a, b), then the top 10 paths (no query) with 5xx.
// nginx `main` format: $4 = "[19/Nov/2026:22:31:05", $7 = path, $9 = status.
const NGINX_AWK = `NR==1 { first=$4 }
index($4,d)==1 { m=substr($4,14,5); if (m>=a && m<b) { t[m]++; if ($9 ~ /^5/) { f[m]++; split($7,p,"?"); top[p[1]]++ } if ($9=="499") c[m]++ } }
END {
  if (first=="" || (index(first,d)==1 && substr(first,14,5)>a)) print "NOTE: the window starts before the first line of the current log (" first "); older lines are in rotated logs, not read"
  print "minute total 5xx 499"
  for (m in t) printf "%s %d %d %d\\n", m, t[m], f[m]+0, c[m]+0 | "sort"
  close("sort")
  print "top paths with 5xx:"
  for (k in top) printf "%d %s\\n", top[k], k | "sort -rn | head -10"
}`;

const window = { type: 'object', properties: { since: { type: 'string', description: 'ISO 8601 UTC, e.g. 2026-01-31T22:00:00Z' }, until: { type: 'string', description: 'ISO 8601 UTC, after since, at most 6 h later' } }, required: ['since', 'until'] };
const TOOLS = [
  { name: 'prod_status', description: 'Production server status: pm2 ls, start time of each node process, uptime and free -m.', inputSchema: { type: 'object', properties: {} } },
  { name: 'nginx_summary', description: 'nginx access log for a UTC window inside today: per-minute rows "HH:MM total 5xx 499" and the top 10 paths with 5xx.', inputSchema: window },
  {
    name: 'pm2_errors',
    description: 'pm2 error log of one service: most recent lines only, no timestamps. contains filters the lines (case-sensitive).',
    inputSchema: { type: 'object', properties: { service: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 300, default: 100 }, contains: { type: 'string', maxLength: 80 } }, required: ['service'] },
  },
  { name: 'waf_blocks', description: 'WAF BlockedRequests (sum per 5 min) per rule and ALL for a UTC window of at most 6 h.', inputSchema: window },
];

export function parseInfra(raw) {
  try {
    const c = JSON.parse(raw);
    const text = (v) => typeof v === 'string' && v.trim() !== '';
    const ok = ['region', 'instanceId', 'pm2User', 'nginxLog', 'wafAcl'].every((k) => text(c?.[k]))
      && ['pm2Services', 'wafRules'].every((k) => Array.isArray(c[k]) && c[k].every(text));
    return ok ? c : null;
  } catch {
    return null;
  }
}

class Invalid extends Error {}
const bad = (msg) => { throw new Invalid(msg); };
function windowOf({ since, until } = {}) {
  const [s, u] = [since, until].map((v, i) => (ISO.test(v ?? '') && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : bad(`${i ? 'until' : 'since'} must be ISO 8601 UTC like 2026-01-31T22:00:00Z`)));
  if (u <= s) bad('until must be after since');
  if (u - s > MAX_WINDOW_MS) bad('the window is at most 6 h');
  return [new Date(s), new Date(u)];
}

// env: { WHA_ME_INFRA }; execFile: promisified, (cmd, args) -> { stdout }; leaks: secret guard (secrets.js), per line.
export function createInfraTools({ env = process.env, execFile = promisify(nodeExecFile), leaks = createSecretGuard(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const cfg = parseInfra(env.WHA_ME_INFRA);
  const aws = async (args) => (await execFile('aws', args, { maxBuffer: 10 * 1024 * 1024 })).stdout;

  async function ssm(script) {
    const dir = mkdtempSync(join(tmpdir(), 'infra-mcp-'));
    let id;
    try {
      const file = join(dir, 'params.json');
      writeFileSync(file, JSON.stringify({ commands: [script] }));
      id = (await aws(['ssm', 'send-command', '--region', cfg.region, '--instance-ids', cfg.instanceId, '--document-name', 'AWS-RunShellScript',
        '--parameters', `file://${file}`, '--query', 'Command.CommandId', '--output', 'text'])).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const end = now() + SSM_TIMEOUT_MS; ;) {
      let r;
      try {
        r = JSON.parse(await aws(['ssm', 'get-command-invocation', '--region', cfg.region, '--command-id', id, '--instance-id', cfg.instanceId, '--output', 'json']));
      } catch (e) {
        if (!/InvocationDoesNotExist/.test(e.stderr ?? e.message)) throw e; // not registered yet right after send-command
      }
      if (r && !['Pending', 'InProgress', 'Delayed'].includes(r.Status)) {
        const out = r.StandardOutputContent ?? '';
        return r.Status === 'Success' ? out : `remote command ${r.Status}\n${out}\n${r.StandardErrorContent ?? ''}`.trim();
      }
      if (now() >= end) throw new Invalid(`remote command still running after ${SSM_TIMEOUT_MS / 1000} s`);
      await sleep(SSM_POLL_MS);
    }
  }

  const run = {
    prod_status: () => ssm([
      'echo "== pm2 =="', `su - ${q(cfg.pm2User)} -c ${q(`${NVM_PATH}; pm2 ls`)}`,
      'echo "== node processes (pid, start, args) =="', 'ps -C node -o pid=,lstart=,args= | cut -c1-155', // ~35 chars pid+lstart, 120 args
      'echo "== uptime =="', 'uptime', 'echo "== memory =="', 'free -m',
    ].join('\n')),
    nginx_summary(args) {
      const [s, u] = windowOf(args);
      const today = new Date(now()).toISOString().slice(0, 10);
      if (s.toISOString().slice(0, 10) !== today || u.toISOString().slice(0, 10) !== today) bad('the window must fall within today (UTC): only the current log is read');
      const d = `[${String(s.getUTCDate()).padStart(2, '0')}/${MONTHS[s.getUTCMonth()]}/${s.getUTCFullYear()}:`;
      const hhmm = (x) => x.toISOString().slice(11, 16);
      return ssm(`awk -v ${q(`d=${d}`)} -v ${q(`a=${hhmm(s)}`)} -v ${q(`b=${hhmm(u)}`)} ${q(NGINX_AWK)} ${q(cfg.nginxLog)}`);
    },
    async pm2_errors({ service, lines = 100, contains } = {}) {
      if (!cfg.pm2Services.includes(service)) bad(`service must be one of ${cfg.pm2Services.join(', ')}`);
      if (!Number.isInteger(lines) || lines < 1 || lines > 300) bad('lines must be an integer from 1 to 300');
      if (contains !== undefined && (typeof contains !== 'string' || contains.length > 80)) bad('contains must be a string of at most 80 chars');
      const file = `${service.replace(/_/g, '-')}-error.log`;
      const out = await ssm(`H=$(getent passwd ${q(cfg.pm2User)} | cut -d: -f6); tail -n ${contains ? ERROR_FETCH : lines} "$H/.pm2/logs/"${q(file)}`);
      // Filtered here, never sent to the server.
      return contains ? out.split('\n').filter((l) => l.includes(contains)).slice(-lines).join('\n') : out;
    },
    async waf_blocks(args) {
      const [s, u] = windowOf(args);
      const parts = [];
      for (const rule of [...cfg.wafRules, 'ALL']) {
        const r = JSON.parse(await aws(['cloudwatch', 'get-metric-statistics', '--region', WAF_REGION, '--namespace', 'AWS/WAFV2', '--metric-name', 'BlockedRequests',
          '--dimensions', `Name=WebACL,Value=${cfg.wafAcl}`, `Name=Rule,Value=${rule}`, '--start-time', s.toISOString(), '--end-time', u.toISOString(),
          '--period', '300', '--statistics', 'Sum', '--output', 'json']));
        const rows = (r.Datapoints ?? []).sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp)).map((p) => `${new Date(p.Timestamp).toISOString().replace('.000', '')} ${p.Sum}`);
        parts.push(`== ${rule} ==`, ...(rows.length ? rows : ['(no blocked requests)']));
      }
      return parts.join('\n');
    },
  };

  const clean = (text) => {
    const t = String(text).split('\n').map((l) => (leaks(l) ? REDACTED : l)).join('\n');
    return t.length > MAX_OUT ? `${t.slice(0, MAX_OUT)}\n[truncated: ${t.length - MAX_OUT} more chars]` : t;
  };
  const error = (text) => ({ content: [{ type: 'text', text: clean(text) }], isError: true });

  return {
    list: () => TOOLS,
    async call(name, args = {}) {
      if (!cfg) return error('ERROR: infra config missing or invalid (WHA_ME_INFRA); nothing was run');
      if (!Object.hasOwn(run, name)) return error(`ERROR: unknown tool ${name}`);
      try {
        return { content: [{ type: 'text', text: clean(await run[name](args ?? {})) }] };
      } catch (e) {
        if (e instanceof Invalid) return error(`ERROR: ${e.message}`);
        const first = String(e.stderr || e.message).trim().split('\n')[0];
        return error(EXPIRED.test(String(e.stderr || e.message)) ? `CREDENCIAL_VENCIDA: ${first}` : `ERROR: ${first}`);
      }
    },
  };
}

// Resolves once input ends and every answer is written.
export function serve({ input = process.stdin, output = process.stdout, tools = createInfraTools() } = {}) {
  const pending = [];
  const write = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  async function handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: 'parse error' } }); }
    if (m.id === undefined) return; // notification (notifications/initialized): no answer
    if (m.method === 'initialize') {
      return write({ id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'wha-me-infra', version: '1.0.0' } } });
    }
    if (m.method === 'tools/list') return write({ id: m.id, result: { tools: tools.list() } });
    if (m.method === 'tools/call') return write({ id: m.id, result: await tools.call(m.params?.name, m.params?.arguments) });
    if (m.method === 'ping') return write({ id: m.id, result: {} });
    return write({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
  const rl = createInterface({ input });
  rl.on('line', (l) => { if (l.trim()) pending.push(handle(l)); });
  return new Promise((r) => rl.on('close', r)).then(() => Promise.all(pending));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve();
