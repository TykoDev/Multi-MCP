# Development

Needs Deno 2.9.x and a Chromium-family browser (Chrome, Edge or Chromium, found automatically). ffmpeg is optional
(recordings). Docker is needed only for the sandbox, container and Compose tiers.

## Set up and run

```sh
deno install --frozen        # dependencies from the lockfile
deno task setup              # every file in secrets/, and .env (secrets/README.md)
deno task build:web          # web app bundle
deno task ok                 # fmt, lint, types, gates, unit tests
export TTK_DATA_DIR=data TTK_DB_KEY_FILE=secrets/ttk_db_key TTK_API_KEYS_FILE=secrets/ttk_api_keys.json
deno task dev                # http://127.0.0.1:8787, with file watching
```

PowerShell:
`$env:TTK_DATA_DIR='data'; $env:TTK_DB_KEY_FILE='secrets/ttk_db_key'; $env:TTK_API_KEYS_FILE='secrets/ttk_api_keys.json'`.

- `dev` grants network to `127.0.0.1` only: `browser_head` is withheld and only local model servers (Ollama, vLLM on
  loopback) are reachable.
- State lands in `./data` (git-ignored). `secrets/ttk_admin_user.json` is read automatically.
- With no credentials at all, loopback requests run anonymously with `TTK_ANON_SCOPES`.
- `deno task stdio` runs MCP over stdio with the same grants and the same `ttk.db`.
- The web UI is served with `Cache-Control: no-cache`: rebuild (`build:web`) and reload; no restart needed.
- `deno task` lists every task with its description.

## Layout

```
packages/
  bus, cdp, browser   vendored browser stack (see each VENDOR.md)
  wire                live-view and A2UI message contract
  mcp                 tool catalog (catalog/), handlers (tools/), dispatcher, registry, resources
  sandbox             coding-sandbox service and client
  agents              task runtime, A2A, ACP, built-in model agent
  gateway             Hono app, auth, REST, live view, ttk.db, vault, memory, cluster
  web                 control-plane SPA and MCP Apps embeds
  cli                 composition root (serve, stdio, acp, setup, seed, doctor, …)
scripts/              gates, compile, health checks, grant resolvers
docker/               sandbox, workspace and agent-runner images; seccomp profiles; ttk
tests/                unit, e2e (browser), stdio, compile, container, sandbox, agents, fixtures, support
```

## Rules

| Rule                                                                                                                | Enforced by        |
| ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Tabs, single quotes, 120 columns                                                                                    | `deno fmt --check` |
| Recommended lint plus `no-external-import`, `no-sync-fn-in-async-fn`, `no-throw-literal`                            | `deno lint`        |
| `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`                                                          | `deno check`       |
| Packages expose only `mod.ts`; layers point downward (`bus`/`cdp`/`wire` → `browser` → `mcp` → `gateway` → `cli`)   | review             |
| Tool failures are results (`ToolError`), never JSON-RPC errors                                                      | dispatcher         |
| Every task names exact permissions, `--deny-ffi` first, absolute `--allow-run`                                      | `gate:tasks`       |
| Frozen once released: tool names and parameters, live-view message types, problem slugs, error codes, `TTK_*` names | review             |
| No secret in `Deno.env` or in plaintext at rest; resolve from `*_FILE`, seal with the vault                         | review, tests      |
| Comments explain constraints the code cannot show                                                                   | review             |

Changing a Dockerfile, `docker/ttk`, `scripts/compile.ts` or a tool's availability must pass **both** container tiers.

## Adding a browser tool

1. Handler in `packages/mcp/src/tools/`, output schema in `packages/mcp/src/schemas.ts`.
2. Catalog entry in `packages/mcp/src/catalog/*.ts`: name, title, description, Zod input schema, `mutates`, optional
   `scope` and `available`.
3. Add the name to the pinned list in `packages/mcp/src/catalog_test.ts` and a browser-tier test in `tests/e2e/`.
4. Document it in `docs/reference/mcp-tools.md` and update the stated count in `README.md`, `docs/index.md` and
   `docs/reference/mcp-tools.md` (`tests/unit/docs_claims_test.ts` checks them).

The web app's **Resources › Tools** console builds a form from each tool's schema: the quickest manual test.

## Test tiers

Pick the lowest tier that proves the change.

| Tier      | Command                                                                        | Needs                                      | Proves                                                      |
| --------- | ------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------- |
| Gate      | `deno task ok`                                                                 | —                                          | Format, lint, types, task table, lockfile, unit tier        |
| Unit      | `deno task test:unit`                                                          | —                                          | Every package, loopback only                                |
| Browser   | `deno task test:browser`                                                       | Chromium (ffmpeg for recording)            | Every catalog tool, live view, events, files, web UI        |
| stdio     | `deno task test:stdio`                                                         | Chromium                                   | The stdio transport end to end                              |
| Compile   | `deno task test:compile`                                                       | —                                          | The compiled binary and its baked permissions               |
| Container | `deno task test:container`, `test:container:slim`                              | Docker, built image                        | The image from outside: tools, sandbox flags, allowlist     |
| Sandbox   | `deno task test:sandbox`                                                       | Docker on Linux                            | Cages under production settings                             |
| Compose   | `deno task test:compose --tag <t>`                                             | `tykotech-mcp:<t>`, `tykotech-sandbox:<t>` | The default Compose stack (gateway, sandbox, A2A peer)      |
| Agents    | `deno task test:agents`, `test:agents:runner`, `test:agents:compose --tag <t>` | Docker for the last two                    | ACP and A2A against fixtures; the runner image              |
| Coverage  | `deno task cov`                                                                | As browser                                 | Line coverage ≥80% of `packages/mcp` and `packages/gateway` |

```sh
deno task build:image && deno task test:container
docker tag tykotech-mcp:0.2.0 tykotech-mcp:verify && docker tag tykotech-sandbox:0.2.0 tykotech-sandbox:verify
deno task test:compose --tag verify
```

The Compose tiers refuse deployed tags, never pull, and use scratch secrets only. The browser tier skips without a
browser unless `BUA_REQUIRE_BROWSER=1`; sampling tests also run against a real model when `TTK_MODEL_BASE_URL` and
`TTK_MODEL_API_KEY` (or an `openai_compatible_api` file) are set.

CI (`.github/workflows/ci.yml`) runs the gate on Linux, Windows and macOS, the browser and stdio tiers, coverage, the
compile tier, both container tiers and `deno audit`.

## Pull requests

`deno task ok` green, the affected tiers green, tests at the lowest tier that proves the change, docs updated. Branches
`feature/…` or `bugfix/…`; Conventional Commits; fill in the PR template.
