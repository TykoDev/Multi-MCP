# Design: one-command stack, consolidated secrets, a cleaner task table

Status: implemented on branch `dev`. Scope: `deno.json` tasks, `deno task setup` / `doctor`, `secrets/`, the Compose
files, and the docs that describe them. No tool, route, wire message or `TTK_*` name changes meaning; new variables and
files are additions.

## Goals

1. `deno task setup && docker compose up -d --build` starts a **fully configured** stack on Linux, macOS and Windows,
   with no manual permission step: gateway with the browser, the coding sandbox, A2A, A2UI, the coding agent (SlopLord)
   and a working **A2A peer**, all reachable with the key `setup` prints.
2. Every secret and config file any shipped Compose file mounts is created by **one** command, described in **one**
   place (`secrets/README.md`).
3. A task table that lists itself (`deno task` prints a description per task), with no duplicates, one matrix per test
   tier, and a `deno task ok` that passes on a fresh checkout.

## Defects found

| #   | Where                                  | Defect                                                                                                                                                                                                                                                                                            | Effect                                                                                                                                          |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `setup` + `docker-compose.yml`         | `setup` writes secrets `0600`. Compose file secrets are bind mounts that keep the host owner and mode; the long-syntax `uid`/`gid`/`mode` are ignored for file secrets (measured with Compose v5.6). The containers run as uid 1993.                                                              | On Linux (and WSL, rootless Docker) the gateway cannot read its own keys and restarts forever until the operator finds the manual `sudo chgrp`. |
| D2  | `packages/gateway/src/gateway_test.ts` | The B6.3 test fetches `/assets/app.css`, which exists only after `deno task build:web`; `ok` and CI's `check` job do not build the web app.                                                                                                                                                       | `deno task ok` fails on every fresh checkout.                                                                                                   |
| D3  | `setup`                                | The `client` key and the admin get the default grant (`mcp:invoke`, `view:*`, `files:read`), which lacks `sandbox:execute`, `agent:invoke`, `a2ui:publish`, `model:invoke`, `files:write`.                                                                                                        | The sandbox, agent, A2UI and memory tools are withheld from the credentials the quick start hands out.                                          |
| D4  | Overlays                               | `docker-compose.sandbox.yml` and `docker-compose.agents.yml` mount files (`ttk_sandbox_token`, `ttk_agent_bridge_token`, `ttk_agent_commands.json`) that nothing creates; the commands to make them are spread over compose comments, `secrets/README.md` and `docs/guides/coding-and-agents.md`. | `docker compose -f … up` refuses with "secret file not found"; the operator has to hunt for a `deno eval` one-liner.                            |
| D5  | `docker-compose.yml`                   | Browser secrets, git remotes and model providers are opt-ins that each need three separate lines uncommented (variable, service `secrets:`, top-level `secrets:`); a missed line is a refused start.                                                                                              | Easy to half-enable; the structure is hard to read.                                                                                             |
| D6  | Stack                                  | No A2A peer is configured anywhere (no peers file, no peer service), so `agent_delegate` has nothing to talk to.                                                                                                                                                                                  | The A2A peer path cannot be exercised out of the box.                                                                                           |
| D7  | `.env` / `.env.example`                | `setup` writes a two-line `.env` from its own template; `.env.example` is a different, longer file. Settings in compose (`TTK_ALLOWED_DOMAINS`) are not reachable from `.env` at all.                                                                                                             | Two sources of truth for the same settings; some settings need a compose edit.                                                                  |
| D8  | `deno.json`                            | `cov:unit`, `cov:browser` and `cov:agents` restate `test:unit`, `test:browser` and `test:agents` with drifted grants; `admin:generate` duplicates `doctor --new-admin admin`; no task has a description, so `deno task` prints a wall of flags.                                                   | Drift between a tier and its coverage run (D13); an unreadable task list.                                                                       |
| D9  | `docker/Dockerfile.agent-runner`       | The only image whose Deno base is a literal `FROM`, not `ARG DENO_IMAGE` like the other three.                                                                                                                                                                                                    | The base cannot be overridden the same way as every other image (mirrors, air-gapped builds).                                                   |
| D10 | `doctor --new-key`                     | Prints a record the operator must paste into `secrets/ttk_api_keys.json` by hand.                                                                                                                                                                                                                 | Hand-edited JSON; one more scattered instruction.                                                                                               |
| D11 | `docker/seccomp-chromium.json`         | The profile allows `inotify_init` but not `inotify_init1`, which the runtime calls; found while verifying `doctor --new-key --save` against the running stack.                                                                                                                                    | The gateway logs `cannot watch the API key file`; a key added to the file is ignored until a restart, contrary to the docs.                     |
| D12 | `tests/agents/verify_compose.ts`       | The fixture never replaces the base file's `ttk_db_key` (added by D-154 after the proof was written), so the proof's own isolation check refuses it.                                                                                                                                              | `deno task test:agents:compose` cannot pass.                                                                                                    |
| D13 | `cov:unit`                             | Its path-scoped `--allow-read=.`/`--allow-write=tests/.scratch` (the drift of D8) make Deno 2.9's `Deno.symlink` refuse, so two sandbox unit tests fail under it; `test:unit`'s bare grants are what they need.                                                                                   | `deno task cov` cannot pass.                                                                                                                    |

