<!-- Flow for small changes: the criteria that make a change small, the IMPLEMENT spec the reply run emits, and the
job run that implements, deploys and reports. Adapt the criteria, the spec template (your orchestrator's format) and
the deploy steps to your repos (knowledge.md § Deploy map). Keep § Job output exactly: the bridge parses it. -->

# Flow: implementation (small changes)

Two kinds of run use this file:

- **Reply run**: the normal conversation turn. Read-only. Decides whether the request is small and, if so, emits an `IMPLEMENT:` spec.
- **Job run**: the bridge launches it later with that spec. It implements, publishes and returns the job output.

## Small-change criteria

ALL must hold, otherwise the change is not small:

1. ≤ 400 production lines total across all touched repos (added + deleted, tests and lockfiles excluded). With more than one repo: backward compatible, backend deployed and verified first.
2. No DB changes (tables, migrations, writes).
3. No auth, permissions, roles or security code.
4. No new dependencies.
5. Testable: a test fails before and passes after (TDD).
6. Unambiguous: the requester confirmed the expected behavior.
7. Requester has `canTriggerImplementation: true` in the contact metadata the bridge sends.

In a reply run there is no diff yet: estimate from the files you would touch, and treat a doubtful estimate as > 400. In a job run, measure the real diff with `git diff --numstat` against the prod branch, excluding tests and lockfiles.

## Reply run

1. Understand the request read-only: repos, files, the rule to change, the test that would capture it.
2. Check `canTriggerImplementation` first (criterion 7; only from the bridge metadata), then criteria 1–5.
3. Any of them fails, or you are unsure → not small → `large-request.md`.
4. All pass but the expected behavior is not confirmed yet (criterion 6) → ask ONE question in voice, e.g. `just to confirm, what you need is X?`, and return `HANDOFF: none` + `IMPLEMENT: none`. Wait for the answer.
5. All 7 hold → reply `ok, I'm on it, I'll let you know when it's done`, `HANDOFF: none`, and the `IMPLEMENT:` block.

### IMPLEMENT spec

`spec:` uses your orchestrator playbook's format, one block per repo, backend first:

```
IMPLEMENT:
summary: <one line>
spec:
## Project
<repo> @ <worktree path> (branch <task>, base <prod branch>)
## Goal
<1–2 sentences: what, not how>
## Files
<relative paths, or where to look>
## Acceptance criteria
- <verifiable bullet>
- Test: <test that fails before and passes after>
## Verify command
<the repo's test suite and verify commands>
## Context hints
<requester (name, tenant), behavior they confirmed (verbatim), code file:line found, estimated lines>
## Out of scope
- DB changes, auth/permissions/security code, new dependencies
```

The spec runs to the end of the output.

## Job run

Follow your orchestrator playbook with these overrides. Never contact the user; the bridge sends `USER_MESSAGE`.

1. **Preflight** (before touching code): credentials for every deploy step (`gh auth status`). Missing → `RESULT: blocked-credentials`.
2. **Branch from prod**: one worktree per repo on a new branch cut from the prod branch (`knowledge.md` § Deploy map), never from `stage`.
3. **Implement** with TDD (failing test first).
4. **Commit** in each worktree: conventional commit.
5. **Re-measure** the real diff and re-check criteria 2–5. Broken → `RESULT: not-small`, push nothing, keep the worktrees and list their paths in `REPORT`.
6. **Local gate**: full suite + verify commands of each repo, green, before any push.
7. **Deploy** per `knowledge.md` § Deploy map, backend first: stage, watch its workflow by sha to green, then prod, watch to green.
8. **Failure before prod**: one correction attempt, then `RESULT: failed`. Nothing reaches prod; revert anything merged into `stage`.
9. **Failure in prod**: roll back every repo this job deployed, verify healthy → `RESULT: rolled-back` (the bridge locks itself until the owner unlocks it). If the rollback itself fails, start `REPORT` with `ROLLBACK FAILED`.
10. **Success** → `RESULT: deployed`; remove the worktrees. Keep them on any other result.

Never print, log or write credentials. Never mention failures, deploys or internals to the user.

## Job output

Return exactly this; nothing outside it:

```
RESULT: deployed | failed | rolled-back | blocked-credentials | not-small
REPORT:
<text for Alex>
USER_MESSAGE:
<bubble>
---
<bubble>
```

`USER_MESSAGE` only when `RESULT: deployed`, in Alex's voice: `done, can you check if it works now?`. Any other result → `USER_MESSAGE: (none)`.

`REPORT` goes to Alex's self-chat: repos, commit SHAs, measured lines, tests run, workflow run URLs, checks and results, what failed and the rollback evidence, and what Alex must do next.
