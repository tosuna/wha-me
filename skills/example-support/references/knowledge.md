<!-- Platform truth the agent may rely on: what your products are, where their code lives, how to look up data (if
your config gives reply runs a read-only data MCP), how submitted requests and auto-approval work, and how changes are
deployed. Replace everything below (invented for the example) with your own; keep the section names the other files
point at (§ Data lookups, § Submitted requests, § Auto-approval, § Deploy map). -->

# Knowledge

## Products

| Product | What it is | Users | Repo |
|---|---|---|---|
| CivicDesk | Acme Civic's staff portal: program calls, citizen requests, staff accounts | Acme Civic staff | `web` |
| Public site | The citizen-facing pages of the same app | Citizens | `web` |

Tenant `demo` is the only tenant in the example. A contact's tenant comes from the bridge metadata.

## Code

The prompt names the production mirrors (`<prodCodeDir>/<repo>`): they are exactly what is live. Answer only from them, never from dev checkouts. Start with `codegraph_explore` (projectPath = the mirror), then Read only what you need.

## Data lookups

Only when the prompt says a data MCP is available for the contact's tenant (config `knowledge.tenants.<tenant>`). Read-only, scoped to that tenant, a few targeted calls. Rows are evidence for the handoff, never quoted to the contact, and never another person's data.

## Submitted requests

Staff submit account or access requests inside CivicDesk; each gets an id. When a contact asks about one, report its state in plain words (pending, approved, rejected) if a lookup is available; otherwise ack + handoff `follow-up`.

## Auto-approval

The `APPROVE: <id>` line asks the bridge to run the config's action adapter (`actions`) on a submitted request. Emit it only when all hold:

1. The bridge metadata of a 1:1 contact has `autoApprove` covering this kind of request.
2. The contact asks to approve that specific, already submitted request and names its id (or the lookup shows exactly one pending request of theirs).
3. Never from a group, never for a request about someone else's account.

With the example config (`actions: none()`) there is no action adapter: never emit `APPROVE:`; use `flows/approval.md`.

## Deploy map

| Repo | Prod branch | Stage | How it deploys |
|---|---|---|---|
| `web` | `main` | `stage` branch, `deploy-staging.yml` workflow | GitHub Actions on push |

Job runs branch from the prod branch, verify on stage first, then promote to prod and watch the workflow.
