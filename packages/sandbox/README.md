# Coding sandbox

The private service behind the `sandbox_*` tools. `mod.ts` exports the gateway's client (`SandboxClient`), the Linux
service, and the seccomp profile builder `scripts/sandbox_seccomp.ts` uses. It listens on port 8080 with no published
port; `docker-compose.yml` runs it beside the gateway on an internal network.

## Token

The service and the gateway share one bearer, read only from the file `TTK_SANDBOX_TOKEN_FILE` names (a regular file, no
link, at most 4096 bytes, at least 32 non-whitespace characters). `deno task setup` writes it as
`secrets/ttk_sandbox_token`; Compose mounts it read-only into both services at `/run/secrets/ttk_sandbox_token`. A
missing file refuses the start; after the one read the service gives up its read grant. While the gateway cannot reach
the service, its health probe withholds the `sandbox_*` tools.

Rotate it with `deno task setup --only sandbox-token --force`, then
`docker compose up -d --force-recreate tykotech-mcp sandbox`.

## API

`POST /v1/{operation}` with `{ "principal": "...", "args": {} }` and the bearer. Ownership is kept as the principal's
SHA-256 in `/work/.owners`, which no cage or workspace container mounts. Unknown fields are refused with 400
`invalid_request`.

| Operation       | Arguments                                                                      |
| --------------- | ------------------------------------------------------------------------------ |
| `create`        | `name?`, `files?` (up to 64 text files, 256 KiB in all)                        |
| `clone`         | `url` or `remote`, `ref?`, `depth?`, `name?`, `timeout_ms?`                    |
| `list`          | none (the caller's workspaces), or `workspace_id` and `path?` (a directory)    |
| `read`          | `workspace_id`, `path`                                                         |
| `write`         | `workspace_id`, `path`, `content`                                              |
| `exec`          | `workspace_id`, `command`, `cwd?`, `timeout_ms?`, `network?`, `env?`, `stdin?` |
| `diff`          | `workspace_id`                                                                 |
| `remove`        | `workspace_id`                                                                 |
| `session_open`  | `workspace_id`, `network?`                                                     |
| `session_input` | `session_id`, `data`                                                           |
| `session_read`  | `session_id`, `after?`, `wait_ms?`                                             |
| `session_close` | `session_id`                                                                   |

`GET /healthz` is unauthenticated and answers `{ "ok", "backend": "bwrap"|"docker", "clone" }` without diagnostics; the
gateway offers `sandbox_clone` only while `clone` is `true`.

- **Clone** is off unless `TTK_SANDBOX_GIT_HOSTS` or `TTK_SANDBOX_GIT_REMOTES_FILE` is set (`docker-compose.yml` sets
  both). Public clones go through the CONNECT proxy limited to the git hosts; credentialed clones through the
  service-side forwarder (upload-pack only, TLS verified), whose credential never enters a cage. `.git` is read-only
  afterwards; a failed clone is discarded; until it finishes every operation but `remove` answers 409 `run_busy`.
- **Network** is off in a command unless it asks for `registries`.
- **Live sessions** are line-mode shells read by long-polling `session_read`: one per workspace, two per owner, four in
  all, closed after 30 minutes idle or 4 hours. While one is open, file operations on its workspace run inside a cage.

## Backends

`TTK_SANDBOX_BACKEND` selects how commands run; both answer the same API with the same limits and errors.

**`bwrap` (default).** Each command runs in fresh namespaces with an empty environment, no capabilities, read-only
system files and `.git`, and only its own workspace, home and `/tmp`; no network but, in registries mode, its proxy
socket. The container needs the seccomp and AppArmor profiles `docker-compose.yml` names.

**`docker` (opt-in).** `docker-compose.sandbox-docker.yml` mounts the Docker socket into this service (never the
gateway) and runs each workspace as its own container from `docker/Dockerfile.sandbox-workspace`, for hosts that forbid
unprivileged user namespaces. **Socket access is root-equivalent on the host:** the service warns at every start; prefer
rootless Docker.

- Every create and exec body is built from fixed values and checked against an allowlist before it is sent: uid 1993, no
  privileges or capabilities, `no-new-privileges`, read-only root, 256 MiB `/tmp`, `NetworkMode: none`, 1 GiB, one CPU,
  200 processes, named-volume subpath mounts only.
- Containers are named `ttk-sandbox-<deployment>-<workspace>` and labelled `eu.tykotech.sandbox=1`, started on demand,
  stopped after 10 minutes idle, removed with their workspace. At start-up the service checks the Engine (API 1.45+) and
  both volumes, proves the code volume is the one it holds at `/work`, and reconciles leftover containers. Two
  deployments on one daemon need different code volumes.
- `docker compose down` leaves these containers; remove them with
  `docker rm -f $(docker ps -aq --filter label=eu.tykotech.sandbox=1)` before `down -v`.
- Differences: one registries-mode command per workspace at a time; `/tmp` is shared between a workspace's commands and
  outside the disk budget; disk is measured with the container paused (needs `pause`, cgroup v2 under rootless).
- Settings: `TTK_SANDBOX_DOCKER_SOCKET` (`/var/run/docker.sock`), `TTK_SANDBOX_WORKSPACE_IMAGE`
  (`tykotech-sandbox-workspace:0.2.0`, a tag or digest), `TTK_SANDBOX_DOCKER_VOLUME` (`ttk-code`),
  `TTK_SANDBOX_DOCKER_SOCK_VOLUME` (`ttk-sandbox-sock`); the overlay also reads `TTK_SANDBOX_DOCKER_GID` from `.env`.

## Limits

- **Network.** HTTPS CONNECT to a fixed registry allowlist (npm, JSR/Deno, PyPI, crates.io, the Go proxy), dialling only
  validated public addresses; the tunnel's TLS ClientHello must name the `CONNECT` host as SNI, or it is closed. Uploads
  are possible too, so nothing secret belongs in a checkout.
- **Paths.** Absolute paths, `..`, symlinked segments, Windows drive or stream names and `.git` are refused.
- **Sizes.** File I/O 256 KiB, listings 1,000 entries, command output 1 MiB, diff patches 8 MiB.
- **Counts.** 128 workspaces per principal, 1,024 in all.
- **Fair share.** Two commands at once with eight waiting, up to two minutes; one slot per owner with four more of its
  own waiting; past that 429 `busy` with `retry-after`.
- **Disk.** 1.5 GiB per workspace and 6 GiB per principal, measured before and after each command and every 250 ms while
  one runs; any command stops when free space falls below 1 GiB. Over budget a workspace may only remove, move or
  truncate files; past twice its budget nothing runs until it is removed.
- Leftovers from a crash are swept at start and hourly.

## Seccomp

`docker/seccomp-sandbox.json` is Docker's default profile (vendored at the commit `docker/seccomp-sandbox-source.json`
names) plus the calls bubblewrap needs. Regenerate it with
`deno run --allow-read=docker --allow-write=docker scripts/sandbox_seccomp.ts`.

## Tests

- `deno task test:unit`: the package's unit tests, the Docker backend against a fake Engine (`src/testing_engine.ts`).
- `deno task test:sandbox`: builds `docker/Dockerfile.sandbox` and runs the cage, proxy, budget, session, clone and
  cancellation tests inside it under the production posture.
- `deno task test:compose --tag <t>`: the default stack, with the sandbox driven through the gateway's tools.
- `tests/sandbox/verify_docker_backend.ts`: the Docker backend on a real Engine (the command is in its header).
