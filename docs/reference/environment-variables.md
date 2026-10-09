# Environment variables

Read once at startup. An invalid value stops startup with `<VARIABLE>: <problem>`, never quoting a secret.
`deno task doctor` (or `ttk doctor` in the image) prints what the server parsed.

| Format   | Rule                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| list     | Comma-separated; entries trimmed, empty entries dropped.                                            |
| integer  | Whole number in the stated range.                                                                   |
| boolean  | `1`, `true`, `yes`, `on` / `0`, `false`, `no`, `off`, any case.                                     |
| `*_FILE` | Path to a file holding the value; one trailing newline stripped. Never copied into the environment. |

## Reachability

Behind a reverse proxy or on a LAN, set `TTK_PUBLIC_URL` to the address clients use; it opens both allowlists to that
host.

| Variable              | Default                                                        | Meaning                                                                              |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TTK_HOST`            | 127.0.0.1                                                      | Bind address; a non-loopback bind needs API keys, OAuth or a user account.           |
| `TTK_PORT`            | 8787 (0–65535)                                                 | Bind port; 0 picks a free port.                                                      |
| `TTK_PUBLIC_URL`      | http://127.0.0.1:<port> on loopback, else http://<host>:<port> | The URL clients use; it seeds the Host and Origin allowlists and the OAuth audience. |
| `TTK_ALLOWED_HOSTS`   | derived from the public URL and the bind                       | Host header allowlist (DNS-rebinding guard); setting it replaces the derived list.   |
| `TTK_ALLOWED_ORIGINS` | derived from the public URL                                    | Browser Origin allowlist as bare hostnames; setting it replaces the derived list.    |

## Authentication

A non-loopback bind refuses to start without API keys, an OAuth issuer or an account. Inline and `_FILE` forms of one
variable cannot both be set.

| Variable              | Default                                    | Meaning                                                                                        |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `TTK_API_KEYS`        | none                                       | Inline JSON array of hashed key records; prefer the file form.                                 |
| `TTK_API_KEYS_FILE`   | none                                       | File holding the hashed key records; watched and reloaded on change.                           |
| `TTK_ADMIN_USER`      | none                                       | Inline PBKDF2 account record that seeds the user store; prefer the file form.                  |
| `TTK_ADMIN_USER_FILE` | none; secrets/ttk_admin_user.json is tried | File holding the account record that seeds the user store on first start.                      |
| `TTK_LOGIN_TTL_S`     | 604800 (60–31536000)                       | Lifetime of sign-in sessions, in seconds.                                                      |
| `TTK_ANON_SCOPES`     | the default grant                          | Scopes for credential-less principals (loopback development, stdio); set but empty means none. |
| `TTK_OAUTH_ISSUER`    | none (OAuth off)                           | Issuer URL; enables OAuth 2.1 resource-server mode.                                            |
| `TTK_OAUTH_AUDIENCE`  | TTK_PUBLIC_URL                             | Expected aud claim.                                                                            |
| `TTK_OAUTH_JWKS_URL`  | discovered                                 | JWKS location.                                                                                 |
| `TTK_API_KEYS_REF`    | none                                       | Read the key records once at startup from a secret provider (vault: or op: reference).         |
| `TTK_SECRETS_REF`     | none                                       | Read the browser secrets once at startup from a secret provider.                               |

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

`TTK_BROWSER_ARGS` refuses any switch that weakens the sandbox, relocates the DevTools endpoint or profile, or runs
another program.

| Variable                    | Default                     | Meaning                                                                                                          |
| --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TTK_ALLOWED_DOMAINS`       | empty (unrestricted)        | Navigation allowlist: a host matches itself and its subdomains.                                                  |
| `TTK_ALLOWED_DOMAINS_SCOPE` | documents                   | What Chromium judges against the allowlist: document requests only, or every request. One of `documents`, `all`. |
| `TTK_SESSION_OWNERSHIP`     | owner (shared in a cluster) | Whether sessions are shared among mcp:invoke holders or bound to their creator. One of `shared`, `owner`.        |
| `TTK_BROWSER_PATH`          | discovered                  | Chromium executable.                                                                                             |
| `TTK_BROWSER_ARGS`          | none                        | Extra Chromium switches; anything that weakens the sandbox is refused.                                           |
| `TTK_CHROMIUM_NO_SANDBOX`   | false                       | Runs Chromium without its sandbox; the only way to do so, and no shipped image sets it.                          |
| `TTK_HEADLESS`              | true                        | Run Chromium headless.                                                                                           |
| `TTK_MAX_SESSIONS`          | 8 (1–128)                   | Concurrent browser sessions.                                                                                     |
| `TTK_SESSION_TTL_S`         | 1800 (10–86400)             | Idle seconds before a session is closed; a session with a viewer is never closed for idleness.                   |
| `TTK_SECRETS`               | none                        | Inline JSON object of browser secrets; prefer the file form.                                                     |
| `TTK_SECRETS_FILE`          | none                        | File holding the browser secrets a model references by name; values are never returned.                          |

