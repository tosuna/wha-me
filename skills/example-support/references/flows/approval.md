<!-- Flow for anything security-related: the agent never acts, it acks and raises a blocking handoff with a risk
assessment. Adapt the "applies to" list and the risk signals to your platform's permission model. -->

# Flow: approval (blocking)

Applies to: permissions, access to modules or programs, role changes, account creation, password resets, 2FA, making internal data public, deleting records, anything security-related.

The agent STOPS here. It never executes these, and never says it will be done. Only exception: a request the contact already submitted, under `knowledge.md` § Auto-approval (the bridge executes it).

## Steps

0. The contact says they already submitted it in CivicDesk, or the metadata has `autoApprove` and a lookup shows a pending request of theirs matching the ask → not this flow: `knowledge.md` § Submitted requests (§ Auto-approval when it applies).
1. Reply, one of two cases:
   - **Missing identifier.** An action on an account or access that does not say which account, user or program: a short ack plus ONE short question asking only for that identifier, each in its own bubble (`Hi, sure` / `which account is it, yours or someone on your team?`). Never ask for passwords, codes or personal data beyond the identifier.
   - **Everything else:** the request is complete, or it asks to see, send or export data, internals, credentials, someone else's information or another tenant's data. Neutral ack only, `Hi, let me check`, nothing else. No question, not even to narrow it down.
   Either way: no yes, no timing, never say it is being approved or done.
2. Assess risk with the table below.
3. Return the blocking handoff in both cases (missing identifier → `for: pending, asked <what>`) and stop. Do not continue this topic until Alex answers; other topics in later messages follow their own flows.

## Risk

| Signal | Risk |
|---|---|
| More scope than the stated task (all programs vs one, admin vs read-only) | high |
| Role up, cross-team or cross-tenant access | high |
| Request for someone else's account or permissions (requester ≠ owner) | high |
| Disabling 2FA, making internal data public, deleting records | high |
| Requester is not a known contact in `contacts.md` | high |
| Same scope the requester already has, for their own account | low |
| Anything else | medium |

Highest matching signal wins.

## Output

```
REPLY:
Hi, let me check
HANDOFF:
type: approval
blocking: true
contact: <name> (<team>, <tenant>)
summary: <what they want, one line>
request: <verbatim message>
for: <account/person affected, item ids>
risk: low | medium | high — <signals that matched>
evidence: <requester ≠ owner?, known contact?, current access if known>
safer option: <smallest grant that covers the stated need, if any>
question: <the yes/no or choice Alex must make>
IMPLEMENT: none
```

After Alex decides, they reply themselves; the agent does not follow up on its own.
