# Error codes

Codes and slugs are stable: branch on them, not on message text. Messages never quote a secret or an upstream body.

## MCP tool errors

A failed tool call is a result, not a JSON-RPC error:

```json
{
	"isError": true,
	"content": [{ "type": "text", "text": "Error: human-has-control: a live-view user has taken control of session …" }],
	"structuredContent": { "error": { "code": "human-has-control", "message": "…" } }
}
```

Checks run in this order: unknown tool (JSON-RPC error) → `scope-required` → `feature-unavailable` → `invalid-arguments`
→ confirmation (`user-declined`) → handler → output-schema check.

| Code                       | Meaning                                                                                                     | Extra fields                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `unknown-session`          | No such session, or another principal's in `owner` mode.                                                    |                                  |
| `session-limit`            | `TTK_MAX_SESSIONS` reached.                                                                                 |                                  |
| `human-has-control`        | A person holds the takeover lock; mutating tools wait, read-only tools work.                                |                                  |
| `navigation-blocked`       | Scheme not http/https, host outside `TTK_ALLOWED_DOMAINS`, or a secret not permitted on the frame's origin. |                                  |
| `timeout`                  | An operation exceeded its deadline.                                                                         |                                  |
| `unknown-tab`              | No such tab in the session.                                                                                 |                                  |
| `unknown-index`            | The element table has no such index.                                                                        |                                  |
| `element-not-found`        | `state_token` does not match the current table, or there is no table yet.                                   | `reason`, `state_token`, `index` |
| `element-not-interactable` | The element cannot take the action (wrong tag, disabled, no box).                                           | `index`, `tag`                   |
| `dialog-open`              | A held JavaScript dialog blocks the page; answer it with `browser_handle_dialog`.                           | `dialog_id`, `dialog_kind`       |
| `download-failed`          | The download was refused when it started.                                                                   | `file_id`, `reason`              |
| `browser-crashed`          | The browser process died.                                                                                   |                                  |
| `browser-unavailable`      | Generic browser or server failure, or a cancelled call.                                                     |                                  |
| `browser-error`            | A remote failure for `browser_head` (`dns`, `refused`, `reset`, `tls`, …).                                  |                                  |
| `invalid-arguments`        | Arguments invalid by schema or by meaning (e.g. no sampling support, a finished task).                      |                                  |
| `unknown-file`             | `file_id` never tracked by this session.                                                                    |                                  |
| `file-unavailable`         | The file or library item exists but cannot be delivered now, or a memory collection is missing.             |                                  |
| `scope-required`           | The credential lacks a scope. The message never names it.                                                   |                                  |
| `feature-unavailable`      | The deployment cannot offer the tool now (no data dir, no ffmpeg, no egress, service down, switch off).     | `feature`                        |
| `user-declined`            | The client's user declined a confirmation, handoff or secret choice.                                        |                                  |

Extension and library tools map service failures by status: 400 → `invalid-arguments`, 404 → `file-unavailable`, else
`feature-unavailable`, in fixed words.

## HTTP problem documents

```json
{
	"type": "https://tykotech.eu/problems/forbidden-scope",
	"title": "Insufficient scope",
	"status": 403,
	"x-request-id": "01J…",
	"detail": "…"
}
```

| Slug                                                  | Status | Typical cause                                                                                      |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `unauthenticated`                                     | 401    | No or bad credential; failed sign-in; a bad signed link.                                           |
| `forbidden-scope`                                     | 403    | Missing scope; a `ttkd_` token outside `/mcp`.                                                     |
| `origin-forbidden`                                    | 403    | `Origin` not allowed, or a bound ticket redeemed elsewhere.                                        |
| `csrf-failed`                                         | 403    | Cookie request without own origin or `x-ttk-csrf`.                                                 |
| `host-forbidden`                                      | 400    | `Host` not in the allowlist (set `TTK_PUBLIC_URL`).                                                |
| `rate-limited`                                        | 429    | Rate limit, sign-in backoff, viewer or stream caps. Carries `Retry-After`.                         |
| `unknown-session`                                     | 404    | The session is not on this node or not yours.                                                      |
| `ticket-expired`, `ticket-consumed`, `ticket-invalid` | 403    | Live-view ticket problems.                                                                         |
| `payload-too-large`                                   | 413    | Body over its limit.                                                                               |
| `not-found`                                           | 404    | Unknown route or object.                                                                           |
| `invalid-request`                                     | 400    | Malformed body, policy refusal, non-canonical path.                                                |
| `persistence-required`                                | 409    | Needs `TTK_DATA_DIR`.                                                                              |
| `conflict`                                            | 409    | Duplicate, last-admin protection, target exists, sandbox busy, no `TTK_DB_KEY_FILE` to seal a key. |
| `service-unavailable`                                 | 503    | Draining for shutdown, or the owning cluster node is unreachable.                                  |
| `internal`                                            | 500    | Unhandled error or failed store write.                                                             |

Other shapes: bearer failures on `/mcp` answer the SDK's OAuth body (`invalid_token`); unparseable JSON is plain
`400 Invalid JSON`; a missing web bundle is `503`.

## Live-view socket

Sent as `{ "type": "error", "code", "message", "reason"? }`.

| Code                 | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `not-holder`         | Input or control message without the lock, or on a watch socket. |
| `lock-held`          | Another viewer holds the lock.                                   |
| `bad-message`        | Failed schema validation, or unknown tab.                        |
| `navigation-blocked` | `navigate` URL or a redirect hop off the allowlist.              |
| `input-rejected`     | Input outside the viewport, or an unsupported key.               |
| `not-ready`          | No frame yet, or the session is not connected.                   |
| `browser-crashed`    | The browser died; the socket closes.                             |
| `internal`           | Input injection failed.                                          |

## A2A

JSON-RPC errors on `/a2a`: `-32001` task not found, `-32002` not cancelable, `-32003` push not offered, `-32004`
unsupported operation (e.g. no ACP agent or model provider, provider unreachable), `-32005` unsupported content,
`-32009` missing `A2A-Version: 1.0`, `-32600` missing scope, `-32601` unknown method, `-32602` invalid parameters, and
`-32000` as the terminal event of a stream the server ended (`unauthorized`, `stream-expired`, `server-shutdown`). The
HTTP+JSON binding and `POST /api/v1/agent/tasks` map them to problem documents.

## Startup refusals

One line, `error: <VARIABLE>: <problem>`, exit 1, before anything listens. The common ones:

| Line                                                                                  | Fix                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `TTK_HOST: refusing to bind 0.0.0.0 with no credentials configured`                   | Configure an API key, account or OAuth issuer.                             |
| `TTK_DB_KEY_FILE: the key does not open this database`                                | Mount the key the database was created with.                               |
| `TTK_DB_KEY_FILE: the database holds encrypted secrets and no key is set`             | Set `TTK_DB_KEY_FILE`.                                                     |
| `TTK_MODEL_PROVIDERS_FILE: provider <id> has a key, and TTK_DB_KEY_FILE is not set …` | Set `TTK_DB_KEY_FILE`, or remove the key.                                  |
| `TTK_SECRETS: browser secrets are configured, and TTK_DB_KEY_FILE is not set …`       | Set `TTK_DB_KEY_FILE`.                                                     |
| `database (<path>): …`                                                                | `TTK_DATA_DIR` not writable by the process, or not this server's database. |
| `tykotech-mcp: refusing to start: …` (stderr)                                         | OpenTelemetry endpoint not in `TTK_OTEL_ENDPOINTS`.                        |
