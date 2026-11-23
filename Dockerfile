# TykoTech-MCP — single bundled-Chromium image.
#
# Session recording runs `ffmpeg` as a sidecar process, so the image
# carries it and the run grant names it explicitly - a bare `--allow-run` is
# refused by the permission gate, and rightly.
#
# The Chromium sandbox in Docker needs all three of: the `chromium-sandbox`
# package (Debian ships the setuid helper separately), `no-new-privileges`
# DROPPED on the container (it blocks the helper's setuid escalation), and the
# custom seccomp profile in docker/ (Docker's default denies the
# namespace-creating clone the helper performs). `--no-sandbox` is refused in
# TTK_BROWSER_ARGS at startup and is reachable only through
# TTK_CHROMIUM_NO_SANDBOX, which this image never sets — this process exists to
# load untrusted pages.

# Base images are pinned by digest: a tag can be re-pointed under
# us, a digest cannot. The tag stays beside it for the reader; when a digest is
# present Docker resolves by the digest alone. One Deno for every image and for
# CI — denoland/deno:2.9.7 (the same multi-arch index as debian-2.9.7),
# resolved 2026-10-04. To move it: `docker buildx imagetools inspect
# denoland/deno:<tag>` and replace the digest here, in
# docker/Dockerfile.sandbox and docker/Dockerfile.sandbox-workspace, and the
# deno-version in .github/workflows/ci.yml (tests/unit/images_test.ts holds
# them to one value).
ARG DENO_IMAGE=denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432

# --- build ------------------------------------------------------------------
FROM ${DENO_IMAGE} AS build
WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests

# `deno install --frozen` cannot succeed against a workspace whose lockfile is
# graph-derived; the frozen guarantee is taken over the real module graph
# instead.
RUN deno cache --frozen packages/cli/mod.ts scripts/healthcheck.ts
RUN deno task build:web

