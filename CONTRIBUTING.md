# Contributing

Bug reports, documentation fixes and well-scoped features are welcome.

## Ways to help

- **Bug:** open an issue with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md); include
  `deno task doctor` output and the exact error.
- **Feature:** open an issue with the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
- **Docs:** everything under [docs/](docs/) and the root Markdown files.
- **Code:** pick or propose an issue, then follow the steps below.

## Set up

Needs [Deno 2.9](https://deno.com) and a Chromium-family browser.

```sh
deno install --frozen
deno task setup
deno task build:web
deno task ok
deno task dev            # http://127.0.0.1:8787
```

Details, layout and test tiers: [docs/guides/development.md](docs/guides/development.md).

## Rules

- `deno task ok` must pass (format, lint, types, task and lock gates, unit tests), plus any higher tier your change
  touches. Changes to a Dockerfile, the compiled binary's permissions or a tool's availability must pass both
  `test:container` and `test:container:slim`.
- Tests accompany the change at the lowest tier that proves it; coverage stays at or above 80%.
- Each package exposes only `mod.ts`; tool failures are results, never JSON-RPC errors.
- Never weaken the Chromium sandbox, put a secret in the environment or a log, widen a permission grant without saying
  why, or rename a released tool, parameter, error code or `TTK_*` variable.
- Update `docs/` for any user-visible change.
- Branches `feature/…` or `bugfix/…`; [Conventional Commits](https://www.conventionalcommits.org/); fill in the
  [pull request template](.github/PULL_REQUEST_TEMPLATE.md) and link the issue.

Agent-oriented guidance: [AGENTS.md](AGENTS.md).

## Conduct, security, license

[Code of Conduct](CONDUCT.md) · report vulnerabilities privately per [SECURITY.md](SECURITY.md) · contributions are
licensed under the [MIT License](LICENSE).
