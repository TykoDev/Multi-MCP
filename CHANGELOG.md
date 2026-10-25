# Changelog

All notable changes to TykoTech-MCP are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **One command sets up the full stack.** `deno task setup` now writes every file any shipped Compose file mounts — the
  database key, the administrator, the `client` API key, the A2A peer's token pair and list, the browser-secrets (`{}`)
  and git-remotes (`[]`) placeholders, the sandbox-overlay and agent-runner tokens and the ACP commands template — and
  `.env` from `.env.example` (one template, held equal by a test). `--only <names>` limits it to some files and, with
  `--force`, rotates exactly those; files you fill in yourself are replaced only when `--only` names them. Every file is
  described in one place, `secrets/README.md`. **Upgrading:** run `deno task setup` before the next `docker compose up`;
  it adds the new files, keeps yours, and repairs their modes.
- **The default Compose stack runs an A2A peer**, `a2a-peer`: a second gateway from the same image (no second build),
  with its own data volume and key file, no published port, and `TTK_PUBLIC_URL=http://a2a-peer:8787`. The gateway's
  `TTK_AGENT_PEERS_FILE` names it, so `agent_delegate` and `agent_peers` work out of the box. `TTK_PEER_MEMORY` and
  `TTK_PEER_HEAP_MB` size it. Browser-typed secrets (`TTK_SECRETS_FILE`) and credentialed git remotes
  (`TTK_SANDBOX_GIT_REMOTES_FILE`) are mounted by default from `setup`'s placeholders; `TTK_ALLOWED_DOMAINS` is read
  from `.env`.
- **`docker-compose.providers.yml`** replaces the three commented lines that seeded model providers from a file.
- **`doctor --new-key <id> --save`** adds (or replaces, by id) the record in `secrets/ttk_api_keys.json`, in place, so
  the running gateway admits the key without a restart.
- **Every task has a description**, so `deno task` lists what each does. Design notes:
  `docs/design/stack-tooling-and-secrets.md`.

- **MCP Apps streams for the terminal and A2UI surfaces.** `sandbox_session_open` now opens a terminal embed
  (`ui://tykotech/terminal`) whose **Attach** streams the shell session's output and feeds typed lines to it; the A2UI
  embed gains **Follow live**, which renders every new revision of the surface. Both use the live view's transport: a 30
  s single-use ticket bound to the embed's origin, minted by the new app-only tools `sandbox_session_ticket` and
  `a2ui_surface_ticket`, redeemed by `/live/terminal/{id}/ws` and `/live/surface/{id}/ws`.

- **Sessions: memory per browser session, Active and Idle, Close.** For an administrator the Sessions tab shows the
  container, the browser sessions and the gateway heap against their limits, and lists sessions as Active or Idle (with
  when each closes); every card shows its browser's private memory — Chromium's own memory dump over CDP — and a Close
  button, and the Idle group closes all its sessions at once. `GET /api/v1/system/usage`; `TTK_MEMORY_LIMIT` (the limit
  the meters use). Compose gives the gateway container `mem_limit: ${TTK_GATEWAY_MEMORY:-1536m}` and a heap of
  `${TTK_GATEWAY_HEAP_MB:-1024}` MiB.
- **Screen stylesheets load with their screens.** `dist/app.css` holds the shell, the shared components and the three
  first-paint screens (23.5 KB gzip, from 41.3 KB); each lazy screen's rules are `dist/screens/*.css`, applied with its
  chunk. The first-paint stylesheet budget is 50 KB gzip (D-159).
- **MCP change push: clients re-list their tools after a deploy or a scope change.** 2025-era clients (pi, most hosts)
  now get stateful sessions by default (`TTK_MCP_STATEFUL` defaults on; off in a cluster), whose standalone stream
  carries `notifications/tools/list_changed`. Session records (id, principal, the client's handshake; no token or scope)
  survive a restart in `<TTK_DATA_DIR>/mcp/sessions.json`, so after a deploy the reconnecting client's session is
  restored and told to re-list. A scope change (an edited account, a reloaded key file, a removed key) rebuilds that
  credential's sessions and pushes the same notification; a revoked credential closes them. A session now answers only
  the principal that opened it.
- **Workspaces: Files & shell and Surfaces tabs, and a task icon.** An open workspace switches between its files and
  shell and its surfaces in place (`#/workspaces/<id>[/surfaces]`); the header's task icon counts the agent tasks that
  used the workspace (`GET /api/v1/agent/tasks?workspace_id=`) and opens them on Agents › Tasks, filtered.
- **Agents: one task per conversation, and a Tasks tab with run histories.** Every request in the Agents chat starts a
  task with its own id and the chat moves to it (`#/agents/chat/<task>`), instead of one long thread of every task. The
  new **Tasks** tab (`#/agents/tasks[/<task>]`) lists every task beside its run history: facts, request, answer,
  artifacts and the run log. The run log is new on the server too: each task keeps a bounded, redacted record of its
  provider requests (timing, token usage, stop reason, errors), tool calls with arguments and results, ACP updates, peer
  requests and state changes, persisted with the task (`GET /api/v1/agent/tasks/{id}/log`; 300 entries, 128 KiB).
- **A2UI surfaces belong to a workspace.** `createSurface` takes an optional `workspaceId`, and
  `PATCH /api/v1/a2ui/surfaces/{id}` attaches or detaches one. Surfaces moved from the Agents screen to their workspace
  in **Sessions › Workspaces**, with New surface, Detach, Delete, and Attach here for surfaces in no workspace.
- **A2UI computed text: `formatString` and `formatNumber`.** The v0.9 catalog functions compute a text from the
  surface's data model on the page — `${/pointer}` interpolation, nested for lookups — so a Slider or TextField visibly
  drives the rest of a surface. The current specification's basic catalog id (`…/v0_9/catalogs/basic/catalog.json`) is
  accepted like the older one.
- **Workspaces screen: a file and folder tree.** Opening a workspace lists every file and folder it holds (folders
  first, `.git` hidden); a folder lists on its first expand, a click opens a file, and the tree follows saves and shell
  commands. Keyboard and screen-reader support follow the WAI-ARIA tree pattern. Files no longer have to be opened by
  typing their path.

### Fixed

- **The coding sandbox starts on AppArmor hosts (Ubuntu, Debian).** Docker's `docker-default` AppArmor profile denies
  every mount, so bubblewrap could not build a cage: the sandbox restarted with
  `bwrap: Failed to make / slave: Permission denied`, and the gateway, which waits for it, never started. The sandbox
  now runs under `tykotech-sandbox` (`docker/apparmor-sandbox`): `docker-default` with only that denial lifted.
  `deno task setup` installs and loads it through `sudo` on an AppArmor host (a new `apparmor` unit, last, after the
  credentials are shown), and when it cannot, exits 1 naming AppArmor as the cause, with the two commands to run by
  hand. The sandbox's start-up error names the profile too. **Upgrading:** on an AppArmor host, run `deno task setup`
  again before the next `docker compose up`. Hosts without AppArmor need nothing.
- **The Compose stack starts on Linux without `sudo`.** `setup` wrote its secrets `0600`, and a Compose file secret is a
  bind mount that keeps the host's owner and mode (Compose ignores `uid`/`gid`/`mode` for file secrets), so the uid-1993
  gateway restarted with `Permission denied` until the operator found the manual `chgrp`. `secrets/` is now `0700` and
  its files `0644`: private on the host through the directory, readable in the containers, with rootless Docker and
  Docker Desktop too. Re-running `setup` repairs an existing checkout.
- **`setup`'s credentials reach the stack's features.** The `client` key and the administrator held the default grant,
  so the sandbox, agent, A2UI, model and memory-write tools were withheld from them. They now hold `mcp:invoke`,
  `view:watch`, `view:control`, `files:read`, `files:write`, `sandbox:execute`, `agent:invoke`, `model:invoke` and
  `a2ui:publish` (the administrator also `admin`). `DEFAULT_SCOPES` is unchanged.
- **API-key reload works in the containers.** `docker/seccomp-chromium.json` lacked `inotify_init1`, so the gateway's
  key-file watcher never started under the stack's profile ("cannot watch the API key file") and a key added to the file
  waited for a restart.
- **`deno task ok` passes on a fresh checkout.** The B6.3 cache-policy test fetched `/assets/app.css`, which exists only
  after `build:web`; it now checks a hand-written asset, and the bundle's stylesheet when it was built.
- **`test:agents:compose` runs.** Its fixture never replaced the base file's `ttk_db_key`, so the proof refused itself
  before starting; it now brings its own key, and both Compose proofs bring the stack's new files and pin the peer to
  the tree's gateway image.
- **`deno task cov` runs.** `cov:unit`, `cov:agents` and `cov:browser` restated their tiers' matrices and had drifted:
  `cov:unit` granted path-scoped read and write, which Deno 2.9's `Deno.symlink` refuses, so two sandbox unit tests
  failed under it. Each now runs its tier's task with `--coverage`. `admin:generate` is removed (`setup` creates the
  administrator, `doctor --new-admin admin --force` replaces one).
- **Every image base is an `ARG`.** `docker/Dockerfile.agent-runner` and `docker/Dockerfile.sandbox-workspace` named
  theirs literally; they now take `DENO_IMAGE` (and `RUNTIME_IMAGE`) like the others, defaulting to the same pins.
- The environment reference listed `TTK_GATEWAY_HEAP_MB`'s default as 768; Compose uses 1024.

- **A surface's "Try it" controls did nothing visible.** A Slider moved its own value only: nothing in the catalog could
  compute another component's text from it. With `formatString`/`formatNumber` a bound input now drives computed text on
  the page.

- **`a2ui_publish` refused specification clients with `message: Invalid input`.** A message sent as JSON text, without
  `version`, or naming the A2UI basic catalog's id now publishes; a refusal names the field and the expectation of the
  closest message shape instead of `Invalid input`.
- **`a2ui_delete` and `a2ui_publish` on a missing surface answered
  `file-unavailable … check the service
  configuration`.** They now answer
  `invalid-arguments: you have no A2UI surface "<id>"`, and store refusals (duplicate surface, cyclic tree, surface
  limit) carry their own words.
- **`browser_wait_for` with `selector` or `text` never matched a page no tool had read yet.** Chromium's DOM agent
  searches only a document it has been asked for, so a wait straight after a navigation timed out against a page that
  matched. The search now requests the document first (`browser_find` and `browser_verify_locator` share it).
- **`browser_verify_locator` with a bare `id`, `testid` or `name` value counted plain-text matches.**
  `{kind: "id", value: "username"}` went to the browser search as the word `username` (4 matches on a login page); a
  bare value now means its selector (`#username`, `[data-testid="…"]`, `[name="…"]`). The selectors
  `browser_locator_candidates` emits pass unchanged.
- **A read-only browser tool with no default session answered `no session with id default`**, which read as a broken
  server next to a parameter described as "created on first use". It now says the default session is created by the
  first tool that opens a page, and that the read-only tool never creates one (same `unknown-session` code).
- **Every tool: a value sent as JSON text where the schema wants a number, boolean, object or array** (`{"limit": "5"}`)
  is read as the value it spells and validated again, instead of failing with `expected number, received string`.

### Breaking

- **Secrets rest only encrypted, in `<TTK_DATA_DIR>/ttk.db` (D-154).** Set `TTK_DB_KEY_FILE` (32 bytes;
  `deno task
  setup` or `doctor --new-db-key` writes one; Compose mounts `secrets/ttk_db_key`). With a data directory,
  a providers file carrying a key or `TTK_SECRETS(_FILE)` refuses startup without it, and signed links default off
  without it. The providers file and `TTK_SECRETS(_FILE)` are now seeds: copied into the database once, never re-read
  after that unless `seed --force`. A plaintext `link-signing.key` is moved into the database and deleted.
- **`GET`/`PUT /api/v1/system/model-providers` changed shape (D-154):** `{ seed, store, default, providers }`; key modes
  `keep`, `set`, `none` (no `file`); no `extra_models`, `operator` or `default_source`.
- **`doctor --new-admin` no longer overwrites `secrets/ttk_admin_user.json` without `--force` (D-154).**

- **Exporting OpenTelemetry needs an allowlist and six granted names (D-137).** With `OTEL_DENO=true` the server refuses
  to start until `TTK_OTEL_ENDPOINTS` names the origin of every configured OTLP endpoint; a launcher that exports must
  grant `OTEL_DENO`, `OTEL_DENO_VSOCK` and the four `OTEL_EXPORTER_OTLP_*ENDPOINT` names in `--allow-env` (one that
  grants only `TTK_*` is refused, naming the grant), and the slim image refuses `OTEL_DENO=true` instead of silently not
  exporting. Nothing changes while OpenTelemetry is off.
- **Signed links are `v2` (D-140):** `v1` tokens (at most 300 s old) stop working at once.
- **`TTK_A2UI_ACTIONS` refuses startup when an action names a tool that cannot run indirectly (D-141):** the
  confirmation set, `browser_file_link`, `browser_live_ticket`, `browser_live_view`, `browser_request_human`,
  `agent_run_tool` and the sampling tools. A button that reached the store anyway is refused before it runs. Call those
  tools directly.
- **`admin` is no longer in the default grant (C7, D-098).** `DEFAULT_SCOPES` is `mcp:invoke`, `view:watch`,
  `view:control`, `files:read`. API keys without `scopes`, the anonymous loopback principal and stdio clients (with
  `TTK_ANON_SCOPES` unset) lose session, account and origin administration, diagnostics, `browser_close_all` and the
  cross-principal audit read; name `admin` to keep them. Stored accounts keep it: the first start upgrades `users.json`,
  a cluster KV and a scope-less `TTK_ADMIN_USER` seed to version 2 with the previous five-scope grant written out, and
  `doctor --new-admin` names `admin` explicitly.
- **The web UI signs in with an HttpOnly cookie (B4, D-097).** The `ttk.login` storage key is gone: a token left there
  is revoked and removed on first load, so every browser signs in once more. Cookie-authenticated changes need the
  `x-ttk-csrf` header and an allowed `Origin`; a raw OAuth access token can no longer sign in to the web UI. Bearer
  clients are unchanged.
- **`TTK_BROWSER_ARGS` is validated at startup (D-094).** An entry that is not a `--switch`, a sandbox-weakening switch
  (including any `*sandbox*` switch and `--disable-features` naming a sandbox feature), a launcher-owned switch
  (`--remote-debugging-*`, `--remote-allow-origins`, `--user-data-dir`) or a program-running switch (`*-cmd-prefix`,
  `*-launcher`, `--browser-subprocess-path`) refuses startup.
- **With `TTK_ALLOWED_DOMAINS` set, the browser enforces it (D-095):** a redirect off the list ends on `about:blank`
  (the tool answers `url: "about:blank"`), and an off-list new tab is closed. `<secret>` in
  `browser_type`/`browser_fill` is checked against the frame the keystrokes land in (D-096). `browser_health`'s
  `browser_ok` counts browsers that answer a `Browser.getVersion` probe, so a poll can take up to 2 s (D-096).
- **An invalid `TTK_ADMIN_USER`/`TTK_ADMIN_USER_FILE` refuses startup (C6, D-099),** as do both forms set and a present
  but invalid `secrets/ttk_admin_user.json`. The sign-in route refuses a `ttks_` token sent as `apiKey`/`token` with
  `400` (C14, D-099).
- **Request bodies are capped before anything parses them (D-100, E-83):** over `TTK_MAX_BODY_KB` (default 256 KiB) on
  `/api/v1/*` and `/a2a`, or over 4 MiB on `/mcp`, is `413 payload-too-large`. A2A bodies default to 256 KiB (the A2A
  reader allows 512 KiB).
- **`TTK_MCP_STATEFUL` together with `TTK_CLUSTER_KV` refuses to start (D-102).**
- **`deno task dev` no longer prompts (E-82):** it grants the resolved browser, `TTK_FFMPEG`, `tests/.scratch` and the
  temporary directories and runs with `--no-prompt`, so a `TTK_DATA_DIR` outside those is refused rather than prompted
  for.

- **Administrator logins no longer hold the explicit-only scopes by default (GW-2, D-065).** An admin record without a
  `scopes` array now gets `DEFAULT_SCOPES`, not every scope; `evaluate`, `task`, `sandbox:execute`, `agent:invoke` and
  `a2ui:publish` must be named. To keep them, add a `scopes` array to `secrets/ttk_admin_user.json`;
  `doctor --new-admin` takes `--scopes`.
- **API-key ids are constrained (GW-4):** at most 128 printable characters, never beginning `admin:`. A key file that
  breaks the rule is refused at startup and on reload.
- **Agent tasks that wait more than 120 s to start fail (D-071),** and tasks, delegations and streams end when their
  submitting key is rotated or removed, or the admin logs out.
- **`POST /api/v1/auth/login` with an API key answers with a `ttks_` session token, not the key (D-073).** A client that
  expected the key echoed back must use the returned `token`; it is bound to the key and ends when the key is rotated or
  removed. Sessions live `TTK_LOGIN_TTL_S` (default seven days, was one day in memory).
- **Every credential that names no scopes now holds `files:read` (D-075).** The default grant gained the library's read
  scope, so an API key or account without a `scopes` array can list and read the share, skills and prompts. Name an
  explicit `scopes` array to withhold it; `files:write` is never implied.
- **`TTK_ADMIN_USER` is now a seed (D-074).** On the first start with `TTK_DATA_DIR` the record is copied into
  `<TTK_DATA_DIR>/users.json`, which is the authority from then on: editing the secret later changes nothing until that
  file is removed. Without a data dir the account works but cannot be changed.

- **`POST /api/v1/auth/login` and `POST /api/v1/auth/password` answer errors as `application/problem+json` (D-078).** A
  failed sign-in is `401` with type `…/problems/unauthenticated` (was a hand-written `…/unauthorized` body), a missing
  credential `400 invalid-request`; repeated failures now get `429 rate-limited` with `Retry-After`, and a body over 16
  KiB `413 payload-too-large`.
- **With `TTK_OAUTH_ISSUER` and no `TTK_OAUTH_JWKS_URL`, keys come from the provider's metadata (D-083),** and
  `/.well-known/oauth-authorization-server` serves the provider's own document instead of invented `<issuer>/authorize`
  and `<issuer>/token` endpoints; when the provider publishes no metadata that route answers `500` rather than a guess.

- **Live-view tickets (D-088):** a non-upgrade request to `/live/{id}/ws` now answers 426 without consuming the ticket,
  and an unknown or wrong-session ticket answers `403 ticket-invalid` (was `401 unauthenticated`). A foreign `Host`
  answers `400 host-forbidden` as problem+json (was a JSON-RPC `403 Invalid Host` body).
- **A2A `SendMessage` is idempotent per principal (D-085):** a repeated `messageId` returns the first task instead of
  starting another. A client that reused message ids for different messages must generate fresh ones.

### Security

- **OpenTelemetry export is allowlisted at the process edge (D-137):** before any subcommand runs, the CLI judges every
  non-empty OTLP endpoint — the base one included — against `TTK_OTEL_ENDPOINTS`, and refuses the runtime default
  `http://localhost:4318`, credentials in an endpoint URL, an empty base endpoint and vsock export; a malformed
  `TTK_OTEL_ENDPOINTS` refuses start in every mode. A refusal is one `tykotech-mcp: refusing to start:` line on stderr
  (passwords redacted) and a natural exit, so nothing is exported; a non-loopback plain-`http:` collector starts with a
  warning. `OTEL_EXPORTER_OTLP_HEADERS` is never read or granted.
- **The bundled image's health probe runs with `OTEL_DENO` unset (`/usr/bin/env -u OTEL_DENO`), so it never exports
  (D-137).**
