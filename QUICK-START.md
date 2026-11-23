# Quick start

One script prepares everything and starts Multi-MCP on your computer: the web app, its sandboxed browser and the private
coding sandbox. You need Docker, nothing else.

## 1. Install Docker

| Your computer | Install                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows       | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Start it once and wait until it says **Engine running**.                                               |
| macOS         | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/). Start it once and wait until it says **Engine running**.                                                   |
| Linux         | [Docker Engine](https://docs.docker.com/engine/install/) with the **Compose** and **Buildx** plugins (`docker-compose-plugin`, `docker-buildx-plugin`), and your user allowed to use it. |

Multi-MCP needs about 3 GiB of free memory (the web app and its browsers 1.5 GiB, the coding sandbox 1 GiB) and about 5
GB of disk for the images.

## 2. Get Multi-MCP

Download the ZIP from the [GitHub page](https://github.com/TykoDev/Multi-MCP) (**Code › Download ZIP**) and unpack it,
or, with Git:

```sh
git clone https://github.com/TykoDev/Multi-MCP.git
```

## 3. Run the start script

Open the `Multi-MCP` folder and run:

| Your computer | Run                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows       | Double-click **`start.cmd`** (or right-click `start.ps1` › **Run with PowerShell**). If Windows warns about a downloaded file, choose **More info › Run anyway**. |
| macOS, Linux  | In a terminal, in the folder: `./start.sh` (or `sh start.sh`).                                                                                                    |

The script:

1. checks that Docker is installed and running (on Windows it offers to start Docker Desktop);
2. builds the two images on your computer: the first time downloads Chromium and takes several minutes;
3. creates your secrets in `secrets/` and your settings in `.env`, by running the project's `setup` command inside the
   image it just built, with no network (so you do not need Deno). **The first time, it prints the administrator
   password and an API key once, and waits: save both now**, for example in a password manager. Only their hashes are
   stored, so they cannot be shown again;
4. on Linux with AppArmor (Ubuntu, Debian), installs the coding sandbox's AppArmor profile, after asking for your
   password through `sudo`;
5. starts Multi-MCP, waits until it answers, and opens <http://127.0.0.1:8787/> in your browser.

Sign in as **`admin`** with the password it printed. Then, optionally, add a model provider (web app › System › Agents ›
**Add provider**) to use the built-in agent and the SlopLord coding agent. A tour:
[Guide › The web app](docs/guide.md#the-web-app).

Running the script again is always safe: it keeps your secrets, settings and data, and only rebuilds and restarts.

## 4. Connect an MCP client

The MCP endpoint is `http://127.0.0.1:8787/mcp`, with the API key the script printed:

```sh
claude mcp add --transport http multi-mcp http://127.0.0.1:8787/mcp --header "Authorization: Bearer ttk_<key>"
```

That key holds every scope the stack's features need: browser, live view, file share, memory, coding sandbox, agents and
A2UI. Other clients, and how to give each one its own key:
[Guide › Connecting clients](docs/guide.md#connecting-clients).

## Settings

Change a value in `.env` (in the `Multi-MCP` folder; the script created it), save, and run the start script again.

| Goal                         | In `.env`                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Reach it from your network   | `TTK_BIND=0.0.0.0` and `TTK_PUBLIC_URL=http://<this computer's address>:8787`     |
| Behind your own domain       | `TTK_PUBLIC_URL=https://mcp.example.com` ([production](docs/guide.md#production)) |
| Limit the websites it visits | `TTK_ALLOWED_DOMAINS=example.com,docs.example.com`                                |
| More memory for browsers     | `TTK_GATEWAY_MEMORY=4g`                                                           |

Every other setting: [Environment variables](docs/reference/environment-variables.md). Every secret file and what to put
in it: [secrets/README.md](secrets/README.md).

## Day to day

Run these in a terminal in the `Multi-MCP` folder.

| Goal                      | Do                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stop                      | `docker compose down` (your data is kept)                                                                  |
| Start again               | the start script, or `docker compose up -d`                                                                |
| See whether it is healthy | `docker compose ps` (both services say `healthy`)                                                          |
| Update                    | `git pull` (or download the new ZIP over the folder, keeping `secrets/` and `.env`), then the start script |
| Read the logs             | `docker compose logs tykotech-mcp` (the web app), `docker compose logs sandbox`                            |
| Remove everything         | `docker compose down -v`: **deletes all data**; `secrets/` and `.env` stay                                 |

**Back up** `secrets/ttk_db_key` somewhere apart from Docker's data: it encrypts every secret stored in the database
([why](secrets/README.md#the-database-key)).

## If something goes wrong

| Message                                                     | What to do                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker is installed but not running`                       | Start Docker Desktop (or `sudo systemctl start docker`), wait for it, run the script again.                                                                                      |
| `permission denied ... docker.sock` (Linux)                 | Your user may not use Docker yet: [post-install steps](https://docs.docker.com/engine/install/linux-postinstall/).                                                               |
| `port is already allocated`                                 | Something else uses port 8787. Stop it, or change the first `8787` under `ports:` in `docker-compose.yml` and the port in `TTK_PUBLIC_URL`.                                      |
| `unable to apply apparmor profile` (Linux)                  | The sandbox's AppArmor profile is missing: run the script again and enter your password at the `sudo` prompt.                                                                    |
| The web app did not answer within 3 minutes                 | `docker compose ps` and `docker compose logs tykotech-mcp` say why.                                                                                                              |
| `Docker still holds data from an earlier Multi-MCP install` | Its key (`secrets/ttk_db_key`) is gone. Put your old `secrets/` folder back, or delete the old data with `docker compose down -v` (cannot be undone), then run the script again. |
| Lost the administrator password or API key                  | Another administrator can reset it in the web app (**Users**, **API keys**); otherwise see [secrets/README.md](secrets/README.md#administrator-account).                         |

## Optional: one Docker container per coding workspace

For hosts that forbid unprivileged user namespaces, `docker-compose.sandbox-docker.yml` runs each coding workspace as
its own hardened container instead of a bubblewrap cage. **It gives the sandbox service the Docker socket, which is root
on the host.** Steps and settings are in the file itself and in the [Docker overlays](docs/reference/api.md#overlays).

## For developers

Running from source with Deno 2.9 (`deno task setup`, `deno task dev`, stdio clients), the tests and the project rules:
[Development](docs/development.md) and [AGENTS.md](AGENTS.md).
