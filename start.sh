#!/bin/sh
# Multi-MCP start script for macOS and Linux.
#
#   ./start.sh                (or: sh start.sh)
#   ./start.sh --no-browser   do everything but open the web browser
#
# It checks Docker, builds the two images, creates your secrets and settings (only the first time: later runs keep
# them), starts the stack and opens the web app. Run it again at any time: after an update, or after editing .env.
# Stop the stack with `docker compose down` in this folder.
set -eu

# Always work in the folder this script is in (the Multi-MCP folder).
cd "$(dirname "$0")"

open_browser=yes
[ "${1:-}" = "--no-browser" ] && open_browser=no

step() { printf '\n==> %s\n' "$*"; }
fail() {
	printf '\nERROR: %s\n' "$*" >&2
	exit 1
}

# 1. Docker must be installed and running, with Compose v2 and Buildx.
step "Checking Docker"
command -v docker >/dev/null 2>&1 ||
	fail "Docker is not installed. Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 ||
	fail "Docker is installed but not running (or you may not use it). Start Docker Desktop, or on Linux run
       'sudo systemctl start docker' and make sure your user may use Docker:
       https://docs.docker.com/engine/install/linux-postinstall/"
compose_version=$(docker compose version --short 2>/dev/null) ||
	fail "Docker Compose v2 is missing. Install the 'docker-compose-plugin' package: https://docs.docker.com/compose/install/"
docker buildx version >/dev/null 2>&1 ||
	fail "Docker Buildx is missing. Install the 'docker-buildx-plugin' package: https://docs.docker.com/build/install-buildx/"
echo "Docker is running (Compose $compose_version)."

# 2. Build the images on this computer. The first build downloads Chromium and takes several minutes.
step "Building the images (the first time takes a few minutes)"
docker compose build || fail "The images could not be built. The messages above say why."

# 3. Create the secrets in secrets/ and the settings in .env, by running the project's own `setup` command inside the
#    image just built, so you do not need Deno. The container has no network, no extra privileges, and sees only this
#    folder. Its Deno permissions are the `setup` task's in deno.json (--deny-ffi first). It skips files that exist.
step "Creating your secrets and settings (kept if they already exist)"
# A database from an earlier install can only be opened with that install's key. If the key file is gone but the data
# volume is still there, setup would write a new key that cannot open it and the server would never start: stop and say so.
project=$(docker compose config | sed -n 's/^name: *//p' | head -n 1)
if [ ! -f secrets/ttk_db_key ] && docker volume inspect "${project}_ttk-data" >/dev/null 2>&1; then
	fail "Docker still holds data from an earlier Multi-MCP install (volume ${project}_ttk-data), but its key (secrets/ttk_db_key) is gone, so that data cannot be opened. Either put the old secrets/ folder back, or delete the old data with 'docker compose down -v' (this cannot be undone), then run this script again."
fi
image=$(docker compose config --images | grep '^tykotech-mcp:' | head -n 1)
[ -n "$image" ] || fail "Could not find the tykotech-mcp image name in docker-compose.yml."
user_flag=""
if [ "$(uname -s)" = "Linux" ]; then
	# Write the files as you, so they stay yours. Rootless Docker already maps the container's root to you.
	if docker info --format '{{.SecurityOptions}}' | grep -q rootless; then
		user_flag="--user=0:0"
	else
		user_flag="--user=$(id -u):$(id -g)"
	fi
fi
# The output is kept in memory only (never in a file): it holds the password and key the first time.
# shellcheck disable=SC2086 # $user_flag is one word or empty
setup_output=$(docker run --rm --network=none --cap-drop=ALL --security-opt=no-new-privileges $user_flag \
	--mount "type=bind,source=$(pwd),target=/work" --workdir=/work "$image" \
	deno run --cached-only --no-prompt --config=/app/deno.json --deny-ffi \
	--allow-read=.,/etc/apparmor.d/tykotech-sandbox --allow-write=secrets,.env \
	--allow-run=/usr/bin/aa-enabled,/usr/bin/aa-exec,/usr/bin/sudo \
	"--allow-env=TTK_*,HOME,PATH" \
	/app/packages/cli/mod.ts setup) || {
	printf '%s\n' "$setup_output"
	fail "Setup did not finish. The messages above say why."
}
printf '%s\n' "$setup_output"
case "$setup_output" in
*"Shown once"*)
	printf '\n%s\n%s\n%s\n' \
		"****************************************************************************" \
		"  SAVE THE PASSWORD AND API KEY ABOVE NOW (a password manager is best)." \
		"  They are shown only this once. Sign in to the web app as 'admin'." \
		"****************************************************************************"
	[ -t 0 ] && printf 'Press Enter once you have saved them... ' && read -r _
	;;