## Storage and recording

In both images `TTK_DATA_DIR=/data` and `TTK_FFMPEG=/usr/bin/ffmpeg`. Keep `TTK_DB_KEY_FILE` off the data volume.

| Variable          | Default                    | Meaning                                                                                            |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `TTK_DATA_DIR`    | none (ephemeral)           | Persistent data directory: profiles, downloads, recordings, the share, users, agent state, ttk.db. |
| `TTK_DB_KEY_FILE` | none (no secret is stored) | File holding the 32-byte key that encrypts every secret in ttk.db.                                 |
| `TTK_FFMPEG`      | none (recording off)       | Path to ffmpeg; recording needs this and TTK_DATA_DIR.                                             |

## Signed links

| Variable                   | Default                                                                                               | Meaning                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `TTK_SIGNED_LINKS`         | true with TTK_SIGNED_LINK_KEY_FILE, or TTK_DATA_DIR plus TTK_DB_KEY_FILE on a single node; else false | Enables browser_file_link and the public links route.                |
| `TTK_SIGNED_LINK_TTL_S`    | 3600 (10–3600)                                                                                        | Default link life, in seconds.                                       |
| `TTK_SIGNED_LINK_KEY_FILE` | none (generated and sealed in ttk.db)                                                                 | File holding the link-signing key; every node of a cluster needs it. |

## Live view

| Variable           | Default    | Meaning                        |
| ------------------ | ---------- | ------------------------------ |
| `TTK_MAX_VIEWERS`  | 4 (1–64)   | Live-view viewers per session. |
| `TTK_CAST_QUALITY` | 60 (1–100) | Screencast JPEG quality.       |

## MCP Apps

Add the MCP host's sandbox hostname to `TTK_ALLOWED_ORIGINS`, or its embeds cannot connect.