- **`deno task dev` judges OpenTelemetry egress before its file watcher starts (D-137, SEC-1W).** The `--watch` runner
  shares the server's process and used to log its own lines to the configured endpoint, an off-list one included; a
  gate-only pre-step (`packages/cli/gate.ts`, joined by `&&`) now refuses first. Hot reload is unchanged.
- **A signed link minted by an agent task's delegated MCP bearer never outlives that bearer (D-140, SEC-2).** Under an
  API-key or account delegator such a link used to live the full hour; it is now capped at the delegation's expiry.
- **The `dev`, `stdio`, `serve:cluster` and `doctor` tasks no longer export from their grant-computing helpers (D-137,
  SEC-1).** Each `$( … deno task … )` substitution runs with `OTEL_DENO=false`, so only the gated process can export;
  rule T5 refuses a shipped substitution without it. The `deno task` runner's own header line is still logged when you
  run a task without `-q`.
- **`doctor --new-key`, `--new-key-set` and `--new-admin` are refused while OpenTelemetry exports (D-142),** because the
  console they print a credential to is exported. `doctor --grant` still runs.
- **`<link rel=prefetch>` and `<link rel=prerender>` hints to off-list hosts are refused before they are sent, in the
  default scope too (D-139, E-115).**
- **A signed link ends early with its session and its credential (D-140, G6):** a session closed, or recreated under the
  same id, answers `404`; an API key removed or rotated under the same id, an account whose password changed or that was
  disabled or removed, and OAuth no longer configured answer `401`. An OAuth link is capped at the expiry of the access
  token it was minted under; with less than 10 s left, or no known expiry, the mint is `scope-required`. The token
  carries a keyed credential epoch, never a credential or an unkeyed fingerprint.
- **A `navigation` event record's `path` drops `;matrix=params` and keeps only a `data:` URL's media type, exactly like
  the request log (NF-2).**
- **With `TTK_ALLOWED_DOMAINS` set, off-list documents are refused before their request is sent (R3, D-115, E-94):**
  S-11 is closed — navigations a loaded page makes by itself (clicked links, script and meta-refresh navigations, form
  posts, each redirect hop, pop-ups and iframes) are checked, before the request rather than after. Speculation rules
  cannot take the browser off the list either: the launched profile starts with preloading off, and a page that commits
  an off-list document anyway is parked on `about:blank` and recorded (R2-1, E-110, E-94).
- **The inspection tools keep credentials out (D-116):** request-log values of credential-named headers — among them
  `Sec-WebSocket-Protocol` and names containing `pass`, `pwd`, `credential`, `signature`, `jwt`, `bearer`, `otp`,
  `dpop`, `assertion` or `principal` (R2-3) — are stored only as `[redacted]`, and request bodies are never read.
  Without `network:read` every query and fragment in every header value is cut, `path` drops `;matrix` parameters, and a
  `data:` URL shows only its media type (R2-3). Every string the inspection tools return passes the server's secret
  redaction, applied before any text is cut to its cap in the request log, the console log and `body_for` (R2-7).
- **Every multi-round `requestState` is HMAC-sealed and bound to the method and the authenticated client (D-126).** A
  tampered, expired or another principal's state is refused before any handler runs.
- **Chromium and the recorder's ffmpeg receive the `OTEL_*` exporter settings and the inline `TTK_API_KEYS`,
  `TTK_SECRETS`, `TTK_ADMIN_USER`, `TTK_SANDBOX_TOKEN` and `TTK_AGENT_BRIDGE_TOKEN` blank (D-127);** proxy settings
  still pass through. A startup warning says, when OTLP export is on, that the runtime exports URLs with query strings
  and console output outside the permission matrix (since D-137: to the allowlisted collector).
- **No structured task runs a tool that needs its caller, a person or the client in the loop (D-121, R1-3, R1-5).** Over
  MCP (`agent_run_tool`), A2A, its HTTP+JSON binding and REST, a task naming the confirmation set, a sampling tool, the
  handoff, a live-view tool or `browser_file_link` fails before the tool runs and keeps no artifact, so no ticket or
  link URL is kept in `tasks.json` or push bodies; the extended card lists none of them. An A2A or REST client that ran
  one of these as a task must call it directly. Secret-provider failures refuse the start and never reveal the token,
  the value or the reference path (D-123).
- **No refusal quotes a secret-bearing value (D-123, R1-1, E-109).** `TTK_API_KEYS` or `TTK_SECRETS` that is not valid
  JSON — inline, from a file, on a key-file reload or from a `*_REF` provider — is refused as `not valid JSON` (with the
  position), never with the parser's message, and an invalid secret name is located by entry, not repeated. A corrupt
  storage-state file no longer puts cookie text into the log.
- **The REST live-ticket mint narrows a body `origin` by the per-token origin overlay (D-040, R1-3)**, as the front
  narrows an `Origin` header; outside it, `403 origin-forbidden`.
- **Sandbox permission matrix (D-131):** the sandbox image's command and the Docker overlay's grant
  `TTK_SANDBOX_GIT_HOSTS`, `TTK_SANDBOX_GIT_REMOTES_FILE` and read on `/run/secrets/ttk_git_remotes`; no run or net
  change; both argv lists are pinned whole by `tests/unit/images_test.ts`. A clone runs a fixed script in the
  provisioning cage: https only, no redirects, no hooks, every object checked, no submodules or tags. A clone holds its
  workspace from before its record exists, and every operation but `remove` on a provisioning workspace answers
  `409 run_busy`, so no shell or command starts before `.git` is in place and read-only (R3-1). Credentialed clones go
  through a service-side forwarder that serves upload-pack only (push refused), dials checked public addresses and
  verifies TLS for the remote's name (D-132); the remotes file is read once and its grant revoked, and credentials —
  their JSON-escaped forms included (R3-8) — are cut from every log line. The workspace diff runs git with
  `core.hooksPath=/dev/null`.
- **Signed links (D-119):** tokens are HMAC-SHA256 with a single accepted spelling, minted for at most 300 s (an hour
  since D-140) and verified with an expiry up to 30 s beyond that accepted, for a minting node whose clock runs ahead,
  and none after it expires (R1-4). The route re-checks that the minting owner still holds `mcp:invoke` (an OAuth owner:
  that and nothing more), verifies before any cluster forward, answers an unreachable owner node with a causeless 503
  and names no node (no `x-ttk-served-by`, R1-6), sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`,
  and never logs the URL. The link key is file-only or generated with mode 0600, with startup refusals. The
  accessibility snapshot never returns field values: it blanks any name or description that carries a typed field value,
  and masking bullets beside a password field (D-120, R2-4).
- **MCP Apps embed tickets (D-134, D-135)** are origin-bound, single-use and live 30 s, limited to
  `TTK_MCP_APPS_ORIGINS` narrowed by the per-token origin overlay and to the `TTK_MCP_APPS` mode. The embeds' inline
  code is pinned by hash in a `default-src 'none'` CSP whose only connect source is the gateway's socket origin, and no
  spelling of `/assets/embed_*` — percent-encoded or case-changed — serves an embed as a page of the gateway origin
  (R1-2). An embed ticket needs the minting principal; a tool-executor context is refused (R1-3). MCP Apps refuses to
  start in a cluster.

- **Every JSON-typed request body is size-capped before anything parses it, on every path (D-100);** a JSON-typed share
  upload no longer escapes the cap. **Cookie sign-in and cookie-authenticated changes must come from the server's exact
  origin** — scheme, host and port — and a cookie sign-in must be `application/json` (E-88); duplicate or malformed
  sign-in cookies are refused and cleared. Request paths with dot segments, encoded slashes or empty segments are
  refused with `400` (E-89). `--in-process-gpu` is refused in `TTK_BROWSER_ARGS` (D-094).
- **`<secret>` typing at the focus follows focus into `<object>` and `<embed>` documents and refuses frames it cannot
  name (D-096);** isolated-world context ids are no longer reused across navigations (E-93); an unbracketed IPv6 or `..`
  host in `TTK_ALLOWED_DOMAINS` no longer widens the browser's policy beyond the tools' (E-92).
- **Sandbox Docker backend (E-90, E-91):** `/run/harbour` is mounted read-only, and only `/workspace` and
  `/home/sandbox` are writable; disk use is measured by the service with the container paused and fails closed
  (cleanup-only). **Agents:** push configs are re-validated against the allowlist on restore and before every delivery
  (D-104, D-106).

- **Chromium without its sandbox is one deliberate setting (D-094):** `--no-sandbox` and its equivalents can no longer
  be passed through `TTK_BROWSER_ARGS` (C5/F7); `TTK_CHROMIUM_NO_SANDBOX` is the only way, never set in the images, and
  it warns, shows in the diagnostics and is advertised to clients.
- **The domain allowlist reaches the browser (C1, D-095):** redirects, load-time script navigations and pop-ups that
  leave `TTK_ALLOWED_DOMAINS` are contained; blocked URLs never reach the event ring or the logs, only their origin
  (E-78). Secret substitution can no longer type a top-page secret into a cross-origin frame (A2, D-096).
- **The web UI's session token is out of page script's reach (B4, D-097):** an HttpOnly, `SameSite=Strict` cookie;
  cookie-authenticated changes need the CSRF value and an allowed `Origin`; a cookie sign-in needs an allowed `Origin`;
  the live-view socket never accepts the cookie. Administration is no longer granted to credentials that never asked for
  it (D-098).
- **A2A streams end when their credential is revoked (A6, D-106),** closing D-071's X-1. Push notifications are gated on
  an operator host list and a proven outbound grant; private addresses are refused in configuration and on every
  delivery; no redirects; bounded attempts. `agents/tasks.json` and `agents/surfaces.json` are mode 0600 and hold no
  scopes or credential fingerprints; push tokens are stored but never returned (D-104).
- **The Docker workspace backend holds the Engine socket, which is root-equivalent (D-108):** it is opt-in, mounted into
  the sandbox service only, warned about at every start, and every container and exec body is validated; rootless Docker
  is recommended.
- **Agent HTML is served under `sandbox; default-src 'none'` and framed with an empty sandbox attribute (D-111);** the
  page CSP gains only `media-src 'self' data: blob:`.
- **`/mcp` bodies are capped at 4 MiB, and every capped body is bounded before the adapter's pre-authentication parse
  (E-83, D-100).**

- **A live sandbox shell could race the service's file operations out of its workspace (D-077).** While a workspace has
  an open session, `sandbox_read`, `sandbox_write` and the listing now run in a cage that sees only that checkout, so a
  link the shell swaps in can never resolve to another workspace or the owner records. Found by the 2026-10-01 audit in
  D-076 itself; the overlay had not been deployed.
- **The sign-in route is guarded (D-078):** per-source and per-username backoff with no hard lockout, equal failure
  timing for unknown and real accounts, a 16 KiB body cap, and a log line for every failed sign-in and account change.

- **Agent tasks, ACP delegations and A2UI/task event streams are bound to the credential that started them (GW-1, GW-3,
  D-071).** They are re-authorized at start, before each tool call and delegation, and immediately on key reload or
  logout; the A2UI and REST task streams re-check every 300 s and end at 1800 s (300 s for OAuth). Before, a queued task
  ran after its key was revoked and a post-rotation delegation could be issued to a pre-rotation task.
- **Coding workspaces enforce their disk budget while commands run (SB-1, D-072).** A command could hide its usage from
  the budget with `chmod 000` and fill the host disk; usage is now measured through unreadable directories and watched
  every 250 ms, with a 6 GiB per-owner cap; a sandbox request cancelled while queued now answers 499 `cancelled`.
- **A2UI routes are gated by exact route (GW-6),** the login route refuses delegated `ttkd_` tokens (GW-11), a
  delegation token split across agent output chunks or JSON-escaped is redacted (AG-8), and the sandbox drops its read
  grant on its bearer after start-up and checks file identity on read/write (SB-5).
- **`GET /api/v1/system/diagnostics` requires the `admin` scope (D-070).** It returned the deployment's posture — bind
  address, public URL, origin and domain allow-lists, the API-key count, and which defences are off — to any
  authenticated principal, including watch-only keys, while the SPA told operators the route was admin-only. A
  credential without `admin` now gets `403 forbidden-scope`. Admin logins and admin keys are unaffected.

### Added

- **Agent management (D-158).** System › Agents lists the built-in model agent, SlopLord, the ACP coding agent and the
  A2A peers; each agent's dialog sets its default model, its A2A / ACP / A2UI switches and its memory switch, stored in
  `ttk.db` and applied to the next task (`GET`/`PUT /api/v1/system/agents`).
- **Fetch a provider's models (D-158).** The provider dialog's reload button lists the models the provider serves
  (`POST /api/v1/system/model-providers/models`), each a chip to add or remove; typing them by hand still works. Only a
  saved provider's host is dialled.
- **New chat and an in-chat settings panel on the Agents screen (D-158).** New chat starts an empty conversation
  (earlier turns one click away); the settings icon opens System › Agents in a right-side panel instead of leaving the
  chat.
- **Stored-data overview (D-155).** `GET /api/v1/overview` returns counts and byte totals of what the caller can read —
  sessions, profiles, storage states, recordings, share files, skills, prompts, memory, workspaces, agent tasks by
  state, surfaces, model providers, and (admin) the data directory's size. Each section only with the scope that already
  reads that data; owner-scoped like its own listing; never a name or content; walks capped and cached 10 s. The
  Sessions screen opens on a dashboard of these as linked tiles (it replaces the sessions-only strip).
- **SlopLord, the built-in coding agent, served over A2A (D-156).** Always present, nothing to configure: the built-in
  model agent with a fixed coding prompt and a fixed tool list (sandbox, memory and file-share tools, narrowed by the
  caller's scopes). Its own A2A agent: public card `/a2a/agents/sloplord/.well-known/agent-card.json`, JSON-RPC
  `/a2a/agents/sloplord`, HTTP+JSON `/a2a/agents/sloplord/v1`; also `metadata.agent: "sloplord"` on `/a2a` and
  `agent: "sloplord"` on `POST /api/v1/agent/tasks`. Runs where the coding sandbox and a reachable default provider
  exist (the default Compose stack once a provider is added); needs `model:invoke`, `mcp:invoke`, `sandbox:execute`.
  Tasks carry `metadata.agent`. `GET /api/v1/agent/providers` adds `agents`. The Agents screen offers **SlopLord
  (coding)**; Resources › Agents › SlopLord shows its endpoints.
- **SQLite database with sealed secrets, seed-once sources and agent memory (D-154).** `ttk.db` holds model providers
  (all editable in System › Agents), browser secrets and the link-signing key (AES-256-GCM), and the agents' vector
  memory: `memory_save`, `memory_search`, `memory_delete`, `memory_list` (built-in lexical embedder or a provider's
  `/embeddings`), `GET`/`PUT /api/v1/system/memory`. stdio opens the same database. New commands: `setup` and `seed`
  (both `--force`/`-Force`), `doctor --new-db-key`, and `ttk` inside both images. QUICK-START.md.

- **A built-in model agent (D-143).** A text task can run inside the server on an OpenAI-compatible or Anthropic
  provider named in the new `TTK_MODEL_PROVIDERS_FILE`
  (`{ version: 1, default?, providers: [{ id, kind, base_url,
  models, api_key | api_key_file, … }] }`, the only place
  a provider key may live): a bounded tool-calling loop over the caller's own taskable catalog, each call re-authorized
  and passed through the executor's scope, takeover-lock and confirmation checks, with fixed bounds (`max_steps` 24,
  `token_budget` 400 000, a 768 KiB transcript, 120 s per provider call, the task timeout) and the key redacted from
  everything the task emits. Both wire formats are spoken with `fetch`; no SDK, no dependency. A configured ACP agent
  keeps running text tasks exactly as before; a default provider serves only deployments without one. `doctor` prints a
  `model providers` line, the diagnostics report `modelProviders` and `builtinAgent`, and the agent card lists a
  `builtin-model` skill while a provider is reachable.
- **The `model:invoke` scope (D-144),** held only when named: it gates naming a provider on a task and the bridge-less
  default. `SCOPES` has fourteen members; `doctor --new-key-set` mints one more key.
- **Provider egress is operator-elected on the bundled image (D-145):** no grant changes; a provider whose host is not
  in `--allow-net` is listed `reachable: false` (`no-net-grant`) and never dialled until the operator adds the host in a
  Compose `command:` override (`docker-compose.yml` carries the commented secret opt-in). On the slim image the file is
  the only egress control. `gate:tasks` rule T6 pins `TTK_MODEL_PROVIDERS_FILE` under every shipped grant and refuses
  any shipped task that grants or sets a `*_API_KEY`, `OPENAI*` or `ANTHROPIC*` variable. `server.json` lists
  `TTK_MODEL_PROVIDERS_FILE` as an `isSecret` environment entry, and the binary `scripts/compile.ts` builds for the slim
  image covers the name with its baked bare `--allow-env`.
- **`GET /api/v1/agent/providers`** (`agent:invoke`): the configured providers and models — `invocable`, `acp`,
  `default`, and per provider `id`, `kind`, `label`, `models`, `default_model`, `reachable`, plus `host` and `reason`
  for a caller holding `model:invoke`; never a key, URL path or header.
- **`GET /api/v1/a2ui/actions`** (`agent:invoke`): `{ names }`, the action names a surface button may bind.
- **`capabilities.tykotech.model`** `{ providers, builtin_agent }` for a `model:invoke` holder.
- **Web UI — one Resources screen.** Resources and the Library are one tree (Server, Sessions, Files, Skills, Prompts,
  Templates) with one viewer; JSON documents render as facts with raw as the advanced view, the Files group carries a
  path crumb, a worded Grid · List switch, one **Add** menu and a standing drop strip, and skill and prompt editors are
  drawers. The dock has eight items; `#/library[/<tab>]` redirects to `#/resources/<group>`.
- **Web UI — System configuration.** The raw diagnostics block becomes a Configuration panel of labelled facts with
  source and reach tags, raw JSON moves to one modal, and a configuration composer generates a `TTK_*` block, a Compose
  override and a providers file (with `REPLACE_WITH_KEY`, never a real key) from presets, with a diff against the
  running values. Nothing is sent to the server.
- **Web UI — Agents.** A task composer for the three task kinds (a question to an agent or a model with a provider and
  model picker, a tool run with a schema-driven form, a delegation to a peer), task cards with kind and backend chips,
  and a surface builder from templates (status card, form, table, image with caption, note) with preview and the raw
  JSON as the advanced view.
- **`TTK_ALLOWED_DOMAINS_SCOPE=all` (D-138, E-114, E-116):** with an allowlist, the browser refuses every off-list
  request before it is sent — subresources, `fetch`/XHR (including `browser_evaluate`), beacons, workers and service
  workers — and a resolver layer makes off-list names, IP literals and WebSockets unresolvable in a locally launched
  browser. Under a proxy flag WebSockets to off-list hosts are not refused, and the server and `doctor` say so; an
  allowlist host containing `_` cannot be written as a resolver rule, so under `all` it is left out with a startup
  warning and does not resolve; an entry containing `*` (which matches nothing in any layer) is left out the same way,
  so it can never write an `EXCLUDE *` that would void the layer. The default, `documents`, is unchanged apart from
  hints.
