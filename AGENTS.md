# AGENTS.md

Guidance for AI agents and developers changing Multi-MCP (`tykotech-mcp`): an MCP server with a sandboxed Chromium, a
live view, a coding sandbox and agents, on Deno 2.9 and the MCP TypeScript SDK v2. Human-facing docs start at
[README.md](README.md) and [docs/index.md](docs/index.md).

## Workflow

- Build the complete change in one coherent step that keeps `deno task ok` green. Read the code you change and its tests
  first; the docs in `docs/` describe behaviour, the code is the authority.
- If a request is too large or ambiguous, propose a short design (components, data flow, steps) and wait for approval.
- Update `docs/` in the same change when behaviour, a tool, a route or a `TTK_*` variable changes.

## Non-negotiables

- **Security by design.** Never emit CORS headers, publish the CDP port, or mount `/mcp` without credentials on a
  non-loopback bind. Chromium runs without its sandbox only via `TTK_CHROMIUM_NO_SANDBOX` (never set in the images);
  `TTK_BROWSER_ARGS` refuses `--no-sandbox` and equivalents.
- **Secrets.** Resolve from `*_FILE`, thread by argument, never place in `Deno.env`, never log or return them. Every
  secret kept at rest is AES-256-GCM sealed in `<TTK_DATA_DIR>/ttk.db` with the key from `TTK_DB_KEY_FILE`, which never
  lives on the data volume. A provider key stays bound to its host. Source files (providers, secrets) are never written.
- **Egress.** Both images grant the server unscoped `--allow-net`; the code that dials bounds it and must not be
  loosened: `browser_head` (per-hop literal-address deny, `TTK_ALLOWED_DOMAINS`), model calls (only saved providers'
  `base_url`, no redirects), A2A push (`TTK_A2A_PUSH_ALLOWED_HOSTS`). With `OTEL_DENO=true` the CLI's edge gate
  (`packages/cli/otel_gate.ts`) refuses to start unless every collector is in `TTK_OTEL_ENDPOINTS`;
  `OTEL_EXPORTER_OTLP_HEADERS` is never read or granted.
- **Least privilege.** Every task, image `CMD` and test tier names exact Deno permissions, `--deny-ffi` first,
  `--allow-run` as absolute paths. `gate:tasks` (`scripts/check_tasks.ts`) enforces this for the shipped tasks.
  Allowlists can only be narrowed by clients.
- **Architecture.** Layers point downward: `bus`/`cdp`/`wire` → `browser` → `mcp` → `gateway` → `cli`; `sandbox` and
  `agents` are used by `gateway`. Each package exposes only `mod.ts`; no deep cross-package imports. `bus`, `cdp` and
  `browser` are vendored (see `VENDOR.md`): change them only when necessary and say why at the site.
- **Wire stability.** Tool names and parameters, live-view message types, problem slugs, tool error codes and `TTK_*`
  names are frozen once released. Add; never rename or repurpose.
- **Dependencies.** npm set: `@modelcontextprotocol/{server,client,hono}`, `hono`, `jose`, `zod`, and for the web UI
  `@awesome.me/webawesome` and `lucide-static`; plus `@std/*` from JSR. Adding one needs explicit approval.

## Code patterns

A browser tool handler (throw `ToolError` for anything the model should see):

```ts
export async function browserPressKey(
	args: { key: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, /* mutates */ true); // refuses while a human holds the lock
	await dispatch(record.session, new SendKeysEvent({ keys: args.key }));
	ctx.registry.touch(record.id);
	return text(`Pressed ${args.key} in session ${record.id}.`);
}
```

A catalog entry (one Zod schema yields the JSON Schema, validator and argument type):

```ts
def({
	name: 'browser_scroll',
	title: 'Scroll',
	description: 'Scroll the page up or down by a number of viewport heights.',
	inputSchema: z.object({
		direction: z.enum(['up', 'down']),
		pages: z.number().positive().max(10).optional(),
		session_id: sessionId,
	}),
	mutates: true,
	hints: { openWorld: true },
	outputSchema: OUTPUT.browser_scroll,
	handler: handlers.browserScroll,
});
```

- Errors are results: `ToolError('<code>', message)` becomes
  `{ isError: true, content: [{ type: 'text', text:
  'Error: <code>: …' }], structuredContent: { error } }`. Never a
  JSON-RPC error.
