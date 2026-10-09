# Web app

The control plane at the server's root URL (`http://127.0.0.1:8787/` by default). One page, no framework; it talks to
the same REST API and live-view socket as any client, with an HttpOnly sign-in cookie.

## Sign in

![Sign-in screen](../assets/screens/login.jpg)

Sign in with a username and password, or paste an API key (`ttk_…`) into the first field. The session lasts
`TTK_LOGIN_TTL_S` (7 days). What you see afterwards follows your scopes.

## Layout

| Area      | Contents                                                                                     |
| --------- | -------------------------------------------------------------------------------------------- |
| Left rail | **Sessions**, **Resources**, **Agents**, **Users**, **System**.                              |
| Top bar   | The screen's tabs, search and commands (**Ctrl K**), connection status, theme, account menu. |

## Sessions

![Sessions](../assets/screens/sessions.jpg)

A strip of counts (sessions, profiles, storage states, recordings, files, skills, prompts, workspaces, tasks, memory,
data directory), then one card per browser session with **Watch**, **Screenshot** and **Close**. **New session** (`+`)
opens one. Tabs: **Sessions**, **Live View**, **Workspaces**.

### Live View

![Live View](../assets/screens/live-view.jpg)

The selected session streamed live, with an address bar and back button. **Take control** (pointer icon) takes the
takeover lock: your mouse and keyboard drive the page, and the model's mutating tools wait with `human-has-control`
until you release it. The **Inspector** panel holds actions (screenshot, state, accessibility tree, …), viewport, tabs,
storage state, downloads, the session's event stream and tool output. A model's `browser_request_human` link opens this
view directly (`#/view/<session>`).

### Workspaces

![Workspaces](../assets/screens/workspaces.jpg)

Your coding workspaces (needs `sandbox:execute`): a file editor beside a live shell, plus diff and delete.

## Resources

![Resources](../assets/screens/resources.jpg)

Everything the server exposes to your credential: resources and tools grouped as Server, Browser, Files, Skills,
Prompts, Sandbox, Agents and Surfaces. Selecting a tool opens a form built from its schema with the result beside it,
the quickest way to try a tool by hand. Files, skills and prompts can be edited here with `files:write`.

## Agents

![Agents](../assets/screens/agents.jpg)

A chat over the task runtime: **Ask agent** (built-in model agent, SlopLord or the ACP agent, chosen in the target
picker), **Run tool** (one tool as a background task) and **Delegate** (to an A2A peer). Side panels list **Tasks** and
**Surfaces** (A2UI). Without `agent:invoke` the screen offers **Grant agent scopes to my account** to administrators.
The settings icon opens agent settings (admin).

## Users

Accounts with their scopes, sign-ins and API keys (needs `admin`): create accounts, change scopes, disable, reset
passwords, issue and revoke account keys, sign out everywhere.

## System

![System](../assets/screens/system.jpg)

Tabs: **Overview** (capabilities on and off, network, process memory), **MCP**, **Agents** (model providers, agent
settings, agent memory embedder) and **Configuration** (every setting with its source; **Compose configuration** drafts
environment and Compose snippets, never secrets). Needs `admin`.
