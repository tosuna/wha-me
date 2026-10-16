# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub Private Vulnerability
Reporting: open the repository's **Security** tab and click **Report a vulnerability**.

Include what you found, how to reproduce it and what an attacker could do with it. We will acknowledge the report,
keep you updated and credit you in the fix unless you prefer otherwise.

This private channel can also be used to reach the maintainers about Code of Conduct matters.

## Scope

wha-me acts as its owner on WhatsApp and can run agents with access to code and credentials, so we are especially
interested in:

- **The WhatsApp session** in `bridge/auth/`: anything that leaks it or lets someone else use it. Whoever holds these
  files can act as the owner's WhatsApp account.
- **Local state** in `bridge/state/`: conversation history, topic memory, run logs, requests, saved documents, settings
  and the portal token. Anything that exposes it, including through the local portal or its tunnel.
- **Prompt injection from contacts**: a contact's message that makes the agent ignore its skill, reveal files, prompts,
  secrets or other people's data, act outside the allowlist, approve something, or start or push code changes.
- **The secret guard** (`bridge/src/secrets.js`): ways to get a secret out through an outbound message, the portal or
  a request's evidence without it being caught.
- **The requests pipeline**: escaping the sandboxed verify commands, pushing outside `pipeline.branchPrefix` branches
  and stage, or deploying without the owner.

Out of scope: WhatsApp account bans and Terms of Service issues (see the README disclaimer), vulnerabilities in
WhatsApp, Baileys or the Claude Code CLI themselves (report those upstream), and setups where the attacker already
controls the owner's machine.