- **`TTK_OTEL_ENDPOINTS` (D-137);** `doctor` prints an `otel` line (`off`, or each signal's collector origin) and a
  `scope` line, with the WebSocket caveat for `TTK_ALLOWED_DOMAINS_SCOPE=all` under a proxy. Admin diagnostics gain
  `config.otelEndpoints` and `config.allowedDomainsScope`.
- **System screen:** the Network panel lists the OpenTelemetry collectors `TTK_OTEL_ENDPOINTS` allows ("Telemetry
  collectors", origins only) while exporting or once listed, and Allowed domains carries a `documents only` /
  `all requests` tag; a gateway reporting neither reads "not reported".
- **`browser_network_log`, `browser_console_log` and `browser_har_export` (R4, D-116):** a bounded per-session request
  log (500 requests or 512 KiB, credentials redacted by header name, no request bodies), the page console on a tool-held
  claim released after 10 idle minutes, and a cookie-free HAR 1.2 export of at most 1 MiB. Full URLs, URLs inside
  headers and response bodies need the new explicit scope `network:read` (13 scopes).
- **`browser_request_human` (D-124)** hands a browser session to a person through the live view (URL elicitation, or the
  link). Off unless `TTK_HUMAN_HANDOFF=true`; never on stdio.
- **`browser_pdf` (D-118):** print the focused tab to PDF, inline up to 1 MiB or kept as a session file up to 64 MiB;
  the print is streamed, and reading stops at 64 MiB (R2-7). **Session artifacts (D-119):** server-made files (`art-`
  ids) listed and served beside downloads, at most 32 / 128 MiB per session; a new one sends `resources/list_changed`
  like a finished download, and `browser_download` never reports one as its download (K-1, K-3).
  **`browser_save_to_share` (D-119):** a library tool (`files:write`) that copies a session file into the share, up to
  64 MiB, returning its SHA-256.
- **Signed links (D-119):** `TTK_SIGNED_LINKS`, `TTK_SIGNED_LINK_TTL_S` and `TTK_SIGNED_LINK_KEY_FILE`; the
  `browser_file_link` tool; the public `GET`/`HEAD /api/v1/links/file`.
- **`browser_accessibility_snapshot` and `browser_performance` (D-120, E-97):** the accessibility tree, nested and as an
  outline, without field values; Core Web Vitals read in an isolated world, and runtime counters.
- **MCP Apps, off by default (D-134–D-136).** With `TTK_MCP_APPS=watch|control`, `TTK_MCP_APPS_ORIGINS` and the optional
  `TTK_MCP_APPS_DOMAIN`, the gateway serves `ui://tykotech/live-view` and `ui://tykotech/a2ui-surface` and offers
  `browser_live_view` and the app-only `browser_live_ticket`; `a2ui_publish` links to the read-only A2UI embed. The live
  embed's Watch is a white label on brand 50 in both themes (4.59:1); a refused view tells the chat user one sentence
  and folds the server's words under **Details** (RV-1, RV-10); an administrator's embed ticket carries the
  `Administrator (<name>)` holder label (B4). In the A2UI embed a share-file image shows a note, and each media note
  carries its own description (RV-6).
- **Confirmations (D-125):** with `TTK_CONFIRM_DESTRUCTIVE` (default on), clients that declare form elicitation are
  asked to confirm `browser_close_all`, `sandbox_delete`, `file_delete`, `skill_delete`, `prompt_delete` and
  `a2ui_delete`. A refusal is the new tool error `user-declined` (20 codes). `browser_fill_secret` lets a form-capable
  client's human choose a secret permitted on the page when the named one is unknown or not permitted; names only.
- **`browser_run_task` hands the eight actions to clients that declare `sampling.tools` (D-126).**
- **`agent_run_tool` and `agent_list_tasks` (D-121):** run one tool call as a background task you own and get the task
  at once; list your tasks (active or finished, newest first). Both need `agent:invoke`. In a cluster, every task a node
  creates — over MCP, A2A or REST — is found by id from any node, including one not yet recorded, and the list spans
  every node (R3-5).
- **Server identity (D-122):** a title, description, website and SVG icon, plus per-credential `instructions`, on
  `initialize` and `server/discover` (no website or icon on stdio, or when the public URL's host is a wildcard bind
  address such as `0.0.0.0`, B3); `server.json` (an MCP Registry entry, not published) and the
  `io.modelcontextprotocol.server.name` label on both images.
- **External secret providers (D-123):** `TTK_API_KEYS_REF` and `TTK_SECRETS_REF` read API keys and browser secrets at
  startup from HashiCorp Vault KV v2 or 1Password Connect, with `TTK_VAULT_ADDR`, `TTK_VAULT_TOKEN_FILE`,
  `TTK_VAULT_NAMESPACE`, `TTK_OP_CONNECT_URL`, `TTK_OP_CONNECT_TOKEN_FILE` and `TTK_SECRET_PROVIDER_CA_FILE`. Every
  reference and provider setting is checked before any file is read (R1-7). `doctor` reports them as "configured, not
  contacted".
- **`TTK_SESSION_OWNERSHIP=owner` (D-128)** binds each browser session to the principal that created it at every surface
  — tools, resources, completions, the event stream, files, live tickets, recordings and the admin session routes. Other
  principals get `unknown-session`, `admin` reaches everything, and `default` is per owner. An admin's
  `GET /api/v1/sessions` items carry `owner`, and the Sessions screen shows it on each card (RV-7).
- **Resource-template completions (D-129):** `completion/complete` for session ids, resource kinds, file ids, share
  paths and skill names, filtered per caller.
- **OpenTelemetry tool spans (D-127):** with `OTEL_DENO=true` in the bundled image, every tool call is a `ttk.tool` span
  and a `ttk.tool.calls` count, carrying only the tool and the outcome.
- **Workspaces from a git remote (R12, D-131, D-132):** `sandbox_clone {url | remote, ref?, depth?, name?, timeout_ms?}`
  (`sandbox:execute`) creates an owned workspace from an `https://` URL on a host the sandbox lists in
  `TTK_SANDBOX_GIT_HOSTS`, or from an operator remote by id from `TTK_SANDBOX_GIT_REMOTES_FILE`
  (`/run/secrets/ttk_git_remotes`), whose credential the sandbox adds itself and never puts in a cage. Shallow by
  default (depth 1); `.git` is read-only afterwards; the result carries `commit` and `ref`; a failed clone says why
  under `feature-unavailable`, in fixed words (R3-9). Off by default; offered only while the sandbox's `/healthz` says
  `clone: true`. `sandbox_list` names the allowed hosts and remote ids.
- **Reporting:** `capabilities.tykotech.sessions.ownership`; admin diagnostics `confirmations`, `humanHandoff`,
  `sandboxClone`, `secretProvider`, `sessionOwnership`, `telemetry`, `mcpApps` and `signedLinks`; System screen tiles
  for session ownership, MCP Apps, signed links, confirmations, human handoff, secret provider, OpenTelemetry and git
  clone, each with a glyph the screen draws nowhere else and dimmed to no less than 3:1 when off (E-113); the
  `network:read` scope glyph.

- **`TTK_CHROMIUM_NO_SANDBOX` (D-094)** (default `false`; startup warning; diagnostics `chromiumSandboxed`; capability
  `browser.sandboxed`; never set in the images); `browser_health.sessions.browser_unresponsive`; navigation events gain
  `blocked` and `containment` (D-095, D-096).
- **Cookie sign-in for the web UI (D-097):** `"session": "cookie"` on `POST /api/v1/auth/login` (`ttk_session`, or
  `__Host-ttk_session` with `Secure` on https; answers `{ expires, user, csrf }`), `csrf` in `/api/v1/auth/me` for
  cookie requests, logout clears the cookie, and the problem slug `csrf-failed` (403).
- **The explicit scope `metrics:read` (12 scopes), `doctor --grant` (D-098, E-80)** to repair an account's scopes
  offline (in `users.json`, or the cluster KV with `--unstable-kv`), the account count in `doctor`'s output, and a
  startup warning when no enabled account holds `admin`.
- **`GET /metrics` (D-101)** with `TTK_METRICS=true`, readable with `metrics:read` or `admin`: requests, tool calls,
  sessions, viewers, rate limiting, failed sign-ins and process memory.
- **Durable agent tasks and A2UI surfaces (D-104):** `agents/tasks.json` and `agents/surfaces.json` under
  `TTK_DATA_DIR`; unfinished work comes back `FAILED` "interrupted by restart" and is never run again; restored
  surfaces' buttons stay disabled until republished; `TTK_AGENT_TASK_RETENTION_S` (default 86400).
- **`TTK_AGENT_TASK_TIMEOUT_S` (D-105)** (default 600) bounds text and delegation tasks; tool tasks take their tool's
  bound.
- **A2A push notifications (D-106),** offered only with `TTK_A2A_PUSH_ALLOWED_HOSTS` and an outbound grant for those
  hosts, and under a scoped grant only once a startup probe proves the DNS resolver is permitted (https; address
  re-checked on every delivery; token echoed); `GetExtendedAgentCard` and `GET /a2a/v1/extendedAgentCard`; the A2A
  HTTP+JSON binding at `/a2a/v1`. The editor ACP proxy forwards the agent's `loadSession` and image, audio and
  embedded-context capabilities and relays `session/load` (D-107).
- **An opt-in Docker workspace backend for the coding sandbox (D-108, D-109):** `TTK_SANDBOX_BACKEND=docker`,
  `docker-compose.sandbox-docker.yml` and `docker/Dockerfile.sandbox-workspace` (`tykotech-sandbox-workspace:0.2.0`) — a
  hardened container per workspace, validated create and exec bodies, `NetworkMode: none`, named-volume subpath mounts,
  idle stop and startup reconciliation. Sandbox settings `TTK_SANDBOX_BACKEND`, `TTK_SANDBOX_DOCKER_SOCKET`,
  `TTK_SANDBOX_WORKSPACE_IMAGE`, `TTK_SANDBOX_DOCKER_VOLUME`, `TTK_SANDBOX_DOCKER_SOCK_VOLUME` and the Compose variable
  `TTK_SANDBOX_DOCKER_GID`; the sandbox's `/healthz` reports its backend, as do the diagnostics (`sandboxBackend`) and
  `capabilities.tykotech.sandbox` for `sandbox:execute` callers (D-110); `test:sandbox --image <tag>`;
  `tests/sandbox/verify_docker_backend.ts`.
- **A2UI on the v0.9 basic catalog (D-111):** Image, Icon, List, Tabs, Modal, Slider, DateTimeInput, ChoicePicker,
  Video, AudioPlayer and Text variants; `createSurface.theme`; a sandboxed `Html` component served by
  `GET /api/v1/a2ui/surfaces/{surfaceId}/html/{componentId}`.
- **Typed `outputSchema` for every `sandbox_`, `agent_`, `a2ui_`, `file_`, `skill_` and `prompt_` tool (D-113),** inside
  `{ result }`; progress with a total from `browser_run_task`, `sandbox_exec`, `browser_wait_for` and `browser_download`
  (D-114); a System "Coding sandbox" tile with the backend.
- **Container verifier `--shape`, a derived tool set and Chromium sandbox assertions (D-103).**

- **A redesigned control plane on a component kit (D-089–D-091).** The SPA is built on Web Awesome 3.14 (MIT) with
  Lucide icons (ISC) from one same-origin sprite: a floating dock with count badges, a context bar, a command palette
  (Ctrl/⌘+K), dark and light themes, number-first tiles, cards instead of rows, icon-only controls with tooltips and
  accessible names, illustrated empty states, and confirmation in a popover beside the button. Every screen was redrawn;
  behaviour, routes and API calls are unchanged. The sign-in form recognises an API key as it is typed and folds the
  password field away; the user popover says how the browser is signed in.
- **Wave 2 of the specification audit (D-084–D-088).** Accounts and sign-ins shared through the cluster store
  (`TTK_CLUSTER_KV`); A2A follow-up messages answer pending permissions, task history keeps the agent's turns, tool
  calls and plans reach subscribers; ACP `authenticate` with `TTK_AGENT_AUTH_METHOD`; configured A2UI tool actions
  (`TTK_A2UI_ACTIONS`); `agent_delegate` structured parts; `sandbox_create` returns its limits and can seed from a share
  folder (`from_share`), `sandbox_write` returns its path, `sandbox_list` lists inside a workspace; crash →
  `browser-crashed` and teardown; a drain stage on shutdown (`503 service-unavailable`); `doctor` resolves the browser.

- **MCP protocol completeness (D-079–D-082).** A client that cancels a call (dropping the request, or
  `notifications/cancelled`) now stops the tool; calls past one second send `notifications/progress` to a caller that
  sent a `progressToken`; the stateful 2025 mount and stdio push `resources/list_changed` and, for subscribed URIs,
  `resources/updated` (`resources/subscribe` is served); `tools_withheld` names every tool family; and the sandbox and
  ACP runner are re-probed every 30 s, their tools appearing and disappearing with them (`tools/list_changed`).

- **A library on the data volume: file share, skills and prompts (D-075).** New MCP tools `file_*` (list, stat, read,
  write, mkdir, delete, move), `skill_*` (list, get, read_file, put, delete) and `prompt_*` (list, get, put, delete,
  render); `ttk://share/{path}` and `ttk://skill/{name}` resources; every stored prompt and every skill (`skill:<name>`)
  served as a native MCP prompt; HTTP routes under `/api/v1/share` for binary upload and download; a Library screen in
  the SPA. Two new scopes: `files:read` (in the default grant) and `files:write` (explicit). Served by the gateway and
  the stdio mount whenever `TTK_DATA_DIR` is set.
- **Live shell sessions in the coding sandbox (D-076).** `sandbox_session_open`, `sandbox_session_input`,
  `sandbox_session_read` and `sandbox_session_close` run a line-mode shell in the same bubblewrap cage a command uses,
  beside file reads and writes; `/api/v1/sandbox/sessions` streams it to the new Workspaces screen. One session per
  workspace, four per service, 30 min idle, 4 h lifetime.
- **Tools console chips follow the server, not the browser catalog:** Browser, Files, Skills, Prompts, Sandbox, Agents,
  Surfaces.
- **User management in the SPA (`#/users`) and over `/api/v1/users` (D-074).** An administrator lists accounts, adds one
  (with a chosen or a generated password, shown once), edits scopes with the explicit-only grants marked, disables and
  enables, resets a password, ends every sign-in of an account, and deletes it; every account can change its own
  password. The store refuses to remove the last enabled administrator, and an administrator cannot delete, disable or
  de-scope themself. Accounts and sign-ins persist in `TTK_DATA_DIR` (`users.json`, `logins.json` holding token hashes
  only).
- **Staying signed in (D-073, D-097).** The SPA's `ttks_` sign-in session — never a raw API key or a password — survives
  a reload and a gateway restart for up to `TTK_LOGIN_TTL_S`; it is held in an HttpOnly cookie (see Breaking). A session
  the server refuses is forgotten at once. `TTK_LOGIN_TTL_S` is new (default `604800`, 60–31536000).
- **A Tools console in the SPA (`#/tools[/:name]`).** Every tool `tools/list` serves the credential, with one filter
  chip per **server** the credential can reach (Browser, Files, Sandbox, Agents, Surfaces) and the catalog families
  (Navigation, Interaction, Perception, Session, Files) as headings inside the list. The screen spans the window on wide
  displays instead of sitting in a centred column. Each tool gets a form generated from its JSON Schema, with a JSON
  editor for anything the generator does not model, so no argument is unreachable. Results render images, structured
  JSON, text and resource links; the last 25 calls are kept in memory, never persisted. Tools that need MCP sampling say
  so, because the console has no model.
- **A Resources browser (`#/resources[/:uri]`).** `resources/list` grouped by session with `ttk://capabilities` pinned,
  resource templates as fill-in forms, and live `resources/read` rendered as JSON, text, an image or a binary download.
  It also asks `prompts/list`, and says that this server publishes none.
- **A Live View inspector.** Quick actions (screenshot, full page, page state, session info, frames, audit log, go back,
  record where served, close session), viewport presets and a custom size, the tab list with focus and close,
  storage-state save/load, session downloads fetched with the bearer, a live event log over the existing socket's
  `events.subscribe`, and an output pane. Every action is a `tools/call`, so it obeys the takeover lock as an agent
  does: while anyone holds the lock the mutating controls are disabled with the reason as a tooltip, and reads keep
  working.
- **Sessions and System gain operator actions.** Sessions has a KPI strip, a 5 s auto-refresh, a screenshot preview per
  row (the `ttk://session/{id}/screenshot` resource), confirm-to-close, and an admin-only **Close all**
  (`browser_close_all`). System adds an MCP-capabilities panel (from `ttk://capabilities`), a live-view origins panel
  that edits this token's overlay through `PUT /api/v1/live/origins` when the server reports it writable, a heap meter,
  and an auto-refresh toggle.
- **Agents: Follow a task's events.** A running task's `GET /api/v1/agent/tasks/:id/events` stream is read with a
  fetch-based SSE reader (`streamEvents`), since `EventSource` cannot carry the `Authorization` header. Streams stop
  when the screen is left.
- **`packages/web/src/mcp.ts`, a stateless JSON-RPC client for `POST /mcp`.** It uses the same bearer as the REST calls
  and sends no `initialize`: a 2025 `initialize` would be routed to the stateful mount and leave a transport session
  behind. It accepts a JSON or an SSE reply and caches `tools/list` for the page.

### Changed

- **Larger filter chips and logos.** The Resources filter chips are 15% larger again, with count bubbles in inverted
  text colour for contrast; the dock logo is 20% larger and the Sessions empty-state logo 40% larger.
- **Brand: Multi-MCP.** The dock shows the Multi-MCP logo and wordmark; the TykoTech logo sits at the dock's foot (full
  logo with the dock open, its lettering alone when narrow; hidden on the phone bar). Assets:
  `packages/web/static/brand/` (served at `/assets/brand/…`). The sign-in screen shows the Multi-MCP wordmark; the tab
  icon and the MCP `serverInfo` icon are the raster Multi-MCP mark (`favicon-32.png`, `icon-192.png`), replacing the
  generated `favicon.svg`. The display name "TykoTech MCP" is now "Multi-MCP" (page title, `serverInfo.title`,
  instructions, A2A card, OAuth resource name); the wire name `tykotech-mcp` is unchanged (E-117).

- **Resources counts name what was added (D-155).** Each group's card and tree count is its sessions, files, skills,
  prompts, workspaces, agent tasks or surfaces, in that noun (`2 sessions`, `0 prompts`), from `/api/v1/overview` — not
  its tree leaves; the Server group shows tools only. Filter toggles say they count tree entries.
- **`POST /api/v1/agent/tasks` and A2A `SendMessage`/`SendStreamingMessage` accept a provider selection (D-143):**
  `provider` and `model` beside `message` on the REST body, and under the request-level `metadata` on A2A, each a string
  of at most 64 characters. Naming a provider without `model:invoke` is `403 forbidden-scope` / `-32600`; an unknown
  provider or model is `-32602`, an unreachable one `-32004`, and on REST both arrive as `400 invalid-request` with the
  text in `detail`. The no-backend text is now "Text execution requires a configured ACP agent or a model provider".
- **Every agent task carries `metadata`** — `kind` (`text` | `tool` | `delegation`), and for a text task `backend`
  (`model` | `acp`), `provider`, `model`, `steps` and `usage` — on every binding and in `agents/tasks.json`.
- **Three model-key names are blanked for Chromium and ffmpeg (D-143):** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
  `TTK_MODEL_API_KEY` join `CHILD_ENV_BLANKED` (25 names). The server never reads them.
- **The dock has eight sections, not nine:** the Library is absorbed into Resources, and `#/library[/<tab>]` redirects
  to `#/resources/<group>` with no history entry.
- **Signed links live up to an hour (G5, D-140):** `TTK_SIGNED_LINK_TTL_S` is 10–3600, default 3600, and
  `browser_file_link.ttl_seconds` 10–3600.
- **The shipped tasks, the bundled `CMD` and both Compose overlays grant the six OpenTelemetry names the egress check
  reads (`OTEL_DENO`, `OTEL_DENO_VSOCK` and the four `OTEL_EXPORTER_OTLP_*ENDPOINT` names) by name (D-137),** pinned by
  `gate:tasks` rule T5; the HEALTHCHECK is narrowed to run without `OTEL_DENO`.
- **In the default scope an allowlisted browser briefly pauses fetch, XHR and EventSource requests for inspection (about
  0.5 ms each, D-139).** A refused subresource or hint appears in `browser_network_log` as
  `net::ERR_BLOCKED_BY_CLIENT.Inspector` and in the log at `info` (origin only, rate-limited), never on the event ring.
  `browser_evaluate`'s description now says the allowlist constrains an evaluated fetch under
  `TTK_ALLOWED_DOMAINS_SCOPE=all`.
- **Every coding-sandbox tool names a failure by the sandbox's code in fixed words (FXC-N1);** `sandbox_clone` keeps its
  own five texts, `cage_failed` and unknown codes keep the generic text, and nothing from the service is passed on.
- **System shows no glyph twice outside the dock (D-092 amended):** copy and Remove are the only per-row repeats, list
  entries and group labels carry no glyph, Save overlay is a text button shown only with unsaved changes, and capability
  tiles show on/off as a drawn mark (disc, ring, `!`, `?`).
- **`deno task test:unit` and `cov:unit` include `packages/cli/` (D-137, N1).**
- **With `TTK_ALLOWED_DOMAINS` set, Chromium refuses every off-list document request before it is sent, instead of
  containing it afterwards (R3, D-115, E-94).** This covers clicked links, script and meta-refresh navigations, form
  posts, each redirect hop, pop-ups and iframes. The off-list host receives no request, the tab keeps its page, a pop-up
  that never loaded is closed, and the navigation event carries `containment: "request-blocked"`. New tabs, pop-ups and
  out-of-process frames start paused until the veto is armed on them.
- **`browser_navigate` and `browser_go_back` through a refused redirect answer `navigation-blocked` naming the origin**
  (this replaces the `url: "about:blank"` answer listed under Breaking, which remains only where the browser could not
  refuse the request); the live view's `navigate` answers `navigation-blocked`; `browser_download` through a refused
  redirect or script navigation keeps its `navigation-blocked` text but leaves no canceled ledger row. Each answers
  `navigation-blocked` only for its own request chain: a page that leaves the list by itself after the tool's navigation
  landed is recorded, but does not fail the tool (R2-2).
- **`deno task dev`, `stdio`, `serve:cluster`, `doctor` and `admin:generate` deny FFI first, and the task gate enforces
  it on each Deno invocation's own flags (rule T4, E-103).** `admin:generate` also runs with `--no-prompt`. The
  sandbox's `/healthz` answers `{ ok, backend, clone }`.
- **`test:compose` and `test:agents:compose` require `--tag <t>` and run images built from this tree (E-112).** Deployed
  tags are refused and nothing is pulled; every secret, a synthetic administrator record included, comes from a scratch
  folder checked after `compose config`; the agents proof builds `tykotech-agent-runner:<t>` and its fixture instead of
  rebuilding `:0.2.0`.
- **`deno task build:web` also writes `dist/embed_live.html` and `dist/embed_a2ui.html` (D-135; no new grant).** The
  Tools console hides app-only tools and lists the new browser tools under Perception, Files and Session (RV-5), and
  `/assets/embed_*` is not served (D-134).

- **Startup warns, naming the fix, when API keys are configured and no key and no account holds `admin` (D-098).**
  Traversal spellings of file ids answer `400` instead of `404` (E-89).
- **Each owner runs at most 2 of the 4 concurrent agent tasks (D-105).** Docker workspace containers are named and
  labelled per deployment and replaced when their create body or image changed (D-108, E-90).

- **Explicit tool annotations (D-112):** `openWorldHint` is always stated; `destructiveHint` and `idempotentHint` are
  always stated on mutating tools; `file_delete`, `skill_delete` and `prompt_delete` are destructive; most non-web tools
  are closed-world. Cancellation stops `browser_run_task`, `browser_get_state`, `browser_find`, `browser_screenshot`,
  the download wait, `browser_head`, library reads and the agent and sandbox waits (D-114). The Agents screen's Delete
  surface is a quiet confirm button.
- **Agent tasks (D-104–D-106):** finished tasks are kept 24 h by default (was 1 h), also without a data dir; execution
  bounds follow the task's kind (`sandbox_exec` timeout + 150 s; `browser_wait_for` timeout + 30 s, 40 s at its default;
  other tools 120 s; text and delegation `TTK_AGENT_TASK_TIMEOUT_S`); A2A streams are re-checked every 300 s and end at
  1800 s, on rotation, logout and shutdown, with a terminal `-32000` event; the agent card says
  `extendedAgentCard: true`, lists the HTTP+JSON interface, and its `pushNotifications` follows the push gate.
  `readyExpansion` is removed from the `@tykotech/gateway` exports (D-107).
