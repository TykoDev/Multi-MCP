# Connecting clients

| Transport            | Endpoint                                 | Credential                             |
| -------------------- | ---------------------------------------- | -------------------------------------- |
| MCP, Streamable HTTP | `http://<host>:8787/mcp`                 | `Authorization: Bearer ttk_…` or OAuth |
| MCP, stdio           | `deno task stdio` / `tykotech-mcp stdio` | none (scopes from `TTK_ANON_SCOPES`)   |
| A2A 1.0              | `/a2a` (JSON-RPC), `/a2a/v1` (HTTP+JSON) | Bearer key with `agent:invoke`         |
| ACP                  | `deno task acp` / `tykotech-mcp acp`     | An editor, through the agent runner    |

## HTTP

`deno task setup` printed one API key, `client`, holding every scope the stack's features need. Mint one per client with
the scopes it needs; `--save` adds it to `secrets/ttk_api_keys.json`, which the gateway reloads live:

```sh
deno task doctor --new-key my-client --scopes mcp:invoke,view:watch --save
```

**Claude Code**

```sh
claude mcp add --transport http multi-mcp http://127.0.0.1:8787/mcp --header "Authorization: Bearer ttk_<key>"
```

**Any Streamable HTTP client**

```json
{
	"mcpServers": {
		"multi-mcp": {
			"type": "http",
			"url": "http://127.0.0.1:8787/mcp",
			"headers": { "Authorization": "Bearer ttk_<key>" }
		}
	}
}
```

With `TTK_OAUTH_ISSUER` set, clients that support MCP authorization discover the identity provider from the `401`
challenge; no static header. 2025-era clients get `Mcp-Session-Id` sessions with `resources/subscribe` and are told to
re-list their tools after a deploy or a scope change ([change push](../reference/mcp-protocol.md#notifications));
`TTK_MCP_STATEFUL=false` turns sessions off, and a cluster runs without them.

## stdio

The client starts the server as a subprocess. With `TTK_DATA_DIR` and `TTK_DB_KEY_FILE`, it opens the same `ttk.db` as
the HTTP server (providers, sealed keys, browser secrets, memory), read once at start.

**Claude Code**

```sh
claude mcp add multi-mcp -e TTK_DATA_DIR=data -e TTK_DB_KEY_FILE=secrets/ttk_db_key \
  -- deno task --cwd /absolute/path/to/multi-mcp stdio
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
	"mcpServers": {
		"multi-mcp": {
			"command": "deno",
			"args": ["task", "--cwd", "/absolute/path/to/multi-mcp", "stdio"],
			"env": { "TTK_DATA_DIR": "data", "TTK_DB_KEY_FILE": "secrets/ttk_db_key" }
		}
	}
}
```

A compiled binary works the same: `"command": "/path/to/tykotech-mcp", "args": ["stdio"]`.

stdio callers hold `TTK_ANON_SCOPES` (default `mcp:invoke,view:watch,view:control,files:read`). Add what you need:

| Add                            | For                                                         |
| ------------------------------ | ----------------------------------------------------------- |
| `files:write`                  | Memory and library writes                                   |
| `agent:invoke`, `model:invoke` | The built-in model agent                                    |
| `sandbox:execute`              | Coding workspaces (needs `TTK_SANDBOX_URL`)                 |
| `task`, `evaluate`, `admin`    | `browser_run_task`, `browser_evaluate`, `browser_close_all` |

Not on stdio: live view, MCP Apps, event streams, recording, signed links, `browser_request_human`. The `stdio` task
grants loopback network only, so `browser_head` is withheld and only local model providers are reachable. stdio reads
the files in `secrets/` as you; if they were once `chown`ed to the containers' uid, see
[secrets/README.md](../../secrets/README.md#permissions).

## First calls

1. `tools/list`, then read `ttk://capabilities`: what is withheld and why.
2. `browser_navigate`, then `browser_get_state`. Pass element `index` and `state_token` to interaction tools.
3. After the page changes, read state again; a stale token answers `element-not-found`.
4. Wait with `browser_wait_for`, not by polling.

## Client capabilities the server uses

| Client declares  | Effect                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Sampling         | `browser_extract_content` and `browser_run_task` run on your model (`sampling.tools` gets tools). |
| Form elicitation | The seven destructive tools ask for confirmation; `browser_fill_secret` offers permitted secrets. |
| URL elicitation  | `browser_request_human` shows the live-view link to the user.                                     |
| MCP Apps         | `browser_live_view`, `a2ui_publish` and `sandbox_session_open` render live inside the host.       |

For MCP Apps, add the host's sandbox hostname to `TTK_ALLOWED_ORIGINS` and serve the gateway on an `https`
`TTK_PUBLIC_URL` the host can reach.

## A2A

Read `/.well-known/agent-card.json`, then send JSON-RPC to `/a2a` with `A2A-Version: 1.0` and a key holding
`agent:invoke`. A `data` part `{ "tool": "<name>", "arguments": {…} }` runs one MCP tool; a `text` part runs the
built-in model agent or the ACP agent. SlopLord, the built-in coding agent, has its own card at
`/a2a/agents/sloplord/.well-known/agent-card.json`. See [Agents and sandbox](coding-and-agents.md#a2a).

## Watching from a browser

Open the server's root URL, sign in with a password account or an API key, and choose **Live View**. See
[Web app](web-app.md).
