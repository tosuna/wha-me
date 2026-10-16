// Example wha-me configuration. Copy it to private/wha-me.config.js (or point WHA_ME_CONFIG at your copy) and edit it.
import { none as noActions } from '../bridge/src/actions.js';
import { githubWorkflow } from '../bridge/src/deploy.js';
import { none } from '../bridge/src/migrations.js';

// Directory holding your repos (one checkout per repo) and the arch/projects.yaml that describes them.
const ROOT = '/home/alex/work';

export default {
  // The owner: the person whose WhatsApp the bridge answers for.
  profile: {
    // Display name used in agent prompts, errors and portal labels.
    name: 'Alex',
    // Persisted identity: stored as the message author ('OWNER') and, lowercased, as the person/actor key ('owner') in
    // history, topic memory and request events. NEVER change it after the first run: existing data would stop matching.
    tag: 'OWNER',
    // BCP 47 language the agents write in for the owner (facts, summaries, reasons).
    language: 'en-US',
    // IANA time zone of the office hours below.
    timezone: 'America/New_York',
    // Office hours: replies outside them wait for the next opening. days: 0 = Sunday ... 6 = Saturday.
    hours: { open: '09:00', close: '18:00', days: [1, 2, 3, 4, 5] },
    // macOS Keychain service holding the bridge's credentials.
    keychainService: 'wha-me',
    // The agent skill the reply and job runs follow. dir: absolute or relative to the wha-me repo root, holding SKILL.md and
    // references/ (start from skills/example-support). name: as in SKILL.md's frontmatter, named in the prompts.
    // learnable: [voice rules file, contact notes file], relative to dir: the only files /aprender may propose changes to.
    skill: { dir: 'skills/example-support', name: 'example-support', learnable: ['references/voice.md', 'references/contacts.md'] },
    // What the chats are about, for the archivist (the agent that keeps the topic memory): chats completes "<name> ...";
    // facts: the durable facts worth keeping besides who asked whom for what; ids: what makes a topic title specific.
    context: {
      chats: "answers WhatsApp chats from teammates about Acme Civic's apps",
      facts: 'numbers, ticket ids and form names',
      ids: 'numbers/ticket ids',
    },
  },
  // Where the Peticiones pipeline and the reply runs find code. Every path is absolute.
  workspace: {
    root: ROOT,
    // Project catalog: `  - id:` entries with path, package_manager and verify_commands (see plan-step.js readProjects).
    projectsYaml: `${ROOT}/arch/projects.yaml`,
    // Evidence of each request (plan, specs, reports, reviews), one dir per request id.
    requestsDir: `${ROOT}/wha-me-requests`,
    // Parent dir of a repo's pipeline worktrees (repo path as in projects.yaml).
    worktreesDir: (repo) => `${ROOT}/${repo}-worktrees`,
    // Read-only detached worktrees of the repos below at their production branch (prod-code.js), read by reply and plan runs.
    prodCodeDir: `${ROOT}/wha-me-prod-code`,
    prodMirrors: { web: 'main' },
    // The codegraph binary when it is not on the bridge's PATH.
    codegraphBin: 'codegraph',
    // Optional: the command that builds the code index of a new production mirror, if on the bridge's PATH, e.g.
    // codeIndex: { bin: 'codegraph', args: (dir) => ['init', dir] }. Without it new mirrors are not indexed (Grep still works).
  },
  // Peticiones pipeline: the repos it may plan, branch, push to and deploy.
  pipeline: {
    // Block branches are <branchPrefix><request id>-<block key>; the bridge pushes only those (and stage, see deploy).
    branchPrefix: 'pet/',
    // Repo id as in projects.yaml -> GitHub repo, production branch (PR base) and stage deploy (bridge/src/deploy.js:
    // githubWorkflow({ workflow }) or none(), or your own DeployTarget).
    repos: {
      web: { github: 'acme/web', prodBranch: 'main', deploy: githubWorkflow({ workflow: 'deploy-staging.yml' }) },
    },
    // Where the preprod step applies a request's schema migrations before stage: none(), or your own MigrationTarget
    // (bridge/src/migrations.js).
    migrations: none(),
    // How the pipeline agents work in your workspace: your own conventions go here. plan / implement: the opening lines of
    // the PLAN and IMPLEMENT step prompts; spec: how the plan agent writes each block's spec (its template must use every
    // heading in bridge/src/plan-step.js SPEC_HEADINGS); specRule: a rule every spec's "## Context hints" must quote verbatim
    // (text, shown to the plan agent) and the part of it the bridge checks (check), or null.
    playbook: {
      plan: ({ root }) => [
        'Mode: Peticiones pipeline, PLAN step. You are the orchestrator of this workspace: plan the request and split it into blocks.',
        `Read first: ${root}/CLAUDE.md and ${root}/arch/projects.yaml.`,
      ],
      spec: ({ worktrees }) => [
        '- Every spec follows this template, every heading present, in English:',
        '```',
        [
          '## Project', `<id> @ <absolute worktree path, e.g. ${worktrees}/<task>> (branch <branch>, base <base branch>)`, '',
          '## Goal', '<1-2 sentences: WHAT to achieve, not how>', '',
          '## Files', '<files to change or create, relative to the project>', '',
          '## Acceptance criteria', '- <verifiable bullet>', '- Test: <the test that fails before the change and passes after it>', '',
          '## Verify command', "<the project's test suite and projects.yaml verify_commands, run in the worktree>", '',
          '## Context hints', '<what the implementer needs from the plan: env vars, conventions>', '',
          '## Out of scope', '- <what NOT to touch>', '',
          '## Read budget', '<rough hint: files and tokens this task should need>',
        ].join('\n'),
        '```',
      ],
      specRule: {
        text: 'Bash: use absolute paths, never `cd` + a relative path in the same command (e.g. `npm --prefix /abs/path test`).',
        check: 'use absolute paths, never `cd` + a relative path',
      },
      implement: ({ root, id, plan }) => [
        `Mode: Peticiones pipeline, IMPLEMENT step for request #${id}. You are the orchestrator of this workspace: implement the plan.`,
        `Read first: ${root}/CLAUDE.md. The plan is ${plan}; the bridge already created and installed every worktree.`,
      ],
    },
  },
  // What reply runs may consult beyond the code, and what the bridge checks before each one.
  knowledge: {
    // contacts.json tenant -> its portal label (optional; else the id), extra read-only MCP servers for that contact's reply
    // runs (passed to claude --mcp-config next to codegraph), the tools they may call (permissions.allow) and prompt lines
    // that tell the agent about them. E.g. mcpServers: { docs: { type: 'stdio', command: '/opt/docs-mcp', args: [] } },
    // allowedTools: ['mcp__docs__search'], replyHints: ['...']. The first tenant is also the one the /aprender safety cases
    // run as (learn-eval.js).
    tenants: { demo: { label: 'Demo', mcpServers: {}, allowedTools: [], replyHints: [] } },
    // HTTP checks made before each reply run (status questions). apis: healthy only if the body is JSON.
    healthUrls: { pages: ['https://example.com/'], apis: [] },
  },
  // The domain action behind the reply agent's `APPROVE: <id>` directive: none(), or your own ActionAdapter
  // (bridge/src/actions.js).
  actions: noActions(),
};