- **`users.json` is schema version 2 with a one-time upgrade (D-098)** (cluster marker `["ttk","schema","users"]`); the
  bind policy counts user accounts as credentials (C9, D-099).
- **`accept_downloads` applies at run time (E-77);** the serializer no longer treats `pointer-events: none` layers as
  covering (E-76); `browser_element_at` and the live view's hover resolve pseudo-element hits (D-096).
- **`TTK_MAX_BODY_KB` is enforced (D-100).** Base images are pinned by digest, every image and CI runs Deno 2.9.7 (the
  sandbox-workspace image takes its Deno binary from the same digest), and the CI slim leg is tagged `:ci-slim` and
  verified as slim (D-103).
- **`dev`, `stdio` and `serve:cluster` grant the resolved browser and `TTK_FFMPEG`, pin `TTK_BROWSER_PATH`, grant the
  temporary directories and run with `--no-prompt`; `scripts/compile.ts` chooses its `--chromium` default per target
  (E-82).**
- **The sandbox image contains an empty `/run/ttk-sandbox-sock` (its `CMD` is unchanged);** the internal `scratch` exec
  mode and `LIMITS.sessionProcesses` are removed (no API change) (D-109, D-110).

- **The logo opens and closes the dock; Tools is a workbench (D-093).** The page title left the context bar (the
  highlighted dock item names the screen). Clicking the logo widens the dock to show each section's name beside its
  icon, and the choice is remembered. Tools gives its list more room, fits the server filters on one row, merges the
  tool's header and arguments into one compact card, and puts the result beside it on wide screens. Resources uses the
  full width, other screens widen to 1680 px, and Library no longer shows Upload twice in an empty folder.
- **Every control has one home; metrics are a compact strip (D-092).** The dock only navigates (the brand is a mark,
  Sign out moved to the account popover), the context bar drops the repeated section glyph and puts the screen's actions
  at the right, refresh buttons are gone from screens that keep themselves current (Users and Workspaces now poll), an
  empty list's create action lives in its empty state only, destructive buttons stay quiet until hovered, and the metric
  cards became one glass strip sized to its content. Password change opens from the account popover for any password
  account. Workspaces and Library no longer report missing scopes for a moment after a reload.
- **SPA build (D-089, D-090).** `build:web` now also bundles `src/styles/app.css` into `dist/app.css` and writes
  `dist/icons.svg` and `dist/favicon.svg` (`scripts/build_icons.ts`); `static/app.css` is gone. Every screen but
  Connect, Sessions and the Live View is a lazy chunk, so `app.js` is about 31 KB; a first paint, the kit included, must
  stay under 160 KB of gzip JavaScript. New pinned dependencies: `@awesome.me/webawesome@3.14.0`,
  `lucide-static@1.49.0`.
- **Destructive actions confirm in a popover (D-091)** instead of asking for a second click within three seconds.
- **The theme preference is stored** under `localStorage['ttk.theme']` (`dark` or `light` only); with `ttk.dock`, it is
  all the SPA keeps in storage.
- **The SPA is redesigned around a left icon rail, a top bar and one full-width scroll region.** `renderShell` builds
  the 56 px rail (Sessions, Live View, Tools, Resources, Agents, System, Sign out), the 48 px top bar (title, page
  actions, a gateway health chip polling the public `/healthz` every 20 s, the user chip) and the main region for every
  authenticated screen. See `SPECS/DESIGN-SYSTEM.md`.
- **UI text is set in the system sans; monospace is kept for data.** Ids, URLs, URIs, tool names and JSON use `--mono`;
  the rest uses `--font`. No font file is loaded.
- **Icons are inline SVG**, built with `createElementNS` from a compact path DSL in `icons.ts` — no icon font, no CDN,
  no `innerHTML`. Motion is CSS keyframes only, and `prefers-reduced-motion: reduce` switches all of it off.
- **The Live View URL field also navigates when nobody holds the session.** Enter sends `navigate` over the socket while
  driving, and calls `browser_navigate` while the session is free; it stays read-only while someone else drives.
- **`build:web` code-splits.** It now cleans `packages/web/dist` and runs
  `deno bundle --platform browser --minify --code-splitting --outdir packages/web/dist packages/web/src/app.ts`.
  `app.js` is ~68 KB; `ws.ts` and `a2ui.ts` — the only runtime users of the Zod wire schemas — are dynamically imported,
  so the shared wire + Zod chunk (~98 KB) loads only when a Live View or the Agents screen opens. The SPA entry is
  renamed `src/entry.ts` → `src/app.ts`. No gateway or `scripts/compile.ts` change: both already take every file under
  `dist/`. The 150 KB budget now applies to `app.js` and to each lazy chunk separately (D-069), asserted by a web unit
  test whenever `dist/` is built.
- `LiveViewSocket` takes an optional `onEvent` hook for session event records.

### Removed

- **The Library screen.** Its files, skills and prompts are groups of the Resources tree; every behaviour (upload, new
  folder and file, move, delete, download, grid and list, the skill and prompt editors, `files:write` gating) has one
  home there. Nothing on the wire changes.

### Fixed

- **A `model` named without a `provider` is refused (D-143):** `-32602 "model requires provider"` on A2A,
  `400
  invalid-request` with that `detail` on REST; the server no longer guesses the provider.
- **A credential that loses `model:invoke` mid-task stops the loop (D-143):** the scope is re-checked before every
  provider call, and the task fails with "model:invoke scope required" at the next step.
- **The `REPLACE_WITH_KEY` placeholder is refused in a providers file:** a preset copied from the composer with its key
  unedited fails `doctor` ("the key is the composer placeholder, entry N, field api_key") instead of dialling a
  provider.
- **A providers file with CRLF line endings loads** as one saved with LF does.
- **`doctor` prints each provider's host as `host:port`** — the `--allow-net` spelling the override needs.
- **Web UI — the Agents task composer submits on first use:** its submit gate no longer stays disabled until a field is
  re-edited, and a failed providers fetch offers a retry instead of an empty target list.
- **Web UI — Resources:** a sub-folder expands again after the tree is re-listed, and the **Add** menu stays visible in
  an empty folder; drawers close on navigation instead of outliving the screen that opened them.
- **Web UI — System:** the Configuration panel sits on its own full-width row, and the composer's diff table keeps its
  key column on one line (only the before/after cells wrap).
- **`OTEL_DENO=TRUE` on a build that is not exporting is refused like `true` (D-137, DX-2).** Deno reads the value
  case-insensitively, so the gate now does too; it used to start silently with nothing exported.
- **Tabbing into a field inside a hovered tooltip owner (a Library field) hides that owner's tooltip (BUG-4, FE-1,
  CR-5).** It used to stay open over the field being typed in; Tab between tooltip owners still moves the tip (RV-13).
- **An OAuth token with a fractional `exp` can mint signed links again (D-140, BUG-3).** Its expiry is floored to whole
  milliseconds, so the link cap reads it instead of refusing the token as having no known expiry.
- **`browser_file_link` refuses identifiers a link cannot carry (D-140, BUG-2)** — an owner past 512 characters or a
  token body past 1800 — with `invalid-arguments`, instead of returning a link that answered `401` on every follow.
- **One secret store per mount (NF-3):** the HTTP server and stdio each build one `SecretStore`, so log redaction and
  the tools' secret handling read the same secrets.
- **Diagnostics `hasAdminUser` is `true` only when an enabled account holds `admin` (RV-14).**
- **The System screen's capability tiles are reachable by keyboard (RV-13):** Tab draws a ring and shows the tile's name
  and state, and Tab from one tooltip owner straight to another now shows the second tooltip. The Tools screen's
  selected row title is 5.54:1 in light (was 3.63:1) and 6.56:1 in dark (RV-15). The Live View Inspector's event stream
  survives a reconnect while Streaming is on, and not once it is off (FXD-N3).
- **A late `browser_run_task` answer for a replaced run no longer drives the new run (F3, D-126).** A cluster fan-out
  whose local answer could not be merged returned an already-consumed body; it now passes the answer through intact
  (D-121). The documented OpenTelemetry switch is `OTEL_DENO=true`; `OTEL_DENO=1` is rejected by Deno 2.9.7 (D-127).
- **A HEAD on `/api/v1/sessions/{id}/files/{fileId}` releases the file at once (K-2)**; it held the file lease until the
  session closed.