# --- runtime ----------------------------------------------------------------
FROM ${DENO_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
	chromium \
	chromium-sandbox \
	fonts-liberation \
	ca-certificates \
	dumb-init \
	ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

# Chromium's sandbox helper is the one setuid binary this image needs. Because no-new-privileges is dropped for
# it (above) and Docker's default capabilities stay, every other setuid/setgid file the base and the packages ship
# (su, mount, umount, passwd, chsh, chfn, gpasswd, newgrp, unix_chkpwd, …) would be a root step for code that escapes
# the browser into the `deno` user. Strip them all but the helper, then fail the build if the helper lost its bit or
# moved: a silent loss would leave Chromium without its sandbox, which is worse than a red build.
RUN find / -xdev -type f -perm /6000 ! -path /usr/lib/chromium/chrome-sandbox -exec chmod a-s {} + \
	&& test -u /usr/lib/chromium/chrome-sandbox \
	&& test -z "$(find / -xdev -type f -perm /6000 ! -path /usr/lib/chromium/chrome-sandbox -print -quit)"

COPY --from=build --chown=deno:deno /app /app
COPY --from=build --chown=deno:deno /deno-dir /deno-dir

# Chromium needs a writable HOME: the base image sets HOME=/home/deno but does
# not create it, and without it the crashpad handler fails and the browser dies
# with SIGTRAP (exit 133) before the CDP endpoint ever comes up. /data is the
# mounted volume's mount point.
RUN mkdir -p /data /home/deno/.cache \
	&& chown -R deno:deno /data /home/deno

# `ttk <command>` runs the CLI for maintenance (`seed --force`, `doctor`) under a narrower matrix than the
# server's CMD — see docker/ttk. Not the server: the CMD below is.
COPY --chmod=0755 docker/ttk /usr/local/bin/ttk

# Configuration only — never a secret. Secrets arrive as *_FILE paths and are
# read inside the process, so they never enter an image layer or the
# environment Chromium inherits.
ENV DENO_DIR=/deno-dir \
	DENO_NO_PROMPT=1 \
	TTK_LOG_FORMAT=json \
	TTK_BROWSER_PATH=/usr/bin/chromium \
	TTK_DATA_DIR=/data \
	TTK_FFMPEG=/usr/bin/ffmpeg \
	TTK_HEADLESS=true \
	TTK_HOST=0.0.0.0 \
	TTK_PORT=8787

# The MCP Registry's OCI ownership proof — the registry reads this label and compares it with the
# `name` in server.json. A label grants nothing; it is metadata.
LABEL io.modelcontextprotocol.server.name="eu.tykotech/tykotech-mcp"

WORKDIR /app
USER deno
VOLUME ["/data"]

# 8787 only. The CDP port is never published: it is an unauthenticated remote
# control for the browser.
EXPOSE 8787

# The probe reads one name and dials loopback only.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
	CMD ["deno", "run", "--cached-only", "--deny-ffi", "--allow-net=127.0.0.1", "--allow-env=TTK_PORT", "scripts/healthcheck.ts"]

# dumb-init reaps the process tree Chromium leaves behind.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# The permission matrix lives here so an operator can scope or widen it without
# a rebuild. `--deny-ffi` comes first: a deny outranks any later allow.
#
# The net grant is unscoped. It covers the bind (any
# TTK_PORT, no edit here), Chromium's CDP on loopback, the compose services
# (sandbox:8080) and every outbound path a deployment turns on: browser_head,
# model and secret providers, A2A push. What
# bounds each of those is the code that dials, not this flag:
#
#   - browser_head sends HEAD only, with no credential, walks every redirect
#     itself, refuses loopback, private and link-local literals at every hop,
#     and follows TTK_ALLOWED_DOMAINS (empty by default: set it to bound the
#     server's requests as well as the browser's). A *name* that resolves to a
#     private address is not refused — DNS is never inspected, because
#     rebinding makes that unsound — so on a network with internal services,
#     set TTK_ALLOWED_DOMAINS or scope this grant back.
#   - The database's providers are the allowlist for model hosts (seeded
#     from the providers file, edited by an admin): the gateway dials only the
#     base URLs they name, each judged by the file's own parser, with
#     `redirect: 'error'`.
#   - A2A push delivers only to TTK_A2A_PUSH_ALLOWED_HOSTS; secret providers
#     are operator-named addresses.
#
# To scope it back, restate this whole argv in a compose `command:` override
# with a narrower --allow-net (`--deny-ffi` first, the env list verbatim), e.g.
# `--allow-net=0.0.0.0:8787,127.0.0.1,sandbox:8080` — the bind, Chromium's CDP
# and the sandbox. Inbound connections are unaffected either way: reaching this
# container from another machine is a matter of TTK_PUBLIC_URL and the
# published port, never of this flag.
#
# No compose file restates this argv, so this is the one place it lives.
#
# No OTEL_* name is granted: the server exports no telemetry (tests/unit/images_test.ts pins the env list).
#
# A provider named in TTK_MODEL_PROVIDERS_FILE is `reachable: true` here — the
# unscoped grant proves every host, so the file alone decides which hosts the agent dials. A provider key never
# enters the environment: `TTK_*` covers the file's path, and tests/unit/images_test.ts pins that no `*_API_KEY`
# name is granted here. tests/container/verify_container.ts asserts `builtinAgent: true` with a providers file.
CMD ["deno", "run", \
	"--cached-only", \
	"--deny-ffi", \
	"--allow-net", \
	"--allow-run=/usr/bin/chromium,/usr/bin/ffmpeg", \
	"--allow-read=/app,/data,/tmp,/home/deno,/run/secrets", \
	"--allow-write=/data,/tmp,/home/deno", \
	"--allow-env=TTK_*,DENO_DIR,DENO_NO_PROMPT,HOME,TMPDIR,PATH", \
	"packages/cli/mod.ts", "serve"]
