# Multi-MCP start script for Windows.
#
#   Double-click start.cmd, or right-click this file > "Run with PowerShell", or in PowerShell:
#   .\start.ps1               (add -NoBrowser to skip opening the web browser)
#
# It checks Docker Desktop, builds the two images, creates your secrets and settings (only the first time: later runs
# keep them), starts the stack and opens the web app. Run it again at any time: after an update, or after editing .env.
# Stop the stack with `docker compose down` in this folder.
#
# Works with Windows PowerShell 5.1 and PowerShell 7.
param([switch]$NoBrowser)

# Native commands are checked through $LASTEXITCODE; 'Stop' would turn their progress messages into errors in 5.1.
$ErrorActionPreference = 'Continue'
# Always work in the folder this script is in (the Multi-MCP folder).
Set-Location -LiteralPath $PSScriptRoot -ErrorAction Stop
# Pause only when a person is at the window (not when the output is captured or piped).
$interactive = -not [Console]::IsInputRedirected

function Write-Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Stop-WithError([string]$text) {
	Write-Host "`nERROR: $text" -ForegroundColor Red
	if ($interactive) { [void](Read-Host 'Press Enter to close') }
	exit 1
}
# True when `docker info` succeeds, i.e. the Docker engine is running. All output is discarded.
function Test-DockerEngine {
	$ErrorActionPreference = 'Continue'
	docker info *> $null
	return $LASTEXITCODE -eq 0
}