- **Live View: a ticket refused as `unknown-session` ends the view at once (RV-2)**, with one way back ("Back to
  sessions") instead of retrying for ten minutes; the inspector, Go back and Screenshot wait until the view connects.
- **The control plane runs Zod `jitless` from its entry (K-5)**, so the first Live View no longer reports a
  `script-src eval` violation; the validator stays out of the first paint.
- **`browser_head` reports refused, TLS and DNS failures as `refused`, `tls` and `dns` (K-8, D-042)**: Deno's `fetch`
  puts the detail in the error's `cause`, which the classifier now reads, so these had all reported `protocol`.

- **Sign-out clears the cookie even if the server cannot end the session (`500`, logged) and is no longer
  rate-limited;** the web UI says signed out only when the server confirmed it (otherwise it shows the error, retries
  and asks before a reload); share uploads from the web UI keep their content type, so binary files no longer fail as
  Invalid JSON; `/api/v1/auth/me` is not cacheable (D-097, E-88).
- **Sandbox Docker backend (D-108):** the volume check runs once at start-up in its own bounded container and never
  writes in a workspace's home. **Agents (D-104):** `tasks.json` and `surfaces.json` writes are synced to disk; restored
  A2UI surfaces are re-validated, theme included.
- **A2UI share media is de-duplicated, bounded (8 concurrent, 32 MiB per surface), aborted and released when the Agents
  screen is left or a load fails (D-111);** surface themes reach checkboxes, the active tab, the Button and the dialog
  radius; Button labels pick black or white for contrast; a disabled Button is readable; tab panels are tighter. System
  capability tiles are centred, and the sign-in screen no longer shows a stray scrollbar.

- **`browser_element_at` answered `none` under `pointer-events: none` covers, icon `::before` glyphs and stretched links
  (A1, D-096); `browser_health` reported a wedged Chromium healthy (A4); `accept_downloads` was always unsupported (A3,
  E-77).**
- **A `sandbox_exec` submitted as an A2A or REST task is no longer cut at 120 s (C4, D-105);** a `null` ACP result no
  longer kills the transport (E-84).
- **The sandbox client keeps `file_timeout` and `file_failed` instead of reporting `unavailable` (C15, D-110).**
- **The System "Sandboxed Chromium" tile reported the coding sandbox;** it reports Chromium's own sandbox
  (`chromiumSandboxed`, unknown when the gateway does not report it) (C12).
- **`TTK_CLUSTER_KV` works in the bundled image and both overlays (D-102);** `deno task stdio` can launch a browser when
  an MCP client starts it (E-82); `version_test` covers all eleven manifests; stale comments and the slim uid note.

- **Agent capacity, protocol robustness and resource hygiene (agent-expansion review).** Finished tasks no longer hold
  the task caps for their hour of retention (AG-1); a refused or malformed editor permission reply no longer ends the
  ACP proxy session (AG-2); agent stderr is drained without a lifetime cap that killed chatty agents (AG-3); an attached
  event stream or in-flight turn keeps a connection from being reaped, and a prompt timeout cancels that turn instead of
  killing the agent (AG-4); editor `session/new` uses the runner's workspace (AG-5); cancelling during connection setup
  no longer leaks a runner connection (AG-6); plus AG-7, AG-9, AG-10, AG-11, AG-13, AG-14 and sandbox SB-3, SB-4, SB-6
  to SB-10.
- **Test infrastructure:** the live-socket harness no longer leaks re-probe timers, and the agent-runner and agent
  Compose proofs have tasks (`test:agents:runner`, `test:agents:compose`).
- **A stray scrollbar and an empty gutter no longer sit mid-window on System.** The centred `.screen` container scrolled
  itself, leaving a light scrollbar beside an empty strip that read as an unused side panel. The main region is now the
  page's one scroll container, full width, so the scrollbar sits at the window edge.
- **The Live View's top bar follows the focused tab.** The page title is taken from the focused entry of every `tabs`
  message as well as from `state`, so switching tabs updates it.

## [0.2.0] - 2026-09-10

### Breaking

- **A scheme-less `TTK_SECRETS` `domains` pattern now covers `https:` only (SEC-FH-23, D-063).** The secret pin is
  evaluated by the secret-scoping rule instead of the navigation one, so a pattern like `"bank.example.com"` no longer
  permits the credential over plaintext `http:`. A secret that genuinely belongs on a plaintext host needs an explicit
  `http://host` pattern. The full entry — what was reachable before, and why — is under **Security** below; it is
  repeated here because it is the one change in this release that can break a working deployment without any code change
  on your side.

- **`task` must now be named to be held: the autonomous loop is no longer in the default grant (SEC-01b, D-024).**
  `browser_run_task` drives the browser by itself, spending the caller's model and acting without a per-action
  confirmation — a different grant from ordinary tool use, which is why D-024 gave it its own scope. Until 0.2.0 every
  default-grant site handed it out anyway, so that separation described intent rather than behaviour. **What is removed,
  and from whom:** `task` moves from `DEFAULT_SCOPES` to `EXPLICIT_SCOPES`, so a credential whose record omits `scopes`
  no longer holds it, and neither does the anonymous loopback principal or the stdio mount unless `TTK_ANON_SCOPES`
  names it. An OAuth token that _names_ `task` in its scope claim still receives it — that is the explicit grant, not a
  hole. **The remedy is one flag:** `deno task doctor --new-key <id> --scopes mcp:invoke,task`, or
  `deno task doctor --new-key-set <prefix>`, which mints one single-scope key per scope and therefore already includes a
  `task`-only key; for stdio and loopback, name it in `TTK_ANON_SCOPES`. Nothing else about a credential changes and no
  tool name or parameter moves; a principal that never used `browser_run_task` sees only that the tool is absent from
  `tools/list`. This is the intended effect rather than a side effect — nobody ever chose to grant autonomous browser
  control — and the version stays 0.2.0 deliberately: an honest breaking minor rather than a 1.0.0 bump.

- **`browser_evaluate {frame_id}` compiles an EXPRESSION on the repaired same-process frame path, so a multi-statement
  program that used to be accepted there is now a syntax error (E-75, D-054).** The E-75 repair — see **Security** and
  **Fixed** — moved that one path from a receiver-less `Runtime.evaluate` to a `Runtime.callFunctionOn` against a handle
  on the frame's own `window`. The tool's contract has always said it evaluates an expression, and now it does so
  everywhere; until this release a _program_ aimed at a same-process child was accepted, because it was running in the
  top document, where the old call shape allowed one. **Measured:** `const a = 1; a + 1` answers `ok: false` with a
  `SyntaxError` in a same-process child frame and `ok: true, value: 2` on the top document. **The remedy is one
  wrapper:** `(() => { const a = 1; return a + 1; })()`. **Who is affected:** callers passing multi-statement text with
  a `frame_id` naming a same-process child. Two paths are untouched and stay byte for byte what 0.2.0 sent — the focused
  top document, including when it is named by its own frame id, and every out-of-process frame. This is a breaking
  _evaluation-shape_ change, not an authorization one; the release still carries exactly one breaking authorization
  change, the `task` scope above. It cannot regress a correct client, because what it replaces was an evaluation in a
  document the caller did not ask for.

### Specified and not built

Two things a reader of this release could reasonably have expected to exist — one because the requirement asked for it
and the discovery block reads as though it shipped, one because four shipped documents said it was enforced. They are
listed here rather than left to be found on the wire.

- **`browser_get_state` accepts no `since_token`, and answers no `{changed: false}` (D-050).**
  `needed-browser-functions.md` §1.2 asked for a diff mode alongside `state_token`, as a P0 item; `state_token` ships
  and the diff does not. The owner recorded it as a deferral on 2026-09-10 rather than building it, because the need it
  exists for — a settle loop that cannot tell "unchanged" from "changed back to the same element count" — is met by
  three shipped mechanisms: the **`dom.settled` event**, whose `token` is the `state_token` a read would return at
  settle and which costs no poll at all; **`browser_wait_for {until: {state_token_changes: '<token>'}}`**, which blocks
  until the table moves; and **comparing `state_token` client-side**, which is one string equality, and from which
  `indices_stable` is computable because both halves of the token are on the wire. **What is not met is the saving**: a
  poll that finds nothing changed still pays a full DOM build and a full state payload, which is §1.2's own argument for
  the diff. `capabilities.tykotech.state_token`'s `indices_stable: true` describes the token's format, not a server-side
  operation. The plan's acceptance row `AC-P0-12` is retired on this rationale; `SPECS/API-CONTRACT.md` §7.2 is the
  contract and D-050 carries the reopen trigger — ADM reporting the client-side comparison insufficient.
- **`TTK_MAX_BODY_KB` is parsed and never read, so no REST request body is capped (G-8).** The limits tables in
  `SPECS/API-CONTRACT.md`, `SPECS/BACKEND.md`, `docs/reference/api-endpoints.md` and
  `docs/reference/environment-variables.md` presented a 256 KiB REST cap as a control in force; it is not, and they now
  say so. The one body bound actually enforced is the MCP adapter's own 4 MiB default on `/mcp` (E-06), which cannot be
  overridden on the published adapter version. Bound REST bodies at your reverse proxy if you need one. Wiring the value
  in would be a behaviour change, which this release does not make; the reopen trigger is in `SPECS/API-CONTRACT.md` §7.

### Security

- **Fixed: a domain-pinned secret could be typed at origins the pin was supposed to exclude — `about:blank`, `data:`,
  `blob:` and plaintext `http:` (SEC-FH-23, D-063).** **Read this if you configure `TTK_SECRETS` with `domains`.** The
  pin was evaluated by the **navigation** policy predicate instead of the secret-scoping one. That predicate exists to
  answer "may the agent go here", and it deliberately allows three classes of URL before it consults any allowlist:
  `about:blank` and the `chrome://newtab` spellings, `data:` and `blob:` unconditionally, and — for a pattern written
  without a scheme — `http:` as well as `https:`. Used as a credential pin it therefore **failed open**, and this was
  measured through the shipped `browser_fill_secret` handler with a secret pinned to one host: the credential was typed
  at `about:blank`; at a `data:` document; at `blob:https://<attacker-origin>/…`, **with the audit ledger recording the
  spend at the attacker's origin**; and over plaintext `http` to the pinned host. `browser_type`'s `<secret>`
  placeholder took the same path. It was reachable without any exotic step: a page can navigate **itself** to a `blob:`
  URL of its own origin, and from that moment the pin stopped applying to it.

  **`browser_get_state` amplified it rather than merely permitting it.** `available_secrets` resolves through the same
  predicate, so on such a page the server actively **told the model** the pinned credential was usable there. Both
  consumers are corrected at the one shared predicate, so the advertisement and the pin cannot disagree.

  **What changes for an operator.** The pin is now `urlMatch(url, pattern, 'secret')`: a scheme-less pattern covers
  **`https:` only**, and the match fails closed on a host-less, unparseable or new-tab URL, so `about:blank`,
  `about:srcdoc`, `data:`, `blob:` and `javascript:` are refused for any pinned secret. **A pattern such as
  `"domains": ["intranet.corp"]` no longer permits `http://intranet.corp/` — that is the intended narrowing, and it is
  the one change that can break a working deployment.** The remedy is one character-for-character edit:
  `"domains": ["http://intranet.corp"]`, the explicit escape hatch of the matcher's scheme rule, which still works and
  now says out loud that a credential is permitted over plaintext. Ordinary `https` pins are unaffected, including
  wildcard (`*.corp.example`), port and `www.` forms, and an **unpinned** secret — `domains` absent or empty — is
  unchanged, as is `browser_fill_secret`'s existing refusal of one.

  **Second half, same finding.** `browser_fill_secret`'s cross-origin confinement compared `URL.origin` strings, and
  that accessor answers `"null"` for **every** opaque origin — so an `about:blank` top document and a `data:` child, two
  different opaque origins that cannot script each other, compared **same-origin**. It now uses the same fail-closed
  predicate as `browser_get_html`'s cross-origin gate, under which an origin that cannot be named counts as a different
  one. Everything SEC-07 already got right is unchanged: the pin is still taken against the **live** frame URL read
  immediately before the dispatch, the stale-`state_token` refusal still fires before any URL is read, and the refusal
  codes are the same.

  **Not introduced by this release** — the defect predates it and lives in files this release does not otherwise touch.
  There is no configuration that mitigated it: an operator could not write a pattern that excluded `blob:`.

- **Reading a `browser_get_html` frame whose origin differs from the top document requires the `evaluate` scope, and is
  audited (D-055, D-056, D-058).** The tool returns a document **verbatim** — it is the documented exception to the
  password-masking predicate — so pointing it at a frame extends that verbatim read to any frame the caller names, and a
  login or payment frame is exactly where a `value=` on a password input, a CSRF token in a hidden field or a bearer
  token rendered into markup lives. A **same-origin** frame needs nothing beyond the grant a principal already holds —
  and what that does and does not extend is stated precisely rather than waved at. It **is** an extension: a child
  frame's serialized markup was not reachable by any unscoped route before, because the top document's `outerHTML` does
  not serialize a child's document, and a verbatim frame read discloses things `browser_get_state` masks or omits — a
  `value=` attribute and a hidden CSRF token among them (measured). It is bounded in the direction that matters: the
  disclosure is of **serialized markup**, so a value a user typed lives in the live `.value` property and does **not**
  appear. The acceptance rests on the documented masking exception and on the origin boundary, not on the claim that
  nothing is conferred. A **cross-origin** frame needs `evaluate`, the scope that already governs reaching another
  origin's content, and writes one `read-frame-html` audit row carrying the frame id, the **origin** (scheme, host and
  port — never the path or the query), the size returned and the outcome. It never carries a document byte, a prefix of
  one or a digest of one. That size, `result_bytes`, is **UTF-8 bytes** of the HTML actually carried back — the same
  unit the `evaluate` rows it shares the column with have used since B2.8, because one ledger column that meant
  characters in some rows and bytes in others would be unreadable. The result's `returned_length` is **characters** of
  the same text, in the units the rest of this tool's contract uses. Neither counts the truncation notice: that is the
  server's own boilerplate, and counting it would make the ledger overstate what left the page.

  **The gate is a per-call check inside the handler, not a scope on the catalog entry, and that is deliberate.** A
  catalog scope removes the tool from `tools/list` entirely, which would have taken the **top-document** read away from
  every principal that has it today — a removal, not an extension. `browser_get_html` is therefore still listed and
  still callable for every `mcp:invoke` principal, and nothing about the default `browser_get_html {}` call changed.

  **Origin decides, never process-ness.** Chromium's site isolation keys on scheme+site and ignores the port, so a
  cross-origin frame is routinely in the _same_ renderer as its parent; a gate written on "is this frame out-of-process"
  would have handed an unscoped principal a cross-origin document. Both URLs are read live from the frame tree at the
  moment of the call rather than from the last capture. An origin that cannot be named — `about:blank`, `about:srcdoc`,
  a `javascript:` frame, an empty URL — is treated as **cross-origin** and requires the scope; this is stricter than the
  web platform, where a `srcdoc` frame inherits its parent's origin, and is the direction an unknown must fail in. The
  focused top document is unaffected and stays readable on `about:blank` as before.

  **The refusal is `scope-required` and never names the scope** — an error message is a probe result, so the _tool
  description_ documents the requirement instead. Every refusal on the frame path is raised before the extraction
  exists, so a refused read cannot return a byte of the top document; there is a test per refusal condition asserting
  exactly that.

  **The origin is checked against the document that answered, not against the one the frame tree named (SEC-FH-17).** A
  frame's origin read from `Page.getFrameTree` is five CDP round trips older than the bytes, and a frame that commits a
  new document in that window — an SSO hop, a `meta refresh`, an ad rotation, a link the caller itself clicked — would
  have answered with another origin's markup under a verdict computed from the URL it used to have, on the default grant
  and with no ledger row. The extraction therefore returns `location.origin` **beside** the HTML, out of the same
  receiver on the same round trip, and the gate is decided from that: there is no window between the check and the use
  to navigate in, rather than a smaller one. A frame that answers without it is refused rather than read. The same value
  is what the audit row's `origin` now records, so the ledger names the document whose bytes were handed over. A read
  refused by this second check writes **no** row, like every other refusal: nothing privileged reached the principal.

  **The origin is read off the frame's own `Document`, which is where the unforgeability actually lives.** `location` is
  an **own, non-configurable** property of a `Document` — redefining it throws, and patching `Document.prototype` loses
  to the own property — so the value the gate decides from is one a page cannot shadow, redefine or proxy. That the
  _value_ is unforgeable was never the whole claim, and this release states the other half rather than relying on it:
  the **handle** the value is read from is one the browser resolved (`DOM.resolveNode` on the owner element's pierced
  `contentDocument`), with no page-controlled accessor between the server and the document it names. A page still
  chooses its own **content** — `outerHTML` is whatever it exposed, and that is the documented exception to masking —
  but it does not choose the origin that content is attributed to, and therefore cannot suppress, misdirect or mint the
  ledger row for its own document.

- **`browser_get_html`'s size cap is enforced by the server, so a page cannot choose how much it returns (SEC-FH-24,
  D-062).** The 200 000-character cap moved into the page during this release for the bandwidth (D-057), and for that
  window it was also the **only** thing bounding the answer. The in-page extraction reads exactly `h.length` and
  `h.slice(0, limit)` off whatever `documentElement.outerHTML` returned, and `outerHTML` is an ordinary configurable
  accessor — so a getter returning an object with its own `length` and `slice` satisfied the extraction and chose the
  payload. Measured through the shipped handler in a real Chromium: **20 000 034 characters delivered in 564 ms**
  through `browser_get_html {}` — the default call, no `frame_id`, no scope required — reported back as
  `length: 200001, truncated: true`. The tool's own description, which the model reads at runtime, said "truncated at
  200000 characters"; against such a page it was false, as were `length`, `truncated` and `returned_length`.

  **What changed.** The server re-clamps what it received, out of the string it is holding, before the value leaves the
  read: `returned_length` is the length of the text block and can no longer exceed the cap, and `truncated` is
  `returned_length < length` rather than a comparison against a bound the page was trusted to have applied. **The
  in-page slice stays** — it is still why an honest 40 MB document never crosses the CDP channel, which is the whole of
  D-057's win; it is simply no longer the thing that enforces anything.

  **`length` is floored, not replaced**, so F-3 is untouched: it stays the document's **true** character count wherever
  the page reports one truthfully, because an honest renderer always reports at least what it sends. A page that
  under-reports its own size to make an over-limit payload look bounded has its claim replaced by the number of
  characters that actually arrived, and the field then reads as "at least this many". It can never be smaller than
  `returned_length`. A page can still over-state `length` — that is not checkable without transferring the whole
  document, which is the cost the in-page slice exists to avoid — and it changes no resource decision and no
  authorization. A reported length that is not a character count at all (`NaN`, `Infinity`, negative, non-integer) is
  refused as the existing "the frame returned no document" error, naming the frame and carrying no byte of what the
  frame answered with. **No CDP round trip was added on any path**, and the default call still spends exactly
  `[Page.getFrameTree, Runtime.evaluate]`.

- **Every `browser_evaluate {frame_id}` audit row written before this release names the wrong document when that frame
  was a same-process child (E-75).** An expression aimed at such a frame ran in the **top** document while the
  `frame_id` and `origin` the caller asked for were echoed back on the result and written into the ledger — so a
  deployment reviewing that ledger to find out where privileged code ran was told, and was told wrong. **Those rows
  cannot be corrected after the fact** and should be read as naming the tab's **top** document wherever their `frame_id`
  is a same-process child frame; the frames that were never affected are the focused document and every out-of-process
  frame, each of which already _is_ its own session's default execution context. This is an **audit-integrity** change,
  and it is why the repair is called out here and not filed as a correctness fix. The _disclosure_ impact is bounded,
  though **not** by top-document access — the same-origin policy means reaching the top document does not reach a
  cross-origin child — but by capability class: the `evaluate` scope has reached a cross-origin frame's own main world
  since B2.7 wherever that frame happened to be out-of-process, so the repair removes a limitation that depended on
  Chromium's process allocation rather than on any boundary this server draws. **`browser_fill_secret` is not affected
  and never was**: it resolves a frame only to read that frame's own live URL for the SEC-07 domain pin, and types on
  the element node the index table resolved. The repair also changes two observable behaviours on the repaired path —
  see **Breaking** for the expression-versus-program change, and **Fixed** for the full account and the `timeout` half.

- **`admin` is in the default grant, and 0.2.0 put two new surfaces behind it. Recorded as an accepted risk (D-051).** A
  key record that omits `scopes` holds `admin`, as do the anonymous loopback principal, every stdio client, and every
  key `doctor --new-key <id>` mints without `--scopes`. This release added the **unfiltered, cross-principal
  `browser_audit` read** and the **`GET`/`PUT /api/v1/live/origins` overlay** to that scope, so on an unconfigured
  deployment a default credential holds both. The ledger carries no secret value, length or prefix —
  `SPECS/SECURITY-AUTH.md` §7.4 is that contract — so what an unfiltered read discloses is metadata about other
  principals' credential use, not a credential. It stays in the default grant deliberately: unlike `task`, `admin` has
  gated destructive session control since 0.1.0, so moving it would break far more than the `task` change did, and
  **0.2.0 carries one breaking authorization change, not two**. The remedy is the same one flag —
  `deno task doctor --new-key <id> --scopes mcp:invoke,view:watch,view:control` mints a key without it, `--new-key-set`
  mints one single-scope key per scope, and `TTK_ANON_SCOPES` governs the credential-less mounts.

### Added

- **`browser_get_html` can read one named frame, and now says which document it read (D-054, D-057).** The tool takes an
  optional `frame_id` — the id `browser_get_frames` already returns — and the bytes are then **that frame's own document
  and never the top document**: an unknown, detached or unreachable frame is a structured error, not a fall back. This
  is what makes a `<frameset>` readable at all; until now "the page's HTML" was the frameset shell and the content was
  unreachable. The id is **ephemeral** by contract and nothing in this server persists it — rediscover it per run rather
  than storing it.

  The result's structured half gains four keys and keeps every one it had. `frame_id` and `url` name the document the
  bytes came from, read **live** from one `Page.getFrameTree` at the moment of the call rather than from the last
  capture, so a tab that navigated since the last observation is named correctly and a child frame answers with its
  **own** URL — which is the whole point of the provenance, because a frameset makes "the page's URL" ambiguous.
  `state_token` is the token of the element table the server already holds, or `null`; it is **not** a freshness claim
  about the HTML, because this tool mints no token and performs no observation. `returned_length` is what the text block
  carries, so a caller never has to recompute `min(length, 200000)` to know what it is holding.

  **The default call — `browser_get_html {}` with no `frame_id` — stays cheap, and that is asserted rather than
  intended:** exactly one `Page.getFrameTree` and one `Runtime.evaluate`, no `observe()`, no DOM tree built and no touch
  of the cached element table. The one added round trip is the tree read, and it is what buys the live provenance. The
  text block is unchanged, byte for byte, truncation notice included.

  **Naming the top frame's own id means the top document, on both frame-scoped tools.** A `frame_id` equal to the id the
  session's frame list holds first resolves to the focused tab's top document — the same answer as omitting it, at the
  same two CDP calls, on the grant every principal already holds, and writing no audit row. A client that reads
  `browser_get_frames` and passes ids back verbatim therefore needs no special case for the root. The id is still
  **verified**: one that the live frame tree no longer holds — carried across a tab switch, or a main frame Chromium
  replaced — is `invalid-arguments`, "no longer attached", rather than a silent answer about whichever document is
  focused now. This costs no extra round trip: the tree read that answers the URL is the same read that finds the id.

  **The `<frameset>` case is measured, not inferred (D-059).** The mechanism that addresses a same-process child frame
  goes through the frame's **owner element**, and every line of it was written against an `<iframe>` — the only shape
  the recorded corpus held — while the capability exists for frameset pages, whose children are `<frame>` elements in a
  document that has no `<body>`. That gap is now closed against a real Chromium rather than reasoned about: a
  `<frameset cols>` page, its two same-origin children, an `<iframe>` nested inside one of them, and the same shell with
  its content child on another site, each read through the shipped tool. Every read returns that frame's document and no
  other; the default call on the shell returns the shell and not the child's table; a detached frame and an unknown id
  are both refused **carrying no document at all**; and the cross-origin child is refused on the default grant and
  succeeds, audited, under `evaluate`. **One shape stays unreadable and is not a regression:** a frame whose parent is
  itself out-of-process is refused `invalid-arguments` rather than read — the same resolution rule `browser_evaluate`
  has used since 0.2.0 — and it refuses without returning the top document.

- **`browser_get_html`'s 200 000-character cap is now applied inside the page (D-057), and re-applied on the server
  (D-062).** The extraction returns the document's length alongside an at-most-200 000-character slice, so a
  multi-megabyte document is bounded in the renderer instead of crossing the CDP channel to be sliced on arrival — a
  bandwidth optimisation, and only that: what the cap _means_ is re-established on arrival, because the page can choose
  what its `outerHTML` returns (see **Security**, SEC-FH-24). The limit is the server's own constant and is the only
  value interpolated into the extraction: this tool takes no caller JavaScript, and that is enforced by the shape of the
  two fixed function bodies rather than by review.

- **Discovery: `capabilities.tykotech`, so a client can adapt without probing (B3.1).** The `initialize` result now
  carries a vendor block describing what this deployment offers **this credential**: the version, the live-view ceilings
  and features, the event ring's transports and the kinds this principal can actually receive, the `fields` presets, the
  `state_token` contract, and `tools_withheld`. Every member but `version` is scope-filtered, because "authenticated" is
  not "entitled" and an unfiltered block hands every credential the exact feature configuration of the server. `version`
  is unconditional and safe: it is the same string `/healthz` already serves with no credential at all, and a test
  asserts the two are the same expression rather than two strings that happen to agree. **Read it from the
  `ttk://capabilities` resource, not from `initialize`, if you use `@modelcontextprotocol/client`.** The block genuinely
  reaches the wire — measured on both protocol eras, and on `server/discover` too, because the server never validates
  the result on the way out — but the _client_ does validate it, against a `ServerCapabilitiesSchema` declared
  `z.core.$strip`, so `getServerCapabilities()` drops the vendor key. That is why the same object is served at three
  places built by one function: the `initialize` result, the `ttk://capabilities` resource, and `browser_health`. **Its
  absence means "assume nothing", never "the feature is off"** — a client written against it must treat a server that
  does not send it as pre-0.2.0 and probe as it did before.