## Design

### 1. Secrets: one generator, one layout, readable by the containers

`deno task setup` creates, when missing, every file a shipped Compose file mounts, and prints the generated passwords
and keys once:

| File                       | Kind        | Used by                                      |
| -------------------------- | ----------- | -------------------------------------------- |
| `ttk_db_key`               | generated   | gateway (seals `ttk.db`)                     |
| `ttk_admin_user.json`      | generated   | gateway (first administrator)                |
| `ttk_api_keys.json`        | generated   | gateway (`client` key, the stack scopes)     |
| `ttk_agent_peers.json`     | generated   | gateway (A2A peer list: the bundled peer)    |
| `ttk_peer_token`           | generated   | gateway (bearer it presents to the peer)     |
| `ttk_peer_api_keys.json`   | generated   | `a2a-peer` (the hash of `ttk_peer_token`)    |
| `ttk_secrets.json`         | placeholder | gateway (browser-typed secrets, `{}`)        |
| `ttk_git_remotes`          | placeholder | sandbox (credentialed git remotes, `[]`)     |
| `ttk_sandbox_token`        | generated   | `docker-compose.sandbox.yml`                 |
| `ttk_agent_bridge_token`   | generated   | `docker-compose.agents.yml`                  |
| `ttk_agent_commands.json`  | template    | `docker-compose.agents.yml`                  |
| `ttk_model_providers.json` | yours       | `docker-compose.providers.yml` (optional)    |
| `.env` (repository root)   | template    | Compose interpolation; equals `.env.example` |

- **Permissions (D1).** `secrets/` is made `0700` and every file in it `0644`. Confidentiality on the host comes from
  the directory: no other account can open anything inside it, whatever a file's own mode. Inside a container the bind
  mount is the file alone, so `0644` is what lets uid 1993 (the bundled images), uid 1000 (slim), rootless Docker and
  Docker Desktop read it without `sudo`. Exposure inside the containers is unchanged: every process there already ran as
  the uid the old `chgrp 1993` + `0440` granted. `setup` also repairs the modes of files it keeps, so an existing
  checkout is fixed by re-running it. Windows has no POSIX modes; nothing changes there.
- **Placeholders (D5).** An empty browser-secrets document is "no source" to the seeder, and an empty remotes list
  configures no remote, so both are mounted by default; filling the file is the whole opt-in. Model providers cannot be
  a placeholder (the file needs at least one provider and an empty seed would mark the database seeded), so the file
  opt-in becomes the overlay `docker-compose.providers.yml`; the web app stays the recommended way.