# 1. Docker Desktop must be installed and running, with Compose v2 and Buildx.
Write-Step 'Checking Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
	Stop-WithError 'Docker Desktop is not installed. Install it from https://docs.docker.com/desktop/setup/install/windows-install/ , start it once, then run this script again.'
}
if (-not (Test-DockerEngine)) {
	# Docker Desktop installs for all users under Program Files, or for one user under LocalAppData.
	$desktop = @(
		(Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
		(Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
	) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
	if ($interactive -and $desktop) {
		$answer = Read-Host 'Docker Desktop is not running. Start it now? [Y/n]'
		if ($answer -notmatch '^[nN]') {
			Start-Process -FilePath $desktop
			Write-Host -NoNewline 'Waiting for Docker Desktop to start (up to 3 minutes) '
			for ($i = 0; $i -lt 60 -and -not (Test-DockerEngine); $i++) { Write-Host -NoNewline '.'; Start-Sleep -Seconds 3 }
			Write-Host ''
		}
	}
	if (-not (Test-DockerEngine)) { Stop-WithError 'Docker is installed but not running. Start Docker Desktop, wait until it says "Engine running", then run this script again.' }
}
$composeVersion = (docker compose version --short) 2>$null
if ($LASTEXITCODE -ne 0 -or -not $composeVersion) { Stop-WithError 'Docker Compose v2 is missing. Update Docker Desktop: https://docs.docker.com/desktop/' }
docker buildx version *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker Buildx is missing. Update Docker Desktop: https://docs.docker.com/desktop/' }
Write-Host "Docker is running (Compose $composeVersion)."

# 2. Build the images on this computer. The first build downloads Chromium and takes several minutes.
Write-Step 'Building the images (the first time takes a few minutes)'
docker compose build
if ($LASTEXITCODE -ne 0) { Stop-WithError 'The images could not be built. The messages above say why.' }

# 3. Create the secrets in secrets\ and the settings in .env, by running the project's own `setup` command inside the
#    image just built, so you do not need Deno. The container has no network, no extra privileges, and sees only this
#    folder. Its Deno permissions are the `setup` task's in deno.json (--deny-ffi first). It skips files that exist.
#    Docker Desktop has no AppArmor, so setup's AppArmor step finds nothing to do.
Write-Step 'Creating your secrets and settings (kept if they already exist)'
# A database from an earlier install can only be opened with that install's key. If the key file is gone but the data
# volume is still there, setup would write a new key that cannot open it and the server would never start: stop and say so.
$project = (docker compose config --format json | ConvertFrom-Json).name
if (-not (Test-Path -LiteralPath 'secrets\ttk_db_key')) {
	docker volume inspect "${project}_ttk-data" *> $null
	if ($LASTEXITCODE -eq 0) {
		Stop-WithError ("Docker still holds data from an earlier Multi-MCP install (volume ${project}_ttk-data), but its key " +
			"(secrets\ttk_db_key) is gone, so that data cannot be opened. Either put the old secrets\ folder back, or delete " +
			"the old data with 'docker compose down -v' (this cannot be undone), then run this script again.")
	}
}
$image = docker compose config --images | Where-Object { $_ -like 'tykotech-mcp:*' } | Select-Object -First 1
if (-not $image) { Stop-WithError 'Could not find the tykotech-mcp image name in docker-compose.yml.' }
$setupArgs = @(
	'run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
	'--mount', "type=bind,source=$PSScriptRoot,target=/work", '--workdir=/work', $image,
	'deno', 'run', '--cached-only', '--no-prompt', '--config=/app/deno.json', '--deny-ffi',
	'--allow-read=.,/etc/apparmor.d/tykotech-sandbox', '--allow-write=secrets,.env',
	'--allow-run=/usr/bin/aa-enabled,/usr/bin/aa-exec,/usr/bin/sudo',
	'--allow-env=TTK_*,HOME,PATH',
	'/app/packages/cli/mod.ts', 'setup'
)
# The output is kept in memory only (never in a file): it holds the password and key the first time. Setup writes
# UTF-8, which Windows PowerShell would otherwise decode with the console's old code page.
$consoleEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$setupOutput = & docker @setupArgs
$setupCode = $LASTEXITCODE
[Console]::OutputEncoding = $consoleEncoding
# Setup runs on Linux inside the container and tries to set Linux file modes on secrets\, which a Windows folder does
# not have (secrets/README.md#permissions: nothing is needed on Windows). Its warning about that is dropped.
$setupOutput = @($setupOutput | Where-Object { $_ -notmatch '^warning: secrets/ is not yours' })
$setupOutput | ForEach-Object { Write-Host $_ }
if ($setupCode -ne 0) { Stop-WithError 'Setup did not finish. The messages above say why.' }
if (($setupOutput -join "`n") -match 'Shown once') {
	Write-Host ''
	Write-Host '****************************************************************************' -ForegroundColor Yellow
	Write-Host '  SAVE THE PASSWORD AND API KEY ABOVE NOW (a password manager is best).' -ForegroundColor Yellow
	Write-Host "  They are shown only this once. Sign in to the web app as 'admin'." -ForegroundColor Yellow
	Write-Host '****************************************************************************' -ForegroundColor Yellow
	if ($interactive) { [void](Read-Host 'Press Enter once you have saved them') }
}
$setupOutput = $null

# 4. Start the stack in the background and wait until the web app answers.
Write-Step 'Starting Multi-MCP'
docker compose up -d
if ($LASTEXITCODE -ne 0) { Stop-WithError "The stack could not be started. 'docker compose logs' shows why." }
$address = docker compose port tykotech-mcp 8787 | Select-Object -Last 1
if (-not $address) { $address = '127.0.0.1:8787' }
$address = $address -replace '^0\.0\.0\.0:', '127.0.0.1:' -replace '^\[::\]:', '127.0.0.1:'
Write-Host -NoNewline "Waiting for the web app at http://$address/ "
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
	try {
		$response = Invoke-WebRequest -Uri "http://$address/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
		$ready = $response.StatusCode -eq 200
	} catch { Write-Host -NoNewline '.'; Start-Sleep -Seconds 2 }
}
Write-Host ''
if (-not $ready) { Stop-WithError "The web app did not answer within 3 minutes. See 'docker compose ps' and 'docker compose logs tykotech-mcp'." }

# The address you open: TTK_PUBLIC_URL from .env.
$url = 'http://127.0.0.1:8787'
$line = Get-Content -LiteralPath '.env' -ErrorAction SilentlyContinue | Where-Object { $_ -match '^TTK_PUBLIC_URL=.+' } | Select-Object -Last 1
if ($line) { $url = $line.Substring('TTK_PUBLIC_URL='.Length).Trim() }
if (-not $NoBrowser -and $url -match '^https?://') { Start-Process "$url/" }

Write-Host ''
Write-Host 'Multi-MCP is running.' -ForegroundColor Green
Write-Host "  Web app:   $url/"
Write-Host "  Sign in:   user 'admin', with the password shown the first time you ran this script"
Write-Host "  MCP:       $url/mcp  (header 'Authorization: Bearer <the API key shown the first time>')"
Write-Host '  Stop:      docker compose down      (in this folder; your data is kept)'
Write-Host '  Start:     start.cmd or .\start.ps1 (again, at any time)'
Write-Host '  Status:    docker compose ps'
docker compose ps --format '  {{.Service}}: {{.Status}}'
if ($interactive) { [void](Read-Host "`nPress Enter to close this window (Multi-MCP keeps running)") }
