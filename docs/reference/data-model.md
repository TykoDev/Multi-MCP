# Data model

Where state lives. Without `TTK_DATA_DIR` everything is in memory, and writes that need storage answer
`409 persistence-required`.

## The data directory

```
<TTK_DATA_DIR>/                    (/data in the images; the ttk-data volume in Compose)
├── ttk.db (+ -wal, -shm)          SQLite: model providers, sealed secrets, agent memory   (0600)
├── users.json                     accounts: PBKDF2 password hashes, account-key hashes
├── logins.json                    sign-in sessions (token hashes)
├── origins.json                   per-credential live-view origin lists
├── agents/tasks.json              agent tasks and push webhooks                           (0600)
├── agents/surfaces.json           A2UI surfaces                                           (0600)
├── profiles/<name>/               named Chromium profiles (cookies survive restarts)
├── storage/<name>.json            saved storage states
├── sessions/<id>.json             scratch state of an unprofiled session (removed on close)
├── downloads/<id>-<ulid>/         session downloads and printed files (removed on close)
├── recordings/<name>.webm         recordings
├── share/                         the file share
├── skills/<name>/                 SKILL.md plus files
└── prompts/                       prompt templates
```

JSON stores are written to a temporary file and renamed. Profiles, storage states, the share, memory and task files are
**not encrypted**: protect the volume and its backups.

## `ttk.db`

SQLite via Deno's built-in `node:sqlite` (no FFI). WAL, `secure_delete`, `STRICT` tables, schema versioned by
`PRAGMA user_version`. `serve` and a local `stdio` process can open it at once. Node-local in a cluster.

| Table                | Holds                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| `settings`           | Seed markers, the default provider, the default memory embedder.                    |
| `secrets`            | Every stored secret, AES-256-GCM sealed (below).                                    |
| `model_providers`    | Providers in force, in order; `origin` is `seed` or `admin`; no key in the row.     |
| `memory_collections` | One row per collection: owner, name, embedder, dimensions.                          |
| `memory_items`       | Items: text, JSON metadata, Float32 embedding; cascade-deleted with the collection. |

### Sealed secrets

| Row                   | Value                                 | Bound to             |
| --------------------- | ------------------------------------- | -------------------- |
| `vault/check`         | Check value proving the key is right. | —                    |
| `model-provider/<id>` | A provider's API key.                 | The provider's host. |
| `browser-secrets`     | The browser secrets document.         | —                    |
| `link-signing-key`    | The generated signed-link key.        | —                    |

AES-256-GCM with a fresh nonce per value; the additional data binds row name and context, so a row copied elsewhere or a
key moved to another host does not decrypt. The key is 32 bytes from `TTK_DB_KEY_FILE` (base64url, base64 or hex),
outside the data volume. Without it the vault is locked: nothing secret can be stored, and a database that already holds
sealed rows refuses startup.

### Seeding

`TTK_MODEL_PROVIDERS_FILE` and `TTK_SECRETS(_FILE)` are copied in once, when never seeded and empty, at `serve`, `stdio`
or `seed`. Afterwards the database is the source; a changed file is logged, not applied. `seed --force` replaces.
Nothing is written back to a source file. `TTK_SECRETS_REF` is never seeded.

### Agent memory

| Rule      | Value                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Owner     | The principal (e.g. `api-key:ci-bot`); stdio and loopback development share one owner.                           |
| Limits    | 64 collections per owner, 10 000 items per collection, text ≤16 KiB, metadata ≤4 KiB.                            |
| Embedders | `builtin:lexical-512` (offline, lexical) or `provider:<id>/<model>` (an `openai`-kind provider's `/embeddings`). |
| Search    | Cosine similarity over one collection. A collection keeps the embedder it was created with.                      |

## Accounts and sign-ins

- `users.json`: username, PBKDF2-SHA256 hash (100 000 iterations, 16-byte salt), scopes, disabled flag, up to 25 account
  API keys (SHA-256 plus an 8-character prefix). Seeded once from `TTK_ADMIN_USER(_FILE)`; afterwards it is the
  authority.
- `logins.json`: SHA-256 of each `ttks_` token, its backing (account or key) and expiry. Scopes are re-derived on every
  request, so revocation applies at once.
- `origins.json`: up to 64 full origins per credential.

## Read-only inputs

| Input                                                   | Contents                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `TTK_API_KEYS_FILE`                                     | `[{ id, sha256, scopes?, label? }]`. Watched; edits apply live. |
| `TTK_ADMIN_USER_FILE`                                   | The seed account record.                                        |
| `TTK_DB_KEY_FILE`                                       | The 32-byte vault key.                                          |
| `TTK_MODEL_PROVIDERS_FILE`, `TTK_SECRETS_FILE`          | Seeds (used directly without `TTK_DATA_DIR`).                   |
| `TTK_SANDBOX_TOKEN_FILE`, `TTK_AGENT_BRIDGE_TOKEN_FILE` | Service bearer tokens.                                          |
| `TTK_AGENT_PEERS_FILE`                                  | A2A peers.                                                      |
| `TTK_SIGNED_LINK_KEY_FILE`                              | Signed-link key (cluster).                                      |

## In memory only

Browser sessions, event rings (512 records), request logs (500 requests), the audit ledger (200 entries per session),
live-view tickets, rate-limit counters, delegated tokens, pending permission requests and A2UI button actions. All are
rebuilt empty at start.

## Sandbox storage

The sandbox service's own volume (`ttk-code` at `/work`): one git checkout per workspace, a private home (package
caches) and `/tmp` per workspace, and an owner record holding the SHA-256 of the owner. Workspaces survive restarts;
shells do not.

## Cluster store

With `TTK_CLUSTER_KV`, nodes share a Deno KV with node registrations, session owners, task locations, accounts and
sign-in sessions. `ttk.db` stays per node.
