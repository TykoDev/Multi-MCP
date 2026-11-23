# Security Policy

Multi-MCP loads untrusted web pages in a sandboxed browser, runs code in isolated workspaces and exposes both to network
clients. What guards each boundary, and where the guard ends: [docs/security.md](docs/security.md).

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2.0 | ❌        |

## Reporting a vulnerability

**Do not report vulnerabilities through public issues, pull requests or discussions.** Report privately:

- **Email:** stoffe@tykotech.eu, subject starting with `[SECURITY]`.
- **GitHub:** Security → Report a vulnerability (private advisory).

Include the impact, the affected version and run mode (Compose, image, local Deno), the configuration, reproduction
steps and any proof of concept. Do not include live credentials or secret values.

## Disclosure

1. Acknowledgement within a few business days.
2. Assessment of severity and affected versions, with updates to you.
3. A tested fix and a patched release, noted under `Security` in [CHANGELOG.md](CHANGELOG.md).
4. Coordinated public disclosure once a fix is available, crediting reporters who wish to be credited.

## Dependencies

The dependency set is small and pinned: `deno.json` and the frozen `deno.lock`, and base images by digest. CI runs
`deno audit` and enforces the lockfile. Locally: `deno task audit`, and scan built images (for example
`trivy image tykotech-mcp:0.2.0`) for the Chromium and OS packages.
