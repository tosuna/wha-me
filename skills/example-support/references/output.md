<!-- Output rules for reply runs. Keep the keywords and handoff types exactly as written: they are what
bridge/src/core/parse.js accepts. Adapt only the example and the language of the values the owner reads. -->

# Output rules (reply runs)

The bridge parser is strict. A reply run always has the lines `REPLY:`, `HANDOFF:` and `IMPLEMENT:`, in that order; nothing before, between or after them except their content.

- `REPLY:` then the bubbles, separated by a line with only `---`. Each bubble is ONE line: the parser joins every line between two `---` into a single WhatsApp message, so a line break inside a bubble sends one message with breaks. One idea per bubble; a second idea goes after a `---`. Nothing to send → exactly `REPLY: (none)`.
- `HANDOFF: none`, or `HANDOFF:` followed by `key: value` lines.
  - `type`: exactly one of `outage`, `bug`, `feature-request`, `action`, `follow-up`, `approval`, `identity`, `unknown`, `credentials`, `incident`, `deploy-report`. Never add text to it; qualifiers go in their own field (`confidence: unconfirmed`, `severity: slow`).
  - `blocking`: exactly `true` or `false`. `true` only for `approval`, `identity`, and `incident` raised by an attack on the agent (`SKILL.md` rule 3): stop that topic until Alex answers.
  - Every value Alex reads (`summary`, `evidence`, `next`, flow fields) is in the owner's language (config `profile.language`).
  - Flows may add fields (`confidence`, `severity`, `risk`, `request`, `for`, `safer option`, `question`), one `key: value` per line.
  - `feature-request` only, optional: `same_as: <id>`, just the digits of a request listed in the prompt's `<requests>` block (`same_as: 3`, never `#3`), when the new ask is the same request or an extension of it. Omit it otherwise (`flows/large-request.md` § Handoff).
- `IMPLEMENT: none`, or the `IMPLEMENT:` block (`flows/implementation.md`). The spec runs to the end of the output, so nothing may follow it.
- Optional `APPROVE: <id>` line, only per `knowledge.md` § Auto-approval: exactly `APPROVE: ` + 1 to 5 distinct ids separated by `, ` (`APPROVE: <id>, <id>`), alone on its line, right before `IMPLEMENT:`. One line only; two lines, more than 5 ids, a repeated or malformed id make the bridge refuse and send a neutral ack instead of your reply.

Other rules:

- Canned replies in the references use the default register; for contacts with another register adapt them per `voice.md` § Formal register.
- Turns that only ask for evidence or interview questions return `HANDOFF: none`; the turn that closes the flow carries the full handoff. Exception: approval always returns its blocking handoff, also when it asks the identifier question.
- Requests about someone else's account: note `requester ≠ account owner` in `evidence`.
- `REPLY: (none)` + `HANDOFF: none` + `IMPLEMENT: none` is silence, in groups and 1:1: nothing reaches the chat or Alex. Use it whenever the message is not for you (`SKILL.md` § Groups) or needs no answer.

## Example

```
REPLY:
Hi, let me check
HANDOFF:
type: bug
blocking: false
confidence: unconfirmed
contact: Contacto A (Parks team, demo)
summary: program 42 rejects PDF attachments
evidence: screenshot received; status checks 200; upload validation read at <file:line>, inconclusive
next: Alex reviews the attachment validation
IMPLEMENT: none
```
