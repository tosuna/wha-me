# wha-me

A self-hosted WhatsApp agent that answers for you.

wha-me reads your own WhatsApp account, answers the contacts you allow-list in your voice using the
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude -p`), and hands off to you whatever it
cannot answer. It keeps a cross-chat topic memory, runs a local web portal, and can optionally turn change requests
from contacts into code: plan, implement, review and deploy to staging in the repos you configure, each in its own git
worktree, with a draft PR for you to merge.

It starts in **shadow mode**: it drafts replies into your self-chat ("Message yourself") and sends nothing until you
turn shadow mode off.

> [!WARNING]
> **Unofficial client. Use at your own risk.** wha-me connects to WhatsApp through
> [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial, reverse-engineered client of the WhatsApp Web
> protocol. Automating a personal account this way **may violate WhatsApp's Terms of Service and can get your number
> banned**. The agent writes messages in your name; review what it does before letting it send.
>
> This project is **not affiliated with, endorsed by or sponsored by WhatsApp, Meta or Anthropic**. All trademarks
> belong to their owners.

## Safety model

- **Allowlist.** Only chats listed in `bridge/contacts.json` get replies. In a group, only the members listed in its
  `respondTo` are answered. Everything else is ignored (or, if you opt a chat into memory from the portal, only
  remembered).
- **Shadow mode** (on by default). Replies are posted to your self-chat as `[sombra]` drafts instead of being sent.
  Toggle with `/sombra on` / `/sombra off`.
- **Office hours.** With shadow mode off, a reply that falls outside `profile.hours` waits for the next opening.
- **You take over.** If you write in a chat yourself, the pending reply for it is dropped. `/pausa` stops all replies;
  `/sigue` resumes them.
- **Secret guard.** Every outbound message is checked against secret patterns (GitHub tokens, private keys, AWS keys,
  Slack tokens, npm registry tokens) and the bridge's own runtime secrets; a match is blocked and you get an alert
  instead.
- **Handoff.** When the agent cannot or should not answer (approvals, credentials, unknown topics, attempts to
  manipulate it) it escalates to you in the self-chat, with a desktop notification, and sends at most a neutral
  acknowledgement.
- **Lock.** If an implementation job ends in an unknown state or rolls back, the bridge locks itself until you send
  `/desbloquear`.
- Contact messages are treated as untrusted data in every prompt; the example skill spells out how
  (`skills/example-support/SKILL.md`, Hard Rules).

## Requirements

- **Node.js 24** (what CI runs; the bridge uses the built-in `node:sqlite` module).
- **Claude Code CLI** installed as `claude` on the `PATH` and logged in. Every reply, memory and pipeline run is a
  `claude -p` call billed to that account.
- **macOS, for now.** Several pieces call macOS tools directly:
  - `sandbox-exec` runs the pipeline's verify commands without network (`bridge/src/gate.js`);
  - the Keychain (`security`) stores the GitHub token you paste in the portal (`bridge/src/settings.js`);
  - `osascript` shows desktop notifications (`bridge/src/notify.js`).

  Ports to Linux or other platforms are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
- Optional: `git` and the GitHub CLI `gh` for the requests pipeline, `cloudflared` for `npm run tunnel`, Python 3 for
  local audio transcription with faster-whisper (`npm --prefix bridge run setup:stt`), and the `codegraph` CLI for code
  lookups in reply runs (`workspace.codegraphBin`).

## Quick start

```sh
git clone <this repo> wha-me
npm --prefix wha-me/bridge install

# 1. Your configuration. private/ is git-ignored and picked up automatically; the example's relative
#    imports ('../bridge/src/deploy.js') keep working there. Put your own adapters and skill in private/ too.
mkdir -p wha-me/private
cp wha-me/config/example.config.js wha-me/private/wha-me.config.js
#    (Or keep it anywhere and set WHA_ME_CONFIG=/path/to/wha-me.config.js, with absolute imports.)

# 2. Who the bridge may answer.
cp wha-me/bridge/contacts.example.json wha-me/bridge/contacts.json