- **Rotation.** `--only <names>` limits `setup` to some files (`db-key`, `admin`, `api-key`, `peer`, `browser-secrets`,
  `git-remotes`, `sandbox-token`, `agent-token`, `agent-commands`, `env`); with `--force` it replaces exactly those. The
  peer token and its hashed record are one unit and are always written together.
- **More keys (D10).** `doctor --new-key <id> --scopes <list> --save` appends (or replaces, by id) the record in
  `secrets/ttk_api_keys.json`; the gateway already reloads that file without a restart.
- **Stack scopes (D3).** The `client` key gets
  `mcp:invoke, view:watch, view:control, files:read, files:write,
  sandbox:execute, agent:invoke, model:invoke, a2ui:publish`;
  the administrator gets the same plus `admin`. `task`, `evaluate`, `metrics:read` and `network:read` stay explicit
  grants nobody receives by default. `DEFAULT_SCOPES` (what a key with no `scopes` gets) is unchanged. `--scopes` still
  overrides the key's set.

### 2. Compose: a complete default stack, overlays for real alternatives

```mermaid
flowchart LR
  U[Clients, people] -- "${TTK_BIND}:8787" --> G
  subgraph default network
    G[tykotech-mcp<br/>gateway + Chromium]
    P[a2a-peer<br/>gateway + Chromium<br/>no published port]
  end
  G -- "A2A 1.0, bearer ttk_peer_token" --> P
  G -- sandbox-private<br/>internal --> S[sandbox<br/>bubblewrap cages]
  S -- sandbox-egress --> R[(registries, git hosts)]
```

`docker-compose.yml` runs three services:

- **`tykotech-mcp`**, unchanged in shape (the image's `CMD` stays the permission matrix, no `command:`), now also
  mounting `ttk_secrets`, `ttk_agent_peers` and `ttk_peer_token`, with `TTK_SECRETS_FILE`, `TTK_AGENT_PEERS_FILE` and
  `TTK_ALLOWED_DOMAINS` (from `.env`) set.
- **`sandbox`**, unchanged hardening; its generated bearer still lives in the `ttk-sandbox-token` volume (D-151); now
  also mounting the `ttk_git_remotes` placeholder.
- **`a2a-peer`** (new): a second gateway from the same image (no second build), with its own data volume, its own API
  key file, `TTK_PUBLIC_URL=http://a2a-peer:8787` (the A2A client requires the peer's card to name the origin it was
  dialled on), no published port, Chromium sandbox settings as the gateway's. The gateway does not `depends_on` it: a
  peer that is down fails only `agent_delegate`, never the gateway's start. `docker compose up -d tykotech-mcp sandbox`
  runs without it.

Overlays, each self-contained and needing nothing but `setup`:

| Overlay                             | Adds                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `docker-compose.sandbox.yml`        | An operator-held sandbox token (`secrets/ttk_sandbox_token`) instead of the generated one. |
| `docker-compose.sandbox-docker.yml` | One Docker container per workspace instead of a cage.                                      |
| `docker-compose.agents.yml`         | The ACP agent runner (needs your agent in a derived image).                                |
| `docker-compose.providers.yml`      | Seed model providers from `secrets/ttk_model_providers.json`.                              |

`.env` (D7) is written from one template, byte-identical to `.env.example` (a unit test holds the two equal), and every
host-specific value the compose files read is in it: bind, public URL, allowlists, navigation allowlist, memory sizes,
overlay settings.

### 3. Task table

- Object form with a `description` for every task, so `deno task` is the index; grouped run → build → quality → tests →
  grant helpers.
- `cov:unit`, `cov:browser`, `cov:agents` become `deno task test:<tier> --coverage=coverage/<tier>`: one matrix per
  tier, no drift (D8).
- `test:unit` keeps its bare `--allow-read --allow-write`: Deno 2.9's `Deno.symlink` refuses path-scoped grants, and two
  sandbox unit tests make links (D13). Narrowing it would need those tests moved to their own tier.
- `admin:generate` is removed: `setup` creates the administrator; `doctor --new-admin <user> --force` replaces one.
- The server tasks (`dev`, `stdio`, `serve:cluster`) keep their computed matrices: they are what the task gate
  (`scripts/check_tasks.ts`) and `tests/unit/serve_tasks_test.ts` verify statically, and a launcher that computed flags
  at run time would hide them from that gate.

### 4. Smaller fixes

- D11: `inotify_init1` joins the Chromium profile's allow list (Docker's default profile allows it; it is `inotify_init`
  with flags).
