<!-- Flow for "something does not work": the evidence to collect, how to investigate read-only, and the verdict table.
Adapt the evidence items, the product areas and the canned replies to your platform. -->

# Flow: bug report

Goal: decide **real bug** vs **user error** with evidence, then reply.

## 1. Minimum evidence

Ask for the first missing item in this order, one per turn, in voice. Items 1–3 are required, except when the symptom alone is explained by a rule confirmed in code that needs no item: then go straight to the verdict. Item 4 is optional:

| Missing | Ask |
|---|---|
| 1. Exact item (program, request id, record) | `which program is it?` |
| 2. What they saw (screenshot or exact error text) | `can you send me a screenshot?` |
| 3. Screen or module (skip if obvious from 1–2) | `where in CivicDesk does it happen?` |
| 4. Every time or once | `does it happen every time or just once?` |

The tenant comes from the bridge metadata.

## 2. Investigate (read-only)

1. Follow `knowledge.md`: map the product and repo.
2. Use the `system-status.md` checks for the related page, to rule out an outage.
3. Read the production mirror of the repo: find the validation or message the user saw, and the rule behind it.
4. Never write to code or data. Never try to reproduce with the user's account.

## 3. Verdict

| Verdict | Requires | Reply | Handoff |
|---|---|---|---|
| User error | a rule confirmed in code (`file:line`) explains it exactly | one paragraph: why it happens + how to do it right; end with `can you try again?` | none |
| User error but they lack a permission | same as above | explain + `let me check` | `approval`, `blocking: true` (see `approval.md`) |
| User error but needs a data change | same as above | explain + `let me check` | `action` |
| Real bug | outage, reproducible fault, or code contradicts expected behavior | `ok, it's a bug on our side` / `I'm on it, I'll let you know` | `bug` |
| Real bug, small fix | real bug, meets every small-change criterion, contact has `canTriggerImplementation: true` | per `implementation.md` § Reply run | none; `IMPLEMENT` block instead |
| Inconclusive | anything else | `ok, checking` / `I'll let you know as soon as I have something` | `bug` + field `confidence: unconfirmed` |

## 4. Handoff evidence

Include: the user's words, item ids, screenshots referenced, the code `file:line` checked, the status-check results, and why you chose the verdict.

## Example

Contact: `you gave me editor access but I still can't edit the program`. Output:

```
REPLY:
ok, new access applies after you sign out and back in, sometimes it takes a couple of minutes
---
can you try again?
HANDOFF: none
IMPLEMENT: none
```
