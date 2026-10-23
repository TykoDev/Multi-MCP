# Commands and tasks

## CLI

Entry point `packages/cli/mod.ts`; the compiled binary is `tykotech-mcp`; in the images also `ttk`. `-Force` equals
`--force`. Operator errors print one `error: …` line and exit 1.

| Command                                                                     | Does                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve [--host] [--port]`                                                   | The HTTP gateway: `/mcp`, REST, live view, web UI. First SIGINT/SIGTERM drains; a second exits.                                                                                                                                                                                                         |
| `stdio`                                                                     | MCP over stdin/stdout for a local client; logs to stderr.                                                                                                                                                                                                                                               |
| `acp`                                                                       | Agent Client Protocol over stdio, relayed to the agent runner.                                                                                                                                                                                                                                          |
| `setup [--only <l>] [--force] [--admin <u>] [--key-id <id>] [--scopes <l>]` | Create every missing file the compose files mount in `secrets/` (`0700`, files `0644`) and `.env`; repair modes; print the admin password and API key once. `--force` replaces generated files, and yours only when `--only` names them. Files and names: [secrets/README.md](../../secrets/README.md). |
| `seed [--force] [--only providers,secrets]`                                 | Copy the providers file and browser secrets into `ttk.db`. Without `--force`, only into an empty, never-seeded database.                                                                                                                                                                                |
| `doctor`                                                                    | Print the parsed configuration and warnings; exit 1 on a configuration error.                                                                                                                                                                                                                           |
| `doctor --new-key <id> [--scopes <l>] [--save]`                             | Mint an API key: the raw key once, and the hashed record; `--save` writes it into `secrets/ttk_api_keys.json` in place (the gateway reloads it).                                                                                                                                                        |
| `doctor --new-key-set <prefix>`                                             | One single-scope key per scope.                                                                                                                                                                                                                                                                         |
| `doctor --new-admin <u> [--password] [--scopes] [--force]`                  | Write a new admin account record.                                                                                                                                                                                                                                                                       |
| `doctor --new-db-key [--force]`                                             | Write a new database key (`--force` orphans every stored secret).                                                                                                                                                                                                                                       |
| `doctor --grant <u> --scopes <l> [--data-dir]`                              | Set an account's scopes offline (gateway stopped) to recover administration.                                                                                                                                                                                                                            |
| `healthcheck`                                                               | Probe `127.0.0.1:<TTK_PORT>/healthz`; exit 0 when healthy.                                                                                                                                                                                                                                              |
| `version`                                                                   | Print the version.                                                                                                                                                                                                                                                                                      |

In Compose: `docker compose run --rm --no-deps tykotech-mcp ttk <command>` (bundled `ttk` has no network or subprocess
and writes only `/data`). Restart the gateway after `ttk seed`.

## Deno tasks

`deno task` lists every task with a one-line description. Every task names exact permissions, `--deny-ffi` first;
`gate:tasks` enforces this for the shipped tasks. Each `cov:<tier>` is `test:<tier>` with `--coverage`, so a tier and
its coverage run share one matrix.

| Task                                                                | Does                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `setup`, `seed`, `doctor`                                           | The CLI commands above.                                                                        |
| `dev`                                                               | `serve` with file watching, loopback network only, the host's Chromium.                        |
| `stdio`                                                             | `stdio` with `dev`'s grants.                                                                   |
| `serve:cluster`                                                     | `serve` with `--unstable-kv`.                                                                  |
| `acp`                                                               | `acp`.                                                                                         |
| `build:web`                                                         | Bundle the web UI and the three MCP Apps embeds into `packages/web/dist`.                      |
| `compile`                                                           | Single binary in `dist/` with baked permissions (`scripts/compile.ts`; run `build:web` first). |
| `build:image`, `build:image:slim`                                   | `tykotech-mcp:0.2.0`, `tykotech-mcp:slim`.                                                     |
| `ok`                                                                | Pre-commit gate: `fmt:check`, `lint`, `check`, `gate:tasks`, `gate:lock`, `test:unit`.         |
| `fmt`, `fmt:check`, `lint`, `check`                                 | Formatting (tabs, single quotes, 120 columns), lint, type-check.                               |
| `gate:tasks`, `gate:lock`, `audit`                                  | Task-table lint, frozen lockfile, dependency advisories.                                       |
| `test:*`, `cov*`                                                    | Test tiers and coverage: [Development](../guides/development.md#test-tiers).                   |
| `resolve:chromium`, `chromium:read`, `tier:paths`, `resolve:docker` | Compute exact grants for the tasks and test tiers.                                             |

## Scripts

| Script                                                                                | Purpose                                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/compile.ts`                                                                  | `deno compile` wrapper; Linux, macOS and Windows targets; baked permissions.        |
| `scripts/check_tasks.ts`                                                              | The `gate:tasks` lint.                                                              |
| `scripts/coverage.ts`                                                                 | Merge coverage; gate line coverage ≥80% over `packages/mcp` and `packages/gateway`. |
| `scripts/build_icons.ts`, `scripts/build_embed.ts`                                    | Icon sprite; self-contained MCP Apps embed documents.                               |
| `scripts/healthcheck.ts`, `sandbox_healthcheck.ts`, `agent_healthcheck.ts`            | Container health probes.                                                            |
| `scripts/agent_runner.ts`                                                             | The ACP agent runner service.                                                       |
| `scripts/sandbox_seccomp.ts`                                                          | Regenerate `docker/seccomp-sandbox.json`.                                           |
| `scripts/resolve_chromium.ts`, `tier_paths.ts`, `resolve_docker.ts`, `agent_paths.ts` | Permission grants for tasks and tests.                                              |
| `scripts/model_endpoint.ts`                                                           | Optional real model for the sampling test leg.                                      |