| Variable               | Default                                               | Meaning                                                                                                   |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TTK_MCP_APPS`         | control (off in a cluster or without the embed build) | Serves the ui:// embeds; control lets an embed take control on a click. One of `off`, `watch`, `control`. |
| `TTK_MCP_APPS_ORIGINS` | none                                                  | Host-sandbox origins a ticket may be bound to; empty admits any https one TTK_ALLOWED_ORIGINS admits.     |
| `TTK_MCP_APPS_DOMAIN`  | none                                                  | Passed to the host as _meta.ui.domain.                                                                    |

## Limits and transport

| Variable                  | Default        | Meaning                                                                             |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `TTK_RATE_RPM`            | 120 (1–100000) | Requests per minute per principal; the burst is a third of this.                    |
| `TTK_MCP_STATEFUL`        | false          | Also serve 2025-era clients on a stateful mount with Mcp-Session-Id.                |
| `TTK_MAX_BODY_KB`         | 256            | Largest request body on the API routes, in KiB.                                     |
| `TTK_METRICS`             | false          | Serves Prometheus metrics at GET /metrics to metrics:read or admin.                 |
| `TTK_CONFIRM_DESTRUCTIVE` | true           | Ask a client that declared form elicitation to confirm the seven destructive tools. |
| `TTK_HUMAN_HANDOFF`       | true           | Offers browser_request_human, which hands out live-view links.                      |

## Logging

| Variable         | Default | Meaning                                                                          |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `TTK_LOG_LEVEL`  | info    | Log level. One of `debug`, `info`, `warn`, `error`.                              |
| `TTK_LOG_FORMAT` | json    | pretty for human-readable lines; anything else is JSON. One of `json`, `pretty`. |

## Cluster

Every node needs `--unstable-kv` (all shipped launchers have it). See
[Running a cluster](../guides/running-a-cluster.md).

| Variable         | Default            | Meaning                                                                                                        |
| ---------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `TTK_CLUSTER_KV` | none (single node) | A Deno KV path or URL shared by every node.                                                                    |
| `TTK_ROLE`       | all                | all hosts browsers and serves clients; browser hosts browsers; edge forwards. One of `all`, `browser`, `edge`. |
| `TTK_NODE_ID`    | node-<8 hex>       | This node id.                                                                                                  |
| `TTK_NODE_URL`   | none               | The URL other nodes use to reach this one.                                                                     |

## Coding sandbox

| Variable                 | Default    | Meaning                                                                        |
| ------------------------ | ---------- | ------------------------------------------------------------------------------ |
| `TTK_SANDBOX_URL`        | none (off) | Origin of the sandbox service.                                                 |
| `TTK_SANDBOX_TOKEN_FILE` | none       | File holding the shared bearer token the gateway and the sandbox service read. |

## Sandbox service

Read by the sandbox service, not the gateway.

| Variable                         | Default                          | Meaning                                                                                                                  |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TTK_SANDBOX_BACKEND`            | bwrap                            | A bubblewrap cage per command, or one hardened container per workspace through the Engine API. One of `bwrap`, `docker`. |
| `TTK_SANDBOX_DOCKER_SOCKET`      | /var/run/docker.sock             | The Engine API unix socket.                                                                                              |
| `TTK_SANDBOX_WORKSPACE_IMAGE`    | tykotech-sandbox-workspace:0.2.0 | The image each workspace container runs.                                                                                 |
| `TTK_SANDBOX_DOCKER_VOLUME`      | ttk-code                         | The Docker volume that holds the workspaces.                                                                             |
| `TTK_SANDBOX_DOCKER_SOCK_VOLUME` | ttk-sandbox-sock                 | The Docker volume that carries the registry proxy socket into workspace containers.                                      |
| `TTK_SANDBOX_GIT_HOSTS`          | none (off)                       | Exact host names a public sandbox_clone may reach over https.                                                            |
| `TTK_SANDBOX_GIT_REMOTES_FILE`   | none (off)                       | Must be /run/secrets/ttk_git_remotes: credentialed remotes a caller names by id.                                         |

## Agents

