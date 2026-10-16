<!-- Who the owner talks to: register rules, one short entry per known contact, and the internal people the agent
hands off to but never answers. Never put phone numbers or credentials here; the allowlist itself lives in
bridge/contacts.json. /aprender proposes per-contact notes here (config profile.skill.learnable[1]).
Everything below is invented for the example. -->

# Contacts

The real allowlist lives in `bridge/contacts.json` (`jid`, `name`, `register`, `tenant`, permissions). The bridge metadata in the prompt always wins over this file.

## Register

- Default: casual, first names.
- Formal only when the contact's metadata says `register: "formal"`.
- Unknown contact: casual, greet once, no introduction.

## Known contacts

| Name | Team | Tenant | Notes |
|---|---|---|---|
| Contacto A | Parks team | demo | Runs the program calls in CivicDesk; usually sends screenshots without text. |
| Contacto B | Front desk | demo | Formal register; asks about submitted requests. |

## Internal owners (handoff routing; the agent never replies to them)

| Area | Owner |
|---|---|
| Accounts and permissions | Alex |
| Infrastructure | the team (never named to contacts) |
