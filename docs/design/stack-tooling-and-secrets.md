# Design: the stack, setup and secrets

How `deno task setup`, `secrets/`, the Compose files, `.env` and the `deno.json` task table fit together, and why they
are shaped this way. The operator's walkthrough is [QUICK-START.md](../../QUICK-START.md); every file and option is in
[secrets/README.md](../../secrets/README.md).

## Goals

1. `deno task setup && docker compose up -d --build` starts a **fully configured** stack with no manual permission step:
   the gateway with the browser, the coding sandbox, A2A, A2UI, the coding agent (SlopLord) and a working **A2A peer**,
   all reachable with the key `setup` prints.
2. Every secret and config file any shipped Compose file mounts is created by **one** command and described in **one**
   place (`secrets/README.md`).
3. The task table lists itself (`deno task` prints a description per task), has one permission matrix per test tier, and
   `deno task ok` passes on a fresh checkout.

## Secrets

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
| `ttk_agent_bridge_token`   | generated   | `docker-compose.agents.yml`                  |
| `ttk_agent_commands.json`  | template    | `docker-compose.agents.yml`                  |
| `ttk_model_providers.json` | yours       | `docker-compose.providers.yml` (optional)    |
| `.env` (repository root)   | template    | Compose interpolation; equals `.env.example` |

- **Permissions.** `secrets/` is `0700` and every file in it `0644`, applied on every run. Compose file secrets are bind
  mounts that keep the host's owner and mode (Compose ignores `uid`, `gid` and `mode` for file secrets), and the
  containers run as uid 1993 (bundled images) or 1000 (slim). Confidentiality on the host comes from the directory: no
  other account can open anything inside it, whatever a file's own mode. Inside a container the mount is the file alone,
  and `0644` lets the service's uid read it, with rootless Docker and Docker Desktop too, without `sudo`. Every process
  in those containers runs as that uid. `setup` also repairs the modes of files it keeps. Windows has no POSIX modes.
- **Placeholders.** An empty browser-secrets document is "no source" to the seeder, and an empty remotes list configures
  no remote, so both files are mounted by default and filling one in is the whole opt-in. Model providers cannot be a
  placeholder (the file needs at least one provider, and an empty seed would mark the database seeded), so the file
  opt-in is the overlay `docker-compose.providers.yml`; the web app is the recommended way.
- **Units.** `--only <names>` limits `setup` to some files (`db-key`, `admin`, `api-key`, `peer`, `browser-secrets`,
  `git-remotes`, `agent-token`, `agent-commands`, `env`, `apparmor`); with `--force` it replaces exactly those. Files
  you fill in yourself are replaced only when `--only` names them. The peer token and its hashed record are one unit,
  always written together.
- **The sandbox token is not a file.** The sandbox service generates it on its first start into the `ttk-sandbox-token`
  volume, which only the sandbox (read-write) and the gateway (read-only) mount.
- **AppArmor.** The `apparmor` unit installs the coding sandbox's profile (`docker/apparmor-sandbox`) at
  `/etc/apparmor.d/tykotech-sandbox` through `sudo`, last, after the credentials are on screen, and only when AppArmor's
  tools report it enabled and the installed copy differs or is not loaded. When `sudo` fails it exits 1 with the two
  commands to run by hand. On a host without AppArmor or its tools it does nothing, and Docker applies no profile.
- **More keys.** `doctor --new-key <id> --scopes <list> --save` adds (or replaces, by id) the record in
  `secrets/ttk_api_keys.json`; the gateway watches that file and admits the key without a restart.
- **Scopes.** The `client` key holds the stack scopes, `STACK_SCOPES` in `packages/mcp/src/scopes.ts`:
  `mcp:invoke, view:watch, view:control, files:read, files:write, sandbox:execute, agent:invoke, model:invoke, a2ui:publish`.
  The administrator holds the same plus `admin`, the peer's key `mcp:invoke` and `agent:invoke` only. `task`,
  `evaluate`, `metrics:read` and `network:read` are explicit grants nobody receives by default. `--scopes` overrides the
  key's set; a key made without scopes gets `DEFAULT_SCOPES`.

## Compose

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

