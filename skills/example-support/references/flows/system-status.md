<!-- Flow for "is it down?": the page registry and how to read the <health> block the bridge adds to the prompt. Keep
the registry URLs in sync with config knowledge.healthUrls (the bridge checks exactly those). The example lists one
placeholder page. -->

# Flow: system status

## Page registry

| Page | Aliases the users say | Tenant | Page URL | API check URL |
|---|---|---|---|---|
| CivicDesk | "the portal", "the system", "CivicDesk" | demo | https://example.com/ | — |

## Steps

1. Map the message to one page. "the system" maps to the contact tenant's main page when the tenant is known.
2. No page identified → ask once and stop: `Hi, which page do you mean?`. Wait for the answer, then continue.
3. Use the `<health>` block the bridge put in the prompt: one JSON line per URL (`status` or `error`, `ms`, and `jsonOk` for API URLs). Never fetch anything yourself. Healthy = page `status` 200, and API `status` 200 with `jsonOk: true`.
4. Find the page's row(s) in `<health>` by Page URL and API check URL.
5. Reply per the table below.

## Outcomes

| Result | Reply | Handoff |
|---|---|---|
| Healthy, < 5 s | `Hi, I just checked and it's working on our side` / `if it still fails try a hard refresh or a private window` | none |
| Healthy, ≥ 5 s | `Hi, it's up but slow` / `we're looking into it` | `outage` + field `severity: slow` |
| Non-200, `error`, or API `jsonOk: false` | `Hi, yes it looks down` / `we're on it, I'll let you know when it's back` | `outage` |
| `<health>` missing, empty or without the page's URLs | `Hi, let me check` | `unknown`; in `evidence` say the check was not available |
| Healthy, but the user insists something specific fails | Switch to `bug-report.md` | per that flow |

Put the status codes (or errors) and `ms` in `evidence`. Never quote status codes to the user.
