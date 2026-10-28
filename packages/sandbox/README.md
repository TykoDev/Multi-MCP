# Coding sandbox

The private service behind the `sandbox_*` tools. `mod.ts` exports the gateway's client (`SandboxClient`), the Linux
service composition, and the seccomp profile builder `scripts/sandbox_seccomp.ts` uses. The service listens on port 8080
with no published port; `docker-compose.yml` runs it beside the gateway, reachable only on an internal network.

## Token

The service and the gateway share one bearer, read only from the file `TTK_SANDBOX_TOKEN_FILE` names (at least 32
non-whitespace characters).

- **Compose** names `/run/ttk-sandbox-token/token`, on the `ttk-sandbox-token` volume only the sandbox (read-write) and
  the gateway (read-only) mount. That one path is created by the service on its first start (64 hex characters from
  `crypto.getRandomValues`, mode 0400, uid 1993) and never replaced. Rotate it:
  `docker compose down && docker volume rm <project>_ttk-sandbox-token && docker compose up -d`.
- **Outside Compose** the image's default is `/run/secrets/ttk_sandbox_token`: mount a token of your own there, and give
  the gateway the same file in its `TTK_SANDBOX_TOKEN_FILE`. Any path other than the Compose one must exist, or the
  service refuses to start.

After the one read the service gives up its read grant on both token locations and its write grant on the token's folder
(`src/token.ts`).

## API

The internal API accepts `POST /v1/{operation}` with `{ "principal": "opaque authenticated owner", "args": {} }` and the
bearer, for twelve operations. The gateway passes the authenticated principal; ownership is kept as its SHA-256 in
`/work/.owners`, which no command cage or workspace container ever mounts.

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

Unknown fields are refused with 400 `invalid_request`. `GET /healthz` is unauthenticated and answers
`{ "ok": true|false, "backend": "bwrap"|"docker", "clone": true|false }` without diagnostic text. The gateway reports
the backend in its admin diagnostics (`sandboxBackend`, `sandboxClone`) and in `capabilities.tykotech.sandbox` for a
caller holding `sandbox:execute`, and offers `sandbox_clone` only while `clone` is `true`.

- **Create** makes an empty Git repository with an optional display `name` and initial text `files`; seed files appear
  in diffs against the empty initial commit.
