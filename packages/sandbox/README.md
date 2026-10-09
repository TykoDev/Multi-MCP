# Coding sandbox

`mod.ts` exports the gateway client and Linux service composition interfaces. The service listens privately on
port 8080. `docker-compose.yml` runs it beside the gateway (D-151); its token comes only from `TTK_SANDBOX_TOKEN_FILE`.
That file is the operator's (`docker-compose.sandbox.yml` mounts `secrets/ttk_sandbox_token`), except for the one path
`/run/ttk-sandbox-token/token` the base compose file names: there the service creates the token on its first start (64
hex characters from `crypto.getRandomValues`, mode 0400) on a volume only it and the gateway mount, never replaces it,
and after the one read gives up its read grant on both token locations and its write grant on that folder
(`src/token.ts`). Gateway clients pass the authenticated principal by argument. Workspace ownership is persisted as a
SHA-256 principal identity in `/work/.owners`, which is never mounted into a command cage or workspace container.

## API

The internal API accepts `POST /v1/{operation}` with `{ "principal": "opaque authenticated owner", "args": {} }` and a
bearer service credential, for twelve operations:

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

Each operation rejects unknown fields. `GET /healthz` is unauthenticated and answers
`{ "ok": true|false, "backend": "bwrap"|"docker", "clone": true|false }` without diagnostic text; the gateway reports
the backend in its admin diagnostics (`sandboxBackend`, `sandboxClone`) and in `capabilities.tykotech.sandbox` for a
caller holding `sandbox:execute`, and offers `sandbox_clone` only while `clone` is `true`.

