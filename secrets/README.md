# Secrets

Everything here except this README is git-ignored and excluded from the Docker build context. Compose mounts each file
at `/run/secrets/<name>`; the server reads it by path through a `*_FILE` variable. Secrets never go in the environment:
Chromium inherits it ([Security model](../docs/concepts/security-model.md#process-permissions)).

## Files

| File                       | Written by                                                    | Container path                        | Variable                       | Holds                                                               |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `ttk_db_key`               | `deno task setup`, `deno task doctor --new-db-key`            | `/run/secrets/ttk_db_key`             | `TTK_DB_KEY_FILE`              | The key that seals every secret in `ttk.db`                         |
| `ttk_admin_user.json`      | `deno task setup`, `deno task doctor --new-admin <user>`      | `/run/secrets/ttk_admin_user`         | `TTK_ADMIN_USER_FILE`          | The first administrator account (PBKDF2 hash)                       |
| `ttk_api_keys.json`        | `deno task setup` (id `client`); you, from `doctor --new-key` | `/run/secrets/ttk_api_keys`           | `TTK_API_KEYS_FILE`            | API key records (SHA-256 only)                                      |
| `ttk_secrets.json`         | You                                                           | `/run/secrets/ttk_secrets`            | `TTK_SECRETS_FILE`             | Browser-typed secrets (seed)                                        |
| `ttk_model_providers.json` | You, or the web app's configuration composer (draft)          | `/run/secrets/ttk_model_providers`    | `TTK_MODEL_PROVIDERS_FILE`     | Model providers and their keys (seed)                               |
| `ttk_sandbox_token`        | You                                                           | `/run/secrets/ttk_sandbox_token`      | `TTK_SANDBOX_TOKEN_FILE`       | Gateway↔sandbox bearer, with `docker-compose.sandbox.yml` only      |
| `ttk_git_remotes`          | You                                                           | `/run/secrets/ttk_git_remotes`        | `TTK_SANDBOX_GIT_REMOTES_FILE` | Sandbox credentialed git remotes                                    |
| `ttk_agent_bridge_token`   | You                                                           | `/run/secrets/ttk_agent_bridge_token` | `TTK_AGENT_BRIDGE_TOKEN_FILE`  | Gateway↔ACP runner bearer (`docker-compose.agents.yml`)             |
| `ttk_agent_commands.json`  | You                                                           | `/run/secrets/ttk_agent_commands`     | `TTK_AGENT_COMMANDS_FILE`      | The ACP runner's fixed agent commands (`docker-compose.agents.yml`) |

`docker-compose.yml` mounts the first three and refuses to start if one is missing. `ttk_secrets`, `ttk_model_providers`
and `ttk_git_remotes` are commented blocks there: uncomment the variable, the service's `secrets:` entry and the
top-level entry.

`setup` creates only missing files (`--force` / `-Force` replaces all four, `.env` included). `doctor --new-db-key` and
`doctor --new-admin` refuse to overwrite without `--force`. Secret files are written `0600`.

## Ownership

The containers run as 1993:1993. A Compose secret is a bind mount and keeps its owner, group and mode, so on Linux (WSL
included) a file you own `0600` is unreadable in the container. `setup` prints the fix:

```sh
sudo chgrp 1993 secrets/ttk_* && chmod 0440 secrets/ttk_*
# without sudo:
docker run --rm -v "$PWD/secrets:/s" busybox sh -c 'chgrp 1993 /s/ttk_* && chmod 0440 /s/ttk_*'
```

You stay the owner, so local `deno task dev`, `stdio` and `doctor` keep reading the files; group 1993 reads them in the
containers. Files handed over with an older `chown 1993:1993` come back with
`sudo chown $(id -u):1993 secrets/ttk_* && sudo chmod 0440 secrets/ttk_*`.

| Need                             | Run                                                                         |
| -------------------------------- | --------------------------------------------------------------------------- |
| Local Deno only                  | Nothing: `setup` writes `0600`, owned by you.                               |
| Compose and local Deno           | `sudo chgrp 1993 secrets/ttk_* && chmod 0440 secrets/ttk_*`                 |
| Slim image (`ttk`, uid 1000)     | `sudo chgrp 1000 secrets/ttk_* && chmod 0440 secrets/ttk_*`                 |
| Replace a file you no longer own | `--force` works: it deletes the old file first (needs write on `secrets/`). |

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
- `setup --force` and `doctor --new-db-key --force` write a new key, with the same effect. There is no rotation command.
- Without `TTK_DB_KEY_FILE` nothing secret is stored; a seed source that carries a secret refuses startup.

## API keys

```sh
deno task doctor --new-key my-client --scopes mcp:invoke,view:control
```

Keep the printed `ttk_…` key with the client. Append the printed record to the array in `ttk_api_keys.json`; the server
reloads it without a restart:

```json
[{ "id": "my-client", "sha256": "<64 hex>", "scopes": ["mcp:invoke", "view:control"] }]
```

Without `--scopes` a key gets `mcp:invoke`, `view:watch`, `view:control`, `files:read`, never `admin`. Scope list:
[Managing access](../docs/guides/managing-access.md).

## Administrator account

```sh
deno task doctor --new-admin admin [--password <p>] [--scopes <list>] [--force]
```

Prints the password once and writes `{ username, salt, hash, iterations, scopes }` (default scopes plus `admin`). With
`TTK_DATA_DIR` it seeds `users.json` on first start; afterwards edits to this file change nothing. Manage accounts in
the web app's **Users** screen.

## Browser-typed secrets

`ttk_secrets.json` maps names to values a model may type without seeing them:

```json
{ "github_pw": { "value": "…", "domains": ["github.com"] } }
```

- The model writes `<secret>github_pw</secret>` in `browser_type`. The server substitutes it on the way to the browser,
  refuses it outside `domains`, and never returns it. `browser_fill_secret` refuses a secret without `domains`.
- Names: `[A-Za-z0-9_.-]`, up to 64. A plain string value has no `domains`.
- Seeded into `ttk.db` once, sealed (needs `ttk_db_key`). Later edits are not applied; the file may then be removed.
  Apply edits with
  `docker compose run --rm --no-deps tykotech-mcp ttk seed --force --only secrets && docker compose restart tykotech-mcp`.
- Enable: uncomment `ttk_secrets` in `docker-compose.yml` and add `TTK_SECRETS_FILE: /run/secrets/ttk_secrets`.

## Model providers file

Optional: providers can be added in the web app (**System › Agents**) instead.

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

`docker-compose.yml` needs no file here: the sandbox service generates its token on first start (64 hex characters,
`0400`, uid 1993) into the `ttk-sandbox-token` volume, mounted read-write by the sandbox and read-only by the gateway
only. Rotate: `docker compose down`, `docker volume rm <project>_ttk-sandbox-token`, start again.

To use your own token instead (at least 32 random non-whitespace characters):

```sh
deno eval "console.log(crypto.randomUUID() + crypto.randomUUID())" > secrets/ttk_sandbox_token
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up --build
```

## Agent runner files

For [`docker-compose.agents.yml`](../docker-compose.agents.yml): `ttk_agent_bridge_token` is an independent random
token, made like the sandbox token. `ttk_agent_commands.json` fixes the ACP executables, arguments, cwd, environment and
MCP allowlist; it must not hold MCP bearers, headers or provider keys (mount those separately). Example:
[Agents and sandbox](../docs/guides/coding-and-agents.md#the-acp-agent-bridge).

## File format

A secret file is exactly its value plus at most one trailing newline. A byte-order mark, leading or trailing whitespace,
or blank lines after a JSON document refuse startup, naming the variable and path. JSON files may span lines.
