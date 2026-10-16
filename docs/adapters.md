# Adapters

wha-me's config (`config/example.config.js`, loaded by `bridge/src/config.js`) plugs organization-specific behavior
into a few ports. Every adapter is a plain, duck-typed object. `loadConfig` deep-freezes the whole config, so an
adapter must keep any mutable state in closures, not in its own properties.

`loadConfig` validates the shape of each adapter at startup and fails with
`invalid wha-me config: <field> must be a <Port> (see bridge/src/<file>.js)`. The validation only checks the fields
listed as "checked" below; the rest of each contract is on you.

## DeployTarget — `pipeline.repos[id].deploy`

Source: `bridge/src/deploy.js`. How a pipeline repo's stage branch reaches preprod.

| Field | Type | Checked | Contract |
|---|---|---|---|
| `stage` | `boolean` | yes | `true`: the repo has a stage branch the preprod step merges each block into and pushes. `false`: the step stops at the draft PR. |
| `run(ctx)` | `(ctx) => Promise<string>` | yes, when `stage` | Called after stage is pushed. Resolves a one-line summary for the request events (`"(<how>) ok: <where>"`); throws when the deploy did not succeed. |

`ctx`:

- `repo`: `'owner/name'`.
- `sha`: the pushed stage sha.
- `worktree`: the block's worktree.
- `signal`: an `AbortSignal`.
- `ops`: the repo operations of `bridge/src/repo-ops.js` (e.g. `ops.watchRun({ repo, sha, workflow, signal })`).
- `leaks`: the secret guard.
- `onSecret(value | null)`: adds a runtime secret to the secret guard while the deploy holds it; call it with `null`
  when done.

Built-ins:

- `none()` → `{ stage: false }`.
- `githubWorkflow({ workflow })`: a push to stage deploys through that GitHub Actions workflow; `run` waits for the
  workflow's run of the stage sha and throws unless it concludes `success`.

## MigrationTarget — `pipeline.migrations`

Source: `bridge/src/migrations.js`. Where the preprod step applies a request's schema migrations.

| Field | Type | Checked | Contract |
|---|---|---|---|
| `planRules` | `string[]` | yes | Plan prompt rules on database work and the plan's `migrations` field (which targets exist). `[]` with `planTarget: null`: the plan has no `migrations` field. |
| `planTarget` | `string \| null` | no | JSON type of one `{ author, database }` target in the plan's answer contract. |
| `allowed({ author, database })` | `=> boolean` | yes | May a plan name this target (`plan-step.js` `validatePlan`). |
| `open({ ledger })` | `=> { apply(args) } \| null` | yes | `ledger`: the requests ledger of applied files. `null`: nothing is applied; the preprod step only lists the migration files in the PR. |
| `reachable()` | `=> Promise<boolean>` | no, optional | With `downHold`: requests whose hold equals `downHold` are cleared (and the pipeline kicked) once `reachable()` resolves `true`. Checked every 10 minutes. |
| `downHold` | `string` | no, optional | See `reachable()`. |

`apply({ requestId, project, file, sql, author, database, signal })` returns
`{ skipped, kind, dumpPath, extraDatabases }`. When the target is unreachable it must throw, before touching anything,
an `Error` with `code: 'PREPROD_DOWN'`; its message becomes the request's hold.

Built-in: `none()` → `{ planRules: [], planTarget: null, allowed: () => false, open: () => null }`.

The same file exports SQL helpers a target may reuse: `splitSql(text)` and `classify(text)` (additive vs destructive,
touched tables and schemas).

## ActionAdapter — `actions`

Source: `bridge/src/actions.js`. The domain action behind the reply agent's `APPROVE: <id>[, <id>]` directive.

| Field | Type | Checked | Contract |
|---|---|---|---|
| `idPattern` | `RegExp \| null` | yes | One valid id, anchored (`core/parse.js` reads the directive with it). `null`: every `APPROVE` line is malformed. |
| `precheck(contact, approve)` | `=> string \| null` | yes | Static gate, no I/O; also the shadow-mode answer. `approve` is the parsed directive, `{ folios }` or `{ folios: null, error }`. `null` = would go on; otherwise the refusal reason, shown to the owner. |
| `approve({ contact, approve })` | `=> Promise<{ ok: true, done } \| { ok: false, reason, done? }>` | yes | Applies `precheck` itself and never throws. `done`: one self-chat note per action that happened, also before a mid-way failure (it may not be undoable). |
| `reviewHint(profile)` | `=> string` | yes, if present | Optional: the `next` step of the owner's handoff when `approve()` refused (where to review the request by hand). Absent: the generic `reviewHint` exported by `actions.js`. |

The agent's reply is only sent when `approve()` resolved `ok`; otherwise the contact gets a neutral acknowledgement and
the owner a blocking `approval` handoff. Contacts need `autoApprove` in `contacts.json` for the agent to use `APPROVE:`.

Built-in: `none()`: `idPattern: null`, every `APPROVE` refused.

## Knowledge tenants — `knowledge.tenants`

`tenant id -> { label?, mcpServers, allowedTools, replyHints }`. The tenant of a contact is its `tenant` in
`contacts.json`.

| Field | Checked | Contract |
|---|---|---|
| tenant id | yes | Letters, digits, `_` or `-`. |
| `label` | yes, if present | Portal label; else the id. No quotes, backslashes, `< >` or line breaks. |
| `mcpServers` | yes | `name -> { command, args, ... }`, extra read-only MCP servers for that tenant's reply runs, passed to `claude --mcp-config` next to codegraph. Each needs a `command` string and an `args` list. |
| `allowedTools` | yes | Tool names those runs may call (`permissions.allow`), e.g. `mcp__docs__search`. |
| `replyHints` | yes | Prompt lines that tell the agent about those tools. |

The first tenant is also the one the `/aprender` safety cases run as (`learn-eval.js`).

## Health checks — `knowledge.healthUrls`

`{ pages: string[], apis: string[] }` of `http(s)` URLs, checked before each reply run. An `apis` URL is healthy only if
its body is JSON.

## Skill — `profile.skill`

`{ dir, name, learnable }`:

- `dir`: absolute, or relative to the wha-me repo root; must contain a `SKILL.md`.
- `name`: letters, digits, `_`, `.` or `-`, as in the `SKILL.md` frontmatter.
- `learnable`: exactly two paths relative to `dir`, `[voice rules file, contact notes file]`, without `..` and not
  `SKILL.md`. They are the only files `/aprender` may change.

## Proposing a new adapter

See [CONTRIBUTING.md](../CONTRIBUTING.md#proposing-a-new-adapter).
