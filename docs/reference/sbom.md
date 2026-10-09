# Software Bill of Materials (SBOM)

This page lists every third-party component in Multi-MCP (`tykotech-mcp`). It covers all JSR and npm packages resolved
in [deno.lock](../../deno.lock), direct and transitive, plus the base images, the Deno runtime and the Debian packages
installed by [Dockerfile](../../Dockerfile), [Dockerfile.slim](../../Dockerfile.slim),
[docker/Dockerfile.sandbox](../../docker/Dockerfile.sandbox),
[docker/Dockerfile.sandbox-workspace](../../docker/Dockerfile.sandbox-workspace) and
[docker/Dockerfile.agent-runner](../../docker/Dockerfile.agent-runner).

The machine-readable version is [sbom/sbom.cyclonedx.json](sbom/sbom.cyclonedx.json). Both files describe the same
components.

## Document metadata

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Subject          | `tykotech-mcp` 0.2.0, MIT, supplier TykoTech                                                      |
| Format           | CycloneDX 1.5 (JSON)                                                                              |
| BOM version      | 4                                                                                                 |
| Serial number    | `urn:uuid:1d9fd24d-1eab-43f9-9035-1266301d8e30`                                                   |
| Timestamp        | `2026-10-04T00:00:00Z`                                                                            |
| Lifecycle        | pre-build (source manifests and lockfile)                                                         |
| Tool             | `deno.lock export (manual)`                                                                       |
| Components       | 95: 76 library, 14 application, 3 container, 1 platform, 1 operating-system                       |
| Dependency graph | Direct dependencies of the app, every JSR and npm edge in `deno.lock`, and image-to-package edges |

## Conventions

| Item            | Convention                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| npm purl        | `pkg:npm/%40scope/name@version`                                                                                |
| JSR purl        | `pkg:generic/%40std/name@version?repository_url=https://jsr.io` (purl has no registered JSR type)              |
| Base image purl | `pkg:docker/<image>@<tag>`                                                                                     |
| Debian purl     | `pkg:deb/debian/<package>`, unversioned                                                                        |
| npm hashes      | SHA-512 from the lock's `integrity` field, converted from base64 to hex                                        |
| JSR hashes      | SHA-256 from the lock's `integrity` field; it covers the JSR version manifest, not an archive                  |
| npm licenses    | The `license` field of each package's `package.json` in the Deno npm cache                                     |
| Scope           | `required` for anything reachable from the server runtime or the SPA bundle; `optional` otherwise              |
| Properties      | `tykotech:usage` (runtime, web-bundle, build-time, test-only, unused), `tykotech:dependency`, `tykotech:image` |

## Direct runtime dependencies (npm)

