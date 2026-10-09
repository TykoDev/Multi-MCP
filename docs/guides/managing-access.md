# Managing access

Who can reach the server, with which credential, and what each may do.

## Credentials

| Prefix  | Credential          | Source                                                                              |
| ------- | ------------------- | ----------------------------------------------------------------------------------- |
| `ttk_`  | API key             | `deno task setup`, `doctor --new-key`, or an account's key (Users screen).          |
| `ttks_` | Sign-in session     | `POST /api/v1/auth/login` with a password or an API key (the web UI uses a cookie). |
| (JWT)   | OAuth access token  | Your identity provider, with `TTK_OAUTH_ISSUER`.                                    |
| `ttkd_` | Delegated MCP token | Minted per task for an ACP agent; `/mcp` only, ≤120 s.                              |

With no credential configured, a loopback bind serves anonymous requests with `TTK_ANON_SCOPES` (and warns). Any other
bind refuses to start without an API key, an OAuth issuer or an account.

## Scopes

| Scope             | Default | Allows                                                                                                 |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `mcp:invoke`      | yes     | MCP tools and resources; session events and file downloads.                                            |
| `view:watch`      | yes     | Watch live sessions; recordings; the MCP Apps live view.                                               |
| `view:control`    | yes     | Take over live sessions; `browser_request_human`.                                                      |
| `files:read`      | yes     | Read the file share, skills, prompts and memory.                                                       |
| `files:write`     | no      | Change the file share, skills, prompts and memory; `browser_save_to_share`.                            |
| `admin`           | no      | Sessions, accounts, origins, diagnostics, providers, memory settings, `/metrics`, `browser_close_all`. |
| `metrics:read`    | no      | `GET /metrics` only.                                                                                   |
| `network:read`    | no      | Full URLs, headers and bodies in the request log and HAR export.                                       |
| `evaluate`        | no      | `browser_evaluate`.                                                                                    |
| `task`            | no      | `browser_run_task`.                                                                                    |
| `sandbox:execute` | no      | Coding workspaces.                                                                                     |
| `agent:invoke`    | no      | A2A, agent tasks and `agent_*` tools; reading A2UI surfaces.                                           |
| `a2ui:publish`    | no      | Publishing A2UI surfaces.                                                                              |
| `model:invoke`    | no      | Running text tasks on a model provider. Never implied, not even by `admin`.                            |

A credential that names no scopes gets the four defaults. Tools outside a credential's scopes are hidden and listed in
`tools_withheld`.

## API keys

```sh
deno task doctor --new-key ci-bot --scopes mcp:invoke,view:watch
```

Prints the raw key once and a record for `secrets/ttk_api_keys.json` (a JSON array):

```json
[{ "id": "ci-bot", "sha256": "3f1c…", "scopes": ["mcp:invoke", "view:watch"], "label": "CI" }]
```

The file is watched: an edit applies within a second, and a removed key stops at once together with its sign-ins, tasks,
streams and signed links. `doctor --new-key-set <prefix>` mints one single-scope key per scope.

## Accounts

`setup` creates the first administrator (`secrets/ttk_admin_user.json`). With `TTK_DATA_DIR`, it is copied into
`users.json` on first start; from then on manage accounts on the **Users** screen or `/api/v1/users`: create, change
scopes, disable, reset passwords, issue account API keys (≤25 each), sign out everywhere.

- Passwords: 8–256 characters, PBKDF2-SHA256.
- The last enabled `admin` cannot be disabled, deleted or stripped of `admin`; nobody can disable or delete themselves.
- Sign-ins last `TTK_LOGIN_TTL_S` (7 days); scope changes apply on the next request.
- Failed sign-ins back off per source (5 free) and per username (10 free); no lockout.

### Recovering administration

If no enabled account holds `admin`, the server warns at startup. With the gateway stopped:

```sh
deno run --allow-read=.,data --allow-write=data --allow-env=TTK_* \
  packages/cli/mod.ts doctor --grant admin --scopes mcp:invoke,view:watch,view:control,files:read,admin --data-dir data
```

With `TTK_CLUSTER_KV`, add `--unstable-kv` and access to the store; every node picks it up.

## OAuth 2.1

```sh
TTK_OAUTH_ISSUER=https://id.example.com/realms/main
TTK_OAUTH_AUDIENCE=https://mcp.example.com    # default: TTK_PUBLIC_URL
```

RS256/ES256 JWTs; scopes from the `scope` claim or the `scp` array (`ttk:admin` maps to `admin`). The server publishes
protected-resource metadata and verifies tokens; it never issues them.

## Hosts and origins

| Header   | Allowed by            | Default                                                                     | Otherwise              |
| -------- | --------------------- | --------------------------------------------------------------------------- | ---------------------- |
| `Host`   | `TTK_ALLOWED_HOSTS`   | `TTK_PUBLIC_URL`'s host, plus loopback names on a loopback or wildcard bind | `400 host-forbidden`   |
| `Origin` | `TTK_ALLOWED_ORIGINS` | `TTK_PUBLIC_URL`'s host, plus loopback names on a loopback bind             | `403 origin-forbidden` |

Both hold bare hostnames; setting one replaces its derived list. An administrator can narrow live-view origins for their
own credential (System screen or `PUT /api/v1/live/origins`).

## Browser secrets

Values the browser types without the model seeing them:

```json
{ "github_password": { "value": "…", "domains": ["github.com"] } }
```

Mount it as `TTK_SECRETS_FILE` (uncomment `ttk_secrets` in `docker-compose.yml`). With `TTK_DATA_DIR` it is sealed into
`ttk.db` on first start; re-seed after edits with `ttk seed --force --only secrets` and restart. Use it as
`<secret>github_password</secret>` in `browser_type`/`browser_fill`, or with `browser_fill_secret` (stricter: declared
domains, fresh `state_token`, same-origin frames, audited). Values never appear in results, logs or errors.

## Long-lived work follows its credential

Sign-in sessions, agent tasks, delegated tokens and streams are bound to the credential that opened them, re-checked
every five minutes, and end immediately when the key is revoked, the account disabled or the user signs out.