Creation provisions an empty Git repository and accepts an optional display `name` and initial text `files`. Seed files
appear in diffs against the empty initial commit. Cloning is its own operation (`clone`), off unless
`TTK_SANDBOX_GIT_HOSTS` or `TTK_SANDBOX_GIT_REMOTES_FILE` is set; it runs a fixed git command once in the workspace's
provisioning cage, public clones through the CONNECT proxy limited to the git hosts, credentialed clones through the
service-side forwarder (`src/git_forwarder.ts`, upload-pack only, TLS verified for the remote's name), whose credential
never enters a cage. A clone's `.git` is read-only afterwards, and a failed or cancelled clone is discarded. Until the
clone has finished, every operation on the workspace but `remove` answers 409 `run_busy`. The caller can write source
files and install packages through an explicitly requested `registries` network mode. A live session (D-076) is a
line-mode shell (`/bin/sh -s`, no terminal) read by long-polling `session_read`; one per workspace, four in all, closed
after 30 minutes idle or 4 hours.

## Backends

`TTK_SANDBOX_BACKEND` selects how commands run. Both answer every operation with the same limits, results and errors.

**`bwrap` (default).** Each command runs in a fresh bubblewrap user, PID, mount, network, IPC, UTS and cgroup namespace
with an empty inherited environment, no capabilities, read-only system files and Git metadata, and only its own writable
workspace, home and temporary directory. The default cage has no network. A registries cage receives only its own Unix
proxy socket.

**`docker` (opt-in, D-108).** Each workspace is a container of its own, created through the Docker Engine API over the
socket that `docker-compose.sandbox-docker.yml` mounts into this service (never the gateway), from the image
`docker/Dockerfile.sandbox-workspace` builds. Socket access is root-equivalent on the host: the service logs a warning
at every start, and rootless Docker is recommended. Every create and exec body is built from fixed values and checked
against an allowlist and a forbidden list before it is sent (`src/docker_spec.ts`): uid 1993, `Privileged: false`,
`CapDrop: ALL`, `no-new-privileges`, a read-only root with a 256 MiB `/tmp` tmpfs, `NetworkMode: none`, 1 GiB memory,
one CPU, 200 processes, and only named-volume subpath mounts (`/workspace`, `/workspace/.git` read-only,
`/home/sandbox`, `/run/harbour` read-only) — no bind, device, host namespace or published port; only the workspace and
its home are writable. Each container is named `ttk-sandbox-<deployment>-<workspace>`, where the deployment is derived
from the code volume's name, and labelled with that deployment and the hash of its create body: a container whose body
or image no longer matches is replaced before it runs again. The container runs `sleep
infinity` under Docker's init, is
started on demand, stopped after 10 minutes idle and removed with the workspace; each command is an exec into it, run in
a session of its own so a time limit kills its process group, and followed by a cleanup that kills whatever it left
running. A registries-mode exec gets the proxy's socket at `/run/harbour/proxy.sock` only while it runs. At start-up the
service checks the Engine (API 1.45 or later) and both volumes (`TTK_SANDBOX_DOCKER_VOLUME`,
`TTK_SANDBOX_DOCKER_SOCK_VOLUME`), proves with a container of its own that the configured code volume is the one it
holds at `/work` (or refuses to start), then removes this deployment's containers of workspaces that no longer exist and
stops the rest; containers of other deployments are left alone. Two deployments on one daemon must use different code
volumes: sharing one shares every workspace. Disk use is measured by the service on its own view of the volume while the
workspace's container is paused, which needs the Engine's `pause` (cgroup v2 for rootless Docker). Settings:
`TTK_SANDBOX_DOCKER_SOCKET` (default `/var/run/docker.sock`), `TTK_SANDBOX_WORKSPACE_IMAGE` (default
`tykotech-sandbox-workspace:0.2.0`, a tag or digest), `TTK_SANDBOX_DOCKER_VOLUME` (default `ttk-code`),
`TTK_SANDBOX_DOCKER_SOCK_VOLUME` (default `ttk-sandbox-sock`). The default image's grants do not include these names,
which then read as unset.

## Limits

The registry proxy permits HTTPS CONNECT to the fixed registry allowlist and dials only independently validated public
IP addresses; a clone step gets the same proxy limited to `TTK_SANDBOX_GIT_HOSTS` instead (D-131). The remotes file
(`/run/secrets/ttk_git_remotes`) is read once at start-up and its read grant revoked, as the token's is (D-132).
Registry access permits uploads as well as downloads; operator secrets are never injected into cages.

File operations and commands exclude concurrent changes to the same workspace. Removal cancels running commands before
deleting data. Symlinked path segments, absolute paths, parent traversal, Windows drive/stream names and `.git` file
operations are refused. File input/output is bounded to 256 KiB, directory listing to 1,000 entries, command output to 1
MiB, and diff patches to 8 MiB (a diff reply is cut to 9 MiB of JSON). There are at most 128 workspaces per principal
and 1,024 total. Each workspace has a 1.5 GiB disk budget and a principal's workspaces share 6 GiB. It is a measured
budget rather than a filesystem quota: du runs in a cage that can read directories a command locked (the Docker backend
measures from the service with the container paused, gives locked directories their owner's access back first, and
counts a measurement that fails as over budget). The budget is measured before and after each command, and the volume is
watched every 250 ms while a command or diff runs, so a command that writes past its budget is stopped, as is any
command when free space falls below 1 GiB. A workspace over its budget may still run commands that remove, move or
truncate files, but they cannot write file data. A command can overshoot by what it writes between two checks, and a
workspace past twice its budget (or a budget past its share of the 6 GiB) cannot run anything until it is removed.
Leftovers from a crash (a checkout or state with no owner record) are swept hourly.

## Provenance and tests

The cage, registry proxy, request validators, scheduler, diff collector, seccomp filter and output collector are adapted
from `SPECS/sandbox`. The original donor remains unchanged. The Docker base seccomp profile is vendored from the exact
commit in `docker/seccomp-sandbox-source.json`; regenerate the derived profile with `scripts/sandbox_seccomp.ts`.
Adaptation and separate permission matrices are recorded in D-064 and D-066; the Docker backend in D-108; clones in
D-131 and D-132.

Package unit tests run on Windows and Linux; the Docker backend's run against a fake Engine API
(`src/testing_engine.ts`). `deno task test:sandbox` builds the Linux image (`--image <tag>` names another tag),
exercises real cage isolation and cancellation under the production seccomp/container posture, then probes authenticated
workspace lifecycle through a disposable host-loopback-only test port.