- **`tykotech-mcp`**: the image's `CMD` is the permission matrix, and no Compose file restates it with `command:`. It
  mounts the keys, administrator, database key, browser secrets, peer list and peer token, sets `TTK_SECRETS_FILE`,
  `TTK_AGENT_PEERS_FILE` and `TTK_ALLOWED_DOMAINS` (from `.env`), and waits for a healthy sandbox.
- **`sandbox`**: no published port, read-only root, all capabilities dropped, `no-new-privileges`, its own seccomp and
  AppArmor profiles, the generated token on its volume, the `ttk_git_remotes` placeholder, and public clones from
  GitHub, GitLab, Bitbucket and Codeberg.
- **`a2a-peer`**: a second gateway from the same image (no second build), with its own data volume and API key file,
  `TTK_PUBLIC_URL=http://a2a-peer:8787` (the A2A client requires the peer's card to name the origin it was dialled on),
  no published port, and the gateway's Chromium sandbox settings. The gateway does not `depends_on` it: a peer that is
  down fails only `agent_delegate`, never the gateway's start, and `docker compose up -d tykotech-mcp sandbox` runs
  without it.

Overlays, each needing nothing beyond `setup` and combinable in any order:

| Overlay                             | Adds                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `docker-compose.sandbox-docker.yml` | One Docker container per workspace instead of a cage (mounts the Engine socket). |
| `docker-compose.agents.yml`         | The ACP agent runner (needs your agent in an image derived from its base).       |
| `docker-compose.providers.yml`      | Model providers seeded from `secrets/ttk_model_providers.json`.                  |

`.env` is written from one template, byte-identical to `.env.example`, and holds every host-specific value the compose
files read: bind address, public URL, allowlists, navigation allowlist, memory sizes, and the overlays' settings.

## Task table

- Every task has a `description`, so `deno task` is the index; they are grouped run → build → quality → tests → grant
  helpers.
- `cov:unit`, `cov:agents` and `cov:browser` run `deno task test:<tier> --coverage=coverage/<tier>`: one matrix per
  tier, so a coverage run cannot drift from its tier.
- `test:unit` keeps bare `--allow-read --allow-write`: Deno 2.9's `Deno.symlink` refuses path-scoped grants, and two
  sandbox unit tests make links.
- The server tasks (`dev`, `stdio`, `serve:cluster`) compute their matrices in the task line, where the task gate
  (`scripts/check_tasks.ts`) and `tests/unit/serve_tasks_test.ts` can check them; a launcher that built flags at run
  time would hide them from that gate.
- `setup` creates the administrator; `doctor --new-admin <user> --force` replaces one.

## Images

- Every image's base is an `ARG` (`DENO_IMAGE`, and `RUNTIME_IMAGE` where there is a second base) whose default is the
  pinned digest, so a mirror or an air-gapped registry is one `--build-arg` away.
- The Chromium seccomp profile allows `inotify_init1`, which the runtime calls to watch the API key file.

## Security

- No CORS, no CDP port, no unauthenticated non-loopback bind: the peer binds `0.0.0.0` inside the network, holds an API
  key file, and publishes no port.
- Secrets are files threaded by path; none enters the environment. The gateway reads the peer token through the peer
  list's `token_file`. Provider keys stay out of the compose files and the tasks.
- The peer's key holds `mcp:invoke` and `agent:invoke` only, and the gateway reaches it only through the operator-fixed
  peer list.
- The gateway's and sandbox's `CMD`s grant `/run/secrets` and `/run/secrets/ttk_git_remotes`; mounting the files needs
  no wider permission.

## How it is checked

- `packages/cli/setup_test.ts`: every file a compose file mounts is written `0644` in a `0700` folder, kept and repaired
  on a second run, and rotated by unit; the scopes; the AppArmor unit; `.env` equals `.env.example`.
- `tests/unit/images_test.ts`: the compose files and image `CMD`s, with no restated command, the sandbox's hardening and
  token volume, and the peer.
- `deno task gate:tasks` and `tests/unit/serve_tasks_test.ts`: exact permissions in every task.
- `deno task test:compose --tag <t>`: the default stack end to end, from images built under `<t>`, with scratch secrets
  only.
- `deno task test:agents:compose --tag <t>`: the agents overlay on the default stack, with scoped ACP delegation into
  real cages.
