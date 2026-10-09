<!-- Thank you for contributing to Multi-MCP. Please fill this out so review is fast. -->

## Summary

What does this PR do, in one or two sentences?

Closes #<!-- issue number -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Build / CI / tooling

## What changed and why

<!-- Describe the change and why. Explain any permission, scope or security-relevant change. -->

## Checklist

- [ ] `deno task ok` is green (fmt · lint · types · task gate · lock gate · unit tests).
- [ ] Higher tiers pass where relevant (`deno task test:browser`, `deno task test:stdio`, container/compile).
- [ ] Coverage stays above the 80% gate (`deno task cov`) for affected code.
- [ ] New/changed behavior has tests in the appropriate tier.
- [ ] `docs/` updated for any contract or user-visible behavior change.
- [ ] No secret enters `Deno.env`, a log line, or a tool result; credential material is addressed by name only.
- [ ] Public surface stays `mod.ts`-only; no deep cross-package imports.
- [ ] Commit messages follow Conventional Commits.

## Security considerations

<!-- Does this touch auth, scopes, the Chromium sandbox, secrets, the domain allowlist, or the middleware order?
     If so, explain how the posture is preserved. -->

## Screenshots / logs (if UI or behavioral)
