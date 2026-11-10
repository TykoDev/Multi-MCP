# Quick start

Three ways to run Multi-MCP. Each one starts from the same `deno task setup`.

| Option                                                                   | What runs                                      | For                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------- |
| [1. Local development](#1-local-development)                             | The gateway on the host, with Deno             | Changing the code; a local agent over stdio   |
| [2. Docker Compose](#2-docker-compose)                                   | Gateway, coding sandbox (bubblewrap), A2A peer | The full stack on one host. **Start here.**   |
| [3. Docker sandbox and agent runner](#3-docker-sandbox-and-agent-runner) | Option 2 plus two overlays                     | A container per workspace; your own ACP agent |

## Before you start

1. Get the code and install [Deno 2.9](https://docs.deno.com/runtime/getting_started/installation/):

   ```sh
   git clone https://github.com/TykoDev/Multi-MCP.git
   cd Multi-MCP
   deno --version          # deno 2.9.x
   ```

2. Create the secrets and `.env`:

   ```sh
   deno task setup
   ```

   It prints the administrator password and an API key **once** (only their hashes are stored): save both. It writes
   every file the Compose files mount into `secrets/` (a `0700` folder) and `.env` from `.env.example`. Running it again
   is safe: it keeps what exists and repairs file modes. On a host with AppArmor (Ubuntu, Debian) it also installs the
   coding sandbox's AppArmor profile through `sudo`, which asks for your password. Every file and option:
   [secrets/README.md](secrets/README.md).

## 1. Local development

**Needs:** Deno 2.9. Chrome, Chromium, Edge or Brave for the browser tools (found automatically; without one the server
still starts, and its browser tools fail until you install one or set `TTK_BROWSER_PATH`).

1. Build the web app (again after you change `packages/web`):

   ```sh
   deno task build:web
   ```

2. Point the server at the secrets `setup` wrote, and start it:

   ```sh
   export TTK_DATA_DIR=data TTK_DB_KEY_FILE=secrets/ttk_db_key TTK_API_KEYS_FILE=secrets/ttk_api_keys.json
   deno task dev
   ```

   `dev` restarts on every file change. The administrator account is read from `secrets/ttk_admin_user.json`, and state
   goes to `./data`.

3. Check it:

   ```sh
   curl -s http://127.0.0.1:8787/healthz        # {"status":"ok","version":"0.2.0","sessions":0}
   ```

4. Use it:

   | What         | Where                                                                                                   |
   | ------------ | ------------------------------------------------------------------------------------------------------- |
   | Web app      | <http://127.0.0.1:8787/>: sign in as `admin` with the printed password ([tour](docs/guides/web-app.md)) |
   | MCP endpoint | `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <printed key>`                                  |

`dev` may reach loopback addresses only: a model server on this machine works, a cloud provider does not (use Compose).
It runs no coding sandbox and no A2A peer, so their tools are not offered. `deno task` lists every task; tests and
tiers: [Development](docs/guides/development.md).

### Connect a local agent over stdio

stdio opens no port and needs no key. Add this to your MCP client's configuration, with the absolute path of your
checkout; it uses the same `./data` as `dev`:

```json
{
	"mcpServers": {
		"multi-mcp": {
			"command": "deno",
			"args": ["task", "--cwd", "/absolute/path/to/Multi-MCP", "stdio"],
			"env": { "TTK_DATA_DIR": "data", "TTK_DB_KEY_FILE": "secrets/ttk_db_key" }
		}
	}
}
```

The client first sees one `use_<group>` tool per group (`use_browser`, `use_library`, `use_memory`, …); calling one adds
that group's tools. Set `"TTK_MCP_TOOL_GROUPS": "false"` in `env` for the full list at once. stdio callers hold
`TTK_ANON_SCOPES` (default `mcp:invoke,view:watch,view:control,files:read`); add `files:write` to let an agent save
memory. More: [Connecting clients](docs/guides/connecting-clients.md#stdio).

## 2. Docker Compose

**Needs:**

- Docker Engine with the **Compose v2** and **Buildx** plugins. Docker Desktop has both. On Debian or Ubuntu with
  Docker's apt repository: `sudo apt-get install docker-compose-plugin docker-buildx-plugin`. Without Buildx the image
  build stops at `the --chmod option requires BuildKit`.
- Deno 2.9 for `setup`, and about 4 GiB of free memory: the gateway is capped at 1.5 GiB, the peer and the sandbox at 1
  GiB each.

```sh
docker compose version       # Docker Compose version v2.x or later
docker buildx version
```

1. Run `deno task setup` ([Before you start](#before-you-start)) if you have not.

2. Optional: edit `.env` first.

   | Goal                  | In `.env`                                                                                       |
   | --------------------- | ----------------------------------------------------------------------------------------------- |
   | Reach it from the LAN | `TTK_BIND=0.0.0.0` and `TTK_PUBLIC_URL=http://<host address>:8787`                              |
   | Behind a domain       | `TTK_PUBLIC_URL=https://mcp.example.com` ([production](docs/guides/deploying-to-production.md)) |
   | Limit browsing        | `TTK_ALLOWED_DOMAINS=example.com,docs.example.com`                                              |

3. Build and start. The first build downloads Chromium and takes a few minutes:

   ```sh
   docker compose up -d --build
   ```

4. Check that all three services report `healthy`, and the gateway answers:

   ```sh
   docker compose ps
   curl -s http://127.0.0.1:8787/healthz
   ```

5. Use it:

   | What           | Where                                                                                                   |
   | -------------- | ------------------------------------------------------------------------------------------------------- |
   | Web app        | <http://127.0.0.1:8787/>: sign in as `admin` with the printed password ([tour](docs/guides/web-app.md)) |
   | MCP endpoint   | `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <printed key>`                                  |
   | A2A            | `http://127.0.0.1:8787/a2a` with the same key; card at `/.well-known/agent-card.json`                   |
   | Model provider | Web app › System › Agents › **Add provider** (optional; enables the built-in agent and SlopLord)        |

   The printed key holds every scope the stack's features need: browser, live view, file share, memory, coding sandbox,
   agents and A2UI. Client set-up: [Connecting clients](docs/guides/connecting-clients.md).

Only the gateway publishes a port. The sandbox is reachable from the gateway alone, and makes its own access token on
its first start.

**Day to day**

| Goal                 | Run                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Apply a `.env` edit  | `docker compose up -d`                                                                          |
| Another API key      | `deno task doctor --new-key <id> --scopes <list> --save` (the gateway picks it up at once)      |
| Without the A2A peer | `docker compose up -d tykotech-mcp sandbox`                                                     |
| Diagnose             | `docker compose logs tykotech-mcp`, `docker compose run --rm --no-deps tykotech-mcp ttk doctor` |
| Update               | `git pull && deno task setup && docker compose up -d --build`                                   |
| Stop / remove        | `docker compose down` (keeps data) / `docker compose down -v` (deletes all data)                |

Back up `secrets/ttk_db_key` apart from the `ttk-data` volume: it encrypts every secret stored there
([why](secrets/README.md#the-database-key)). To seed model providers from a file instead of the web app, add
`-f docker-compose.providers.yml` ([format](secrets/README.md#model-providers-file)).

## 3. Docker sandbox and agent runner

Two overlays on top of option 2, usable together or alone:

- `docker-compose.sandbox-docker.yml` runs each coding workspace as its own hardened container through the Docker
  Engine, instead of a bubblewrap cage: for hosts that forbid unprivileged user namespaces. **It mounts the Docker
  socket into the sandbox service, which is root on the host**; prefer rootless Docker.
- `docker-compose.agents.yml` runs an external coding agent that speaks ACP (the Agent Client Protocol) in a container
  of its own, which the gateway's agent tools reach.

**Needs:** everything in option 2, and your agent as a Linux executable (or a script that starts it).

1. Run `deno task setup` if you have not. It has written the runner's token and `secrets/ttk_agent_commands.json`.

2. Tell the sandbox the Docker socket's group (Linux; leave `0` on Docker Desktop):

   ```sh
   sed -i "s/^TTK_SANDBOX_DOCKER_GID=.*/TTK_SANDBOX_DOCKER_GID=$(stat -c %g /var/run/docker.sock)/" .env
   ```

3. Build the images: the stack's two, the workspace image, and the runner's base:

   ```sh
   docker compose build
   docker build -f docker/Dockerfile.sandbox-workspace -t tykotech-sandbox-workspace:0.2.0 .
   docker build -f docker/Dockerfile.agent-runner -t tykotech-agent-runner:0.2.0 .
   ```

4. Put your agent in a runner image. The runner starts exactly `/opt/agents/agent` and refuses to start without it. Save
   this as `Dockerfile.my-runner` beside your agent:

   ```dockerfile
   FROM tykotech-agent-runner:0.2.0
   USER root
   # Install what your agent needs here (apt-get, npm, a release binary…).
   COPY my-agent /opt/agents/agent
   RUN chmod 0755 /opt/agents/agent
   USER deno
   ```

   ```sh
   docker build -f Dockerfile.my-runner -t my-runner:1 .
   ```

5. Point the stack at it. In `.env`, set `TTK_AGENT_RUNNER_IMAGE=my-runner:1`. Then edit
   `secrets/ttk_agent_commands.json`: `setup` wrote one agent, `default`, at `/opt/agents/agent`; add its `args`, `env`
   and `mcp_servers` ([format](docs/guides/coding-and-agents.md#the-acp-agent-bridge)). Its provider key goes in a
   mounted file named by a `*_FILE` variable, never in this file.

6. Start the three files together. `--no-build` keeps Compose from building the base runner over your image:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml -f docker-compose.agents.yml up -d --no-build
   ```

   To type less, add `COMPOSE_FILE=docker-compose.yml:docker-compose.sandbox-docker.yml:docker-compose.agents.yml` to
   `.env`: every `docker compose` command then uses all three files.

7. Check that the four services report `healthy`, and that the gateway found the runner:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml -f docker-compose.agents.yml ps
   docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml -f docker-compose.agents.yml logs tykotech-mcp | grep "ACP runner"
   ```

   Use the stack as in option 2. Each new coding workspace shows up as a container named `ttk-sandbox-…`.

**One overlay only:** for the Docker sandbox, do steps 2 and 3 and start with
`-f docker-compose.yml -f
docker-compose.sandbox-docker.yml up -d --build`. For the agent runner, do steps 3 to 5 and
start with `-f docker-compose.yml -f docker-compose.agents.yml up -d --no-build`.

**Stop / remove.** Compose did not create the workspace containers, so remove them first, then stop the stack:

```sh
docker rm -f $(docker ps -aq --filter label=eu.tykotech.sandbox=1)
docker compose -f docker-compose.yml -f docker-compose.sandbox-docker.yml -f docker-compose.agents.yml down      # add -v to delete all data
```

Workspaces live in the `ttk-code` volume (option 2's are in `<project>_ttk-code`, and do not carry over). More:
[Docker reference](docs/reference/docker-reference.md#overlays), [Coding sandbox](packages/sandbox/README.md).
