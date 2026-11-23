# Secrets

One command creates everything here:

```sh
deno task setup
```

It writes every file any shipped Compose file mounts (and `.env` at the repository root), skips the ones that exist, and
prints the administrator password and the API key **once**: only their hashes are stored. Run it again at any time; it
keeps what is there and repairs file modes. Everything here except this README is git-ignored and excluded from the
Docker build context.

The start scripts (`start.sh`, `start.cmd` / `start.ps1`) run this same `setup` inside the gateway image they build,
with the setup task's permissions, no network, and only this checkout mounted, so they need no Deno on the host; on
Linux the files are written as your user. The `--only` and `--force` options below need `deno task setup`.

Compose mounts each file at `/run/secrets/<name>`, and the server reads it by path through a `*_FILE` variable. Secrets
never go in the environment: Chromium inherits it
([Security › Process permissions](../docs/security.md#process-permissions)).

## Files

| File                       | `setup` writes                    | `--only` name     | Mounted by             | Variable                       |
| -------------------------- | --------------------------------- | ----------------- | ---------------------- | ------------------------------ |
| `ttk_db_key`               | 32 random bytes                   | `db-key`          | gateway                | `TTK_DB_KEY_FILE`              |
| `ttk_admin_user.json`      | the `admin` account (PBKDF2 hash) | `admin`           | gateway                | `TTK_ADMIN_USER_FILE`          |
| `ttk_api_keys.json`        | the `client` key (SHA-256 only)   | `api-key`         | gateway                | `TTK_API_KEYS_FILE`            |
| `ttk_secrets.json`         | `{}`: yours to fill in            | `browser-secrets` | gateway                | `TTK_SECRETS_FILE`             |
| `ttk_git_remotes`          | `[]`: yours to fill in            | `git-remotes`     | sandbox                | `TTK_SANDBOX_GIT_REMOTES_FILE` |
| `ttk_sandbox_token`        | 64 hex characters                 | `sandbox-token`   | gateway and sandbox    | `TTK_SANDBOX_TOKEN_FILE`       |
| `ttk_model_providers.json` | nothing: yours, optional          | none              | your own override file | `TTK_MODEL_PROVIDERS_FILE`     |
| `../.env`                  | `.env.example`, byte for byte     | `env`             | Compose interpolation  | none                           |

`docker-compose.yml` mounts every file whose row names the gateway or the sandbox; Compose refuses to start when a
declared file is missing, which is why `setup` comes first.

On the host, `deno task dev`, `stdio`, `doctor` and `seed` pick these files up without an export: they pass
`--local-defaults`, which sets `TTK_DATA_DIR=data`, `TTK_DB_KEY_FILE`, `TTK_API_KEYS_FILE` (not `stdio` or `seed`),
`TTK_SECRETS_FILE`, and `TTK_SANDBOX_TOKEN_FILE` when `TTK_SANDBOX_URL` is set, each to its file here, only when the
variable (and its inline or `*_REF` form) is unset and the file exists. A variable you set wins. Without `ttk_db_key` no
data directory is defaulted, so the server starts stateless unless you set `TTK_DATA_DIR`; with no database key at all
it says to run `setup`. The administrator record needs no default: `ttk_admin_user.json` is read whenever neither
`TTK_ADMIN_USER` variable is set.

## Options

| Need                                    | Run                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Create what is missing (and fix modes)  | `deno task setup`                                                        |
| Rotate one generated file               | `deno task setup --only sandbox-token --force` (any name from the table) |
| Reload the sandbox's AppArmor profile   | `deno task setup --only apparmor --force` (below)                        |
| Reset a file you fill in yourself       | `deno task setup --only browser-secrets --force`                         |
| Replace every generated file and `.env` | `deno task setup --force` (files you fill in are kept; see the db key)   |
| A different administrator name          | `deno task setup --only admin --admin alice` (`--force` to replace)      |
| Narrower scopes on the first key        | `deno task setup --only api-key --force --scopes mcp:invoke,view:watch`  |
| Another API key                         | `deno task doctor --new-key <id> --scopes <list> --save`                 |
| A new administrator password            | `deno task doctor --new-admin admin --force`                             |

After a change, `docker compose up -d` recreates the services whose files changed (`docker compose restart <service>`
when a file was edited in place). A key added with `--save` needs neither: the gateway re-reads its key file on change.

### The sandbox's AppArmor profile

One file `setup` manages lives outside this folder: `/etc/apparmor.d/tykotech-sandbox`, the coding sandbox's AppArmor
profile (`docker/apparmor-sandbox`; `--only` name `apparmor`). On a host that runs AppArmor (Ubuntu, Debian), Docker's
default profile denies the mounts the sandbox's cages need, and the sandbox does not start without this one. `setup`
installs and loads it through `sudo` last, after the password and key are shown, and only when the installed copy
differs from the checkout's or is not loaded; `sudo` asks for your password. When it cannot, `setup` exits 1 naming
AppArmor, with the two commands to run by hand
([Sandbox AppArmor profile](../docs/reference/api.md#sandbox-apparmor-profile)). Elsewhere it does nothing, and so does
Docker: on a host without AppArmor, or without its tools (`aa-enabled`, `apparmor_parser`: the `apparmor` package), the
sandbox runs without the profile. Install the package and run `setup` again to have it applied.

## Permissions

`setup` makes `secrets/` **0700** and every file in it **0644**, on every run. No other account on the host can open
anything inside a `0700` directory, whatever a file's own mode, so the files stay private. Inside a container a Compose
secret is a bind mount of the file alone, which keeps the host's owner and mode (Compose ignores `uid`, `gid` and `mode`
for file secrets); `0644` is what lets the containers' unprivileged users (uid 1993) read it, with rootless Docker and
Docker Desktop too, and without `sudo`.

- A file the containers cannot read (a gateway restarting with `Permission denied`) is repaired by running
  `deno task setup` again. A file owned by another account cannot be; `setup` warns, and `--force` replaces it.
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
to revoke its key. Scope list: [Guide › Scopes](../docs/guide.md#scopes).

## Administrator account

`setup` writes `{ username, salt, hash, iterations, scopes }` for `admin` (the stack's scopes plus `admin`) and prints
the password once. With `TTK_DATA_DIR` it seeds `users.json` on first start; afterwards edits to this file change
nothing: manage accounts in the web app's **Users** screen. Replace the record with
`deno task doctor --new-admin admin [--password <p>] [--scopes <list>] --force`; a password you give with `--password`
is not printed back.

`setup` and `doctor` write a generated password or key straight to the terminal's stream, not through the process log,
so a log collector of the console never holds one. Redirecting the output still captures it: keep such a file as you
would the secret.

## A2A peers

No peer ships with the stack, and `setup` writes no peer file: `agent_delegate` appears once you list your own. Write
the list yourself, here or anywhere the gateway can read it, and mount each peer's bearer beside it:

- `ttk_agent_peers.json`: `[{ "id", "url", "token_file"? }]`, up to 32, for example
  `[{ "id": "reviewer", "url": "https://reviewer.example.com", "token_file": "/run/secrets/reviewer_token" }]`;
- one token file per peer that wants a bearer: the peer's API key for this gateway, scoped on the peer to what you want
  delegated (`mcp:invoke` and `agent:invoke` cover a delegated tool task).

Mount both into the gateway as file secrets in a Compose override (`docker-compose.override.yml`), set
`TTK_AGENT_PEERS_FILE=/run/secrets/ttk_agent_peers.json` on it, and `docker compose up -d`. A peer's agent card must
name the origin it is reached at. Format and limits: [Guide › A2A](../docs/guide.md#a2a).

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
`ttk_model_providers.json` and mount it into the gateway with a `docker-compose.override.yml` of your own
([snippet](../docs/guide.md#model-providers)).

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
- All fields: [Guide › Model providers](../docs/guide.md#model-providers).

## Sandbox token

`ttk_sandbox_token` is the one bearer the gateway and the coding sandbox share. `docker-compose.yml` mounts it read-only
into both services at `/run/secrets/ttk_sandbox_token` and names it in each one's `TTK_SANDBOX_TOKEN_FILE`; a sandbox
run outside Compose mounts it at the same path, the image's default, and a local `dev` with `TTK_SANDBOX_URL` set names
it on its own. The sandbox reads it once at start, as a regular file (no link) of at most 4096 bytes, and then gives up
its grant to it. The gateway starts whether or not the sandbox is up; the sandbox tools are offered while it answers.
Rotate it:

```sh
deno task setup --only sandbox-token --force
docker compose up -d --force-recreate tykotech-mcp sandbox
```

Without Deno, delete `secrets/ttk_sandbox_token` and run the start script again: it writes any missing file.

## File format

A secret file is exactly its value plus at most one trailing newline. A byte-order mark, leading or trailing whitespace,
or blank lines after a JSON document refuse startup, naming the variable and path. JSON files may span lines.