- **`browser_health`, and `x-ratelimit-remaining` on the HTTP routes (B3.2).** `browser_health` answers whether this
  server is serving and what this credential may do with it: the session counts, how many have a live browser
  (`browser_ok`), how many a human is holding, viewers, tabs, the version, and the same capabilities block. It **never
  resolves a session**, so polling it cannot launch a browser — a liveness probe that created the thing it measures
  would be both a lie and a cost anyone with a credential could impose. `status` is `degraded` when sessions exist and
  at least one has no CDP client, which is the state a caller needs to tell from "nothing is running". Separately, every
  response to an authenticated rate-limited route now carries `x-ratelimit-remaining`: the whole requests still
  available, floored, read from the bucket the charge just wrote rather than from a second calculation. A refusal
  carries `0` beside `retry-after`. Public paths carry no header, because no principal exists there.
- **Two new error codes, and the published mapping for the nine that already existed (B3.2).** `dialog-open` fires when
  a mutating tool is asked to act on a page a JavaScript dialog is holding, and carries the `dialog_id` to answer and
  the dialog's kind — never its message, which is page-controlled text the `dialog` event kind already carries under its
  own caps. It replaces a 20-second hang: a held dialog blocks the CDP channel for its target, so the call used to sit
  until the hold expired and then surface as a `timeout` naming nothing the caller could act on. It is raised only while
  manual dialog handling is armed, so a deployment that never subscribes to the `dialog` kind sees no change, and
  `browser_handle_dialog` is exempt because it is the remedy. `download-failed` fires when the ledger refused a download
  at the moment the browser announced it — no downloads directory, an unsanitizable filename, the session's tracked cap
  — and replaces a **false success**: that case used to return `started: true` with a canceled record, so a caller
  polled `browser_list_files` for a transfer that was never going to happen. Its `reason` is the _same_ closed
  vocabulary the `download.failed` event already carried, from the same classifier, rather than a second enum for one
  fact — and that classifier is what keeps the watchdog's free text, which can contain a URL, off the wire. Two
  neighbouring cases deliberately keep what they had: a download that starts and then fails is a success whose
  `file.status` is `failed`, and an off-allowlist download keeps `navigation-blocked`. The other nine names
  `needed-browser-functions.md` §8 asks for already shipped, several under this repository's own spellings —
  `session-not-found` is `unknown-session`, `origin-not-allowed` is `origin-forbidden` — and renaming either would break
  every client matching on it. The mapping is published in `SPECS/CONNECTORS-MCP-A2A-A2UI.md` §1.5 and asserted by a
  test, which also checks that neither declined spelling was quietly added as a synonym.
- **Per-credential tool grants, readable by the client (B3.2).** §8 asked for `x-disabled-reason` on `tools/list`
  entries; there is no entry to annotate, because a tool the principal lacks the scope for is never registered and one
  that is registered but unavailable is omitted by the SDK. The information ships as
  `capabilities.tykotech.tools_withheld` instead: `{ name, reason }` with `reason` closed at
  `scope-required |
  feature-unavailable | human-has-control` — one vocabulary serving both this list and the error
  codes. `scope-required` **never names the scope**, because telling an unauthorised caller which grant would unlock a
  tool is an enumeration aid rather than an affordance, and a tool that is both out of scope and unavailable reports the
  scope, so a caller who cannot reach it either way learns nothing about the deployment.
- **The live view says which frame and which tab you are really in (B3.3).** The `state` message now carries `frames`:
  every frame of the focused tab as `{ frame_id, parent_id, url, name }`, top document first. **Out-of-process frames
  included** — and that took measuring. A single `Page.getFrameTree` on the page session does not see a frame in its own
  renderer _at all_, not even as a placeholder; the frame's own target answers a tree rooted at it with `parentId`
  populated, so the list is the page tree plus every `iframe` target whose root parents into a frame already known. The
  first browser-tier run passed against a same-origin child and proved nothing; tightening it to a real cross-site frame
  is what found this. Frame URLs obey the same origin-plus-path rule as every other URL on the socket, which matters
  more here than at the top level, since an OAuth callback is usually the frame. `frames` is optional and its absence
  means "not known", never "no frames" — a page that genuinely has none sends a one-element array, because the top
  document is a frame. Tabs already carried `url` and `title`; both are now proven on a two-tab fixture the page opens
  itself. The `viewport` notification, added in 0.2.0 for a page resize, is now proven to fire for a tool-driven
  `browser_set_viewport` too, with the recomputed `frame_scale` on the following frame.

- **A cancelled download no longer leaves its partial behind on Windows (E-54).** `Browser.cancelDownload` returns
  before Chromium has closed the `.crdownload` handle, so the removal that follows it failed with a permission error,
  was logged at debug, and was not retried — leaving a partial in the session's directory until the session was reaped.
  It is now retried five times over half a second, and a removal that still fails is reported rather than swallowed. The
  browser tier found it: the step that exists for exactly this claim failed twice and then passed with the leftover
  already gone, which is what a race looks like and why the fix is a bounded retry rather than a longer wait.
- **Files: `Range`, `sha256`, and a policy a client can read instead of infer (B2.9).** The download endpoint now
  honours `Range` and says so on every response, including the whole-file one, because a client deciding whether it can
  resume asks for the whole file first. One range in each of the three standard spellings answers `206` with an exact
  `Content-Range`; a range outside the file answers `416` and is **never silently clamped**, because a clamp tells a
  caller its request succeeded while handing it different bytes, which is how a resumed download produces a truncated
  file. The bytes come from the same lease the whole-file path uses, seeked rather than sliced, so memory stays one read
  chunk whatever the file's length. `browser_get_file` gains `delivery: "stream"`, which is the same authenticated URL
  as `"link"` with that support stated. Every file entry now carries **`sha256`** — computed once when the download
  completes, cached, and `null` only when it has not been computed, never for an empty file, which has a perfectly good
  digest and gets it. And **`browser_file_policy`** answers with the limits this deployment actually enforces: files per
  session, bytes per file and per session, the transfer deadline, the inline limit and whether ranges are supported.
  Every number is read from the constant that enforces it rather than restated. It reports retention as a **mode**
  rather than a number of hours, deliberately: the real policy is the session's lifetime, and an hours figure no code
  reads would have been another guess with a nicer interface.
- **`browser_fill_secret`, the audit ledger and the zoom guard (B2.8).** A model can already spend a server-held
  credential through `browser_type`'s `<secret>name</secret>` placeholder, and that is unchanged. `browser_fill_secret`
  is the same capability with the refusals the older surface lacks, and it is **deliberately stricter than the tool it
  sits beside**: `state_token` is required and a stale one is refused outright — the browser reuses node ids, so a stale
  index can resolve to a different element in a different document where a live URL check would still pass; the element
  must be an input or textarea of type password or text; and **the secret must declare domains**, because once a text
  input is permitted the "is this a password field" check carries no weight and the domain pin is the only control left.
  The pin is evaluated against the live URL of **the frame the element is in** rather than the top document's, read
  immediately before the value is typed — a page can put a same-origin frame around a password field while the top URL
  still looks right — and a cross-origin frame is refused outright. The result names the secret and carries nothing
  derived from its value: not a length, not a prefix, not a hash. **Every secret-bearing action now also refuses when
  the visual viewport is scaled**, including `browser_type` with a placeholder: under a page scale the layout and visual
  viewport scroll sources diverge and a value can land on an element other than the one named. An ordinary
  `browser_type` pays nothing for that check. **`browser_audit`** reads the new per-session ledger, which records every
  use of a server-held secret and every `browser_evaluate` call: an `admin` principal sees every entry, everyone else
  sees their own, and the result says which — sessions are shared between credentials, so an unfiltered read would hand
  each of them a map of the others' credential use. An entry carries the secret's **name**, the element, the frame and
  the origin, and for an evaluated expression its byte count and a 16-character digest. It never carries a value, a
  length or a hash of one, and never any part of an expression body. The ledger holds 200 entries, says how many it
  evicted, dies with the session and is never written to disk.
- **`browser_evaluate`, behind an explicit grant that no principal holds by accident (B2.7).** A JavaScript expression,
  run in a frame's own main world, returning its value. It requires the `evaluate` scope — the only member of
  `EXPLICIT_SCOPES` — so a credential holds it only where a key record or an OAuth claim names it, and a principal
  without it never sees the tool in `tools/list` at all. **The grant is the boundary and the documentation says so
  rather than implying a sandbox that does not exist**: evaluated code reaches the DOM, the page's non-`HttpOnly`
  cookies and the network with the browser's existing logins, and `TTK_ALLOWED_DOMAINS` does not constrain it — an
  in-page `fetch()` is not a navigation and passes none of the allowlist's three enforcement points, which was measured
  on real Chromium rather than reasoned about. `SECURITY-AUTH.md` §1 and §8 carry that exception in the same change,
  because a threat model naming a control that will not fire is worse than one that names none. There is deliberately no
  expression subset: a parser would read as a sandbox while being an incomplete one. A page exception is `ok: false`
  rather than a tool error, the 1 s deadline is enforced by the renderer and by this server, and the 64 KiB result cap
  says `truncated: true` rather than cutting in silence. Every call writes one entry to a new per-session **audit
  ledger** recording the expression's length and a 16-hex digest — never its body, not even a prefix, because an
  expression is attacker-influenced text and a prefix is exactly where an exfiltrating one would put its payload. The
  ledger lives in memory, dies with the session, and is never written to disk.
- **A session a client can read and reconfigure (B2.6).** `browser_get_session` answers with everything the server knows
  about one session — profile, timestamps, the viewport it is emulating, its tabs, who holds the takeover lock, the idle
  timeout it is actually subject to, the origin allow-list effective for _you_, and its viewer and file counts. It is
  read-only, so it answers while a human holds the session, which is when `holder` is most worth having.
  `browser_list_sessions` carries the same fields per session, built by the same function so the two cannot disagree,
  and they land in the structured half only — the text block a 0.1.0 client parses is byte for byte what it was.
  `browser_set_viewport` emulates a viewport across every tab of the session and re-applies it to tabs opened later, so
  a recording replays at the size it was recorded at; `device_scale` is device pixel ratio and this tool **never** sends
  page scale, which is the one line that keeps a mis-landed click from becoming reachable on demand.
  `browser_set_session_options` sets locale, timezone, user agent, viewport and idle timeout, and reports what took
  effect in `applied` and what this build could not apply in `unsupported` — `accept_downloads` is honestly the second
  kind, because it is read once when the session connects. Setting a locale moves `navigator.language` as well as
  `Intl`: measured on real Chromium, `Emulation.setLocaleOverride` alone leaves `navigator.language` untouched, which
  would have given callers a French session no French user has. `browser_storage_state`'s `load` now names the origins
  it restored — names only, so a workflow can assert its login is present without the response becoming a credential
  inventory. Per-session idle timeouts are honoured by the reaper, which used one global cutoff before.
- **Seven action tools: fill, absolute scroll, scroll-into-view, select, upload, drag and dialogs (B2.5).**
  `browser_fill` clears by default where `browser_type` appends, which is the whole reason it exists beside it — a
  replay into a field the browser remembered a value for must end holding only the new text — and it delegates to
  `browser_type` rather than reimplementing it, so the two cannot disagree about what a transcript keeps.
  `browser_scroll_to` lands at a named point where `browser_scroll` moves by viewport heights; neither replaces the
  other. `browser_scroll_into_view` uses the browser's own `scrollIntoViewIfNeeded`, so nested scroll containers and
  frames are Chromium's problem, and reports `bounds: null` rather than a number in the wrong coordinate space when the
  element lives in a cross-origin frame. `browser_select_option` takes exactly one of `value`, `label` or
  `index_in_list` and returns all three, so a workflow that selected by label can record the value a replay should send;
  the page's `input` and `change` handlers fire. `browser_upload_file` takes a `file_id` and nothing else — no bytes, no
  path — and re-resolves it immediately before the dispatch, so containment is checked at upload time and not only at
  capture time. `browser_drag` resolves both endpoints through the click cascade's own geometry and carries `buttons: 1`
  on every intermediate move, which is the field sliders and drop targets actually test. **`browser_handle_dialog`
  needed the server to stop answering first.** A dialog has always been answered the instant it opened, because an
  unanswered one blocks the whole CDP channel for its tab; now, while something is subscribed to the `dialog` event
  kind, the browser holds the next dialog open under an id for up to 20 seconds so a caller can dismiss a `confirm` or
  type into a `prompt` — neither of which was reachable before. The hold expires into the old policy, arming and
  disarming appear on the event stream, and `prompt_text` is never echoed back. New error code
  `element-not-interactable`, for an index that resolved onto an element that cannot take the action. Vendored: E-53.
- **Three pointer tools and two `browser_press_key` arguments (B2.4).** `browser_double_click`, `browser_right_click`
  and `browser_hover` take exactly the arguments `browser_click` takes, and the first two return exactly what it
  returns, because each is that one cascade with a single field changed rather than a second click implementation free
  to disagree about occlusion, geometry, download detection or the guard rails. A double click sends **two**
  press/release pairs counted 1 then 2 — the sequence that fires `click` and then `dblclick`, and the sequence the Live
  View socket already produces when a human double-clicks; one pair carrying `clickCount: 2` would skip the first
  `click`. `browser_hover` moves the pointer and presses nothing, reports where it landed rather than only that it
  moved, and treats an occluded target as a fact (`occluded`, `hit_tag`) rather than a failure — there is no JavaScript
  fallback, because a synthetic `mouseover` would be a lie about where the cursor is. `browser_press_key` gains
  `modifiers` (a name array resolved through the same alias table the Live View socket uses, with an unrecognised name
  refused rather than dropped) and `index` (the element takes keyboard focus through `DOM.focus`, never through a click
  that would fire its handlers as a side effect of a keystroke). A chord with an explicit `shift` now shifts the letter,
  so `{key: 'k', modifiers: ['shift']}` reaches the page as `K` — the key a human holding Shift produces, and the key
  the Live View socket already carried; the divergence was found on real Chromium by driving one gesture through both
  producers. Vendored: E-48, E-49, E-50, E-51.
- **`browser_element_at {x, y}` and the live view's `live.hover` (B2.1).** The topmost interactive element under a point
  in top-document viewport CSS px — the same space as `bounds`. The hit test is Chromium's own
  (`DOM.getNodeForLocation`), so transforms, occlusion, stacking contexts and cross-origin frames are the browser's
  answer rather than arithmetic over `bounds`; the returned `backendNodeId` is joined to the element index through the
  serializer's reverse map. Two things measured on real Chromium and built in rather than assumed: the primitive takes
  document coordinates, so the frame's live scroll is added before the ask; and the page session does not pierce an
  out-of-process frame, so the tool descends through the host `<iframe>`'s live content box into the child's own
  session. A hit on the text inside a control resolves to the control; `element: null` is a success. `live.hover` needs
  no lock, answers with a `hover {id, element, frame_id}` message carrying the `core` record, and never writes to the
  event ring.
- **Live View: `frame_scale`, `live.keyframe`, `live.quality`, `holder_name`, and ticket options (B2.3).**
  `meta.frame_scale` and every frame's `scale` are computed server-side from the frame's own viewport against the
  1280×720 screencast bound, never inferred from the JPEG (D-A6); a `viewport` message announces a change.
  `live.keyframe` answers from the server's frame cache — **and only from the cache**: A-3 measured a cached answer at
  about 1 ms against about 1000–1341 ms for `Page.captureScreenshot` on a 1920×993 page, so the capture fallback the
  design contemplated is not built, and the window right after a tab retarget answers `error{code:"not-ready"}` instead.
  `live.quality` adjusts the shared stream's scale, JPEG quality and frame-rate ceiling, answered with the **effective**
  values. `holder_name` — the credential's label — reaches every viewer on the `lock` message and in the ticket
  response. Tickets gain `ttl_seconds` (clamped to 300 s for a view ticket, 60 s for a control one, always echoed as
  granted), `mode: "view"` (a ticket that can never take control, even for a `view:control` principal), and origin
  binding, which is **required** above the 30 s default. `live.quality` and `live.highlight` need control mode but not
  the lock; a watch-only viewer is refused. The two unsolicited messages a 0.1.0 client never saw — `quality` and
  `viewport` — flow only to a socket that opted in with `events.subscribe`.
- **`live.highlight {index | bounds, ttl_ms}` on the live-view socket (B2.2).** A server-drawn outline around one
  element of the held table, or a rectangle in top-document viewport CSS px, drawn by the DevTools overlay (a sixteenth
  typed CDP domain, E-46, five commands and nothing else) — so it never enters the DOM: `state_token` does not move and
  `browser_get_state` does not see it. Measured on real Chromium: the outline reaches the screencast frame **and**
  `Page.captureScreenshot`, so `browser_screenshot` hides it before capture (E-47) and stays a photograph of the page.
  Hidden after `ttl_ms` (default 2000, clamped 100..30 000); a second highlight replaces the first; control mode is
  required (the outline is visible to every viewer) but not the lock; no reply, by contract.

- **`doctor --new-key-set <prefix>`: one single-scope key per scope.** Mints one API key for every scope in the
  vocabulary, each holding exactly that one scope, ids `<prefix>-<scope>` (the `:` becomes `-`). The raw keys print once
  to stderr; the hashed records print to stdout as one JSON array ready for `TTK_API_KEYS_FILE`, so
  `doctor --new-key-set web > keys.json` yields a file with no secret in it. A deployment composes a role from the
  least-privilege subset it wants instead of hand-editing a scope array, and the `evaluate` key is included so handing
  out arbitrary in-page JavaScript stays a deliberate choice. `doctor --new-key` is unchanged.

- **An authenticated event stream: `GET /api/v1/sessions/{id}/events`.** Server-sent events from the session's event
  ring, for a worker that would otherwise poll. It takes **`mcp:invoke`**, not `view:watch` — the stream carries page
  content, and watching a browser is permission to see pixels, not to read what the page holds. There is no ticket
  parameter and there will not be one: a ticket in a query string is a credential in a URL. A browser cannot set an
  `Authorization` header on an `EventSource`, which is why the live-view WebSocket, not this route, is what a page uses.
- **The same events over the live-view socket: `events.subscribe`.** A page cannot use the SSE route at all — a browser
  `EventSource` is GET-only and cannot set an `Authorization` header — so it subscribes on the socket it already holds,
  with the same optional `kinds` and the same opaque `<epoch>:<seq>` cursor, and receives records in the same envelope
  as `{ "type": "event", "event": … }`. It needs no lock and no control mode: reading what happened to a session is what
  watching is. `events.unsubscribe` ends it and leaves the socket open.
- **All four content event kinds now have producers and are proven end to end (`focus`, `input`, `console`,
  `dom.settled`).** `console` records (`{level, text, truncated}`) are armed on subscription — console output from
  before the first subscriber does not exist — and never carry an object handle, a URL or a source position.
  `dom.settled` reports `{token, mutations, quiet_ms}` after the page is quiet for `quiet_ms` (default 500), where the
  `token` equals the `state_token` `browser_get_state` would return at that moment; it is minted only while a subscriber
  wants the kind, because obtaining the token costs a state read. A page's DOM mutations are observed by a count-only
  observer that never reports a node, a value or any text. `focus` and `input` are unchanged. All four are SSE-only or
  content-blind on the socket: none reaches a `view:watch` connection.
