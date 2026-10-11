# MCP tools

The server defines **102 tools**: **57 browser tools**, 18 library tools and 27 extension tools. Each caller sees only
what its scopes and the deployment allow; everything else is listed with a reason in `tools_withheld` (resource
`ttk://capabilities`).

| Credential                        | Tools in the default Compose stack |
| --------------------------------- | ---------------------------------- |
| Default grant (no `scopes` named) | 65                                 |
| Every scope                       | 100                                |

The two never offered by default: `agent_delegate` (needs `TTK_AGENT_PEERS_FILE`) and `agent_prompt` (needs the ACP
bridge).

**Legend.** ✎ mutates the page or state: refused with `human-has-control` while a person holds the live-view lock.
Scope: needed in addition to `mcp:invoke`; blank = none. Most browser tools take an optional `session_id` (default: your
`default` session). Index-based tools take `index` plus the `state_token` from `browser_get_state`.

## Browser: navigation and interaction

| Tool                       | Scope      |   | Does                                                                                                                                               |
| -------------------------- | ---------- | - | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate`         |            | ✎ | Load a URL in the focused tab. `new_session: true` opens a new session; `profile` attaches one.                                                    |
| `browser_go_back`          |            | ✎ | Back one history entry.                                                                                                                            |
| `browser_wait_for`         |            |   | Wait for `navigation`, `selector`, `text`, `network_idle`, `download`, `dialog` or `state_token_changes`. A timeout is `met: false`, not an error. |
| `browser_click`            |            | ✎ | Click by index or viewport coordinates.                                                                                                            |
| `browser_double_click`     |            | ✎ | Double-click by index or coordinates.                                                                                                              |
| `browser_right_click`      |            | ✎ | Right-click (context menu).                                                                                                                        |
| `browser_hover`            |            | ✎ | Move the pointer onto an element, for hover menus and tooltips.                                                                                    |
| `browser_type`             |            | ✎ | Type into an element, or the focused one. `<secret>name</secret>` types a server-held secret.                                                      |
| `browser_press_key`        |            | ✎ | Key or chord (`Enter`, `Control+a`), optionally into an element.                                                                                   |
| `browser_fill`             |            | ✎ | Replace a field's contents.                                                                                                                        |
| `browser_select_option`    |            | ✎ | Choose a `<select>` option by value, label or position.                                                                                            |
| `browser_upload_file`      |            | ✎ | Put a file this session downloaded onto a file input.                                                                                              |
| `browser_drag`             |            | ✎ | Press, move, release: sliders, sortable lists, drag-and-drop.                                                                                      |
| `browser_scroll`           |            | ✎ | Scroll by viewport heights.                                                                                                                        |
| `browser_scroll_to`        |            | ✎ | Scroll to absolute CSS-pixel coordinates.                                                                                                          |
| `browser_scroll_into_view` |            | ✎ | Bring one element into view.                                                                                                                       |
| `browser_handle_dialog`    |            | ✎ | Answer a held JavaScript dialog by `dialog_id` (needs a `dialog` event subscriber).                                                                |
| `browser_fill_secret`      |            | ✎ | Fill a secret into a text or password field; checked against the frame's origin and audited.                                                       |
| `browser_evaluate`         | `evaluate` | ✎ | Run a JavaScript expression in a frame (1 s, 64 KiB result, audited).                                                                              |
| `browser_run_task`         | `task`     | ✎ | Complete a task autonomously with **your** model via MCP sampling; `resume` continues a paused run.                                                |

## Browser: perception

| Tool                             | Does                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_get_state`              | URL, title, tabs and the indexed interactive elements, with a `state_token`. `fields` picks element detail (`minimal`, `core`, `full`, …); `include_hidden` adds off-screen elements. |
| `browser_find`                   | Rank elements by role, accessible name, text, CSS, `href` pattern or nearness to a point.                                                                                             |
| `browser_element_at`             | The topmost interactive element at a viewport point.                                                                                                                                  |
| `browser_get_frames`             | Every frame (out-of-process ones too) with its URL and box.                                                                                                                           |
| `browser_locator_candidates`     | Ranked locators for one element, each with its match count.                                                                                                                           |
| `browser_verify_locator`         | What a locator matches on the live page.                                                                                                                                              |
| `browser_get_html`               | Raw HTML of a document (≤200 000 characters).                                                                                                                                         |
| `browser_screenshot`             | PNG of the focused tab; `full_page` optional.                                                                                                                                         |
| `browser_extract_content`        | Answer a question about the page with **your** model via MCP sampling.                                                                                                                |
| `browser_accessibility_snapshot` | The accessibility tree (roles, names, states), nested and as an outline.                                                                                                              |
| `browser_performance`            | Core Web Vitals and runtime counters.                                                                                                                                                 |