esac

# 4. Hosts whose Docker uses AppArmor (Ubuntu, Debian) need the coding sandbox's profile loaded once, as root.
#    Docker Desktop (any system) and hosts without AppArmor need nothing.
if docker info --format '{{.SecurityOptions}}' | grep -q 'name=apparmor'; then
	step "Checking the coding sandbox's AppArmor profile"
	profile=/etc/apparmor.d/tykotech-sandbox
	if cmp -s docker/apparmor-sandbox "$profile" && { ! command -v aa-exec >/dev/null 2>&1 || aa-exec -p tykotech-sandbox -- true 2>/dev/null; }; then
		echo "The profile is installed and loaded."
	else
		command -v apparmor_parser >/dev/null 2>&1 || [ -x /sbin/apparmor_parser ] || [ -x /usr/sbin/apparmor_parser ] ||
			fail "AppArmor's tools are missing. Install the 'apparmor' package (e.g. 'sudo apt-get install apparmor'), then run this script again."
		echo "This computer uses AppArmor. The coding sandbox needs its profile installed in $profile."
		echo "This runs two commands as administrator; 'sudo' may ask for your password:"
		echo "  sudo install -m 0644 docker/apparmor-sandbox $profile"
		echo "  sudo apparmor_parser -r $profile"
		sudo install -m 0644 docker/apparmor-sandbox "$profile" && sudo apparmor_parser -r "$profile" ||
			echo "WARNING: the profile could not be installed; the coding sandbox will not start, everything else will."
	fi
fi

# 5. Start the stack in the background and wait until the web app answers.
step "Starting Multi-MCP"
docker compose up -d || fail "The stack could not be started. 'docker compose logs' shows why."
address=$(docker compose port tykotech-mcp 8787 2>/dev/null | tail -n 1)
address=$(printf '%s' "${address:-127.0.0.1:8787}" | sed 's/^0\.0\.0\.0:/127.0.0.1:/; s/^\[::\]:/127.0.0.1:/')
printf 'Waiting for the web app at http://%s/ ' "$address"
ready=no
tries=0
while [ $tries -lt 90 ]; do
	if command -v curl >/dev/null 2>&1; then
		curl -fsS --max-time 3 "http://$address/healthz" >/dev/null 2>&1 && ready=yes && break
	elif command -v wget >/dev/null 2>&1; then
		wget -q -T 3 -O /dev/null "http://$address/healthz" 2>/dev/null && ready=yes && break
	else
		docker compose ps tykotech-mcp | grep -q '(healthy)' && ready=yes && break
	fi
	printf '.'
	tries=$((tries + 1))
	sleep 2
done
echo
[ "$ready" = yes ] || fail "The web app did not answer within 3 minutes. See 'docker compose ps' and 'docker compose logs tykotech-mcp'."

# The address you open: TTK_PUBLIC_URL from .env.
url=$(sed -n 's/^TTK_PUBLIC_URL=//p' .env 2>/dev/null | tail -n 1)
url=${url:-http://127.0.0.1:8787}
if [ "$open_browser" = yes ]; then
	if command -v open >/dev/null 2>&1 && [ "$(uname -s)" = "Darwin" ]; then
		open "$url/" || true
	elif command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$url/" >/dev/null 2>&1 || true
	fi
fi

cat <<EOF

Multi-MCP is running.
  Web app:   $url/
  Sign in:   user 'admin', with the password shown the first time you ran this script
  MCP:       $url/mcp  (header 'Authorization: Bearer <the API key shown the first time>')
  Stop:      docker compose down      (in this folder; your data is kept)
  Start:     ./start.sh               (again, at any time)
  Status:    docker compose ps
EOF
docker compose ps --format '  {{.Service}}: {{.Status}}' 2>/dev/null || true