- Availability (`available`) expresses deployment facts (data dir, ffmpeg, egress, switches), never the takeover lock;
  `SessionRegistry.assertUnlocked` answers that per session.
- Comment the _why_: constraints the code cannot show (budgets, CDP quirks, security reasoning). JSDoc on public
  symbols.
- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; type every function.

## Tool surface

100 tools: 57 browser catalog tools (`packages/mcp/src/catalog/`), 18 library tools (`library_tools.ts`) and 25
extension tools (`extension_tools.ts`: sandbox, agents, A2UI, memory). A default key sees 65 in the default Compose
stack (64 in a plain `docker run` without `TTK_DB_KEY_FILE`, where signed links are off); every scope sees 98.
`tests/container/verify_container.ts` derives the expected set from the code for each image shape
(`--shape
bundled|slim`).

The two images differ: the bundled image's grants live in its `CMD` and can be narrowed by a Compose `command:`
override; the slim image's compiled binary bakes its permissions (`scripts/compile.ts`) and cannot be re-flagged.

## Testing

- Unit tests sit beside the code (`foo_test.ts`); `deno task test:unit` includes `packages/cli/`.
- Choose the lowest tier that proves the claim: unit, `test:browser`, `test:stdio`, `test:compile`, container, sandbox,
  Compose, agents ([tiers](docs/guides/development.md#test-tiers)).
- Anything touching a Dockerfile, `docker/ttk`, the compiled binary's permissions or a tool's availability must pass
  `test:container` **and** `test:container:slim`.
- Coverage gate: 80% line coverage over `packages/mcp/src` and `packages/gateway/src` (`deno task cov`).
- `tests/unit/docs_claims_test.ts` pins the documented catalog size and requires every tool to be named in `docs/`;
  `packages/web/src/config_catalog_test.ts` pins `docs/reference/environment-variables.md` to the settings catalogue.

## Layout

```
deno.json, deno.lock     workspace, imports, tasks, fmt/lint config; frozen lockfile
Dockerfile               bundled image (Deno + Chromium + ffmpeg)
Dockerfile.slim          slim image (compiled binary)
docker-compose*.yml      gateway + sandbox; overlays for sandbox token, Docker backend, ACP runner
docker/                  sandbox, workspace, agent-runner images; seccomp profiles; ttk
scripts/                 gates, compile, coverage, health checks, grant resolvers
secrets/                 git-ignored file secrets (see secrets/README.md)
docs/                    documentation
tests/                   unit, e2e, stdio, compile, container, sandbox, agents, fixtures, support
packages/
  bus, cdp, browser      vendored browser stack
  wire                   live-view and A2UI contract (shared with the SPA)
  mcp                    tool catalog, handlers, dispatcher, session registry, resources
  sandbox                coding-sandbox service and client
  agents                 task runtime, A2A, ACP, built-in model agent
  gateway                Hono app, auth, REST, live view, ttk.db, vault, memory, cluster routing
  web                    control-plane SPA and MCP Apps embeds
  cli                    composition root: serve, stdio, acp, setup, seed, doctor, healthcheck, version
```

## Configuration and core components

- Configuration: `TTK_*` variables, parsed fail-fast in `packages/gateway/src/config.ts`; the catalogue in
  `packages/web/src/config_catalog.ts`; reference in
  [docs/reference/environment-variables.md](docs/reference/environment-variables.md). `deno task doctor` prints what was
  parsed. Compose settings: `.env` (template `.env.example`).
- Authentication: one bearer gate with a verifier chain (sign-in session → delegated token → API key → OAuth → loopback
  anonymous) in `packages/gateway/src/auth.ts`; the web UI's cookie with Origin plus `x-ttk-csrf` checks in
  `session_cookie.ts`.
- Request pipeline: drain → Host/Origin → path and body caps → request id → auth → per-credential origins → rate limit →
  route; `/mcp` builds one MCP server per request from the caller's scopes.
- Session registry (`packages/mcp/src/registry.ts`): sole owner of browser sessions and the takeover lock; TTL reaper;
  per-id creation serialization.
- Live view (`packages/gateway/src/liveview.ts`): ticket-gated WebSocket, JPEG screencast, human input.
- State: `ttk.db` (`database.ts`, `vault.ts`, `seed.ts`, `memory.ts`).

## Commits

Branches `feature/…` / `bugfix/…`; Conventional Commits; PRs fill in [the template](.github/PULL_REQUEST_TEMPLATE.md).
