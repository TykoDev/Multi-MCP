# Security Policy

Multi-MCP loads untrusted web pages in a sandboxed browser, runs code in isolated workspaces and exposes both to network
clients. The full posture is in [docs/concepts/security-model.md](docs/concepts/security-model.md).

## Approach

- **The browser is hostile territory.** Chromium always runs with its own sandbox (setuid helper, custom seccomp
  profile, `no-new-privileges` deliberately unset, `shm_size: 1gb`). `--no-sandbox` is possible only through
  `TTK_CHROMIUM_NO_SANDBOX`, never set in the shipped images. The CDP port is never published.
- **Code runs elsewhere.** Workspace commands run in a separate container, one bubblewrap cage per command, with no
  network by default.
- **Credentials.** API keys and passwords are stored as hashes; every secret kept at rest (provider keys, browser
  secrets, the link-signing key) is AES-256-GCM sealed with a key that lives off the data volume. Secrets never enter
  the process environment, a response or a log.
- **Least privilege.** Per-credential scopes, owner-bound sessions and workspaces, and an explicit Deno permission
  matrix on every runnable surface.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2.0 | ❌        |

## Reporting a vulnerability

**Do not report vulnerabilities through public issues, pull requests or discussions.** Report privately:

- **Email:** stoffe@tykotech.eu, subject starting with `[SECURITY]`.
- **GitHub:** Security → Report a vulnerability (private advisory).

Include the impact, the affected version and run mode (Compose, bundled image, slim image, compiled binary, local Deno),
the configuration, reproduction steps and any proof of concept. Do not include live credentials or secret values.

## Disclosure

1. Acknowledgement within a few business days.
2. Assessment of severity and affected versions, with updates to you.
3. A tested fix and a patched release, noted under `Security` in [CHANGELOG.md](CHANGELOG.md).
4. Coordinated public disclosure once a fix is available, crediting reporters who wish to be credited.

## Dependencies

The dependency set is small; the inventory is in [docs/reference/sbom.md](docs/reference/sbom.md) (CycloneDX:
[sbom.cyclonedx.json](docs/reference/sbom/sbom.cyclonedx.json)). CI runs `deno audit` and enforces the lockfile.
Locally: `deno task audit`, and scan built images (for example `trivy image tykotech-mcp:0.2.0`) for the Chromium and OS
packages.