| Package                        | Version | License | Role                                                                              |
| ------------------------------ | ------- | ------- | --------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server` | 2.0.0   | MIT     | MCP server SDK: tools, resources, Streamable HTTP and stdio transports            |
| `@modelcontextprotocol/hono`   | 2.0.0   | MIT     | Hono adapter for the MCP handler, with Host and Origin validation                 |
| `hono`                         | 4.13.5  | MIT     | HTTP framework for the gateway on `Deno.serve`                                    |
| `jose`                         | 6.2.10  | MIT     | JWT and JWKS verification for OAuth 2.1                                           |
| `zod`                          | 4.5.1   | MIT     | Schema validation; one definition per tool yields JSON Schema, validator and type |

## Web build dependencies (npm)

| Package                  | Version | License | Use                  | Role                                      |
| ------------------------ | ------- | ------- | -------------------- | ----------------------------------------- |
| `@awesome.me/webawesome` | 3.14.0  | MIT     | bundled into the SPA | Web component kit for the live-view SPA   |
| `lucide-static`          | 1.49.0  | ISC     | build-time           | Icon glyph source for the SPA icon sprite |

## Test-only dependencies

| Package                        | Version | License | Role                                              |
| ------------------------------ | ------- | ------- | ------------------------------------------------- |
| `@modelcontextprotocol/client` | 2.0.0   | MIT     | MCP client SDK used to drive the server in tests  |
| `@std/assert`                  | 1.0.19  | MIT     | Assertion functions for tests                     |
| `@std/expect`                  | 1.0.20  | MIT     | Jest-compatible expect API for tests              |
| `@std/testing`                 | 1.0.20  | MIT     | BDD, mocking, snapshot and fake-time test helpers |

## JSR standard library modules

All `@std` modules are MIT.

| Module                 | Version  | Dependency | Use                | Scope    |
| ---------------------- | -------- | ---------- | ------------------ | -------- |
| `@std/assert`          | 1.0.19   | direct     | test-only          | optional |
| `@std/async`           | 1.5.0    | direct     | runtime, test-only | required |
| `@std/cli`             | 1.0.32   | direct     | runtime            | required |
| `@std/crypto`          | 1.1.0    | direct     | runtime            | required |
| `@std/encoding`        | 1.0.11   | direct     | runtime            | required |
| `@std/expect`          | 1.0.20   | direct     | test-only          | optional |
| `@std/fs`              | 1.0.24   | direct     | runtime, test-only | required |
| `@std/http`            | 1.1.3    | direct     | runtime            | required |
| `@std/log`             | 0.224.14 | direct     | unused             | optional |
| `@std/path`            | 1.1.6    | direct     | runtime, test-only | required |
| `@std/streams`         | 1.1.2    | direct     | runtime            | required |
| `@std/testing`         | 1.0.20   | direct     | test-only          | optional |
| `@std/ulid`            | 1.0.0    | direct     | runtime            | required |
| `@std/uuid`            | 1.1.1    | direct     | runtime            | required |
| `@std/bytes`           | 1.0.6    | transitive | runtime            | required |
| `@std/data-structures` | 1.1.2    | transitive | runtime, test-only | required |
| `@std/fmt`             | 1.0.10   | transitive | runtime            | required |
| `@std/html`            | 1.0.7    | transitive | runtime            | required |
| `@std/internal`        | 1.0.14   | transitive | runtime, test-only | required |
| `@std/io`              | 0.225.3  | transitive | unused             | optional |
| `@std/media-types`     | 1.1.0    | transitive | runtime            | required |
| `@std/net`             | 1.0.6    | transitive | runtime            | required |

## Transitive npm packages

| Package                      | Version | License      | Required by                                                                                   | Use                |
| ---------------------------- | ------- | ------------ | --------------------------------------------------------------------------------------------- | ------------------ |
| `@ctrl/tinycolor`            | 4.1.0   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@floating-ui/core`          | 1.8.0   | MIT          | `@floating-ui/dom`                                                                            | web-bundle         |
| `@floating-ui/dom`           | 1.8.0   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@floating-ui/utils`         | 0.2.12  | MIT          | `@awesome.me/webawesome`, `@floating-ui/core`, `@floating-ui/dom`, `composed-offset-position` | web-bundle         |
| `@konnorr/qr-creator`        | 1.1.0   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@lit-labs/ssr`              | 4.1.0   | BSD-3-Clause | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@lit-labs/ssr-client`       | 1.1.8   | BSD-3-Clause | `@awesome.me/webawesome`, `@lit-labs/ssr`                                                     | web-bundle         |
| `@lit-labs/ssr-dom-shim`     | 1.6.0   | BSD-3-Clause | `@lit-labs/ssr`, `@lit/reactive-element`, `lit-element`                                       | web-bundle         |
| `@lit/context`               | 1.1.6   | BSD-3-Clause | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@lit/react`                 | 1.0.8   | BSD-3-Clause | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@lit/reactive-element`      | 2.1.2   | BSD-3-Clause | `@lit-labs/ssr`, `@lit-labs/ssr-client`, `@lit/context`, `lit`, `lit-element`                 | web-bundle         |
| `@modelcontextprotocol/core` | 2.0.0   | MIT          | `@modelcontextprotocol/client`, `@modelcontextprotocol/server`                                | runtime, test-only |
| `@parse5/tools`              | 0.3.0   | MIT          | `@lit-labs/ssr`                                                                               | web-bundle         |
| `@shoelace-style/animations` | 1.2.0   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@shoelace-style/localize`   | 3.2.3   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `@types/react`               | 19.3.0  | MIT          | `@awesome.me/webawesome`, `@lit/react`                                                        | web-bundle         |
| `@types/trusted-types`       | 2.0.7   | MIT          | `lit-html`                                                                                    | web-bundle         |
| `composed-offset-position`   | 0.0.6   | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `cross-spawn`                | 7.0.6   | MIT          | `@modelcontextprotocol/client`                                                                | test-only          |
| `csstype`                    | 3.2.3   | MIT          | `@types/react`                                                                                | web-bundle         |
| `data-uri-to-buffer`         | 4.0.1   | MIT          | `node-fetch`                                                                                  | web-bundle         |
| `enhanced-resolve`           | 5.24.5  | MIT          | `@lit-labs/ssr`                                                                               | web-bundle         |
| `entities`                   | 6.0.1   | BSD-2-Clause | `parse5`                                                                                      | web-bundle         |
| `eventsource`                | 3.0.7   | MIT          | `@modelcontextprotocol/client`                                                                | test-only          |
| `eventsource-parser`         | 3.1.1   | MIT          | `@modelcontextprotocol/client`, `eventsource`                                                 | test-only          |
| `fetch-blob`                 | 3.2.0   | MIT          | `formdata-polyfill`, `node-fetch`                                                             | web-bundle         |
| `formdata-polyfill`          | 4.0.10  | MIT          | `node-fetch`                                                                                  | web-bundle         |
| `graceful-fs`                | 4.2.11  | ISC          | `enhanced-resolve`                                                                            | web-bundle         |
| `isexe`                      | 2.0.0   | ISC          | `which`                                                                                       | test-only          |
| `lit`                        | 3.3.3   | BSD-3-Clause | `@awesome.me/webawesome`, `@lit-labs/ssr`, `@lit-labs/ssr-client`                             | web-bundle         |
| `lit-element`                | 4.2.2   | BSD-3-Clause | `@lit-labs/ssr`, `lit`                                                                        | web-bundle         |
| `lit-html`                   | 3.3.3   | BSD-3-Clause | `@lit-labs/ssr`, `@lit-labs/ssr-client`, `lit`, `lit-element`                                 | web-bundle         |
| `marked`                     | 11.2.0  | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `nanoid`                     | 5.1.16  | MIT          | `@awesome.me/webawesome`                                                                      | web-bundle         |
| `node-domexception`          | 1.0.0   | MIT          | `fetch-blob`                                                                                  | web-bundle         |
| `node-fetch`                 | 3.3.2   | MIT          | `@lit-labs/ssr`                                                                               | web-bundle         |
| `parse5`                     | 7.3.0   | MIT          | `@lit-labs/ssr`, `@parse5/tools`                                                              | web-bundle         |
| `path-key`                   | 3.1.1   | MIT          | `cross-spawn`                                                                                 | test-only          |
| `pkce-challenge`             | 5.0.1   | MIT          | `@modelcontextprotocol/client`                                                                | test-only          |
| `shebang-command`            | 2.0.0   | MIT          | `cross-spawn`                                                                                 | test-only          |
| `shebang-regex`              | 3.0.0   | MIT          | `shebang-command`                                                                             | test-only          |
| `tapable`                    | 2.3.3   | MIT          | `enhanced-resolve`                                                                            | web-bundle         |
| `web-streams-polyfill`       | 3.3.3   | MIT          | `fetch-blob`                                                                                  | web-bundle         |
| `which`                      | 2.0.2   | ISC          | `cross-spawn`                                                                                 | test-only          |

