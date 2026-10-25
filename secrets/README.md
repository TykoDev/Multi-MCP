# Secrets

One command creates everything here:

```sh
deno task setup
```

It writes every file any shipped Compose file mounts (and `.env` at the repository root), skips the ones that exist, and
prints the administrator password and the API key **once**: only their hashes are stored. Run it again at any time; it
keeps what is there and repairs file modes. Everything here except this README is git-ignored and excluded from the
Docker build context.

Compose mounts each file at `/run/secrets/<name>`, and the server reads it by path through a `*_FILE` variable. Secrets
never go in the environment: Chromium inherits it
([Security model](../docs/concepts/security-model.md#process-permissions)).

## Files

| File                       | `setup` writes                    | `--only` name     | Mounted by                     | Variable                       |
| -------------------------- | --------------------------------- | ----------------- | ------------------------------ | ------------------------------ |
| `ttk_db_key`               | 32 random bytes                   | `db-key`          | gateway                        | `TTK_DB_KEY_FILE`              |
| `ttk_admin_user.json`      | the `admin` account (PBKDF2 hash) | `admin`           | gateway                        | `TTK_ADMIN_USER_FILE`          |
| `ttk_api_keys.json`        | the `client` key (SHA-256 only)   | `api-key`         | gateway                        | `TTK_API_KEYS_FILE`            |
| `ttk_agent_peers.json`     | the bundled A2A peer              | `peer`            | gateway                        | `TTK_AGENT_PEERS_FILE`         |
| `ttk_peer_token`           | the bearer the gateway gives it   | `peer`            | gateway (through the list)     | `token_file` in the list       |
| `ttk_peer_api_keys.json`   | that bearer's hash                | `peer`            | `a2a-peer`                     | `TTK_API_KEYS_FILE` (peer)     |
| `ttk_secrets.json`         | `{}`: yours to fill in            | `browser-secrets` | gateway                        | `TTK_SECRETS_FILE`             |
| `ttk_git_remotes`          | `[]`: yours to fill in            | `git-remotes`     | sandbox                        | `TTK_SANDBOX_GIT_REMOTES_FILE` |
| `ttk_sandbox_token`        | 64 hex characters                 | `sandbox-token`   | `docker-compose.sandbox.yml`   | `TTK_SANDBOX_TOKEN_FILE`       |
| `ttk_agent_bridge_token`   | 64 hex characters                 | `agent-token`     | `docker-compose.agents.yml`    | `TTK_AGENT_BRIDGE_TOKEN_FILE`  |
| `ttk_agent_commands.json`  | one agent at `/opt/agents/agent`  | `agent-commands`  | `docker-compose.agents.yml`    | `TTK_AGENT_COMMANDS_FILE`      |
| `ttk_model_providers.json` | nothing: yours, optional          | none              | `docker-compose.providers.yml` | `TTK_MODEL_PROVIDERS_FILE`     |
| `../.env`                  | `.env.example`, byte for byte     | `env`             | Compose interpolation          | none                           |

`docker-compose.yml` mounts the first eight; Compose refuses to start when a declared file is missing, which is why
`setup` comes first.

## Options

| Need                                    | Run                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Create what is missing (and fix modes)  | `deno task setup`                                                       |
| Rotate one generated file               | `deno task setup --only peer --force` (any name from the table)         |
| Reload the sandbox's AppArmor profile   | `deno task setup --only apparmor --force` (below)                       |
| Reset a file you fill in yourself       | `deno task setup --only browser-secrets --force`                        |
| Replace every generated file and `.env` | `deno task setup --force` (files you fill in are kept; see the db key)  |
| A different administrator name          | `deno task setup --only admin --admin alice` (`--force` to replace)     |
| Narrower scopes on the first key        | `deno task setup --only api-key --force --scopes mcp:invoke,view:watch` |
| Another API key                         | `deno task doctor --new-key <id> --scopes <list> --save`                |
| A new administrator password            | `deno task doctor --new-admin admin --force`                            |

After a change, `docker compose up -d` recreates the services whose files changed (`docker compose restart <service>`
when a file was edited in place). A key added with `--save` needs neither: the gateway re-reads its key file on change.

### The sandbox's AppArmor profile

One file `setup` manages lives outside this folder: `/etc/apparmor.d/tykotech-sandbox`, the coding sandbox's AppArmor
profile (`docker/apparmor-sandbox`; `--only` name `apparmor`). On a host that runs AppArmor (Ubuntu, Debian), Docker's
default profile denies the mounts the sandbox's cages need, and the sandbox does not start without this one. `setup`
installs and loads it through `sudo` last, after the password and key are shown, and only when the installed copy
differs from the checkout's or is not loaded; `sudo` asks for your password. When it cannot, `setup` exits 1 naming
AppArmor, with the two commands to run by hand
([Docker reference](../docs/reference/docker-reference.md#coding-sandbox)). Elsewhere it does nothing.

## Permissions

`setup` makes `secrets/` **0700** and every file in it **0644**, on every run. No other account on the host can open
anything inside a `0700` directory, whatever a file's own mode, so the files stay private. Inside a container a Compose
secret is a bind mount of the file alone, which keeps the host's owner and mode (Compose ignores `uid`, `gid` and `mode`
for file secrets); `0644` is what lets the containers' unprivileged users (uid 1993; the slim image: 1000) read it, with
rootless Docker and Docker Desktop too, and without `sudo`.

- A checkout set up before this rule (`0600` files, which the containers cannot read, so the gateway restarted with
  `Permission denied`) is repaired by running `deno task setup` again.
- Files handed over with an older `chgrp 1993` + `0440` keep working. Files `chown`ed to 1993 cannot be repaired by you;
  `setup` warns, and `--force` replaces them (it deletes the old file first).
- Copying a file out of `secrets/` copies its `0644` with it: keep copies and backups somewhere private.
- Windows has no POSIX modes; nothing is needed there.

## The database key

`ttk_db_key`: 32 random bytes as 43 base64url characters (padded base64 or 64 hex also accepted). It seals, AES-256-GCM,
every secret the server stores in `<TTK_DATA_DIR>/ttk.db`: model provider keys, browser secrets and the generated
link-signing key.

- **Back it up apart from the data volume** (`ttk-data`, or `./data` locally), and never store it there. A volume backup
  alone holds only ciphertext.
- **Losing it loses every stored secret.** Startup is refused with `the key does not open this database` (wrong key) or
  `the database holds encrypted secrets and no key is set` (none). Restore the key. Without it the only way on is a new
  database: move `ttk.db`, `ttk.db-wal` and `ttk.db-shm` aside (providers and memory go too), start with a new key,
  re-seed or re-enter providers and secrets.
- `setup --force` (or `--only db-key --force`) and `doctor --new-db-key --force` write a new key, with the same effect.
  There is no rotation command.
- Without `TTK_DB_KEY_FILE` nothing secret is stored; a seed source that carries a secret refuses startup.

## API keys

`setup` mints one key, id `client`, holding the stack's scopes: `mcp:invoke`, `view:watch`, `view:control`,
`files:read`, `files:write`, `sandbox:execute`, `agent:invoke`, `model:invoke`, `a2ui:publish`. That reaches the
browser, live view, file share, memory, coding sandbox, agents and A2UI. `task`, `evaluate`, `admin`, `metrics:read` and
`network:read` are never granted unasked.

Give every other client its own key with the scopes it needs:

```sh
deno task doctor --new-key my-client --scopes mcp:invoke,view:control --save
```

The key is printed once; `--save` adds its record to `ttk_api_keys.json` (replacing one with the same id), and the
running gateway picks it up without a restart. Without `--save` the record is printed for you to add:

```json
[{ "id": "my-client", "sha256": "<64 hex>", "scopes": ["mcp:invoke", "view:control"] }]
```

Without `--scopes` a key gets `mcp:invoke`, `view:watch`, `view:control`, `files:read`, never `admin`. Remove a record
to revoke its key. Scope list: [Managing access](../docs/guides/managing-access.md).

## Administrator account

`setup` writes `{ username, salt, hash, iterations, scopes }` for `admin` (the stack's scopes plus `admin`) and prints
the password once. With `TTK_DATA_DIR` it seeds `users.json` on first start; afterwards edits to this file change
nothing: manage accounts in the web app's **Users** screen. Replace the record with
`deno task doctor --new-admin admin [--password <p>] [--scopes <list>] --force`.

## A2A peer

The default stack runs a second gateway, `a2a-peer`, that `agent_delegate` sends tasks to. `setup` writes three files
for it, as one unit:

- `ttk_peer_token`: the bearer the gateway presents to the peer;
- `ttk_peer_api_keys.json`: its hash, the peer's only key, scoped to `mcp:invoke` and `agent:invoke`;
- `ttk_agent_peers.json`: the gateway's peer list,
  `[{ "id": "peer", "url": "http://a2a-peer:8787", "token_file": "/run/secrets/ttk_peer_token" }]`.

Add other A2A agents to the list (`[{ "id", "url", "token_file"? }]`, up to 32; a token file must be mounted into the
gateway) and `docker compose up -d`. A peer's agent card must name the origin it is reached at. Rotate the bundled pair:
`deno task setup --only peer --force && docker compose up -d`.

## Browser-typed secrets

`ttk_secrets.json` maps names to values a model may type without seeing them; `setup` writes `{}`:

```json
{ "github_pw": { "value": "…", "domains": ["github.com"] } }
```

- The model writes `<secret>github_pw</secret>` in `browser_type`. The server substitutes it on the way to the browser,
  refuses it outside `domains`, and never returns it. `browser_fill_secret` refuses a secret without `domains`.
- Names: `[A-Za-z0-9_.-]`, up to 64. A plain string value has no `domains`.
- Fill it in, then `docker compose restart tykotech-mcp`: the first non-empty file is sealed into `ttk.db` (needs
  `ttk_db_key`). Later edits are not applied on their own; apply them with
  `docker compose run --rm --no-deps tykotech-mcp ttk seed --force --only secrets && docker compose restart tykotech-mcp`.

## Git remotes

`ttk_git_remotes` lists credentialed remotes for `sandbox_clone`; `setup` writes `[]`:

```json
[{ "id": "work", "url": "https://git.example.com/team/repo.git", "username": "bot", "token": "…" }]
```

https only. The sandbox reads it once at start (`docker compose restart sandbox` after an edit); the credential never
enters a cage. Public clones from GitHub, GitLab, Bitbucket and Codeberg need nothing here.

## Model providers file

Optional: add providers in the web app (**System › Agents**) instead. To seed them from a file, write
`ttk_model_providers.json` and add the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.providers.yml up -d
```

```json
{
	"version": 1,
	"providers": [
		{
			"id": "openai",
			"kind": "openai",
			"base_url": "https://api.openai.com/v1",
			"models": ["gpt-4.1"],
			"api_key": "sk-…"
		}
	]
}
```

- `kind`: `openai` (any OpenAI-compatible endpoint) or `anthropic`. Key: `api_key` or `api_key_file` (absolute path),
  not both. At most 128 KiB, 16 providers.
- Seeded into `ttk.db` once, each key sealed to its host (needs `ttk_db_key`). A differing file is then logged at
  startup and not applied. Re-seed: `ttk seed --force --only providers`.
- The web app's configuration composer drafts this file with `REPLACE_WITH_KEY`; startup refuses that placeholder.
- All fields: [Agents and sandbox](../docs/guides/coding-and-agents.md#model-providers).

## Sandbox token

`docker-compose.yml` uses no file for it: the sandbox service generates its token on first start (64 hex characters,
`0400`, uid 1993) into the `ttk-sandbox-token` volume, mounted read-write by the sandbox and read-only by the gateway
only. Rotate: `docker compose down`, `docker volume rm <project>_ttk-sandbox-token`, start again.

`docker-compose.sandbox.yml` uses `ttk_sandbox_token` instead (an operator-held token, at least 32 non-whitespace
characters), for a gateway that is not in this Compose project:

```sh
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

## Agent runner files

For [`docker-compose.agents.yml`](../docker-compose.agents.yml): `ttk_agent_bridge_token` is the gateway↔runner bearer,
and `ttk_agent_commands.json` fixes the ACP executables, arguments, cwd, environment and MCP allowlist. `setup` writes
one agent, `default`, at `/opt/agents/agent`; install it in an image derived from `docker/Dockerfile.agent-runner` and
edit the file to match (the runner refuses to start until the executable exists). It must not hold MCP bearers, headers
or provider keys: mount those as files and name them in `env` as `*_FILE`. Example:
[Agents and sandbox](../docs/guides/coding-and-agents.md#the-acp-agent-bridge).

## File format

A secret file is exactly its value plus at most one trailing newline. A byte-order mark, leading or trailing whitespace,
or blank lines after a JSON document refuse startup, naming the variable and path. JSON files may span lines.