## Browser: sessions

| Tool                          | Scope   |   | Does                                                                                 |
| ----------------------------- | ------- | - | ------------------------------------------------------------------------------------ |
| `browser_get_session`         |         |   | Profile, timestamps, viewport, tabs, lock holder, idle timeout, viewers, files.      |
| `browser_list_sessions`       |         |   | Sessions you can reach, with who holds control.                                      |
| `browser_set_viewport`        |         | ✎ | Emulate a viewport for every tab.                                                    |
| `browser_set_session_options` |         | ✎ | Viewport, locale, timezone, user agent, `accept_downloads`, idle timeout.            |
| `browser_list_tabs`           |         |   | Open tabs.                                                                           |
| `browser_switch_tab`          |         | ✎ | Focus a tab.                                                                         |
| `browser_close_tab`           |         | ✎ | Close a tab.                                                                         |
| `browser_storage_state`¹      |         | ✎ | Save or load cookies and origin storage by name. Returns counts, never the document. |
| `browser_record`²             |         |   | Start, stop or check a WebM recording.                                               |
| `browser_close_session`       |         | ✎ | Close one session.                                                                   |
| `browser_close_all`           | `admin` | ✎ | Close every session on this node. Asks for confirmation.                             |
| `browser_health`              |         |   | Server and browser health plus the capability block.                                 |
| `browser_audit`               |         |   | Secret fills and evaluations recorded for a session (all sessions with `admin`).     |

## Browser: files, network and media

| Tool                     | Scope          |   | Does                                                                                  |
| ------------------------ | -------------- | - | ------------------------------------------------------------------------------------- |
| `browser_download`       |                | ✎ | Start a download by clicking an element or loading a URL; returns its `file_id`.      |
| `browser_list_files`     |                |   | Downloads and server-made files of the session, with status.                          |
| `browser_get_file`       |                |   | A file inline (≤1 MiB), as a resource link, or as an HTTP stream with `Range`.        |
| `browser_file_policy`    |                |   | The file limits this deployment enforces.                                             |
| `browser_head`³          |                |   | Cookie-less `HEAD` from the server, not the browser: status, type, length, final URL. |
| `browser_pdf`            |                |   | Print the tab to PDF, inline or kept as a session file.                               |
| `browser_file_link`⁴     |                |   | A no-bearer download URL for one file, valid 10–3600 s.                               |
| `browser_network_log`    |                |   | The session's requests. Full URLs, headers and bodies need `network:read`.            |
| `browser_console_log`    |                |   | Console output and uncaught exceptions.                                               |
| `browser_har_export`     |                |   | The request log as HAR 1.2 (≤1 MiB).                                                  |
| `browser_request_human`⁵ | `view:control` |   | Ask a person to take over (CAPTCHA, sign-in, a decision) via a live-view link.        |
| `browser_live_view`⁶     | `view:watch`   |   | Show the session live inside an MCP Apps host.                                        |
| `browser_live_ticket`⁶   | `view:watch`   |   | Mint the embed's single-use live-view ticket (app-only: hidden from the model).       |

Availability: ¹ `TTK_DATA_DIR`. ² `TTK_DATA_DIR` and `TTK_FFMPEG`. ³ outbound network grant, no browser proxy. ⁴
`TTK_SIGNED_LINKS` on. ⁵ `TTK_HUMAN_HANDOFF` on, HTTP only. ⁶ `TTK_MCP_APPS` `watch` or `control`, HTTP only.

## Library

Needs `TTK_DATA_DIR`. Reads need `files:read` (default grant); writes need `files:write`.

| Tool                                                   | Does                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `file_list`, `file_stat`, `file_read`                  | Browse and read the file share (UTF-8 text ≤1 MiB).                      |
| `file_write`, `file_mkdir`, `file_move`, `file_delete` | Change the file share. `file_delete` asks for confirmation.              |
| `skill_list`, `skill_get`, `skill_read_file`           | Read skills (`SKILL.md` with frontmatter plus files).                    |
| `skill_put`, `skill_delete`                            | Create, replace or delete a skill. `skill_delete` asks.                  |
| `prompt_list`, `prompt_get`, `prompt_render`           | Read and render prompt templates (`{{argument}}`).                       |
| `prompt_put`, `prompt_delete`                          | Create, replace or delete a template. `prompt_delete` asks.              |
| `browser_save_to_share`                                | Copy a session file into the share (≤64 MiB) so it outlives the session. |