- **The socket carries strictly less than the stream, and it fails closed.** `focus`, `input` and `console` are page
  content and a live-view ticket is minted on `view:watch` or `view:control`, neither of which carries `mcp:invoke` — so
  those kinds never reach a socket. The carried list is **derived by subtraction** from the content list rather than
  written out, so a new content kind is withheld from the socket until someone decides it is not content. Asking for one
  gets a `control {event:"kind-unavailable", kind}` record and the rest of the subscription proceeds, because killing a
  long-lived socket over one unavailable kind is worse than saying so.
- **Frames drop, events gap — on the socket too.** A screencast frame is dropped for a viewer that is behind, because a
  stale frame is worthless. An event is not, so the subscription instead stops _reading_: the ring turns over under a
  stationary cursor and the next successful read leads with a `gap` carrying the exact arithmetic. Nothing queues
  without bound, and nothing is lost in silence.
- **Streams end on purpose, and say so.** A stream is a cached authorization decision, so it re-checks its principal's
  authority every 300 seconds — the same horizon the gateway already applies to an API key — and ends after 1800 seconds
  regardless, with a terminal `bye` naming `stream-expired`. Reconnect with the cursor from the last `id:` and the gap
  contract covers the interval. Four streams per session, counted **separately** from the live-view viewer seats so a
  worker cannot exhaust the seats a human needs to take over.
- **The per-principal connection limit the API contract has published since 0.1.0 is now enforced.** Eight long-lived
  connections per principal, counted across live-view sockets and event streams together. It was documented and
  implemented nowhere; two independent ceilings would have disagreed about what one principal may hold, so there is one.
  The live-view viewer cap now also reserves its seat in the same step as the check — previously the count was read at
  admission and incremented a task later, so concurrent connections could all pass a cap of four.
- **A per-session event ring, and `browser_wait_for` to read it.** Every session now keeps a sequenced record of what
  happened to it — navigations, tab lifecycle, dialogs, downloads, network quiescence, and takeover control changes — so
  a client can learn that the page moved without polling a full state read. `browser_wait_for` blocks until one
  condition holds and answers `{ met, after_ms, event, state_token }`; **a timeout is `met: false`, not an error**,
  because a wait that expires is a truthful answer about the page and `isError` would abort the model's turn over a
  fact. It works on every mount including stdio, which has no HTTP server and therefore neither event transport. See
  `SPECS/DATA-MODEL.md` §4.1.
- **The ring tells you when it lost something, and never lets you infer it from silence.** A cursor that has fallen off
  the tail gets a `gap` record **first**, carrying the exact arithmetic of what was dropped. A cursor from a previous
  incarnation of the ring gets `reason: 'epoch-changed'` with `dropped: null` — null rather than zero, because the old
  ring is gone and the count is genuinely unknowable. `seq` is allocated over the unfiltered stream, so if you filter by
  `kinds` you will see non-contiguous numbers: those are records you filtered, not records you lost, and a `kinds`
  filter never removes a `gap`.
- **Event payloads carry no URL and no typed content, by construction.** `navigation` reports `origin`, `path` and a
  boolean `has_query` — never a URL string, because a navigation URL is where a one-time code or session token lives.
  `download.*` carries no URL either, and its failure `reason` is a closed enum rather than the underlying error text,
  which can itself contain one. No event carries a typed value, its length or a prefix of it, for any element and not
  only a password field: a length is a password-strength oracle. The rules are enforced when a record is minted rather
  than at each transport, so a transport cannot reintroduce what the ring refused to record.
- **The ring is bounded against a page that chooses the numbers.** `console.text` and `dialog.message` are written by
  the page, so the ring is bounded by bytes as well as entries: 512 records, 1 KiB per record, 256 KiB per session (2
  MiB across the 8-session cap). An over-long record is truncated at its variable-length field and flagged, never
  dropped. The kinds a page can spin are separately rate-capped at 50 records per second per session, and the exact
  number dropped is reported on the stream.

- **A credential can narrow the browser origins it may be used from: `GET`/`PUT /api/v1/live/origins` (`admin`).** It
  can only ever **narrow**. The process-wide `TTK_ALLOWED_ORIGINS` list is the ceiling, the per-token list narrows it,
  and the effective list is the intersection; a credential that declares nothing is unchanged. That is forced rather
  than chosen: the MCP adapter's own origin check runs before this server knows which credential is presenting, so a
  per-token list can only be a second check placed after the first — and a second check can only reject further. A
  widening overlay would let an `admin` credential write its way around an operator control.
- **The two origin lists match differently, and every response says which rule applies to which list.**
  `TTK_ALLOWED_ORIGINS` keeps bare-hostname semantics, because changing what a `TTK_*` value means is a major-version
  event. A per-token entry matches the **full origin including the port**, because a page and this server are commonly
  two ports of one host and a hostname rule cannot tell them apart. A bare hostname written into the per-token list is
  refused at write time with the two spellings that would work, rather than stored as an entry that matches nothing.
- **A degraded overlay is visible rather than silent.** `overlay_status` is `ok`, `absent` or `unreadable`, on both
  origin routes and on the live-view ticket response, and a corrupt file degrades to **no narrowing** — never to a wider
  policy. The ticket response also echoes the **effective** list rather than the requested one, for the same reason it
  echoes the granted TTL.
- Two new problem slugs, each justified against the eleven that existed: `invalid-request` (400) for a malformed or
  policy-rejected REST body — there was no generic 400 before, and this is the first route that validates a
  caller-supplied body against a policy — and `persistence-required` (409) for a write on a deployment with no
  `TTK_DATA_DIR`. Refusing an origin needs no new slug: it is the existing `origin-forbidden`, which now has a live
  emitter for the first time.

- **Two more event kinds have producers: `focus` and `input`.** `focus` carries a five-field descriptor —
  `{element_index, tag, role, label, frame_id}` — resolved from the accessibility tree during a state read. That is a
  real limit and it is stated rather than implied: a `focus` record says a read _observed_ the focus somewhere new, so
  its absence is not evidence that focus did not move, only that no read looked. `input` reports that typing happened
  and carries `{element_index, kind, source, value_masked}` — **no character data, no length, no prefix, for any element
  and not only a password field.** A length is a password-strength oracle. Both kinds are SSE-only: a live-view ticket
  carries no `mcp:invoke`, and asking for one on the socket gets a `kind-unavailable` record.
- **`input`'s producer is the page, so every field of its record is derived server-side.** The page reports only a
  bounded, closed-enum event type; `source` comes from the takeover lock, `value_masked` from the single password
  predicate (and fails closed), and `element_index` from the server's own focus for the frame the CDP session names —
  `null` when no current index table is held. Otherwise a page could fabricate "a human typed here", mark its own
  password field ordinary, or point a consumer at an element of its choosing. The listener runs in a named isolated
  world under a per-session random binding name, reads nothing from the page, and is removed with the session.
- **`input.kind` keeps the design's closed enum `input | change | submit | other`, with the mapping onto the
  requirement's vocabulary now written down (owner decision, D-038 amended):** `type` is `input` (fires per keystroke),
  `change` is `change`, `submit` is `submit`, and a click on a field is a `focus` event rather than an `input` —
  clicking types nothing. See `SPECS/API-CONTRACT.md` §7.1.
- **An `input` record is not an audit trail, and its absence is not one either.** A page can synthesise an event — those
  are dropped — and can also suppress a real one, which nothing inside the page can prevent. Said plainly beside the
  record rather than left to be assumed.
- **`browser_download`** starts a download by clicking an element or navigating to a URL and returns the `file_id` it
  will be readable under, so a caller no longer has to diff `browser_list_files` to find its own file. `started: false`
  is a **success**, not an error: a click that navigated instead is a truthful answer about the page.
- **`browser_head`** asks a server about a URL — status, content type, length, filename, final URL — with a
  **cookie-less `HEAD` request issued by the server process**, never by the browser (owner decision SR-HEAD-REDIRECT,
  D-042). The browser primitive this replaced followed redirects silently, reported no hop and no final URL, and
  transferred the whole body for a metadata query (33 554 432 of 33 554 432 bytes, U-4); the server's request transfers
  none — a raw loopback upstream counting the bytes it wrote measured 418 bytes for a 4 MiB resource across a four-hop
  chain. Redirects are followed one hop at a time, and **every hop** is checked against the domain allowlist, refused if
  it points at a loopback, private, link-local or cloud-metadata address (only an exact allowlist entry lifts that), and
  refused if the process holds no `--allow-net` grant for that exact host and port. No cookie, no `Authorization`, no
  forwarded header leaves the process; `final_url` is origin plus path. **The tool is offered only where the operator
  has elected outbound network for the server** by widening `--allow-net` in the container `CMD` — proven through Deno's
  permissions API at startup, never assumed from an environment variable — and the shipped permission matrices are
  unchanged, so a stock deployment does not list it and a call answers `feature-unavailable` with the new
  `feature: "egress"`. It takes no `session_id`: no browser is involved, so a human holding the session cannot be spent
  by it. Design §8.2's rejection of a server-side fetch is amended in D-042.
- **`events.subscribe` needs no lock and no control mode**, because reading what happened to a session is what watching
  is; `input-rejected` and `ping` join the live-view wire (below).
- **Every tool failure now carries a machine-readable code (D-033).** The first text block keeps the exact
  `Error: <code>: <detail>` form it has always had, and `structuredContent.error` carries `{ code, message }` alongside
  it. Two new codes: `scope-required`, when the tool exists but this credential lacks its scope — it names no scope,
  deliberately — and `feature-unavailable`, carrying `feature: 'persistence' | 'recording'`, when the deployment cannot
  offer the tool. Both previously read as `Tool <name> not found`, which is indistinguishable from a tool this server
  has never had. Invalid arguments are now a coded tool error too, rather than the SDK's fixed `Input validation error:`
  prefix with no structured half. See `SPECS/CONNECTORS-MCP-A2A-A2UI.md` §1.5.
- **Every tool declares an `outputSchema`**, object-rooted, and every success carries `structuredContent` matching it.
  `browser_get_html` and `browser_screenshot` carry metadata only: the document and the base64 stay in the blocks that
  already held them.
- **`TTK_ANON_SCOPES`** — the scopes granted to a principal with no credential to carry a grant, on the stdio and
  loopback-development mounts. A comma-separated subset of the vocabulary, defaulting to the default grant; an unknown
  name refuses startup naming the variable and the offending value.
- **`state_token` — the identity of the index table a result was computed against (E-36).** Two 16-hex-character halves
  joined by `.`, an index-identity half and a content half, so a client can tell "the page changed but my indices still
  mean the same thing" from "my indices are gone" without a second opaque value. Minted by the DOM serializer as a
  by-product of the render walk. Root scroll is excluded, so scrolling does not invalidate it; a password field
  contributes the literal `masked` rather than a digest, so a token diff cannot observe a password edit and the token is
  not an oracle against a guessed password. It reaches `browser_get_state` through `structuredContent` **only** — the
  text block keeps its 0.1.0 layout byte for byte — and both halves of `browser_click`, `browser_type`,
  `browser_press_key` and `browser_scroll`.
- **An optional `state_token` argument on every tool that takes an `index`.** Omit it and behaviour is exactly what it
  was. Supply it and a mismatch is refused with the new `element-not-found` code, carrying
  `{ index, state_token, reason }` where `reason` is a closed enum: `no-state` (no table held at all) or `stale-token`
  (a different table is held, and its token comes back). `unknown-index` is unchanged and means the other thing — the
  table you addressed is the one held, and it has no such index.

- **Four perception tools (B1.6).** `browser_find` ranks the interactive elements against a query — `role`, `name`,
  `text`, `css` (the browser's matcher), `href_pattern` (a regular expression under a 200-character cap, a 2000-href cap
  and a 2 s budget) and `near {x, y}` in top-document viewport CSS px — every predicate conjunctive, `score` a ranking
  aid. `browser_get_frames` lists the frames with `bounds_composed` and `capture_truncated`.
  `browser_locator_candidates` ranks the seven locator kinds for one held index, counted in memory as of the capture;
  `browser_verify_locator` asks the browser what a locator matches today through `DOM.performSearch`, every search
  discarded before it returns, with `aria` and `label` counted over the merged accessibility nodes. The catalog is 25
  tools.
- **The element record (B1.5).** `browser_get_state` takes `fields` (presets `minimal`, `core` — the default — and
  `full`, freely mixed with field names), `element_limit`, `include_hidden` and `frames`, and its `structuredContent`
  carries per element `bounds` (top-document viewport CSS px), `document_bounds`, `visible`, `enabled`, `focused`,
  `frame_id`, `frame`, `input` (the live value, E-39), `attrs`, `text`, `locator` and `locators` (DD-4, seven ranked
  kinds with a per-document uniqueness count), plus the root fields `focused_index`, `elements_total`,
  `elements_truncated`, `frames[]` with `bounds_composed`, `frames_unknown` and `capture_truncated` (E-40). The text
  block is byte for byte the 0.1.0 payload. The default set is measured, not designed: 250.4 B/element on the heaviest
  recorded page, with `locator` opt-in (D-035). A password field reports `input.value` as `•••` and nothing else (DD-7).
  `include_hidden` admits rendered-but-off-screen elements only (E-41).
- **An `evaluate` scope, held by nobody.** The first member of the new explicit-grant set: no principal receives it by
  default on any path. No tool takes it yet.

- **Browser downloads and file retrieval (E-33).** Two read-only tools, `browser_list_files` and `browser_get_file`
  (`delivery: 'inline'` up to 1 MiB as an embedded blob resource, or `'link'` with a resource link and an authenticated
  HTTP URL), a `ttk://session/{id}/files/{fileId}` resource template, and
  `GET /api/v1/sessions/{sessionId}/files/{fileId}` (scope `mcp:invoke`, streamed as an attachment, one hop in a
  cluster). `browser_click` appends the download it detected. Downloads keep the logged-in browser's cookies; files live
  as long as the session.

### Fixed — the Live View can be left watching (B6, D-052)

The container acceptance verification drove the shipped image in a real browser and then **left it idle**, which no
earlier pass had done. Six defects fell out; five are fixed here, plus three more found by the audit that followed. All
of them are in the bundled SPA and the socket that feeds it — none is in the MCP surface, the tool wire, or the
container's security posture.

- **A viewer that only watched was disconnected every 45 seconds (F1).** The server's keep-alive is an application-level
  JSON `ping`, not a WebSocket control frame, so the browser never answered it, and the SPA discarded it deliberately.
  The liveness timer was refreshed only by an inbound message, so a client that was _watching_ rather than _driving_ had
  no way to stay alive and was closed as unresponsive on a fixed timer. **`{type:'pong'}` is now a member of the client
  message union** and the SPA answers every ping with it. The reap deadline is now evidence-based: **300 s** until a
  socket proves it can answer, **45 s** after that. A client that never pongs — ADM's own page, any non-browser socket
  consumer, a 0.1.0 client — gets the long window; one that has ponged and then goes quiet is genuinely gone and its
  connection slot is freed promptly.
- **The disconnect overlay stacked, and Reconnect stopped being clickable (F2).** Each drop appended another full-stage
  overlay; the topmost one intercepted every click meant for the button underneath, so the only way back was a full
  document reload. There is now **one overlay**, replaced in place.
- **A dropped view now keeps trying for ten minutes, not for eight attempts (F2, F3).** With exponential backoff the old
  budget gave up after about a minute — shorter than a laptop coming off standby or a server restart. The window resets
  on every good connection. When it does run out, the view says **`Session and recovery window expired`** and offers
  **Start a new session**, because by then the ticket is dead and the session behind it may have been reaped. A `429` on
  the ticket mint now imposes a cool-off (honouring `Retry-After`) instead of retrying into a cap the principal has
  already hit.
- **The page's own CSP blocked the page's own layout (F4).** `style-src 'self'` blocks style _attributes_, so the viewer
  shell's `display:flex` never applied, costing a flex column and leaving ~105 px of dead space under the canvas plus a
  console error on every load. The declaration moved to a class in `app.css`.
- **`frame-ancestors 'none'` is now actually in force (F5).** It was declared only in a `<meta>` CSP, which **browsers
  ignore** for that directive, so the page holding a live credential in memory was framable. `GET /` now sends it as a
  response header alongside `X-Frame-Options: DENY`.
- **`/favicon.ico` no longer answers `401` with an OAuth challenge (F6).** The catch-all bearer gate runs ahead of
  routing, so the request every browser makes on its own put an auth error in the console of every page load. It is now
  a public path answering `204` with no body. The broader deviation — unknown paths answer `401`, where
  `SPECS/API-CONTRACT.md` said `404` — is **recorded rather than changed**, and the document now describes what the
  server does and why; see D-052.
- **Three defects found by the audit that followed.** A `createImageBitmap` still in flight when the viewer was
  navigated away painted into a detached canvas and leaked its decoded bitmap; nothing ordered concurrent decodes, so an
  older frame could paint over a newer one; and the tab list overwrote the address field while the user was typing in
  it, where the state handler already guarded against exactly that.

`packages/web` was scoped out of this delivery by D-A7, so F1, F2, F4 and F5 are **pre-existing 0.1.0 defects rather
than regressions** — they survived because no earlier pass stood the SPA up and watched it idle. F3 is the one
interaction the delivery caused, and neither reading of it is quite true: the per-principal connection cap had been
published since 0.1.0 and enforced by no code until B2, so enforcing a documented promise turned a latent client defect
into a visible one.

### Fixed

- **`browser_get_html` reports the document's TRUE length when it truncates; until this release it reported the cap
  (F-3).** On a document longer than 200 000 characters the result carried `length: 200000`, so a caller could not tell
  a page that exactly fitted from one of 40 MB, and the number it was handed was not the document's. `length` is now the
  document's real character count in both cases, `truncated` still says whether the cap bound it, and the new
  `returned_length` carries what the text block holds. **This is a behaviour change on a field that existed**, which is
  why it is here rather than filed as an internal fix: a client that read `length` as "how much did I receive" must read
  `returned_length` instead. The text block itself is unchanged, notice included.

- **`browser_evaluate {frame_id}` now reaches a same-process child frame's own document; until this release the
  expression ran in the top document (E-75).** A frame that shares the top document's renderer was resolved to the
  **host page's** CDP session, and the evaluation was then issued as a `Runtime.evaluate` with no receiver — which runs
  in that session's _default_ execution context, the top document. The `frame_id` was accepted, echoed back on the
  result and written into the audit ledger, and ignored. The focused document and every out-of-process frame were never
  affected — each already _is_ its own session's default document — and both of those paths are byte for byte what 0.2.0
  sent, the renderer-side `timeout` included. **Naming the top frame's own id is one of those unaffected paths**, and
  stays one: it has worked since `browser_evaluate` gained `frame_id` in B2.7, and it still issues the identical
  `Runtime.evaluate` against the page session — asserted by running the 0.2.0 release and this one against one scripted
  wire and comparing every parameter, the payload, the text block and the audit row.

  **Security note, stated in full under `### Security` above** — an operator reading that section to find this release's
  security-relevant changes must reach it there rather than here. The _disclosure_ impact is bounded, though **not** by
  top-document access — the same-origin policy means reaching the top document does not reach a cross-origin child — but
  by capability class: the `evaluate` scope has reached a cross-origin frame's own main world since B2.7 wherever that
  frame was out-of-process, so this repair removes a limitation that depended on Chromium's process allocation rather
  than on any boundary this server draws. The **audit integrity** impact is not bounded, and is why this is called out
  rather than filed as a correctness fix — every `evaluate` row recorded a `frame_id` and an `origin` for a document the
  code never entered, so a deployment reviewing that ledger was told where privileged code ran and was told wrong. Rows
  written before this release cannot be corrected after the fact and should be read as naming the tab's **top** document
  wherever their `frame_id` is a same-process child frame. **`browser_fill_secret` is not affected and never was**: it
  resolves a frame only to read that frame's own live URL for the SEC-07 domain pin, and types on the element node the
  index table resolved, so no credential ever went to a document other than the one its element lives in.

  **Two behaviour changes, on the repaired path and only on it — the first of them carries a row under `### Breaking`
  above.** The expression now runs against a handle on the child frame's own `window` through `Runtime.callFunctionOn`,
  so (1) it is compiled as an **expression** — which this tool's contract has always said it is — and a multi-statement
  _program_ that the old receiver-less call happened to accept against the top document is now a syntax error; and (2)
  `Runtime.callFunctionOn` carries no renderer-side `timeout`, so on that one path the 1 s cap is this server's own
  deadline alone: a runaway expression is abandoned by the server and keeps running in that frame until it finishes or
  the frame navigates. Both are stated in the tool's description. Neither can regress a correct client, because what
  they replace was an evaluation in a document the caller did not ask for. See `SPECS/DECISION-REGISTER.md` E-75 and
  D-054.