- D12: the agents proof brings its own database key; both proofs bring the stack's new files (`writeStackFiles` in
  `tests/support/compose_proof.ts`) and pin the peer to the tree's gateway image.

- D2: the B6.3 test checks a hand-written asset that is always present, and the bundle's stylesheet only when it was
  built.
- D9: `docker/Dockerfile.agent-runner` takes `ARG DENO_IMAGE` like the other images (same digest; the image test
  substitutes `ARG` defaults).

## Security review

- No CORS, no CDP port, no unauthenticated non-loopback bind: the peer binds `0.0.0.0` inside the network with an API
  key file, and publishes no port.
- Secrets stay files threaded by path; none enters the environment. The peer token is read by the gateway through the
  existing `token_file` reference. Provider keys stay out of compose and tasks (T6 unchanged).
- The peer's key holds `mcp:invoke` and `agent:invoke` only; the gateway can only reach it through the operator-fixed
  peer list.
- The new file modes are argued in §1; the `0700` directory is applied on every `setup` run.
- No permission matrix changes: the gateway's and sandbox's `CMD`s already grant `/run/secrets` and
  `/run/secrets/ttk_git_remotes`.

## Verification

Run in a Linux container with Docker 29.9 and Compose v5.6. Its egress policy blocks the Debian mirrors, so the images
were built through a local shim (outside the repository) that supplies the Dockerfiles' `DENO_IMAGE`/`RUNTIME_IMAGE`
with an Ubuntu 24.04 stand-in carrying Deno 2.9.7 and a packaged Chromium; the Dockerfiles, compose files and secrets
under test were the repository's.

| Check                                                                      | Result                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `deno task ok` (was: 1 failing test on a fresh checkout)                   | passes                                                                                                  |
| `deno task setup` on a fresh copy; again; `--only peer --force`            | 11 files + `.env`, `secrets/` 0700, files 0644; kept and repaired; the pair rotated alone (unit tested) |
| `docker compose config` for every overlay combination                      | resolves with only `setup`'s files                                                                      |
| Original `setup` + original compose (D1)                                   | gateway `Restarting (1)`: `TTK_API_KEYS_FILE (/run/secrets/ttk_api_keys): Permission denied`            |
| New `setup` + `docker compose up -d --wait`                                | `tykotech-mcp`, `sandbox`, `a2a-peer` healthy on the first start                                        |
| `client` key: tools                                                        | 98 (default grant 65, every scope 101)                                                                  |
| Browser navigate + state; sandbox create/exec (`42`); A2UI surface; memory | pass                                                                                                    |
| A2A card, `SendMessage` tool task; SlopLord card                           | pass                                                                                                    |
| `agent_delegate` to `peer` with a `browser_get_state` tool task            | `TASK_STATE_COMPLETED`; the peer started a browser session                                              |
| `admin` sign-in with the printed password                                  | session token, stack scopes plus `admin`                                                                |
| `doctor --new-key --save` while running (after D11)                        | same inode; `API key records reloaded`; the new key lists 65 tools                                      |
| `ttk doctor` in the gateway container                                      | sandbox, peer, keys, data dir, browser all reported                                                     |
| `deno task test:compose --tag verify`                                      | PASS (sandbox, scoped MCP, Chromium, sealed DB, `ttk seed`, built-in agent, SlopLord over A2A)          |
| `deno task test:agents:compose --tag verify`                               | passes its isolation and config checks (D12); stops at the runner image's Debian `apt-get` here         |