Stored prompts and skills are also served as MCP prompts (`skill:<name>` for skills).

## Extension tools

Results arrive inside `{ result }`.

| Tool                                                            | Scope             | Does                                                                       |
| --------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `sandbox_create`, `sandbox_clone`                               | `sandbox:execute` | New workspace from files or the share, or from a git repository.           |
| `sandbox_list`, `sandbox_read`, `sandbox_write`, `sandbox_diff` | `sandbox:execute` | List workspaces and files, read and write files, diff against the start.   |
| `sandbox_exec`                                                  | `sandbox:execute` | Run a command in a fresh cage (no network unless `network: "registries"`). |
| `sandbox_session_open`, `…_input`, `…_read`, `…_close`          | `sandbox:execute` | A live line-mode shell.                                                    |
| `sandbox_delete`                                                | `sandbox:execute` | Delete a workspace. Asks.                                                  |
| `agent_run_tool`                                                | `agent:invoke`    | Run one tool call as a background task you own.                            |
| `agent_get_task`, `agent_list_tasks`, `agent_cancel_task`       | `agent:invoke`    | Follow, list and cancel your tasks.                                        |
| `agent_peers`, `agent_delegate`                                 | `agent:invoke`    | List A2A peers; delegate a message to one.                                 |
| `agent_prompt`                                                  | `agent:invoke`    | Start a task on the external ACP agent.                                    |
| `a2ui_publish`, `a2ui_delete`                                   | `a2ui:publish`    | Publish or delete an A2UI v0.9 surface. `a2ui_delete` asks.                |
| `sandbox_session_ticket`⁷                                       | `sandbox:execute` | Mint the terminal embed's single-use socket ticket (app-only).             |
| `a2ui_surface_ticket`⁷                                          | `a2ui:publish`    | Mint the surface embed's single-use socket ticket (app-only).              |
| `memory_search`, `memory_list`                                  | `files:read`      | Similarity search over your memory collections.                            |
| `memory_save`, `memory_delete`                                  | `files:write`     | Save up to 32 items; delete items or a collection. `memory_delete` asks.   |

Sandbox tools need the sandbox service (`TTK_SANDBOX_URL`) and are withheld while it is unreachable. Memory tools need
`TTK_DATA_DIR`. `sandbox_clone` needs `TTK_SANDBOX_GIT_HOSTS` or remotes on the sandbox service. ⁷ `TTK_MCP_APPS`
`watch` or `control`, HTTP only; hosts keep these from the model (see [MCP Apps](mcp-protocol.md#mcp-apps)).

**Argument spellings.** A value the schema refuses only because it arrived as JSON text — an object, array, number or
boolean sent as a string, such as `{"limit": "5"}` or a stringified `message` — is read as the value it spells and
validated again; text that spells nothing, or a value that is still wrong, is refused with the field named.
`a2ui_publish` also accepts a message without `version` (read as `v0.9`) and the A2UI basic catalog's own id
(`https://a2ui.org/specification/v0_9/basic_catalog.json`, read as the local catalog).

## Behaviour common to all tools

- **Errors are results**: `isError: true`, text `Error: <code>: <detail>`, and `structuredContent.error.code`. Codes:
  [error reference](error-codes.md).
- **Output**: every tool returns `structuredContent` matching its `outputSchema`, plus text.
- **Confirmations**: the seven tools marked "asks" request `{ confirm: true }` through form elicitation when the client
  supports it and `TTK_CONFIRM_DESTRUCTIVE` is on. Declining answers `user-declined`.
- **Annotations**: read-only tools carry `readOnlyHint`; mutating ones state `destructiveHint`, `idempotentHint` and
  `openWorldHint` explicitly.
- **Progress**: a request with a `progressToken` gets a notification every second. `browser_run_task`, `sandbox_exec`,
  `browser_wait_for` and `browser_download` report a total.
- **Not runnable as a background task** (`agent_run_tool`, A2A, A2UI buttons): the sampling tools,
  `browser_request_human`, the live-view tools, `browser_file_link`, `agent_run_tool` and the confirmation set.