- **The event ring's rate window slides, and a `gap` now says which kind took the ring (SR1-A1b).** Two defects, one
  finding. The window was fixed and re-anchored to `now` at each roll, so a page defeated it by straddling a boundary:
  250 `dialog` records at 900 ms and 250 more at 1000 ms is 500 admitted in 100 ms against a budget that reads as 250 a
  second. Each kind is now charged `previous × (1 − elapsed/window) + current`, so **any** 1000 ms interval is bounded
  rather than only the aligned ones. Separately — and this is the part that matters to a consumer — a `ring-overrun` gap
  carries **`by_kind`**, an exact per-kind breakdown of the evicted span whose counts sum to `dropped`. A rate cap never
  closes event blinding on its own; what it can do is make the loss **attributable**, so a consumer can tell "the page
  flooded `dialog`" from "you were away too long" and act differently on each. `by_kind` is `null` — never approximate —
  when the span reaches beyond the eviction ledger or the epoch changed, the same honesty `dropped: null` already
  carried. The ring was deliberately **not** enlarged: a bigger buffer moves the threshold without changing the
  property. `control`, `gap` and `bye` stay uncapped, now asserted by name, so a flood can never suppress the report of
  itself. See `SPECS/DECISION-REGISTER.md` D-048.

- **A revoked API key now takes effect without a restart, so the event stream's authorization re-check can actually deny
  (SR2-M3).** `SPECS/SECURITY-AUTH.md` §2.1 has promised since 0.1.0 that revocation "takes effect next request (no
  cached decisions)", and an open SSE stream — which has no next request — re-checks its principal every 300 s for that
  reason. For an API key that check could only ever answer "still present": the key store was built once at startup and
  nothing in the tree could change it, so revoking a key meant editing the source and restarting, and a restart
  terminates every stream anyway. When `TTK_API_KEYS_FILE` is the source in force the server now watches that file and
  replaces its record set when it changes, so a removed key stops authenticating and its live streams end within one
  re-check interval. Editing the file **in place** is what the watch sees. Three things it deliberately will not do: it
  never applies a **malformed** file (the previous good records stand and a warning names the fault), it never applies
  an **empty** one (a server with no credentials on a loopback bind serves anonymous principals, so emptying the file
  would grant access in the name of revoking it — removing the last credential is still a restart), and it needs **no
  new permission** in any shipped matrix: the watch runs inside the `--allow-read` grant the configuration already used,
  holds no write grant, and the container already reads `/run/secrets`. Keys supplied inline through `TTK_API_KEYS` have
  no file to watch and are unchanged. See `SPECS/DECISION-REGISTER.md` D-047.

- **G-7: the live view no longer drops a human's input in silence.** Three branches of the input dispatcher returned
  with no error, no answer and no log when the session had no CDP client, no session manager or no focused tab — a
  viewer that had taken control typed into a void with no way to learn it. Each now answers `input-rejected` with a
  closed `reason` (`session-not-connected`, `no-focused-tab`), and a pointer far outside the last-known viewport gets
  `out-of-range` instead of landing nowhere. A malformed message keeps its existing `bad-message` code and gains
  `reason: "schema"`, so nothing an existing client handles changes meaning.
- **G-6: `ping` is part of the message union.** The server has always sent a `{"type":"ping"}` keep-alive every 15
  seconds and it was simply absent from the schema, so a strict client that validated every message rejected the stream.
  The bundled SPA works around it with a hard-coded exception before its own parse, which is why nothing there changes.
- **The live-view `meta.version` was a hard-coded `0.1.0`** and therefore never the build's version. `PKG_VERSION`
  reaches a client twice — the MCP server identity and this field — and one of the two had never moved.

- **`browser_scroll` reported the geometry from before the scroll.** It read `pageInfo` from the cached state, which no
  action refreshes; it now makes a DOM-less live read after the action, which by E-36 never touches the index table.
- **Five security-review findings on the same change, two Major (E-38).** The widened predicate was evadable with one
  attribute — it gated its new arms behind an allowlist of input types, and HTML renders an unrecognised `type` keyword
  as a text box, so `<input type="passcode" name="password">` was waved past every arm; it is a denylist now.
  `browser_type`'s new structured `typed_length` disclosed the exact character length of a server-held secret, which the
  frozen text block had always withheld on that branch on purpose; it is omitted when the type was sensitive. The
  `state_token` preimages length-prefix every page-controlled field, so a `|` or a newline in a URL or an accessible
  name cannot shift a field boundary. The name and label arms were widened (`pass`, `pw`, `pin`, `secret`, API/access
  tokens; and the label arm is no longer English-only) and the reveal-widget arm now reads the input's two nearest
  ancestors, which is where the common Bootstrap/Tailwind toggle puts its marks. `serialize_attrs`'s two-argument
  `isPasswordField` is renamed `isPasswordInputTag`, so there is one _name_ for the one predicate and not two.

- **The password predicate missed a revealed password and a page's own naming (E-37, SEC-04).** The single
  `isPasswordField` had two arms — `type="password"` and the `autocomplete` hint — so a field a "show password" toggle
  had switched to `type="text"` stopped being detected at exactly the moment its value was on screen, and a field the
  page merely _named_ or _labelled_ as a password was never detected at all. Now five arms: those two (plus
  `autocomplete=one-time-code`), the `name`/`id` token, the visible label and accessible name, and the marks a reveal
  widget leaves on `class`/`data-test*`. Input types that cannot hold a credential are excluded first, so
  `<input type=checkbox name=save_password>` stays a control. Replayed over all 36 recorded captures the widened
  predicate classifies the same two fields as the narrow one, so no golden moves.

- **An element index could resolve against a page the browser had already left (E-36).** The one index table in the
  product had four writers. `getBrowserStateSummary` wrote every summary into it, including the DOM-less read
  `identify()` issues after every navigation and before every secret substitution — whose `selectorMap` is empty by
  construction — so a `browser_type` carrying a `<secret>` placeholder _and_ a valid index failed with `unknown-index`,
  and a navigation silently emptied the table. The failure branch was worse: it left the previous summary standing, so a
  state read that failed after a navigation handed back elements from the old page and the action landed somewhere
  nobody asked for. The write is now conditional on the request having built a DOM, and a failed read clears the table
  rather than keeping a stale one.

- **`browser_get_state` could return a password as an element label (E-34).** `packages/mcp/src/observe.ts` read the
  `value` attribute as a label candidate and carried no password predicate at all, so an
  `<input type="password" value="...">` with no accessible name — the ordinary shape of a form re-rendered after failed
  validation — had its value emitted as that element's label, on the tool result, on the `resources/read` observation,
  and on both sampling prompts, which send it to the caller's model. It is now gated on the browser layer's single
  `isPasswordField`, and a containment test pins the complete set of modules that may read an element value at all.
- **The session resources were not scope-gated (E-35).** `ttk://session/{id}/{state,screenshot,page}` and the file
  template were registered outside the catalog's scope loop, so the whole observation was readable through
  `resources/read` by any authenticated principal holding no scopes at all. They now require `mcp:invoke`, like the
  tools and like the HTTP file route.
- **A held session no longer turns a recoverable refusal into a protocol error (G-2).** The mutating tools used to be
  withdrawn from `tools/list` when _every_ session was human-held, and the SDK answers a disabled tool with a JSON-RPC
  error, which aborts the calling model's turn. Both the partial-lock and all-locked cases now answer
  `Error: human-has-control:` as a result the model can act on. A client that inferred "a human is present" from a
  shrinking tool list loses that signal; `browser_get_state` reports `human_has_control` per session, which was always
  the honest form of the question. Revises D-027.
- **A key record that named no scopes was granted every scope**, as were the anonymous loopback principal, every stdio
  client, and every key minted by `ttk doctor --new-key` without `--scopes`. All four now receive the default grant,
  which is a strict subset of the vocabulary. The loopback-development warning prints the effective scope list instead
  of claiming "all scopes". (`task` was still in the default grant when this fix landed; the Breaking entry above
  records its later move to `EXPLICIT_SCOPES` in the same release.)
- Downloads were never captured by the normal launch path (no `downloadsPath` was configured), clicked attachments were
  downloaded twice by the response sniffer, and two files with the same suggested name overwrote each other while the
  ledger recorded a file that did not exist. Files are now stored by Chromium's download guid (`allowAndName`), records
  are installed synchronously, a record is publishable only after a regular-file containment check, and transfer limits
  (100 files, 100 MiB per file, 500 MiB per session, 5-minute deadline) cancel through `Browser.cancelDownload`.
  Measured against real Chrome; see `SPECS/DECISION-REGISTER.md` E-33.
- **`tools/list` told every client that the default `fields` preset includes `locator`; it has not since D-035.** The
  `fields` argument description advertised
  `core (default: minimal plus bounds, visible, enabled, focused, frame_id,
  locator)`, while `FIELD_PRESETS.core` is
  the five without `locator` — moved out when the real candidate measured 118 B/element and the default overshot the 310
  B/element budget at 368.4. The documentation and `capabilities.tykotech.fields` were already correct; only the wire
  text was stale, and nothing asserted any tool description in either direction. A client that read it, took the default
  and found no `locator` had been told the field should be there, and would fall back to the coordinate this release
  exists to replace. The description now states what `core` and `full` emit and says plainly that `locator` is opt-in
  (`fields: ["core","locator"]`), and a test derives both preset claims from `FIELD_PRESETS` itself, off the emitted
  JSON Schema, so the two cannot drift again.
- **`README.md` and `docs/index.md` said "28 browser tools"; the catalog holds 47.** The number was set when the first
  slice of this release landed and never moved while three later slices added nineteen more tools. Both now read 47, and
  every shipped file that states the current catalog size is compared against `CATALOG.length` by a test, so the front
  door cannot go stale again. Historical counts in the journal, the decision register and this file's own 0.1.0 section
  are deliberately not pinned: they were correct when written.

### Changed

- **`browser_head` is withheld, and refuses if called anyway, where the browser has its own proxy (SR3-M2).** This
  server's HEAD is a server-side `fetch` and follows the process `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; the browser
  follows Chromium's proxy flags. A deployment configuring both got two different network paths from one tool surface,
  and the tool's answer might not describe what the browser would fetch. From 0.2.0, any proxy flag in
  `TTK_BROWSER_ARGS` (`--proxy-server`, `--proxy-pac-url`, `--proxy-auto-detect`, `--no-proxy-server`,
  `--proxy-bypass-list`) withholds the tool from `tools/list` and makes a direct call answer
  `feature-unavailable {feature: 'egress'}` naming the flag and the remedy — the handler holds the control too, because
  one that lives only in the tool list is one an out-of-band call walks past. **This is a deliberate behaviour change in
  a minor release**: a deployment with a browser proxy that saw `browser_head` listed will not any more. It refuses
  rather than compares because a Chromium proxy list and the `HTTP_PROXY` family are different configuration languages,
  and it cannot simply read the process side — Deno proxies this `fetch` whether or not `--allow-env` names those
  variables, measured, while `Deno.env.get` throws `NotCapable` under the shipped grant. Configure the proxy in one
  place: give the process the proxy environment and remove the Chromium flag, or bound both paths with a network-level
  egress control. See `SPECS/DECISION-REGISTER.md` D-049.

- **Every key a human sends through the live view now arrives with a real `keyCode`.** It arrived as `0` before, on
  every keystroke: the Live-View path forwarded `{key, code}` and set no `windowsVirtualKeyCode`, so a page switching on
  `event.keyCode` — most pages with a keyboard shortcut, and every `Enter`-to-submit handler predating `event.key` — saw
  nothing it recognised. The server now resolves each key through the same tables the agent's own typing path has always
  used, so what a human does through the socket is reproducible by the tools with the same events. `Enter` carries its
  carriage return (which is what makes `keypress` fire), a chord suppresses insertion, and `input.key` gains optional
  `windowsVirtualKeyCode`, `location` and `autoRepeat` for a client that wants to override any of it. A key name this
  server cannot describe is now **answered** rather than dispatched with `keyCode: 0`.
- `modifiers` accepts an array (`["ctrl","shift"]`) as well as the bitmask, additively; an empty array is legal and
  means no modifiers.
- **The server now refuses to start on a `TTK_ALLOWED_ORIGINS` entry that could never match.** The comparison is against
  `new URL(origin).hostname`, so an entry carrying a scheme or a port — `https://app.example:3000`, which is what you
  get by copying an address bar — matched nothing at all, silently, and every browser call was refused with a 403 that
  could not be traced back to this list. The refusal names the entries and prints the corrected list, and
  `deno task doctor` reports the same fault before a restart does. The deployments this breaks are exactly the ones
  whose origin policy already did nothing.
- **The server also refuses to start when `TTK_DATA_DIR` contains the Chromium or ffmpeg executable it is granted
  `--allow-run` for.** A writable data root holding an executable this process may run turns a write primitive into an
  execute primitive, which is a different class of exposure from anything the data itself carries.
- **Breaking for one field's content, not its shape: the live view no longer receives a page's query string or
  fragment.** The `state` message and every entry in a `tabs` list now carry **origin plus path** instead of the full
  navigation URL. The message types and their `url: string` fields are unchanged, so a client still parses the socket
  exactly as before; what narrowed is what the field contains. A live-view ticket is minted on `view:watch` or
  `view:control`, neither of which carries `mcp:invoke`, and a navigation URL is precisely where a magic-link token, a
  one-time code or an OAuth implicit fragment lives — so a watcher with no authority to read page content was being
  handed one, on the same connection whose new `navigation` event records were already redacted for that reason. The
  same reduction applies to a `title` that **is** the URL, which is what Chromium supplies for a page with no `<title>`
  — a rule covering two of three URL-bearing fields is not a rule, and the pinning test caught the third. This is a
  **deliberate behaviour change shipped in a minor release**; every other wire change in this release is additive, and
  this is the one exception. Two consequences, stated rather than discovered: `state.url` can no longer be followed back
  to a page distinguished only by its query, and the live view's address field — which now shows what the socket sends —
  re-navigates without the query if a human presses Enter in it without editing. See `SPECS/SECURITY-AUTH.md` §8.3,
  `SPECS/API-CONTRACT.md` §5.2 and decision D-037.
- Tool error codes gained `unknown-file` and `file-unavailable`; the catalog is 21 tools. The browser tier proves a
  cancelled transfer end to end — an export advertising more than the per-file limit is cancelled through
  `Browser.cancelDownload` and leaves no partial behind — and the 2025-era stateful mount is covered for the new tools.
  The container verification now drives a real attachment download inside the image — captured under `/data`, read back
  inline over MCP and byte-identical over the authenticated file route, with an anonymous read refused.
- `deno.json` excludes `skillset-saves`, `.harness-state` and `.codex` from formatting, linting and checking: they hold
  delivery-run records, not project source, and the Markdown formatter rewrapped their JSON. `.gitignore` keeps those
  three and `MCP-FILE-TOOL-PLAN.md` out of the product tree.
- Reformatted 27 documentation files (`README.md`, `AGENTS.md`, `SECURITY.md`, the issue templates, the `docs/` tree,
  the three SVG diagrams and the CycloneDX SBOM) that had drifted from `deno fmt` under Deno 2.9.6. Whitespace only: the
  SVG text nodes and the SBOM's 36 components are unchanged.

## [0.1.0] - 2026-08-30

Initial release. Design specification v1.0, implemented: milestones M0–M16 complete — v1 plus roadmap items R1–R15 (R9
deferred). Wire surface (tool names/params, WebSocket message types, problem slugs, `TTK_*` variable names) is
considered frozen from this release.

### Added

- **MCP server over Streamable HTTP and stdio**, built on the MCP TypeScript SDK v2 (`createMcpHandler` behind Hono,
  served by `Deno.serve`), stateless per request (2026-07-28 revision) with an optional 2025-era stateful mount
  (`TTK_MCP_STATEFUL`).
- **19 browser tools:** navigation (`browser_navigate`, `browser_go_back`), interaction (`browser_click`,
  `browser_type`, `browser_press_key`, `browser_scroll`), perception (`browser_get_state`, `browser_get_html`,
  `browser_screenshot`), tabs (`browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`), sessions
  (`browser_list_sessions`, `browser_close_session`, `browser_close_all`), persistence (`browser_storage_state`),
  recording (`browser_record`), and two model-backed tools (`browser_extract_content`, `browser_run_task`) that borrow
  the client's model through MCP sampling — no LLM or provider key runs in the server.
- **Live browser view:** a JPEG screencast over WebSocket with mouse, keyboard, wheel and IME input, an exclusive
  takeover lock, single-use tickets, and automatic reconnection with backoff.
- **Session recording:** a real WebM encoded via an ffmpeg sidecar from the same screencast the live view uses (R7).
- **Persistent sessions:** named profiles keep cookies and logins across restarts; named storage-state documents move by
  name, server-side, never through the model (R3).
- **MCP resources:** per-session `state`, `screenshot` and `page` resources, live and subscribable (R4/R5).
- **Authentication:** hashed API keys (constant-time comparison) and OAuth 2.1 resource-server mode against an external
  IdP (`jose` JWT/JWKS verification).
- **Authorization scopes:** `mcp:invoke`, `view:watch`, `view:control`, `task`, `admin`.
- **Browser-typed secrets (R14):** a model can use a configured, domain-scoped credential by name
  (`<secret>name</secret>`) without ever seeing it.
- **Multi-node clustering (R10/R12):** a shared session index with forward/fan-out routing; a browser-less edge node can
  front a private pool.
- **Two container shapes:** a bundled image (Deno + sandboxed Chromium + ffmpeg) and a slim image (a compiled binary on
  `debian:stable-slim`) with an identical security posture.
- **CLI:** `serve`, `stdio`, `doctor`, `healthcheck`, `version`.
- **Documentation:** a full Diátaxis documentation set under `docs/`, three architecture SVG diagrams, and a Software
  Bill of Materials.

### Security

- Chromium is always sandboxed (`chromium-sandbox`, custom seccomp, `no-new-privileges` deliberately unset,
  `shm_size: 1gb`); `--no-sandbox` is never used.
- The CDP port (9222) is never published.
- Secrets are file-backed, resolved inside the process, and threaded by argument — never written into the environment
  Chromium inherits.
- Least-privilege Deno permission matrices on every runnable surface; `--deny-ffi` first; `--allow-run` is always an
  absolute path.
- A non-loopback bind refuses to start without credentials; Host and Origin allowlists derive from `TTK_PUBLIC_URL`.

<!-- Update these links to the project's actual repository host once published. -->

[0.2.0]: ./CHANGELOG.md
[0.1.0]: ./CHANGELOG.md
