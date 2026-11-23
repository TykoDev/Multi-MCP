# Environment variables

Read once at startup. An invalid value stops startup with `<VARIABLE>: <problem>`, never quoting a secret.
`deno task doctor` (or `ttk doctor` in the image) prints what the server parsed. The gateway image presets a few
([API › The gateway image](api.md#the-gateway-image)).

| Format   | Rule                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list     | Comma-separated; entries trimmed, empty entries dropped.                                                                                                                        |
| integer  | Whole number in the stated range.                                                                                                                                               |
| boolean  | `1`, `true`, `yes`, `on` / `0`, `false`, `no`, `off`, any case.                                                                                                                 |
| `*_FILE` | Path to a file holding the value, never copied into the environment. A secret file loses one trailing newline; a byte-order mark, an empty file or stray whitespace is refused. |

## Reachability

Behind a reverse proxy or on a LAN, set `TTK_PUBLIC_URL` to the address clients use; it opens both allowlists to that
host.

| Variable              | Default                                                              | Meaning                                                                                                                   |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TTK_HOST`            | 127.0.0.1                                                            | Bind address; a non-loopback bind needs API keys or a user account.                                                       |
| `TTK_PORT`            | 8787 (0–65535)                                                       | Bind port; 0 picks a free port.                                                                                           |
| `TTK_PUBLIC_URL`      | http://127.0.0.1:<port> on loopback, else http://<host>:<port>       | The URL clients use; it seeds the Host and Origin allowlists, and `https:` makes the sign-in cookie `__Host-` and Secure. |
| `TTK_ALLOWED_HOSTS`   | derived from the public URL and the bind                             | Host header allowlist (DNS-rebinding guard); setting it replaces the derived list.                                        |
| `TTK_ALLOWED_ORIGINS` | derived from the public URL (plus loopback names on a loopback bind) | Browser Origin allowlist as bare hostnames (a scheme or port refuses startup); setting it replaces the derived list.      |

## Authentication

A non-loopback bind refuses to start without API keys or an account. The inline, `_FILE` and `_REF` forms of one secret
cannot be combined. A key record is `{ "id", "sha256", "scopes"?, "label"? }`
([Guide › API keys](../guide.md#api-keys)): ids are unique, at most 128 printable characters and never start with
`admin:`; a label is at most 64 printable characters without `<`, `>` or `&`; a record without `scopes` gets the default
grant.

| Variable              | Default                                    | Meaning                                                                                                                          |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_API_KEYS`        | none                                       | Inline JSON array of hashed key records; prefer the file form.                                                                   |
| `TTK_API_KEYS_FILE`   | none                                       | File holding the hashed key records; watched and reloaded on change.                                                             |
| `TTK_ADMIN_USER`      | none                                       | Inline PBKDF2 account record that seeds the user store; prefer the file form.                                                    |
| `TTK_ADMIN_USER_FILE` | none; secrets/ttk_admin_user.json is tried | File holding the account record that seeds the user store on first start.                                                        |
| `TTK_LOGIN_TTL_S`     | 604800 (60–31536000)                       | Lifetime of sign-in sessions, in seconds.                                                                                        |
| `TTK_ANON_SCOPES`     | the default grant                          | Scopes for credential-less principals (loopback development, stdio); set but empty means none; an unknown scope refuses startup. |
| `TTK_API_KEYS_REF`    | none                                       | Read the key records once at startup from a secret provider (vault: or op: reference).                                           |
| `TTK_SECRETS_REF`     | none                                       | Read the browser secrets once at startup from a secret provider.                                                                 |

## Secret providers

References: `vault:<mount>/<path>#<key>` (Vault KV v2) or `op:<vault-id>/<item-id>#<field>` (1Password Connect). Read
once at startup; never copied into `ttk.db`. Addresses must be `https:` (`http:` only on loopback); redirects are
refused; any failure refuses startup without echoing the value.

| Variable                      | Default | Meaning                                                                       |
| ----------------------------- | ------- | ----------------------------------------------------------------------------- |
| `TTK_VAULT_ADDR`              | none    | Vault address for vault: references.                                          |
| `TTK_VAULT_TOKEN_FILE`        | none    | File holding the Vault token.                                                 |
| `TTK_VAULT_NAMESPACE`         | none    | Vault Enterprise namespace.                                                   |
| `TTK_OP_CONNECT_URL`          | none    | The 1Password Connect server address for op: references.                      |
| `TTK_OP_CONNECT_TOKEN_FILE`   | none    | File holding the Connect token.                                               |
| `TTK_SECRET_PROVIDER_CA_FILE` | none    | PEM file with the certificate authority that signed the provider certificate. |

## Browser

`TTK_BROWSER_ARGS` takes only `--name` or `--name=value` entries and refuses any switch that weakens the sandbox or site
isolation (`--disable-web-security`, `--disable-site-isolation-trials`, the file-access and unpacked-extension switches,
`--disable-features` naming site isolation, `--js-flags` with a V8 sandbox or `--allow-natives-syntax` flag), relocates
the DevTools endpoint or profile, or runs another program. `CHROMIUM_FLAGS` and `CHROMIUM_USER_FLAGS`, which Debian's
`chromium` wrapper would pass to the browser, are blanked for every child process. A proxy switch in `TTK_BROWSER_ARGS`
makes `browser_head` refuse: the server's own requests follow `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` instead.

`TTK_ALLOWED_DOMAINS_SCOPE=all` judges every request Chromium makes over HTTP(S) and WebSockets, and disables WebRTC.
Every document gets `RTCPeerConnection` and the other RTC interfaces removed before its own script runs, child frames
and `window.open` pop-ups included, and they cannot be restored. Behind that, Chromium launches with
`webrtc.ip_handling_policy` set to `disable_non_proxied_udp`, so WebRTC sends no UDP, and WebRTC over TCP meets the same
resolver rules as every other connection, so it reaches no off-list name or address. With a proxy in `TTK_BROWSER_ARGS`
that TCP goes to the proxy, as WebSockets do, and only the removed interfaces stand in the way. The allowlist is not a
network boundary; for one, use a network that reaches only allowed sites.

| Variable                    | Default              | Meaning                                                                                                                                                                                                                     |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_ALLOWED_DOMAINS`       | empty (unrestricted) | Navigation allowlist, which `browser_head` follows too: a host matches itself and its subdomains. `browser_head` reaches a loopback or private literal, or a non-default port, only when it is named exactly (`host:port`). |
| `TTK_ALLOWED_DOMAINS_SCOPE` | documents            | What Chromium judges against the allowlist: document requests only, or every request (`all` needs a non-empty allowlist). One of `documents`, `all`.                                                                        |
| `TTK_SESSION_OWNERSHIP`     | owner                | Whether sessions are shared among mcp:invoke holders or bound to their creator. One of `shared`, `owner`.                                                                                                                   |
| `TTK_BROWSER_PATH`          | discovered           | Chromium executable.                                                                                                                                                                                                        |
| `TTK_BROWSER_ARGS`          | none                 | Extra Chromium switches; anything that weakens the sandbox is refused.                                                                                                                                                      |
| `TTK_CHROMIUM_NO_SANDBOX`   | false                | Runs Chromium without its sandbox; the only way to do so, and no shipped image sets it.                                                                                                                                     |
| `TTK_HEADLESS`              | true                 | Run Chromium headless.                                                                                                                                                                                                      |
| `TTK_MAX_SESSIONS`          | 8 (1–128)            | Concurrent browser sessions.                                                                                                                                                                                                |
| `TTK_SESSION_TTL_S`         | 1800 (10–86400)      | Idle seconds before a session is closed; a session with a viewer is never closed for idleness.                                                                                                                              |
| `TTK_MEMORY_LIMIT`          | unset                | The container's memory limit (1536m, 1.5g; at least 64m); the Sessions screen's memory meters measure against it. Compose sets it to `TTK_GATEWAY_MEMORY`.                                                                  |
| `TTK_SECRETS`               | none                 | Inline JSON object of browser secrets; prefer the file form.                                                                                                                                                                |
| `TTK_SECRETS_FILE`          | none                 | File holding the browser secrets a model references by name; with `TTK_DATA_DIR` sealed into ttk.db once, which needs `TTK_DB_KEY_FILE`. Values are never returned.                                                         |

## Storage and recording

Startup refuses a `TTK_DB_KEY_FILE` inside `TTK_DATA_DIR`, and a `TTK_BROWSER_PATH` or `TTK_FFMPEG` inside it.

| Variable             | Default                    | Meaning                                                                                                                         |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_DATA_DIR`       | none (ephemeral)           | Persistent data directory: profiles, downloads, recordings, the share, users, agent state, ttk.db.                              |
| `TTK_DB_KEY_FILE`    | none (no secret is stored) | File holding the 32-byte key (base64url, base64 or hex; `doctor --new-db-key` writes one) that encrypts every secret in ttk.db. |
| `TTK_FFMPEG`         | none (recording off)       | Path to ffmpeg; recording needs this and TTK_DATA_DIR.                                                                          |
| `TTK_DISK_BUDGET_MB` | 2048 (64–1048576)          | MiB the file share and recordings may hold together; a write past it is refused (413), a recording stops at it.                 |

## Signed links

| Variable                   | Default                                                                                   | Meaning                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `TTK_SIGNED_LINKS`         | true with TTK_SIGNED_LINK_KEY_FILE, or with TTK_DATA_DIR plus TTK_DB_KEY_FILE; else false | Enables browser_file_link and the public links route; `true` without a key refuses startup. |
| `TTK_SIGNED_LINK_TTL_S`    | 3600 (10–3600)                                                                            | Default link life, in seconds.                                                              |
| `TTK_SIGNED_LINK_KEY_FILE` | none (generated and sealed in ttk.db)                                                     | File holding the link-signing key, at least 32 characters.                                  |

## Live view

| Variable           | Default    | Meaning                        |
| ------------------ | ---------- | ------------------------------ |
| `TTK_MAX_VIEWERS`  | 4 (1–64)   | Live-view viewers per session. |
| `TTK_CAST_QUALITY` | 60 (1–100) | Screencast JPEG quality.       |

## MCP Apps

Add the MCP host's sandbox hostname to `TTK_ALLOWED_ORIGINS`, or its embeds cannot connect.

| Variable               | Default                               | Meaning                                                                                                                                                                                         |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_MCP_APPS`         | control (off without the embed build) | Serves the ui:// embeds; control lets an embed take control on a click. A mode named on a build without the embeds refuses startup. One of `off`, `watch`, `control`.                           |
| `TTK_MCP_APPS_ORIGINS` | none                                  | Host-sandbox origins (`https://host[:port]`, `http://` only on loopback) a ticket may be bound to, each admitted by TTK_ALLOWED_ORIGINS; empty admits any https one TTK_ALLOWED_ORIGINS admits. |
| `TTK_MCP_APPS_DOMAIN`  | none                                  | Passed to the host as _meta.ui.domain; at most 253 characters, no control characters.                                                                                                           |

## Limits and transport

| Variable                  | Default        | Meaning                                                                                                                                         |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_RATE_RPM`            | 120 (1–100000) | Requests per minute per principal; the burst is a third of this.                                                                                |
| `TTK_MCP_STATEFUL`        | true           | Serve 2025-era clients a stateful session (Mcp-Session-Id, change push).                                                                        |
| `TTK_MCP_TOOL_GROUPS`     | true           | stdio and stateful sessions list one `use_<group>` tool per group until the model opens it.                                                     |
| `TTK_MAX_BODY_KB`         | 256 (1–65536)  | Largest request body on the other API routes and `/a2a`, in KiB; `/mcp`, sign-in and share uploads have fixed caps ([API](api.md#conventions)). |
| `TTK_METRICS`             | false          | Serves Prometheus metrics at GET /metrics to metrics:read or admin.                                                                             |
| `TTK_CONFIRM_DESTRUCTIVE` | true           | Ask a client that declared form elicitation to confirm the seven destructive tools.                                                             |
| `TTK_HUMAN_HANDOFF`       | true           | Offers browser_request_human over HTTP, which hands out live-view links the person opens by signing in.                                         |

## Logging

| Variable         | Default | Meaning                                                                          |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `TTK_LOG_LEVEL`  | info    | Log level. One of `debug`, `info`, `warn`, `error`.                              |
| `TTK_LOG_FORMAT` | json    | pretty for human-readable lines; anything else is JSON. One of `json`, `pretty`. |

## Coding sandbox

| Variable                 | Default    | Meaning                                                                                                        |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `TTK_SANDBOX_URL`        | none (off) | Origin of the sandbox service (http or https, no path, credentials, query or fragment).                        |
| `TTK_SANDBOX_TOKEN_FILE` | none       | File holding the shared bearer token (at least 32 characters, no whitespace) the gateway and the sandbox read. |

The gateway needs both or neither: one set alone refuses startup. Both services read `secrets/ttk_sandbox_token`, which
`deno task setup` writes; `docker-compose.yml` mounts it read-only into the gateway and the sandbox as the
`ttk_sandbox_token` secret and sets `TTK_SANDBOX_TOKEN_FILE` to `/run/secrets/ttk_sandbox_token` on both (the sandbox
image's default). The sandbox reads it once, only as a regular file of at most 4096 bytes and never through a symlink,
then gives up its read grant.

## Sandbox service

Read by the sandbox service, not the gateway, and only the names its `--allow-env` grants: the image's `CMD` grants
`TTK_SANDBOX_TOKEN_FILE` and the two `TTK_SANDBOX_GIT_*` names, the Docker overlay's command the rest. Any other name
reads as unset.

| Variable                         | Default                          | Meaning                                                                                                                          |
| -------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_SANDBOX_BACKEND`            | bwrap                            | A bubblewrap cage per command, or one hardened container per workspace through the Engine API. One of `bwrap`, `docker`.         |
| `TTK_SANDBOX_DOCKER_SOCKET`      | /var/run/docker.sock             | The Engine API unix socket, an absolute path.                                                                                    |
| `TTK_SANDBOX_WORKSPACE_IMAGE`    | tykotech-sandbox-workspace:0.2.0 | The image each workspace container runs, named by a tag or a digest.                                                             |
| `TTK_SANDBOX_DOCKER_VOLUME`      | ttk-code                         | The Docker volume that holds the workspaces.                                                                                     |
| `TTK_SANDBOX_DOCKER_SOCK_VOLUME` | ttk-sandbox-sock                 | The Docker volume that carries the registry proxy socket into workspace containers; must differ from the code volume.            |
| `TTK_SANDBOX_GIT_HOSTS`          | none (off)                       | Exact host names (at most 64) a public sandbox_clone may reach over https; Compose names GitHub, GitLab, Bitbucket and Codeberg. |
| `TTK_SANDBOX_GIT_REMOTES_FILE`   | none (off)                       | Must be /run/secrets/ttk_git_remotes: credentialed remotes a caller names by id.                                                 |

## Agents

Model providers file format: [Guide › Model providers](../guide.md#model-providers).

| Variable                     | Default                                 | Meaning                                                                                                                                                  |
| ---------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TTK_AGENT_PEERS_FILE`       | none                                    | File holding a JSON array of A2A peers ([Guide › A2A](../guide.md#a2a)); without it `agent_delegate` is absent.                                          |
| `TTK_A2UI_ACTIONS`           | []                                      | Inline JSON array of up to 32 operator-defined A2UI button actions, `{ name, tool, arguments?, context? }`; a tool that cannot run as a task is refused. |
| `TTK_AGENT_TASK_TIMEOUT_S`   | 600 (10–86400)                          | How long a text or delegation task may run, in seconds.                                                                                                  |
| `TTK_AGENT_TASK_RETENTION_S` | 86400 (60–2592000)                      | How long finished agent tasks are kept, in seconds.                                                                                                      |
| `TTK_A2A_PUSH_ALLOWED_HOSTS` | empty (push off)                        | Hosts (`host` or `host:port`) A2A push webhooks may target over https; private, loopback and link-local addresses are refused.                           |
| `TTK_MODEL_PROVIDERS_FILE`   | none (add providers in System › Agents) | Seed file of model providers, copied into the database once with its keys sealed (a key needs `TTK_DB_KEY_FILE`); never written.                         |

## Compose

The variables in this table are Compose interpolation only; the server never reads them. Compose reads them from `.env`
beside `docker-compose.yml`, which `setup` (run by the start scripts) writes from `.env.example` with `TTK_BIND`,
`TTK_PUBLIC_URL`, `TTK_ALLOWED_DOMAINS` and `TTK_GATEWAY_MEMORY`. Of the services' own variables, `.env` reaches only
those the compose files pass on: `TTK_PUBLIC_URL`, `TTK_ALLOWED_HOSTS`, `TTK_ALLOWED_ORIGINS`, `TTK_ALLOWED_DOMAINS`
and, with the Docker overlay, `TTK_SANDBOX_WORKSPACE_IMAGE`, `TTK_SANDBOX_DOCKER_VOLUME` and
`TTK_SANDBOX_DOCKER_SOCK_VOLUME`. Set any other under `environment:` in a `docker-compose.override.yml`.

| Variable                 | Default   | Meaning                                                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------------ |
| `TTK_BIND`               | 127.0.0.1 | Host address the container port is published on; 0.0.0.0 exposes it on the network.  |
| `TTK_SANDBOX_DOCKER_GID` | 0         | The group that owns the Docker socket on the host, for the docker sandbox overlay.   |
| `TTK_GATEWAY_MEMORY`     | 1536m     | Memory limit of the gateway container: the server and every browser session it runs. |
| `TTK_GATEWAY_HEAP_MB`    | 1024      | The gateway's JavaScript heap limit in MiB (DENO_V8_FLAGS --max-old-space-size).     |

## Browser-layer variables

Read by the vendored browser layer only where the process grants them (the test tasks).

| Variable                                         | Default                      | Meaning                                                         |
| ------------------------------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `BUA_BROWSER_PATH`, `BROWSER_USE_BROWSER_PATH`   | —                            | Browser discovery, after `TTK_BROWSER_PATH`.                    |
| `BUA_CDP_TIMEOUT_S`, `BROWSER_USE_CDP_TIMEOUT_S` | `60`                         | Per-request CDP timeout, seconds.                               |
| `BUA_CDP_WIRE_LOG`                               | off                          | `1` or `true` logs one JSON line per CDP frame to stderr.       |
| `TIMEOUT_<EventClassName>`                       | the event's own (30 if none) | Override one event handler's timeout, seconds; `0` disables it. |

## Test-only variables

| Variable                                                                                             | Used by                     | Meaning                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `BUA_TEST_CHROMIUM`                                                                                  | browser tier                | Chromium for the browser tests; the test tasks set it.                              |
| `BUA_REQUIRE_BROWSER`                                                                                | browser tier                | A missing browser fails instead of skipping.                                        |
| `BUA_TEST_UNSANDBOXED`                                                                               | browser tier                | Set, also runs a launch without Chromium's sandbox.                                 |
| `TTK_UI_EVIDENCE_DIR`                                                                                | browser tier                | Directory the workspaces test saves a screenshot to.                                |
| `TTK_MODEL_CONFIG`, `TTK_MODEL_BASE_URL`, `TTK_MODEL_API_KEY`, `TTK_MODEL_NAME`, `ANTHROPIC_API_KEY` | `scripts/model_endpoint.ts` | Optional real model for the sampling test leg. The server itself never reads these. |
| `TTK_SANDBOX_TEST_DIR`                                                                               | sandbox cage tests          | Temporary directory root.                                                           |