# 3. Run it.
npm --prefix wha-me/bridge start
```

Config resolution (`bridge/src/config.js`): `WHA_ME_CONFIG` if set, else `private/wha-me.config.js` if it exists, else
`config/example.config.js`. The config is validated at startup and the bridge refuses to start with a clear
`invalid wha-me config: <field> ...` error.

On first start the terminal and the portal (http://127.0.0.1:4747, `PORTAL_PORT` to change it) show a QR code. Scan it
from WhatsApp → Linked devices. The session is saved in `bridge/auth/`.

Then talk to the bridge from your self-chat:

| Command | What it does |
|---|---|
| `/estado` | Shows pause, lock and shadow state. |
| `/sombra on` · `/sombra off` | Shadow mode on (drafts only) / off (sends for real). |
| `/pausa` · `/sigue` | Stop / resume all replies. |
| `/desbloquear` | Clears the lock set after a failed or unknown implementation job. |
| `/grupos` | Lists your groups with their ids and member ids, to fill `contacts.json`. |
| `/portal` | Sends the portal login link (needs `npm --prefix bridge run tunnel` running). |
| `/simular <contact name>` | You write as that contact in the self-chat and see what the agent would answer and decide; nothing is sent. `/simular fin` ends it. |
| `/aprender` | Proposes edits to the skill's voice and contact notes from your corrections; `/aprender si` applies, `/aprender no` discards. |

Other scripts in `bridge/package.json`: `portal` (the portal alone), `tunnel` (a Cloudflare quick tunnel to the portal),
`seed-memory`, `setup:stt`, `login:tg` (see [Telegram](#telegram)).

### contacts.json

An array of chats (see `bridge/contacts.example.json`):

- `jid`: the WhatsApp id (`...@s.whatsapp.net` for a person, `...@g.us` for a group), or a Telegram id `tg:<id>`
  (see [Telegram](#telegram)).
- `name`: how the agent and the portal refer to the contact.
- `register`: the register to address them in (passed to the skill).
- `tenant`: a key of `knowledge.tenants` in your config.
- `canTriggerImplementation`: whether this contact's requests may start implementation jobs.
- `type: "group"` and `respondTo: [{ name, jids }]`: in a group, the only members the agent may answer.
- `autoApprove` (optional): allows the `APPROVE:` directive for this contact (see the `actions` adapter).
- `persona` (optional): a markdown file (absolute, or relative to the repo root) with the full instructions for this
  chat, e.g. to answer a casual or personal chat in its own tone, kept apart from your work skill (start from
  `skills/example-persona.md`). It replaces your skill: the reply run gets only that text and the transcript, no tools,
  no MCP, no memory, health or code. It may only reply (never hand off, implement or approve), and the chat never feeds the topic memory or
  `/aprender`. The file must exist at startup.
- `model` (optional): Claude model id passed as `--model` to this contact's reply runs (e.g. `claude-haiku-5-5`), with or
  without `persona`.
- `effort` (optional): `low`, `medium`, `high`, `xhigh` or `max`, passed as `--effort` to this contact's reply runs.

The same name merges entries only within one channel (a phone jid and a LID listed with the same name are one person).
A WhatsApp and a Telegram contact are never merged by name: two people called Carlos stay two people in the topic
memory. When they really are the same person, link their chats in the portal (Memoria → Enlazar contactos, saved to
`bridge/state/contact-links.json` and read live); chats with alike names are only suggested, never linked for you.
A link shares the memory under the WhatsApp contact's identity; unlinking splits what comes next, not what was stored.
- `anyHour` (optional): `true` answers this contact at any time, ignoring `profile.hours`.
- `live` (optional): `true` handles this contact as if shadow mode were off (replies are sent, normal delay,
  business hours apply unless `anyHour`) while every other contact stays in shadow.
  Useful to trial a single chat live while the rest stays in shadow.

### Telegram

Optional second channel, on your own Telegram account (a userbot over MTProto, not a bot). Telegram chats get the same
allowlist, gates, shadow mode and handoffs as WhatsApp; the self-chat (drafts, handoffs, commands) stays on WhatsApp, and
every line there says which channel the chat is on (`[sombra · TG] → Carlos:`, `HANDOFF · WA · Bea`). Stickers are not
sent on Telegram; voice notes are transcribed and photos described like on WhatsApp; other files stay placeholders.

1. Create an API id and hash at https://my.telegram.org (API development tools) and export `TG_API_ID` and `TG_API_HASH`
   wherever you run the bridge.
2. `npm --prefix bridge run login:tg`: asks for your phone, the code Telegram sends you and your 2FA password, and saves
   the session to `bridge/auth-tg/session`.
3. Restart the bridge. Without both variables and a saved session it runs WhatsApp only, exactly as before.

In `contacts.json`, a Telegram chat is `tg:<id>`: a person's user id (`tg:123456789`), a group's negative id
(`tg:-123456`, supergroups `tg:-100…`); `respondTo` members are `tg:<user id>`. To find them: a chat that writes to you
and is not in `contacts.json` shows up in the portal's Memoria view with its id; `/grupos` lists your Telegram groups;
an unknown member of an allowlisted group is logged with their id.

## Configuration reference

Every key of `config/example.config.js`:

| Key | Meaning |
|---|---|
| `profile.name` | Your display name, used in prompts, errors and the portal. |
| `profile.tag` | Persisted identity of your messages (`UPPERCASE`). Never change it after the first run. |
| `profile.language` | BCP 47 tag the agents write in for you (facts, summaries, reasons). |
| `profile.timezone` | IANA time zone of the office hours. |
| `profile.hours` | `{ open: 'HH:MM', close: 'HH:MM', days: [0..6] }`, 0 = Sunday. |
| `profile.keychainService` | macOS Keychain service that holds the bridge's credentials. |
| `profile.skill` | `{ dir, name, learnable }`: the agent skill and the two files `/aprender` may edit. |
| `workspace.root` | Directory holding your repo checkouts and `arch/projects.yaml`. |
| `workspace.projectsYaml` | Project catalog: `- id:` entries with `path`, `package_manager`, `verify_commands`. |
| `workspace.requestsDir` | Where each request's plan, specs, reports and reviews are written. |
| `workspace.worktreesDir` | `(repo) => dir`: parent dir of a repo's pipeline worktrees. |
| `workspace.prodCodeDir` · `prodMirrors` | Read-only worktrees of repos at their production branch, read by reply and plan runs. |
| `workspace.codegraphBin` | The codegraph binary, when it is not on the `PATH` (optional). |
| `pipeline.branchPrefix` | Prefix of pipeline branches, e.g. `pet/`. The bridge pushes only those (and stage). |
| `pipeline.repos` | `id -> { github: 'owner/name', prodBranch, deploy }`: repos the pipeline may touch. |
| `pipeline.migrations` | A MigrationTarget: where schema migrations are applied before stage. |
| `knowledge.tenants` | `tenant -> { label?, mcpServers, allowedTools, replyHints }`: extra read-only tools per contact group. |
| `knowledge.healthUrls` | `{ pages, apis }`: URLs checked before each reply run, for "is it down?" questions. |
| `actions` | An ActionAdapter: the domain action behind the agent's `APPROVE: <id>` directive. |

The requests pipeline itself is off until you enable it in the portal's settings (`PIPELINE_ENABLED` in
`bridge/state/settings.json`).

## Ports and adapters

Anything specific to your organization plugs into the config instead of the code. Adapters are plain duck-typed
objects; the config is deep-frozen at load, so keep any state in closures.

| Port | Config key | Built-ins | Contract |
|---|---|---|---|
| DeployTarget | `pipeline.repos[id].deploy` | `none()`, `githubWorkflow({ workflow })` in `bridge/src/deploy.js` | How a repo's stage branch reaches preprod. |
| MigrationTarget | `pipeline.migrations` | `none()` in `bridge/src/migrations.js` | Where a request's schema migrations are applied. |
| ActionAdapter | `actions` | `none()` in `bridge/src/actions.js` | What `APPROVE: <id>` does. |
| Knowledge tenants | `knowledge.tenants` | — | Extra MCP servers, allowed tools and prompt hints per tenant. |
| Health checks | `knowledge.healthUrls` | — | URLs checked before each reply. |
| Skill | `profile.skill` | `skills/example-support` | The instructions every reply run follows. |

Full contracts: [docs/adapters.md](docs/adapters.md).

### Example: your own DeployTarget

```js
// my-deploy.js
export const webhook = ({ url }) => ({
  stage: true, // the repo has a stage branch the pipeline merges into and pushes
  async run({ repo, sha, signal }) {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ repo, sha }), signal });
    if (!res.ok) throw new Error(`deploy failed: HTTP ${res.status}`); // throw = the deploy did not succeed
    return `(webhook) ok: ${repo}@${sha.slice(0, 7)}`; // one-line summary for the request's events
  },
});
```

```js
// in your wha-me.config.js
import { webhook } from './my-deploy.js';
// ...
repos: { web: { github: 'acme/web', prodBranch: 'main', deploy: webhook({ url: 'https://deploy.example.com/hook' }) } },
```

## The skill

The agent's behavior lives in a Claude Code skill, not in the code: `SKILL.md` is appended to every reply run's system
prompt, and `references/` holds the voice, contact notes, platform knowledge and flows it points to. The repo ships an
invented one, `skills/example-support` ("Alex", developer and support for "Acme Civic").

To make it yours:

1. Copy `skills/example-support` to a directory of your own and rename it.
2. Point `profile.skill` at it: `dir` (absolute, or relative to the repo root), `name` (as in the `SKILL.md`
   frontmatter) and `learnable` (your voice rules file and contact notes file, relative to `dir`).
3. Replace the invented setting with yours. Every file under `references/` starts with a comment saying what goes in it.
4. Keep the **Output Contract** section exactly as it is: the bridge parses it (`bridge/src/core/parse.js`).

## Data and privacy

Everything stays on your machine, except what the Claude Code CLI sends to Anthropic to run the agent, the health
checks you configure, and what the pipeline pushes to GitHub.

- `bridge/auth/`: the WhatsApp session. Anyone with these files can act as your WhatsApp account.
- `bridge/auth-tg/`: the Telegram session, same warning for your Telegram account.
- `bridge/state/`: bridge state and pending replies, run logs, requests and learning pairs (SQLite), topic memory
  (`topics.db`), memory-only and seen chats, saved documents (`media/`), settings, the portal token, proposals.
- `bridge/contacts.json`: your allowlist.

All of them are in `.gitignore`. **Never commit them.** Keep your config and your skill outside the repo (point `WHA_ME_CONFIG` and
`profile.skill.dir` at them), or under `private/`; never publish them.

## Project status

Young and evolving. The portal UI and the self-chat commands and replies are in
**Spanish**; translations are welcome. Expect breaking changes in the config shape.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