"Required by" includes peer dependencies that the lock resolves into a package's key.

## License summary

| License      | JSR | npm |
| ------------ | --- | --- |
| MIT          | 22  | 38  |
| BSD-3-Clause | 0   | 9   |
| ISC          | 0   | 4   |
| BSD-2-Clause | 0   | 1   |

## Container images

| Base image (tag and digest)                                                                   | Used by                                                                                                                                                                                       | Deno runtime                           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432` | `Dockerfile` (build and runtime), `Dockerfile.slim` (build only), `docker/Dockerfile.sandbox`, `docker/Dockerfile.agent-runner`, `docker/Dockerfile.sandbox-workspace` (the Deno binary only) | 2.9.7                                  |
| `debian:stable-slim@sha256:5bc3287b25407c965a30f38e32603dc253a3869e1b12a21ac09bfc27fd8b13ce`  | `Dockerfile.slim` (runtime)                                                                                                                                                                   | 2.9.7, embedded in the compiled binary |
| `debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a`  | `docker/Dockerfile.sandbox-workspace` (runtime)                                                                                                                                               | 2.9.7, the copied binary               |

The images built from these files are tagged `tykotech-mcp:0.2.0` (bundled), `tykotech-mcp:slim`,
`tykotech-sandbox:0.2.0`, `tykotech-sandbox-workspace:0.2.0` and `tykotech-agent-runner:0.2.0`. Deno itself is MIT.

## OS packages per image

Every package is installed with `apt-get install --no-install-recommends` and no version pin.

| Package            | License                                  | bundled | slim | sandbox | sandbox-workspace | agent-runner |
| ------------------ | ---------------------------------------- | ------- | ---- | ------- | ----------------- | ------------ |
| `chromium`         | `BSD-3-Clause`                           | yes     | yes  |         |                   |              |
| `chromium-sandbox` | `BSD-3-Clause`                           | yes     | yes  |         |                   |              |
| `fonts-liberation` | NOASSERTION                              | yes     | yes  |         |                   |              |
| `ca-certificates`  | `GPL-2.0-or-later AND MPL-2.0`           | yes     | yes  | yes     | yes               |              |
| `dumb-init`        | `MIT`                                    | yes     | yes  |         |                   |              |
| `ffmpeg`           | `LGPL-2.1-or-later AND GPL-2.0-or-later` | yes     | yes  |         |                   |              |
| `bubblewrap`       | `LGPL-2.0-or-later`                      |         |      | yes     |                   |              |
| `socat`            | `GPL-2.0-only`                           |         |      | yes     | yes               |              |
| `git`              | `GPL-2.0-only`                           |         |      | yes     | yes               |              |
| `python3`          | `Python-2.0`                             |         |      | yes     | yes               |              |
| `python3-pip`      | `MIT`                                    |         |      | yes     | yes               |              |
| `nodejs`           | `MIT`                                    |         |      | yes     | yes               |              |
| `npm`              | `Artistic-2.0`                           |         |      | yes     | yes               |              |
| `curl`             | `curl`                                   |         |      | yes     | yes               |              |
| `util-linux`       | `GPL-2.0-or-later`                       |         |      | yes     | yes               | yes          |
| `procps`           | `GPL-2.0-or-later`                       |         |      |         |                   | yes          |

Debian package licenses are the upstream primary license. The full per-file terms are in
`/usr/share/doc/<package>/copyright` inside each image.

## Scope notes

- `@modelcontextprotocol/client` is imported only by tests. It is `optional`, and so are the packages only it pulls in.
- `lucide-static` is used at build time. `deno task build:web` copies its glyph data into `packages/web/dist/icons.svg`,
  so the ISC notice applies to the shipped sprite.
- `@awesome.me/webawesome` is bundled into the SPA. The table lists its whole locked dependency tree. Some of those
  packages (the Lit SSR packages, `node-fetch`, `@types/react`) are resolved by the lock but not imported by browser
  code.
- `@std/log` is in the import map, but no module imports it. `@std/streams` and `@std/fs` are only reached at runtime
  through `@std/http`.
- `node:assert/strict` and `node:fs/promises`, mapped in the import maps, are Deno built-ins and not packages.
- Base images are pinned by digest (recorded as each container component's SHA-256 hash). Debian packages are
  unversioned, so their versions depend on what the package mirrors serve when the image is built. `fonts-liberation` is
  `NOASSERTION` because its license depends on the Debian release (GPL-2.0 with a font exception for Liberation 1.x,
  OFL-1.1 for 2.x).
- Container images have no single license and carry no `licenses` entry.

## Generation & maintenance

Regenerate when `deno.json`, `deno.lock` or a Dockerfile changes, and before every release.

1. Run `deno install --frozen` so the lock matches the import maps.
2. Take every key under `jsr` and `npm` in `deno.lock`. Strip the `_peer` suffix from npm keys to get name and version.
   Mark direct dependencies from `workspace.dependencies`.
3. Copy `integrity` into `hashes`: npm values are `sha512-<base64>`, recorded as SHA-512 hex. JSR values are SHA-256
   hex.
4. Read each npm license from `<DENO_DIR>/npm/registry.npmjs.org/<name>/<version>/package.json`. `deno info` prints
   `DENO_DIR`.
5. Take base images, their digests and apt lists from the five Dockerfiles.

Verify:

```sh
# The JSON parses
deno eval 'JSON.parse(Deno.readTextFileSync("docs/reference/sbom/sbom.cyclonedx.json"))'

# Every locked JSR and npm package has a component with the same version
deno eval 'const l = JSON.parse(Deno.readTextFileSync("deno.lock")); const b = JSON.parse(Deno.readTextFileSync("docs/reference/sbom/sbom.cyclonedx.json")); const have = new Set(b.components.map((c) => `${c.name}@${c.version}`)); const want = [...Object.keys(l.jsr), ...Object.keys(l.npm).map((k) => k.split("_")[0])]; const missing = want.filter((k) => !have.has(k)); console.log(`${want.length} locked, ${missing.length} missing`, missing); if (missing.length) Deno.exit(1);'

# Formatting
deno fmt --check docs/reference/sbom.md docs/reference/sbom/sbom.cyclonedx.json

# Advisories over the resolved graph
deno task audit
```

OS packages can only be checked against a built image. Scan the image with an image scanner, not the source tree.