- **Clone** is off unless `TTK_SANDBOX_GIT_HOSTS` or `TTK_SANDBOX_GIT_REMOTES_FILE` is set; `docker-compose.yml` sets
  both (GitHub, GitLab, Bitbucket and Codeberg, and `secrets/ttk_git_remotes`). A fixed git command runs once in the
  workspace's provisioning cage: public clones through the CONNECT proxy limited to the git hosts, credentialed clones
  through the service-side forwarder (`src/git_forwarder.ts`, upload-pack only, TLS verified for the remote's name),
  whose credential never enters a cage. The clone's `.git` is read-only afterwards and a failed or cancelled clone is
  discarded. Until it has finished, every operation on the workspace but `remove` answers 409 `run_busy`.
- **Network** is off in a command unless it asks for `registries`, which allows package registries only (see Limits).
- **Live sessions** are line-mode shells (`/bin/sh -s`, no terminal) read by long-polling `session_read`: one per
  workspace, four in all, closed after 30 minutes idle or 4 hours.

## Backends

`TTK_SANDBOX_BACKEND` selects how commands run. Both answer every operation with the same API, limits and errors, with
the exceptions listed under Docker.

**`bwrap` (default).** Each command runs in a fresh bubblewrap user, PID, mount, network, IPC, UTS and cgroup namespace
with an empty inherited environment, no capabilities, read-only system files and Git metadata, and only its own writable
workspace, home and temporary directory. The default cage has no network; a registries cage receives only its own Unix
proxy socket. The container needs the seccomp and AppArmor profiles `docker-compose.yml` names
([Docker reference](../../docs/reference/docker-reference.md#coding-sandbox)).

**`docker` (opt-in).** `docker-compose.sandbox-docker.yml` mounts the Docker socket into this service (never the
gateway) and runs each workspace as a container of its own, from the image `docker/Dockerfile.sandbox-workspace` builds.
For hosts that forbid unprivileged user namespaces. **Socket access is root-equivalent on the host:** the service logs a
warning at every start, and rootless Docker is recommended.

- Every create and exec body is built from fixed values and checked against an allowlist and a forbidden list before it
  is sent (`src/docker_spec.ts`): uid 1993, `Privileged: false`, `CapDrop: ALL`, `no-new-privileges`, a read-only root
  with a 256 MiB `/tmp` tmpfs, `NetworkMode: none`, 1 GiB memory, one CPU, 200 processes, and only named-volume subpath
  mounts (`/workspace`, `/workspace/.git` read-only, `/home/sandbox`, `/run/harbour` read-only). No bind, device, host
  namespace or published port.
- A container is named `ttk-sandbox-<deployment>-<workspace>` (the deployment derives from the code volume's name) and
  labelled `eu.tykotech.sandbox=1`. It runs `sleep infinity` under Docker's init, is started on demand, stopped after 10
  minutes idle and removed with its workspace. Each command is an exec in a session of its own, so a time limit kills
  its process group, followed by a cleanup that kills whatever it left running.
- At start-up the service checks the Engine (API 1.45 or later) and both volumes, proves the configured code volume is
  the one it holds at `/work` (or refuses to start), removes this deployment's containers of workspaces that no longer
  exist and stops the rest. Two deployments on one daemon need different code volumes: sharing one shares every
  workspace.
- Compose does not create these containers, so `docker compose down` leaves them; remove them with
  `docker rm -f $(docker ps -aq --filter label=eu.tykotech.sandbox=1)` before `down -v`, or the volumes stay in use.
- Differences from `bwrap`: one registries-mode command per workspace at a time (another answers 409 `run_busy`); `/tmp`
  is shared by the workspace's commands, kept between them and outside the disk budget; disk use is measured by the
  service with the container paused, which needs the Engine's `pause` (cgroup v2 under rootless Docker).
- Settings: `TTK_SANDBOX_DOCKER_SOCKET` (default `/var/run/docker.sock`), `TTK_SANDBOX_WORKSPACE_IMAGE` (default
  `tykotech-sandbox-workspace:0.2.0`, a tag or digest), `TTK_SANDBOX_DOCKER_VOLUME` (default `ttk-code`),
  `TTK_SANDBOX_DOCKER_SOCK_VOLUME` (default `ttk-sandbox-sock`); the overlay also reads `TTK_SANDBOX_DOCKER_GID`, the
  socket's group, from `.env`. The default image does not grant these names, so without the overlay they read as unset
  and the backend stays `bwrap`.

## Limits

- **Network.** The registry proxy permits HTTPS CONNECT to a fixed registry allowlist (npm, JSR/Deno, PyPI, crates.io,
  the Go proxy) and dials only validated public addresses; a clone gets the same proxy limited to the git hosts. It
  permits uploads as well as downloads. Operator secrets are never injected into cages; the remotes file is read once at
  start and its read grant revoked, as the token's is.
- **Paths.** Absolute paths, parent traversal, symlinked segments, Windows drive or stream names and `.git` file
  operations are refused. Operations on one workspace exclude each other; removal cancels running commands first.
- **Sizes.** File input and output 256 KiB, directory listings 1,000 entries, command output 1 MiB, diff patches 8 MiB
  (a diff reply is cut to 9 MiB of JSON).
- **Counts.** 128 workspaces per principal, 1,024 in all.
- **Disk.** 1.5 GiB per workspace and 6 GiB per principal, a measured budget rather than a filesystem quota: checked
  before and after each command and every 250 ms while a command or diff runs, so a command that writes past it is
  stopped, as is any command when free space falls below 1 GiB. A command can overshoot by what it writes between two
  checks. Over budget, a workspace can still remove, move or truncate files but not write data; past twice its budget
  (or a budget past its share of the 6 GiB) it cannot run anything until it is removed.
- Leftovers from a crash (a checkout or state with no owner record) are swept at start and hourly.

## Seccomp

The cage's seccomp profile, `docker/seccomp-sandbox.json`, is Docker's default profile (vendored from the commit
`docker/seccomp-sandbox-source.json` names) plus the calls bubblewrap needs. Regenerate it with
`deno run --allow-read=docker --allow-write=docker scripts/sandbox_seccomp.ts`.

## Tests

- `deno task test:unit`: the package's unit tests (Linux, macOS, Windows), the Docker backend against a fake Engine API
  (`src/testing_engine.ts`).
- `deno task test:sandbox`: builds `docker/Dockerfile.sandbox` (`--image <tag>` names the tag; default
  `tykotech-sandbox:0.2.0`), runs the cage, proxy, budget, session, clone and cancellation tests inside it under the
  production posture, then probes the service's workspace lifecycle on a host-loopback port with a token file.
- `deno task test:compose --tag <t>`: the default stack from images built under `<t>`, with the generated token and the
  sandbox driven through the gateway's tools.
- `tests/sandbox/verify_docker_backend.ts`: the Docker backend on a real Engine, with throwaway volumes (no task; the
  command is in the file's header).