Model providers file format: [Agents and sandbox](../guides/coding-and-agents.md#model-providers).

| Variable                      | Default                                 | Meaning                                                                                          |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TTK_AGENT_BRIDGE_URL`        | none (off)                              | URL of the private ACP agent runner.                                                             |
| `TTK_AGENT_BRIDGE_TOKEN_FILE` | none                                    | File holding the bridge bearer token; required with the URL.                                     |
| `TTK_AGENT_DEFAULT`           | default                                 | The runner agent id to use.                                                                      |
| `TTK_AGENT_AUTH_METHOD`       | none                                    | ACP authentication method to select when the agent advertises it.                                |
| `TTK_AGENT_MCP_URL`           | <TTK_PUBLIC_URL>/mcp                    | The MCP URL handed to the agent with its delegated token; its path must be /mcp.                 |
| `TTK_AGENT_PEERS_FILE`        | none                                    | JSON array of A2A peers.                                                                         |
| `TTK_A2UI_ACTIONS`            | []                                      | Inline JSON array of operator-defined A2UI button actions.                                       |
| `TTK_AGENT_TASK_TIMEOUT_S`    | 600 (10–86400)                          | How long a text or delegation task may run, in seconds.                                          |
| `TTK_AGENT_TASK_RETENTION_S`  | 86400 (60–2592000)                      | How long finished agent tasks are kept, in seconds.                                              |
| `TTK_A2A_PUSH_ALLOWED_HOSTS`  | empty (push off)                        | Hosts A2A push webhooks may target; private, loopback and link-local addresses are refused.      |
| `TTK_MODEL_PROVIDERS_FILE`    | none (add providers in System › Agents) | Seed file of model providers, copied into the database once with its keys sealed; never written. |

## OpenTelemetry

Bundled image only. With `OTEL_DENO=true`, startup is refused unless every endpoint origin is in `TTK_OTEL_ENDPOINTS`.
`OTEL_EXPORTER_OTLP_HEADERS` is never read or granted.

| Variable                              | Default           | Meaning                                                                                               |
| ------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `TTK_OTEL_ENDPOINTS`                  | empty             | Collector origins the runtime may export to; while exporting, an endpoint off the list refuses start. |
| `OTEL_DENO`                           | off               | Turns OTLP export on; the runtime performs it outside the permission matrix (bundled image only).     |
| `OTEL_DENO_VSOCK`                     | unset             | Refused while exporting: vsock export cannot be allowlisted.                                          |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | unset             | Where to export; a credential-free http(s) URL on a listed origin.                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | the base endpoint | Where traces export, when it differs from the base.                                                   |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | the base endpoint | Where metrics export, when it differs from the base.                                                  |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`    | the base endpoint | Where logs export, when it differs from the base.                                                     |

## Compose

Compose interpolation only (`.env`); the server never reads these.

| Variable                 | Default                     | Meaning                                                                             |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| `TTK_BIND`               | 127.0.0.1                   | Host address the container port is published on; 0.0.0.0 exposes it on the network. |
| `TTK_AGENT_RUNNER_IMAGE` | tykotech-agent-runner:0.2.0 | The derived runner image that contains your ACP agent.                              |
| `TTK_SANDBOX_DOCKER_GID` | 0                           | The group that owns the Docker socket on the host, for the docker sandbox overlay.  |

## Browser-layer variables

Read by the vendored browser layer only where the process grants them (compiled binary, slim image, test tasks).

| Variable                                         | Default | Meaning                                         |
| ------------------------------------------------ | ------- | ----------------------------------------------- |
| `BUA_BROWSER_PATH`, `BROWSER_USE_BROWSER_PATH`   | —       | Browser discovery, after `TTK_BROWSER_PATH`.    |
| `BUA_CDP_TIMEOUT_S`, `BROWSER_USE_CDP_TIMEOUT_S` | `60`    | Per-request CDP timeout, seconds.               |
| `BUA_CDP_WIRE_LOG`                               | off     | `1` logs one JSON line per CDP frame to stderr. |
| `TIMEOUT_<EventClassName>`                       | 30      | Override one event handler's timeout, seconds.  |

## Test-only variables

| Variable                                                                                             | Used by                     | Meaning                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `BUA_TEST_CHROMIUM`                                                                                  | browser tier                | Chromium for the browser tests; the test tasks set it.                              |
| `BUA_REQUIRE_BROWSER`                                                                                | browser tier                | A missing browser fails instead of skipping.                                        |
| `TTK_MODEL_CONFIG`, `TTK_MODEL_BASE_URL`, `TTK_MODEL_API_KEY`, `TTK_MODEL_NAME`, `ANTHROPIC_API_KEY` | `scripts/model_endpoint.ts` | Optional real model for the sampling test leg. The server itself never reads these. |
| `TTK_SANDBOX_TEST_DIR`                                                                               | sandbox cage tests          | Temporary directory root.                                                           |
