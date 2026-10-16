# Contributing to wha-me

Thanks for helping. wha-me speaks for a real person on a real WhatsApp account, so the bar is: small, tested changes
that keep the safety model intact.

## Setup

Requirements are in the [README](README.md#requirements) (Node.js 24, the Claude Code CLI; macOS for the sandboxed
pipeline gate, the Keychain and notifications).

```sh
npm --prefix bridge ci
npm --prefix bridge test
```

Tests use the built-in runner (`node --test`) and live next to the code as `bridge/src/*.test.js`. Modules get their
dependencies injected (WhatsApp client, agent runs, clock), so tests use fakes instead of a real account or `claude`.

## How we work

- **Failing test first.** Write the test that captures the behavior, see it fail, then implement the minimum to make it
  pass. A bug fix starts with a test that reproduces the bug.
- **Keep changes small.** One cohesive change per PR. No drive-by refactors or reformatting.
- **Conventional commits**: `feat: ...`, `fix: ...`, `test: ...`, `docs: ...`, `refactor: ...`, `chore: ...`.
- **Adapters over hardcoding.** Nothing specific to a person, company, product or deployment goes into the code. If
  behavior varies between owners, it belongs in the config (`config/example.config.js`) or in a port
  ([docs/adapters.md](docs/adapters.md)).
- **No real data.** No real names, phone numbers, WhatsApp ids, domains, hostnames or emails in code, tests, fixtures or
  docs. Fixtures use fictional data (the example owner is "Alex", the example organization "Acme Civic"; ids like
  `5210000000001@s.whatsapp.net`). Never commit `bridge/auth/`, `bridge/state/`, `bridge/contacts.json` or your config.
- **Safety first.** Changes that touch the allowlist, shadow mode, the secret guard, prompts or the pipeline's push and
  deploy paths need a test that shows the guard still holds.

## Proposing a new adapter

1. Open an issue describing the system you want to plug in and which port it fits (DeployTarget, MigrationTarget,
   ActionAdapter), or why a new port is needed.
2. Implement it as a factory that returns a plain object honoring the contract in [docs/adapters.md](docs/adapters.md),
   with state in closures (the config is frozen).
3. Add tests with fake `ops`, ledgers or HTTP clients; no real services.
4. Document its options in a comment next to the factory, like `githubWorkflow` in `bridge/src/deploy.js`.

Platform ports (Linux sandboxing instead of `sandbox-exec`, a secret store instead of the Keychain, notifications
instead of `osascript`) are very welcome; follow the same steps.

## Pull request checklist

- [ ] A test failed before the change and passes after it.
- [ ] `npm --prefix bridge test` is green.
- [ ] The change is small and focused; no unrelated edits.
- [ ] No personal, company or deployment data; fixtures are fictional.
- [ ] Docs (README, `docs/adapters.md`, the example config) updated if behavior or config changed.
- [ ] Conventional commit messages.

## License of contributions

wha-me is licensed under the [Apache License 2.0](LICENSE). Under its section 5, any contribution you intentionally
submit for inclusion is licensed under the same terms (inbound = outbound). There is no CLA.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
