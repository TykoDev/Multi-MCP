# Monitoring

## Health

```sh
curl -s http://127.0.0.1:8787/healthz     # {"status":"ok","version":"0.2.0","sessions":3}
```

Public, not rate-limited, answers while draining. Both images probe it every 30 s. The sandbox and agent runner have
their own health checks; the gateway waits for them.

## Diagnostics

`GET /api/v1/system/diagnostics` (`admin`) returns uptime, memory, sessions and the effective configuration; the web
app's **System** screen shows the same. Alert when:

| Field                        | Alert when                                 |
| ---------------------------- | ------------------------------------------ |
| `chromiumSandboxed`          | `false`                                    |
| `hasAdminUser`               | `false` (no enabled account holds `admin`) |
| `userStore`, `loginStore`    | `unreadable`                               |
| `sandboxEnabled`             | `false` where the sandbox is deployed      |
| `modelProviders[].reachable` | `false`                                    |

`ttk doctor` prints the database summary: providers, sealed secrets, memory items, and whether the key is set.

An MCP client can call `browser_health` with its own credential: session counts, unresponsive browsers (each probed with
a 2 s timeout), and the capability block.

## Prometheus

With `TTK_METRICS=true`, `GET /metrics` serves Prometheus text to `metrics:read` or `admin`.

```sh
deno task doctor --new-key prometheus --scopes metrics:read
```

```yaml
scrape_configs:
  - job_name: multi-mcp
    scheme: https
    authorization: { type: Bearer, credentials_file: /etc/prometheus/ttk_key }
    static_configs: [{ targets: ['mcp.example.com:443'] }]
```

| Family                     | Type    | Labels                                              |
| -------------------------- | ------- | --------------------------------------------------- |
| `ttk_http_requests_total`  | counter | `route`, `status`                                   |
| `ttk_tool_calls_total`     | counter | `tool`, `outcome` (`ok`, `error`, `input_required`) |
| `ttk_sessions`             | gauge   | `state` (`active`, `idle`, `human_control`)         |
| `ttk_viewers`              | gauge   | —                                                   |
| `ttk_rate_limited_total`   | counter | —                                                   |
| `ttk_login_failures_total` | counter | —                                                   |
| `ttk_process_*_bytes`      | gauge   | resident, heap total, heap used, external           |

No credential, URL, session id or argument becomes a label.

## OpenTelemetry (bundled image)

```yaml
environment:
  OTEL_DENO: 'true'
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
  TTK_OTEL_ENDPOINTS: http://otel-collector:4318
  OTEL_SERVICE_NAME: multi-mcp
  OTEL_DENO_CONSOLE: ignore
```

- Each tool call becomes a `ttk.tool` span with only `tool` and `outcome`.
- Startup is refused unless every endpoint origin is in `TTK_OTEL_ENDPOINTS`.
- Redact `url.full` and `url.query` at the collector: request spans carry live-view tickets and link tokens.
- Key and account generation is refused while exporting. The slim image cannot export.

## Logs

One JSON object per line (`TTK_LOG_FORMAT=pretty` for humans; `TTK_LOG_LEVEL` `debug`…`error`). Correlate with
`x-request-id`. Secrets, passwords and tokens are never logged.

```sh
docker compose logs -f tykotech-mcp | jq 'select(.level == "warn" or .level == "error")'
```

Worth alerting on: startup lines `error: …` (exit 1, restart loop), `auth.login_failed`, `auth.login_throttled`,
`auth.csrf_failed`, `rate limit exceeded for …`, `… is not reachable; its tools are withheld`,
`no enabled account holds the admin scope…`, `TTK_CHROMIUM_NO_SANDBOX is set…`, and any `level: "error"`.

## What to watch

| Signal                | Source                                 | Alert                    |
| --------------------- | -------------------------------------- | ------------------------ |
| Liveness              | `/healthz`, container health           | Unhealthy for 2 minutes  |
| Restart loop          | Container restarts                     | Any                      |
| Session pressure      | `sessions.total` vs `TTK_MAX_SESSIONS` | Above 80% for 10 minutes |
| Memory                | `memory.rss`, container stats          | Near the container limit |
| Failed sign-ins       | `rate(ttk_login_failures_total[5m])`   | A spike                  |
| Unresponsive browsers | `browser_health`                       | Above 0 for 5 minutes    |
| Optional services     | `… is not reachable` log lines         | Any                      |
