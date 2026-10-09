# MCP protocol

Protocol-level behaviour. Tools: [MCP tools](mcp-tools.md).

## Identity

| Item              | Value                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Name / title      | `tykotech-mcp` / `Multi-MCP` (registry name `eu.tykotech/tykotech-mcp`, see `server.json`)                     |
| Description       | "Browser control with a live view, a coding sandbox and agents over MCP"                                       |
| Version           | `0.2.0`                                                                                                        |
| Website, icon     | `TTK_PUBLIC_URL` origin and `/assets/brand/icon-192.png`; omitted on stdio and on a wildcard bind (`0.0.0.0`). |
| SDK               | `@modelcontextprotocol/server` 2.0.0 with the `@modelcontextprotocol/hono` adapter                             |
| Protocol versions | `2026-07-28` (stateless), `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`                 |
| `instructions`    | ≤2 KiB, built from the caller's scopes; never contains configuration values.                                   |

## Transports

| Transport       | Endpoint                                 | Model                                                                                                            |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Streamable HTTP | `POST`/`GET`/`DELETE /mcp`               | Stateless: one server per request, built from the caller's scopes. Browser state lives in sessions.              |
| Stateful HTTP   | `/mcp` with `TTK_MCP_STATEFUL=true`      | `Mcp-Session-Id` sessions for 2025-era clients (≤64, 30 min idle); adds `resources/subscribe`. Not in a cluster. |
| stdio           | `tykotech-mcp stdio` / `deno task stdio` | One server per connection; logs to stderr; scopes from `TTK_ANON_SCOPES`.                                        |

`/mcp` is mounted only when a credential is configured or the bind is loopback. stdio has no live view, event streams,
recorder, signed links, handoff or MCP Apps.

## Capabilities

| Capability              | When                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `tools.listChanged`     | always                                                              |
| `resources.listChanged` | always                                                              |
| `resources.subscribe`   | stateful HTTP and stdio connections                                 |
| `prompts`               | the library holds a prompt or skill and the caller has `files:read` |
| `completions`           | the caller has a resource template                                  |
| `tykotech`              | always (vendor block, scope-filtered)                               |

The `tykotech` block is also served as resource `ttk://capabilities` and in `browser_health`. SDK clients strip unknown
capability keys, so read the resource. Keys: `version`, `live_view`, `events`, `fields`, `state_token`, `tools_withheld`
(`[{ name, reason }]`, reason `scope-required` or `feature-unavailable`), `browser.sandboxed`, `sessions.ownership`,
`sandbox.backend`, `model`.

## Resources

| URI                                        | Content                                                          | Needs                        |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------- |
| `ttk://capabilities`                       | The capability block (JSON).                                     | `/mcp` access                |
| `ttk://session/{sessionId}/{kind}`         | `state`, `screenshot` (PNG) or `page`. Never launches a browser. | `mcp:invoke`                 |
| `ttk://session/{sessionId}/files/{fileId}` | A session file, base64, ≤1 MiB.                                  | `mcp:invoke`                 |
| `ttk://share/{+path}`                      | A file-share file, ≤1 MiB.                                       | `files:read`, `TTK_DATA_DIR` |
| `ttk://skill/{name}`                       | A skill's `SKILL.md`.                                            | `files:read`, `TTK_DATA_DIR` |
| `ui://tykotech/live-view`                  | MCP Apps live-view embed.                                        | `mcp:invoke`, `TTK_MCP_APPS` |
| `ui://tykotech/a2ui-surface`               | MCP Apps read-only A2UI surface embed.                           | `mcp:invoke`, `TTK_MCP_APPS` |

`completion/complete` completes the template arguments (`sessionId`, `kind`, `fileId`, `path`, skill `name`), ≤100
values. Stored prompt templates and skills (`skill:<name>`) are listed as MCP prompts.

## Notifications

| Notification                           | When                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `notifications/tools/list_changed`     | The sandbox or agent runner becomes reachable or unreachable (30 s probe). |
| `notifications/resources/list_changed` | A session or its file list changes.                                        |
| `notifications/resources/updated`      | A session's page changes (subscribed URIs on 2025-era connections).        |
| `notifications/progress`               | Every second for a call that sent a `progressToken`.                       |

Stateless clients receive notifications over `subscriptions/listen`. A cancelled call aborts tools that wait and answers
`browser-unavailable` ("`<tool>` was cancelled by the caller").

## Sampling

The server hosts no model for these two tools; they borrow the client's:

- `browser_extract_content` asks one question about the page (≤24 000 characters of page text).
- `browser_run_task` asks for one action per step (`navigate`, `click`, `type`, `press_key`, `scroll`, `go_back`,
  `switch_tab`, `done`). A client declaring `sampling.tools` gets them as tools. A spent budget parks the run;
  `resume: true` continues it.

Without client sampling support both answer `invalid-arguments`. The built-in model agent is separate and calls a
configured provider ([Agents and sandbox](../guides/coding-and-agents.md)).

## Elicitation

Asked only of clients that declared the mode:

| Use           | Mode | When                                                                               |
| ------------- | ---- | ---------------------------------------------------------------------------------- |
| Confirmation  | form | Before the seven destructive tools, while `TTK_CONFIRM_DESTRUCTIVE` is on.         |
| Secret choice | form | `browser_fill_secret` named a secret that is unknown or not permitted on the page. |
| Human handoff | url  | `browser_request_human`, while `TTK_HUMAN_HANDOFF` is on.                          |

Declining is `user-declined`. On `2026-07-28` these run as `input_required` rounds whose `requestState` is HMAC-sealed
per process for 600 s; a forged, expired or foreign one is JSON-RPC `-32602`. A retry on another cluster node fails the
same way.

## Results and errors

- Every tool returns `structuredContent` matching its `outputSchema`, plus text. Extension and library results sit
  inside `{ result }`.
- Images: `browser_screenshot`, `browser_get_state` with `include_screenshot`. Embedded resources or resource links:
  `browser_get_file`, `browser_pdf`, `browser_har_export`.
- Failures are results (`isError: true`, `Error: <code>: …`). The only JSON-RPC errors are an unknown tool and an
  invalid `requestState`. Codes: [error reference](error-codes.md).

## MCP Apps

On while `TTK_MCP_APPS` is `watch` or `control` (default `control` on a single node; off in a cluster; never on stdio).

- `browser_live_view` and `a2ui_publish` link their results to the two `ui://` embeds; `browser_live_ticket` is
  app-only.
- Each embed is one self-contained HTML document with a hash-pinned inline script and style and a `default-src 'none'`
  CSP whose only connect source is the gateway's WebSocket origin.
- The live-view embed connects only after the user presses Watch, with a 30 s single-use ticket bound to its origin. Add
  the host's sandbox hostname to `TTK_ALLOWED_ORIGINS`; `TTK_MCP_APPS_ORIGINS` narrows which origins may be bound.

## Authorization

With `TTK_OAUTH_ISSUER` the gateway is an OAuth 2.1 resource server: RFC 9728 metadata at
`/.well-known/oauth-protected-resource`, `401` with `WWW-Authenticate: Bearer … resource_metadata`, the issuer's own
metadata at `/.well-known/oauth-authorization-server`, RS256/ES256 tokens checked against its JWKS and the audience
(`TTK_OAUTH_AUDIENCE`, default `TTK_PUBLIC_URL`). It issues no tokens and registers no clients.

## Not implemented

MCP tasks (`tasks/*`; use `agent_run_tool`), prompt-argument completions, roots, `logging/setLevel`, step-up
authorization challenges.
