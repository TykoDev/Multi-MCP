/**
 * @module
 * Browser process launch, per-OS executable discovery, and the `/json/version` handshake.
 *
 * Contract owners: SPECS/ARCHITECTURE.md §6.1 (LocalBrowserWatchdog dispatches to these primitives),
 * §7.4 (launch vs connect convergence), SPECS/DECISION-REGISTER.md D-BROWSER1 (launch via
 * `Deno.Command`, no bundled-browser download in v1), SPECS/SETUP-WIZARD.md §4.2 (resolution order +
 * per-OS candidate table), SPECS/SECURITY-AUTH.md §3.2 (`--allow-run` scoped to a resolved path).
 *
 * This file is leaf infrastructure: it imports `@std` only and nothing from any other `@bua/*`
 * package. It owns process spawning and readiness; it owns no session, focus, or bus concept.
 */

import { delay } from '@std/async';
import { isAbsolute, resolve } from '@std/path';

// ---------------------------------------------------------------------------
// constants (SPECS/ARCHITECTURE.md §6.1, §7.4, §8)
// ---------------------------------------------------------------------------

/**
 * Kept in step with `packages/cdp/deno.json` — asserted by `src/launch_test.ts` so the two cannot
 * drift. Used for the `User-Agent: bua/<version>` handshake header (ARCHITECTURE.md §7.4).
 */
// ERRATUM(E-44). Moved with the nine-file 0.2.0 bump (G-9, B1.13). `launch_test.ts`
// already required this to equal `packages/cdp/deno.json`, so it is a version
// constant tracking its own manifest rather than a behaviour change.
export const CDP_PACKAGE_VERSION = '0.2.0';

/** `/json/version` readiness cadence during launch (ARCHITECTURE.md §6.1). */
export const READINESS_POLL_INTERVAL_MS = 100;
/** Hard cap on the `/json/version` readiness wait (ARCHITECTURE.md §6.1, §7.4). */
export const READINESS_TIMEOUT_MS = 30_000;
/** Profile-lock retry budget: total attempts, each with a fresh temp profile (D-BROWSER1). */
export const MAX_LAUNCH_ATTEMPTS = 3;
/** SIGTERM grace before SIGKILL (ARCHITECTURE.md §6.1 `BrowserKillEvent`). */
export const GRACEFUL_KILL_MS = 5_000;
/** Temp profile prefix; `bua doctor --kill-zombies` sweeps this glob (SETUP-WIZARD.md §4.4). */
export const TEMP_PROFILE_PREFIX = 'bua-tmp-';

const HANDSHAKE_ATTEMPT_TIMEOUT_MS = 2_000;
const MAX_STDERR_CAPTURE_CHARS = 64 * 1024;
const MAX_HANDSHAKE_BODY_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/**
 * Chromium-family release channels covered by the discovery tables.
 * DATA-MODEL.md §5.2 spells the profile field as "chromium/chrome/…/msedge-canary"; ARCHITECTURE.md
 * §6.1 additionally requires Brave, so the Brave channels are part of this union.
 */
export type BrowserChannel =
	| 'chromium'
	| 'chrome'
	| 'chrome-beta'
	| 'chrome-dev'
	| 'chrome-canary'
	| 'msedge'
	| 'msedge-beta'
	| 'msedge-dev'
	| 'msedge-canary'
	| 'brave'
	| 'brave-beta'
	| 'brave-nightly';

/** Platform families the discovery tables are written for. */
export type TargetOs = 'windows' | 'darwin' | 'linux';

/** How a browser executable was resolved — `bua doctor` D2 grades WARN for `path`/non-Chrome hits. */
export type DiscoverySource = 'explicit' | 'env' | 'table' | 'path';

/** Result of a successful discovery pass. */
export type BrowserDiscovery = {
	readonly path: string;
	readonly channel: BrowserChannel | null;
	readonly source: DiscoverySource;
};

/**
 * Outcome of probing one candidate path.
 *
 * ERRATUM(SEAM-1): this used to be a file-local type. `permission-denied` and `missing` are the E-24
 * distinction — "I was not allowed to look" versus "I looked and it is not there" — and they have
 * opposite remediations. Keeping the union private meant every consumer had to recover it by
 * substring-matching {@linkcode describeProbe}'s prose out of {@linkcode BrowserNotFoundError.searched},
 * which two of them did (`packages/server/src/browser.ts`, `packages/cli/src/doctor/checks.ts`). That
 * wording is operator-facing and will be improved; control flow must not be pinned to it.
 */
export type ProbeResult = 'executable' | 'missing' | 'not-a-file' | 'permission-denied';

/**
 * One step of a discovery pass, in the order it ran — the structured twin of a
 * {@linkcode BrowserNotFoundError.searched} entry.
 *
 * `result: 'skipped'` means the step could not run **at all** (e.g. `PATH` was unreadable, so no
 * candidate was ever built). A skipped step is not evidence of absence, which is precisely the
 * inference E-24 exists to prevent.
 */
export type DiscoveryProbe = {
	/** The candidate probed. `null` for the aggregate `PATH` sweep, which covers many paths at once. */
	readonly path: string | null;
	readonly result: ProbeResult | 'skipped';
	/** Which discovery stage produced the candidate. */
	readonly source: DiscoverySource;
	/** Operator-facing rendering — byte-identical to this step's `searched` entry. Display only. */
	readonly detail: string;
};

/** Why discovery came back empty. The whole point of E-24 is that these are not the same thing. */
export type DiscoveryFailureKind = 'not-installed' | 'not-permitted';

/** {@linkcode classifyDiscoveryFailure}'s verdict plus the evidence it rests on. */
export interface DiscoveryFailure {
	readonly kind: DiscoveryFailureKind;
	/** Steps that hit `permission denied`. One is enough to refuse the "not installed" conclusion. */
	readonly denied: readonly DiscoveryProbe[];
	/** Steps that ran and found nothing — the only entries that are actual evidence of absence. */
	readonly missing: readonly DiscoveryProbe[];
	/** Steps that never ran. Not evidence of anything. */
	readonly skipped: readonly DiscoveryProbe[];
}

/** Filesystem roots the per-OS tables expand against. Injectable so the tables are unit-testable. */
export type DiscoveryRoots = {
	readonly programFiles?: string | undefined;
	readonly programFilesX86?: string | undefined;
	readonly localAppData?: string | undefined;
	readonly home?: string | undefined;
};

/** Options for {@linkcode launchBrowser}. */
export type LaunchOptions = {
	/**
	 * Profile directory. REQUIRED: ARCHITECTURE.md §6.1 makes "`--user-data-dir` is set" a normative
	 * assertion, so this primitive refuses to spawn without one rather than letting Chrome fall back
	 * to the user's real profile (which it would then lock).
	 */
	readonly userDataDir: string;
	/** Explicit executable; skips discovery entirely (SETUP-WIZARD.md §4.2 step 1). */
	readonly executablePath?: string | undefined;
	/** Channel hint for discovery when `executablePath` is absent. */
	readonly channel?: BrowserChannel | undefined;
	/** Caller-composed launch args (BrowserProfile owns composition at M1; DATA-MODEL.md §5.2). */
	readonly args?: readonly string[] | undefined;
	/** Default `true`. BrowserProfile owns the `null → headful iff a display exists` rule. */
	readonly headless?: boolean | undefined;
	/** Extra environment for the child process. */
	readonly env?: Record<string, string> | undefined;
	/** Drop the parent environment instead of inheriting it. */
	readonly clearEnv?: boolean | undefined;
	/** Positional start URL. `null` opens the browser's own start page. Default `about:blank`. */
	readonly initialUrl?: string | null | undefined;
	/** `true` drops every default arg; an array drops the named ones (DATA-MODEL.md §5.2). */
	readonly ignoreDefaultArgs?: boolean | readonly string[] | undefined;
	/** Debug host; loopback only in practice. Default `127.0.0.1`. */
	readonly host?: string | undefined;
	/** Fixed debug port. Omit for a random free ephemeral port (D-BROWSER1). */
	readonly debugPort?: number | undefined;
	/** Readiness cap, default {@linkcode READINESS_TIMEOUT_MS}. */
	readonly readinessTimeoutMs?: number | undefined;
	/** Readiness cadence, default {@linkcode READINESS_POLL_INTERVAL_MS}. */
	readonly readinessPollIntervalMs?: number | undefined;
	/** Attempts including the first, default {@linkcode MAX_LAUNCH_ATTEMPTS} (D-BROWSER1). */
	readonly maxAttempts?: number | undefined;
	/** Supplies a fresh profile dir for a profile-lock retry. Default: a `bua-tmp-*` temp dir. */
	readonly freshProfileDir?: (() => string | Promise<string>) | undefined;
	/** Parent directory for auto-created temp profiles (lets callers stay inside `--allow-write`). */
	readonly tempProfileRoot?: string | undefined;
	/** Extra handshake headers, merged over `User-Agent: bua/<version>` (ARCHITECTURE.md §7.4). */
	readonly headers?: Record<string, string> | undefined;
	/** Aborts the launch; a spawned child is torn down before the rejection propagates. */
	readonly signal?: AbortSignal | undefined;
};

/**
 * A running browser plus the teardown primitive M1's `BrowserKillEvent` handler needs.
 *
 * ARCHITECTURE.md §3 sketches the return as `{cdpUrl, child}`; the extra fields are additive.
 *
 * ERRATUM(M0-cdp-launch-ci-1): the teardown members exist because `packages/cdp/mod.ts` exports no
 * standalone kill helper and cross-package deep imports are forbidden (AGENTS.md §3), yet
 * ARCHITECTURE.md §6.1 requires `@tykotech/browser` to run SIGTERM → 5 s → SIGKILL + temp-dir cleanup.
 */
export type LaunchedBrowser = {
	/** HTTP CDP URL (`http://host:port`) — the input to `connect()` per ARCHITECTURE.md §7.4. */
	readonly cdpUrl: string;
	/** Browser-level WebSocket endpoint observed during the readiness handshake. */
	readonly webSocketDebuggerUrl: string;
	readonly child: Deno.ChildProcess;
	readonly executablePath: string;
	readonly userDataDir: string;
	readonly port: number;
	readonly args: readonly string[];
	/** SIGTERM → `gracefulMs` → SIGKILL, then temp-profile cleanup (ARCHITECTURE.md §6.1). */
	close(opts?: { readonly gracefulMs?: number }): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Thrown when no usable executable was found. The message is what `bua doctor` D2 shows a user. */
export class BrowserNotFoundError extends Error {
	readonly channel: BrowserChannel | null;
	/** Operator-facing search trail. **Display only** — classify from {@linkcode probes} instead. */
	readonly searched: readonly string[];
	/**
	 * ERRATUM(SEAM-1): the structured twin of {@linkcode searched}, in the same order. Consumers that
	 * need the E-24 not-installed/not-permitted distinction read this and pass it to
	 * {@linkcode classifyDiscoveryFailure}; nothing outside this module should parse `searched`.
	 *
	 * Empty only when the error was built through the legacy 3-argument constructor, which carries no
	 * structured trail. {@linkcode classifyDiscoveryFailure} treats "no probes" as *not-permitted*
	 * rather than inventing an absence claim from a search it has no record of.
	 */
	readonly probes: readonly DiscoveryProbe[];

	constructor(
		channel: BrowserChannel | null,
		searched: readonly string[],
		os: TargetOs,
		probes: readonly DiscoveryProbe[] = [],
	) {
		super(formatNotFoundMessage(channel, searched, os));
		this.name = 'BrowserNotFoundError';
		this.channel = channel;
		this.searched = searched;
		this.probes = probes;
	}

	/**
	 * Builds the error from the structured trail, deriving `searched` from it so the two cannot drift.
	 * This is how every throw site inside this module constructs it.
	 */
	static from(
		channel: BrowserChannel | null,
		probes: readonly DiscoveryProbe[],
		os: TargetOs,
	): BrowserNotFoundError {
		return new BrowserNotFoundError(channel, probes.map((probe) => probe.detail), os, probes);
	}
}

/** Thrown for a failed spawn, a failed readiness poll, or a failed `/json/version` handshake. */
export class BrowserLaunchError extends Error {
	readonly executablePath: string | null;
	readonly args: readonly string[];
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly attempts: number;

	constructor(message: string, detail: {
		readonly executablePath?: string | null;
		readonly args?: readonly string[];
		readonly exitCode?: number | null;
		readonly stderr?: string;
		readonly attempts?: number;
		readonly cause?: unknown;
	} = {}) {
		super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
		this.name = 'BrowserLaunchError';
		this.executablePath = detail.executablePath ?? null;
		this.args = detail.args ?? [];
		this.exitCode = detail.exitCode ?? null;
		this.stderr = detail.stderr ?? '';
		this.attempts = detail.attempts ?? 1;
	}
}

// ---------------------------------------------------------------------------
// discovery tables (SETUP-WIZARD.md §4.2)
// ---------------------------------------------------------------------------

/**
 * Scan order when no channel is given: Chrome → Chromium → Edge → Brave (SETUP-WIZARD.md §4.2).
 *
 * ERRATUM(M0-cdp-launch-ci-7): ARCHITECTURE.md §6.1 lists Chrome/Chromium/**Brave/Edge**; SETUP-WIZARD
 * §4.2 is the section that states an order as a contract, so it wins.
 */
export const DEFAULT_CHANNEL_ORDER: readonly BrowserChannel[] = [
	'chrome',
	'chromium',
	'msedge',
	'brave',
	'chrome-beta',
	'chrome-dev',
	'chrome-canary',
	'msedge-beta',
	'msedge-dev',
	'msedge-canary',
	'brave-beta',
	'brave-nightly',
];

const WINDOWS_RELATIVE: Record<BrowserChannel, string> = {
	chrome: 'Google\\Chrome\\Application\\chrome.exe',
	'chrome-beta': 'Google\\Chrome Beta\\Application\\chrome.exe',
	'chrome-dev': 'Google\\Chrome Dev\\Application\\chrome.exe',
	'chrome-canary': 'Google\\Chrome SxS\\Application\\chrome.exe',
	chromium: 'Chromium\\Application\\chrome.exe',
	msedge: 'Microsoft\\Edge\\Application\\msedge.exe',
	'msedge-beta': 'Microsoft\\Edge Beta\\Application\\msedge.exe',
	'msedge-dev': 'Microsoft\\Edge Dev\\Application\\msedge.exe',
	'msedge-canary': 'Microsoft\\Edge SxS\\Application\\msedge.exe',
	brave: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
	'brave-beta': 'BraveSoftware\\Brave-Browser-Beta\\Application\\brave.exe',
	'brave-nightly': 'BraveSoftware\\Brave-Browser-Nightly\\Application\\brave.exe',
};

const DARWIN_RELATIVE: Record<BrowserChannel, string> = {
	chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
	'chrome-beta': 'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
	'chrome-dev': 'Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
	'chrome-canary': 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
	chromium: 'Chromium.app/Contents/MacOS/Chromium',
	msedge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'msedge-beta': 'Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
	'msedge-dev': 'Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
	'msedge-canary': 'Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
	brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
	'brave-beta': 'Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
	'brave-nightly': 'Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
};

/** Absolute Linux candidates; `~` expands against {@linkcode DiscoveryRoots.home}. */
const LINUX_ABSOLUTE: Record<BrowserChannel, readonly string[]> = {
	chrome: [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/local/bin/google-chrome',
		'/opt/google/chrome/chrome',
		'/snap/bin/google-chrome',
		'/var/lib/flatpak/exports/bin/com.google.Chrome',
		'~/.local/share/flatpak/exports/bin/com.google.Chrome',
	],
	'chrome-beta': ['/usr/bin/google-chrome-beta', '/opt/google/chrome-beta/chrome'],
	'chrome-dev': ['/usr/bin/google-chrome-unstable', '/opt/google/chrome-unstable/chrome'],
	'chrome-canary': ['/usr/bin/google-chrome-canary'],
	chromium: [
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/local/bin/chromium',
		'/snap/bin/chromium',
		'/var/lib/flatpak/exports/bin/org.chromium.Chromium',
		'~/.local/share/flatpak/exports/bin/org.chromium.Chromium',
	],
	msedge: [
		'/usr/bin/microsoft-edge',
		'/usr/bin/microsoft-edge-stable',
		'/opt/microsoft/msedge/msedge',
	],
	'msedge-beta': ['/usr/bin/microsoft-edge-beta', '/opt/microsoft/msedge-beta/msedge'],
	'msedge-dev': ['/usr/bin/microsoft-edge-dev', '/opt/microsoft/msedge-dev/msedge'],
	'msedge-canary': ['/usr/bin/microsoft-edge-canary'],
	brave: [
		'/usr/bin/brave-browser',
		'/usr/bin/brave',
		'/usr/local/bin/brave-browser',
		'/opt/brave.com/brave/brave-browser',
		'/snap/bin/brave',
		'/var/lib/flatpak/exports/bin/com.brave.Browser',
		'~/.local/share/flatpak/exports/bin/com.brave.Browser',
	],
	'brave-beta': ['/usr/bin/brave-browser-beta', '/opt/brave.com/brave-beta/brave-browser-beta'],
	'brave-nightly': [
		'/usr/bin/brave-browser-nightly',
		'/opt/brave.com/brave-nightly/brave-browser-nightly',
	],
};

/** Bare command names probed against `PATH` (SETUP-WIZARD.md §4.2 step 4). */
const PATH_COMMANDS: Record<BrowserChannel, readonly string[]> = {
	chrome: ['google-chrome', 'google-chrome-stable', 'chrome'],
	'chrome-beta': ['google-chrome-beta'],
	'chrome-dev': ['google-chrome-unstable'],
	'chrome-canary': ['google-chrome-canary'],
	chromium: ['chromium', 'chromium-browser'],
	msedge: ['microsoft-edge', 'msedge'],
	'msedge-beta': ['microsoft-edge-beta'],
	'msedge-dev': ['microsoft-edge-dev'],
	'msedge-canary': ['microsoft-edge-canary'],
	brave: ['brave-browser', 'brave'],
	'brave-beta': ['brave-browser-beta'],
	'brave-nightly': ['brave-browser-nightly'],
};

function joinWindows(root: string, relative: string): string {
	return `${root.replace(/[\\/]+$/, '')}\\${relative}`;
}

function joinPosix(root: string, relative: string): string {
	return `${root.replace(/\/+$/, '')}/${relative}`;
}

/**
 * Expands the per-OS table for one channel. Pure and root-injected so every OS's table is testable
 * from any OS (the Windows user-local `%LOCALAPPDATA%` row in particular).
 */
export function candidatePathsFor(
	os: TargetOs,
	channel: BrowserChannel,
	roots: DiscoveryRoots,
): string[] {
	if (os === 'windows') {
		const relative = WINDOWS_RELATIVE[channel];
		// %ProgramFiles% → %ProgramFiles(x86)% → %LOCALAPPDATA% (SETUP-WIZARD.md §4.2). The
		// user-local root is not optional: Chrome's per-user installer is the default on Windows.
		return [roots.programFiles, roots.programFilesX86, roots.localAppData]
			.filter((root): root is string => typeof root === 'string' && root.length > 0)
			.map((root) => joinWindows(root, relative));
	}
	if (os === 'darwin') {
		const relative = DARWIN_RELATIVE[channel];
		const appRoots = ['/Applications'];
		if (roots.home !== undefined && roots.home.length > 0) {
			appRoots.push(joinPosix(roots.home, 'Applications'));
		}
		return appRoots.map((root) => joinPosix(root, relative));
	}
	return LINUX_ABSOLUTE[channel]
		.map((candidate) => {
			if (!candidate.startsWith('~/')) return candidate;
			if (roots.home === undefined || roots.home.length === 0) return null;
			return joinPosix(roots.home, candidate.slice(2));
		})
		.filter((candidate): candidate is string => candidate !== null);
}

// ---------------------------------------------------------------------------
// environment + filesystem probes (permission-tolerant by design)
// ---------------------------------------------------------------------------

/**
 * Reads an env var, treating a missing `--allow-env` grant as "unset".
 *
 * ERRATUM(M0-cdp-launch-ci-2): no `--allow-env` matrix in SECURITY-AUTH.md §3.3/§3.6 grants
 * `LOCALAPPDATA`/`PROGRAMFILES`/`PATH`, which SETUP-WIZARD.md §4.2's own Windows table needs, so
 * discovery MUST degrade rather than throw `NotCapable`.
 */
export function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name);
	} catch (error) {
		if (error instanceof Deno.errors.NotCapable) return undefined;
		throw error;
	}
}

/** Reads `BUA_<name>`, falling back to the `BROWSER_USE_<name>` compat alias (D-CFG1). */
function readBuaEnv(suffix: string): string | undefined {
	return readEnv(`BUA_${suffix}`) ?? readEnv(`BROWSER_USE_${suffix}`);
}

function currentOs(): TargetOs {
	if (Deno.build.os === 'windows') return 'windows';
	if (Deno.build.os === 'darwin') return 'darwin';
	return 'linux';
}

function discoveryRoots(os: TargetOs): DiscoveryRoots {
	const home = readEnv(os === 'windows' ? 'USERPROFILE' : 'HOME');
	if (os !== 'windows') return { home };
	return {
		programFiles: readEnv('PROGRAMFILES') ?? 'C:\\Program Files',
		programFilesX86: readEnv('PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)',
		localAppData: readEnv('LOCALAPPDATA') ?? (home === undefined ? undefined : joinWindows(home, 'AppData\\Local')),
		home,
	};
}

async function probeExecutable(path: string): Promise<ProbeResult> {
	let info: Deno.FileInfo;
	try {
		info = await Deno.stat(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotCapable) return 'permission-denied';
		if (error instanceof Deno.errors.NotFound) return 'missing';
		return 'missing';
	}
	if (!info.isFile) return 'not-a-file';
	// ERRATUM(E-24): the previous guard read `info.mode !== null && (info.mode & 0o111) === 0`, on the
	// stated assumption that "`mode` is null on Windows". That assumption is FALSE on Deno 2.9.5:
	// Windows reports a synthesized `mode` of 0o100666 — a real number with **no execute bits, ever**.
	// The POSIX test therefore rejected every `.exe`, so table-driven discovery could never succeed on
	// Windows and `bua doctor` reported "no browser installed" on machines with Chrome. Gate on the
	// platform, not on `mode === null`. Windows carries no execute bit to test; the extension and the
	// `--allow-run=<path>` grant are what gate the spawn there.
	if (Deno.build.os !== 'windows' && info.mode !== null && (info.mode & 0o111) === 0) return 'not-a-file';
	return 'executable';
}

function pathEntries(os: TargetOs): string[] {
	const raw = readEnv('PATH') ?? readEnv('Path');
	if (raw === undefined || raw.length === 0) return [];
	return raw.split(os === 'windows' ? ';' : ':').filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

function formatNotFoundMessage(
	channel: BrowserChannel | null,
	searched: readonly string[],
	os: TargetOs,
): string {
	const target = channel === null ? 'a Chrome/Chromium-family browser' : `channel '${channel}'`;
	const lines = [
		`No browser executable found for ${target} on ${os}.`,
		`Searched ${searched.length} location${searched.length === 1 ? '' : 's'}:`,
		...searched.map((entry) => `  - ${entry}`),
		'Fixes:',
		'  - install Chrome (https://www.google.com/chrome/) or Chromium, then re-run',
		'  - point BUA_BROWSER_PATH at an absolute executable path',
		'  - pass an explicit executablePath (BrowserProfile.executablePath)',
		'  - or attach to an already-running browser via cdpUrl — attach mode needs no --allow-run',
		'  - if entries above say "permission denied", widen --allow-read/--allow-env for the',
		'    discovery roots (SECURITY-AUTH.md §3.3)',
	];
	return lines.join('\n');
}

function describeProbe(path: string, result: ProbeResult): string {
	switch (result) {
		case 'missing':
			return `${path} (not found)`;
		case 'not-a-file':
			return `${path} (not an executable file)`;
		case 'permission-denied':
			return `${path} (permission denied — no --allow-read grant covers this path)`;
		case 'executable':
			return path;
	}
}

/**
 * Splits a failed discovery pass into "looked and found nothing" and "was not allowed to look".
 *
 * ERRATUM(SEAM-1): this classifier lives here because the package that owns the observation is the
 * only one that can classify it without guessing. It previously existed twice — in
 * `packages/server/src/browser.ts` and `packages/cli/src/doctor/checks.ts` — both reading
 * {@linkcode describeProbe}'s wording out of {@linkcode BrowserNotFoundError.searched}, and the two
 * copies had **already drifted apart** (ERRATUM(SEAM-2)): the CLI's lacked the third clause below, so
 * a discovery pass that probed nothing at all was reported to the user as "no browser is installed" —
 * E-24's exact collapse, in the check written to prevent it.
 *
 * Three ways to end up at `not-permitted`:
 *
 * 1. **A denial was observed.** One is enough. Absence cannot be concluded from a search that was
 *    refused partway through, so a single `permission-denied` vetoes the "not installed" verdict
 *    regardless of how many candidates probed clean.
 * 2. **Nothing was probed.** With no `--allow-env` the discovery roots (`PATH`/`HOME`/`PROGRAMFILES`)
 *    are unreadable, so no candidate is ever built and the trail carries only a `skipped` note.
 *    "Not installed" would be a claim about a search that never happened.
 * 3. **No structured trail at all** — the degenerate case of (2).
 *
 * The asymmetry is deliberate and is the safety property: this function will answer "not installed"
 * only from positive evidence of absence, and errs toward "check your permissions" otherwise. The
 * two mistakes are not symmetric — telling an operator to install a browser they already have sends
 * them somewhere with no fix in it.
 */
export function classifyDiscoveryFailure(probes: readonly DiscoveryProbe[]): DiscoveryFailure {
	const denied = probes.filter((probe) => probe.result === 'permission-denied');
	const missing = probes.filter((probe) => probe.result === 'missing');
	const skipped = probes.filter((probe) => probe.result === 'skipped');
	const kind: DiscoveryFailureKind = denied.length > 0 || missing.length === 0 ? 'not-permitted' : 'not-installed';
	return { kind, denied, missing, skipped };
}

/**
 * Full discovery pass, reporting how the executable was found. `bua doctor` D2 grades a `path` or
 * non-Chrome hit as WARN, which is why the source and channel are carried out of here.
 */
export async function discoverBrowserExecutable(opts: {
	readonly executablePath?: string | undefined;
	readonly channel?: BrowserChannel | undefined;
	readonly os?: TargetOs | undefined;
	readonly roots?: DiscoveryRoots | undefined;
} = {}): Promise<BrowserDiscovery> {
	const os = opts.os ?? currentOs();
	const roots = opts.roots ?? discoveryRoots(os);
	// ERRATUM(SEAM-1): the trail is accumulated structured and rendered to strings at the throw, so
	// `searched` is derived from `probes` rather than the two being written independently.
	const probes: DiscoveryProbe[] = [];

	// (1) explicit path wins — an explicitly-configured browser is never second-guessed. A
	// `permission-denied` stat is accepted: `--allow-run=<path>` is what actually gates the spawn.
	if (opts.executablePath !== undefined && opts.executablePath.length > 0) {
		const result = await probeExecutable(opts.executablePath);
		if (result === 'executable' || result === 'permission-denied') {
			return { path: opts.executablePath, channel: opts.channel ?? null, source: 'explicit' };
		}
		throw BrowserNotFoundError.from(opts.channel ?? null, [{
			path: opts.executablePath,
			result,
			source: 'explicit',
			detail: `${describeProbe(opts.executablePath, result)} [explicit executablePath]`,
		}], os);
	}

	// (2) BUA_BROWSER_PATH / BROWSER_USE_BROWSER_PATH (SETUP-WIZARD.md §4.2 step 2).
	const fromEnv = readBuaEnv('BROWSER_PATH');
	if (fromEnv !== undefined && fromEnv.length > 0) {
		const result = await probeExecutable(fromEnv);
		if (result === 'executable' || result === 'permission-denied') {
			return { path: fromEnv, channel: opts.channel ?? null, source: 'env' };
		}
		throw BrowserNotFoundError.from(opts.channel ?? null, [{
			path: fromEnv,
			result,
			source: 'env',
			detail: `${describeProbe(fromEnv, result)} [BUA_BROWSER_PATH]`,
		}], os);
	}

	// (3) per-OS candidate tables.
	const channels = opts.channel === undefined ? DEFAULT_CHANNEL_ORDER : [opts.channel];
	for (const channel of channels) {
		for (const candidate of candidatePathsFor(os, channel, roots)) {
			const result = await probeExecutable(candidate);
			if (result === 'executable') return { path: candidate, channel, source: 'table' };
			probes.push({ path: candidate, result, source: 'table', detail: describeProbe(candidate, result) });
		}
	}

	// (4) PATH lookup. One aggregate entry, because the sweep is one step over many paths.
	const entries = pathEntries(os);
	if (entries.length > 0) {
		for (const channel of channels) {
			for (const command of PATH_COMMANDS[channel]) {
				const fileName = os === 'windows' ? `${command}.exe` : command;
				for (const entry of entries) {
					const candidate = os === 'windows' ? joinWindows(entry, fileName) : joinPosix(entry, fileName);
					const result = await probeExecutable(candidate);
					if (result === 'executable') return { path: candidate, channel, source: 'path' };
				}
			}
		}
		probes.push({
			path: null,
			result: 'missing',
			source: 'path',
			detail: `PATH lookup of ${channels.flatMap((c) => PATH_COMMANDS[c]).join(', ')} (no match)`,
		});
	} else {
		// `PATH` itself was unreadable, so not one candidate was built. `skipped`, never `missing`.
		probes.push({
			path: null,
			result: 'skipped',
			source: 'path',
			detail: 'PATH lookup (skipped — PATH unreadable or empty)',
		});
	}

	throw BrowserNotFoundError.from(opts.channel ?? null, probes, os);
}

/**
 * Resolves an absolute browser executable path, honoring an explicit path, then `BUA_BROWSER_PATH`,
 * then the per-OS tables, then `PATH` (SETUP-WIZARD.md §4.2).
 *
 * @throws {BrowserNotFoundError} listing every location searched — that message is `bua doctor` D2's
 * output, so it names the fixes too.
 */
export async function findBrowserExecutable(channel?: BrowserChannel): Promise<string> {
	const found = await discoverBrowserExecutable({ channel });
	return found.path;
}

// ---------------------------------------------------------------------------
// `/json/version` handshake (ARCHITECTURE.md §7.4)
// ---------------------------------------------------------------------------

/**
 * ERRATUM(M0-cdp-launch-ci-5): loopback is spoken over a raw socket rather than `fetch`, because `HTTP_PROXY`/`ALL_PROXY`
 * in the environment would otherwise intercept the CDP handshake — ARCHITECTURE.md §7.4 requires
 * that proxy env MUST NOT intercept localhost, and `NO_PROXY` hygiene cannot be assumed on a user's
 * machine. Non-loopback CDP hosts keep `fetch` (a remote browser behind a proxy is legitimate).
 */
export function selectHandshakeTransport(url: URL): 'direct-loopback' | 'fetch' {
	if (url.protocol !== 'http:') return 'fetch';
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return 'direct-loopback';
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? 'direct-loopback' : 'fetch';
}

/** Normalizes a CDP base URL into its `/json/version` endpoint. */
export function jsonVersionUrl(httpCdpUrl: string): URL {
	let url: URL;
	try {
		url = new URL(httpCdpUrl);
	} catch (error) {
		throw new BrowserLaunchError(`Invalid CDP URL: ${httpCdpUrl}`, { cause: error });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new BrowserLaunchError(
			`CDP handshake needs an http(s) URL, got '${url.protocol}' in ${httpCdpUrl}. ` +
				'A ws(s) URL is already a debugger endpoint and needs no /json/version lookup.',
		);
	}
	if (url.pathname === '' || url.pathname === '/') {
		return new URL('/json/version', url);
	}
	return url;
}

/** Splits a raw HTTP/1.x response. Exported for unit tests of the loopback transport. */
export function parseHttpResponse(bytes: Uint8Array): { status: number; body: string } | null {
	const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	const split = text.indexOf('\r\n\r\n');
	if (split < 0) return null;
	const head = text.slice(0, split);
	const rest = text.slice(split + 4);
	const headLines = head.split('\r\n');
	const statusLine = headLines[0] ?? '';
	const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
	if (!Number.isFinite(status)) return null;

	let contentLength: number | null = null;
	let chunked = false;
	for (const line of headLines.slice(1)) {
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (name === 'content-length') contentLength = Number.parseInt(value, 10);
		if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
	}

	if (chunked) {
		const body = dechunk(rest);
		return body === null ? null : { status, body };
	}
	if (contentLength !== null && Number.isFinite(contentLength)) {
		if (rest.length < contentLength) return null;
		return { status, body: rest.slice(0, contentLength) };
	}
	return { status, body: rest };
}

function dechunk(raw: string): string | null {
	let offset = 0;
	let out = '';
	for (;;) {
		const eol = raw.indexOf('\r\n', offset);
		if (eol < 0) return null;
		const size = Number.parseInt(raw.slice(offset, eol).split(';')[0] ?? '', 16);
		if (!Number.isFinite(size)) return null;
		if (size === 0) return out;
		const start = eol + 2;
		if (raw.length < start + size + 2) return null;
		out += raw.slice(start, start + size);
		offset = start + size + 2;
	}
}

function handshakeHeaders(extra?: Record<string, string>): Record<string, string> {
	// ARCHITECTURE.md §7.4: custom profile headers plus `User-Agent: bua/<version>`.
	return { 'user-agent': `bua/${CDP_PACKAGE_VERSION}`, accept: 'application/json', ...extra };
}

async function getViaLoopbackSocket(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<string> {
	const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const conn = await Deno.connect({ hostname, port, transport: 'tcp' });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			conn.close();
		} catch {
			// already closed by the happy path
		}
	}, timeoutMs);
	try {
		const requestLines = [
			`GET ${url.pathname}${url.search} HTTP/1.1`,
			`Host: ${url.host}`,
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			'Connection: close',
			'',
			'',
		];
		await conn.write(new TextEncoder().encode(requestLines.join('\r\n')));

		const buffer = new Uint8Array(64 * 1024);
		const collected: number[] = [];
		for (;;) {
			const read = await conn.read(buffer);
			if (read === null) break;
			for (let i = 0; i < read; i++) collected.push(buffer[i] as number);
			if (collected.length > MAX_HANDSHAKE_BODY_BYTES) {
				throw new BrowserLaunchError(`CDP handshake response exceeded ${MAX_HANDSHAKE_BODY_BYTES} bytes`);
			}
			const parsed = parseHttpResponse(new Uint8Array(collected));
			if (parsed !== null) {
				if (parsed.status !== 200) {
					throw new BrowserLaunchError(`CDP handshake returned HTTP ${parsed.status} for ${url}`);
				}
				return parsed.body;
			}
		}
		const parsed = parseHttpResponse(new Uint8Array(collected));
		if (parsed === null) throw new BrowserLaunchError(`CDP handshake returned a truncated response from ${url}`);
		if (parsed.status !== 200) {
			throw new BrowserLaunchError(`CDP handshake returned HTTP ${parsed.status} for ${url}`);
		}
		return parsed.body;
	} catch (error) {
		if (timedOut) throw new BrowserLaunchError(`CDP handshake timed out after ${timeoutMs}ms for ${url}`);
		throw error;
	} finally {
		clearTimeout(timer);
		try {
			conn.close();
		} catch {
			// closed by the timeout path
		}
	}
}

async function getViaFetch(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
		if (!response.ok) {
			await response.body?.cancel();
			throw new BrowserLaunchError(`CDP handshake returned HTTP ${response.status} for ${url}`);
		}
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

/** Shape of the `/json/version` document that this layer depends on. */
export type JsonVersionDocument = {
	readonly webSocketDebuggerUrl: string;
	readonly Browser?: string;
	readonly 'Protocol-Version'?: string;
	readonly 'User-Agent'?: string;
};

async function getJsonVersion(
	httpCdpUrl: string,
	opts: { headers?: Record<string, string> | undefined; timeoutMs: number },
): Promise<JsonVersionDocument> {
	const url = jsonVersionUrl(httpCdpUrl);
	const headers = handshakeHeaders(opts.headers);
	let body: string;
	try {
		body = selectHandshakeTransport(url) === 'direct-loopback'
			? await getViaLoopbackSocket(url, headers, opts.timeoutMs)
			: await getViaFetch(url, headers, opts.timeoutMs);
	} catch (error) {
		// Transport failures (refused, reset, aborted) become typed errors: nothing in @tykotech/cdp's
		// public surface may leak a bare runtime error (AGENTS.md §3 "Errors").
		if (error instanceof BrowserLaunchError) throw error;
		throw new BrowserLaunchError(
			`CDP handshake to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new BrowserLaunchError(`CDP handshake returned non-JSON from ${url}`, { cause: error });
	}
	if (typeof parsed !== 'object' || parsed === null) {
		throw new BrowserLaunchError(`CDP handshake returned a non-object document from ${url}`);
	}
	const record = parsed as Record<string, unknown>;
	const wsUrl = record.webSocketDebuggerUrl;
	if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
		throw new BrowserLaunchError(`CDP handshake document from ${url} has no webSocketDebuggerUrl`);
	}
	return { ...record, webSocketDebuggerUrl: wsUrl } as JsonVersionDocument;
}

/**
 * GETs `/json/version` and returns `webSocketDebuggerUrl` (ARCHITECTURE.md §7.4).
 *
 * Capped at 30 s. Sends `User-Agent: bua/<version>` plus any caller headers. Loopback hosts bypass
 * `fetch` so environment proxies cannot intercept the handshake.
 */
export async function fetchWebSocketDebuggerUrl(
	httpCdpUrl: string,
	headers?: Record<string, string>,
): Promise<string> {
	const document = await getJsonVersion(httpCdpUrl, { headers, timeoutMs: READINESS_TIMEOUT_MS });
	return document.webSocketDebuggerUrl;
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/**
 * Args added unless `ignoreDefaultArgs` drops them. Deliberately small: BrowserProfile (M1) owns
 * real arg composition (DATA-MODEL.md §5.2); these only suppress first-run UI and the background
 * network chatter that would otherwise violate the Q7 "no unsolicited network traffic" gate.
 */
export const DEFAULT_LAUNCH_ARGS: readonly string[] = [
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-search-engine-choice-screen',
	'--disable-background-networking',
	'--disable-component-update',
	'--metrics-recording-only',
	'--no-service-autorun',
	'--password-store=basic',
	'--use-mock-keychain',
];

function argName(arg: string): string {
	const eq = arg.indexOf('=');
	return eq < 0 ? arg : arg.slice(0, eq);
}

/** Composes the final argv. Mandatory args are appended last so a caller cannot shadow them. */
export function composeLaunchArgs(opts: {
	readonly userDataDir: string;
	readonly port: number;
	readonly headless?: boolean | undefined;
	readonly args?: readonly string[] | undefined;
	readonly ignoreDefaultArgs?: boolean | readonly string[] | undefined;
	readonly initialUrl?: string | null | undefined;
}): string[] {
	const callerArgs = [...(opts.args ?? [])];
	for (const arg of callerArgs) {
		if (!arg.startsWith('--')) {
			throw new BrowserLaunchError(`Launch arg must start with '--': ${arg}`);
		}
		if (argName(arg) === '--remote-debugging-port') {
			throw new BrowserLaunchError(
				'--remote-debugging-port is owned by launchBrowser (it picks a free ephemeral port); ' +
					'pass LaunchOptions.debugPort instead',
			);
		}
		// ERRATUM(TIER-2): compare the two **resolved** paths, not the two spellings. One directory
		// reaches this guard by two routes — `LaunchOptions.userDataDir`, which `launchBrowser` has
		// already put through `absolutize()`, and the caller-composed `--user-data-dir=` arg, which
		// `@tykotech/browser`'s `resolveBrowserProfile` writes verbatim from `BrowserProfile.userDataDir` and
		// nobody absolutizes. A raw `!==` therefore rejected a *relative* profile directory as being in
		// conflict with itself, and a client can reach that through `CreateSessionRequest.profile`,
		// where a relative path is exactly what a config file contains. Same directory in two spellings
		// is not a conflict; a genuinely different directory still is.
		if (argName(arg) === '--user-data-dir') {
			const fromArgs = arg.slice('--user-data-dir='.length);
			if (absolutize(fromArgs) !== absolutize(opts.userDataDir)) {
				throw new BrowserLaunchError(
					`Conflicting --user-data-dir: args say '${fromArgs}', ` +
						`LaunchOptions.userDataDir says '${opts.userDataDir}'`,
				);
			}
		}
	}

	const dropped = new Set<string>(
		opts.ignoreDefaultArgs === true
			? DEFAULT_LAUNCH_ARGS.map(argName)
			: Array.isArray(opts.ignoreDefaultArgs)
			? opts.ignoreDefaultArgs.map(argName)
			: [],
	);
	for (const arg of callerArgs) dropped.add(argName(arg));

	const composed = DEFAULT_LAUNCH_ARGS.filter((arg) => !dropped.has(argName(arg)));
	for (const arg of callerArgs) {
		if (argName(arg) !== '--user-data-dir') composed.push(arg);
	}
	if (opts.headless !== false) composed.push('--headless=new');
	composed.push(`--remote-debugging-port=${opts.port}`);
	composed.push(`--user-data-dir=${opts.userDataDir}`);
	// `about:blank` by default: it guarantees ≥1 page target without the new-tab page's network
	// chatter (privacy gate Q7). `null` opts out and lets the browser open its own start page.
	const initialUrl = opts.initialUrl === undefined ? 'about:blank' : opts.initialUrl;
	if (initialUrl !== null) composed.push(initialUrl);
	return composed;
}

/**
 * Binds an ephemeral port, learns its number, and releases it (D-BROWSER1 "random free debug port").
 *
 * Inherently TOCTOU: another process may claim the port between release and Chrome's bind. That is
 * why {@linkcode launchBrowser} treats a devtools bind failure as a retryable launch attempt.
 */
export function pickFreePort(hostname = '127.0.0.1'): number {
	const listener = Deno.listen({ hostname, port: 0, transport: 'tcp' });
	try {
		return (listener.addr as Deno.NetAddr).port;
	} finally {
		listener.close();
	}
}

type LaunchFailureKind = 'profile-lock' | 'port-conflict' | 'other';

/**
 * Chromium's `RESULT_CODE_PROFILE_IN_USE`. Measured on Windows 10 / Chrome 141: a second instance on
 * a locked `--user-data-dir` exits **21 with empty stderr**, so the exit code — not the log text —
 * is the load-bearing signal there. POSIX builds additionally log a ProcessSingleton line.
 */
export const CHROME_EXIT_PROFILE_IN_USE = 21;

/**
 * Classifies a failed attempt (D-BROWSER1 SingletonLock retry).
 *
 * ERRATUM(M0-cdp-launch-ci-4): Windows Chrome emits no SingletonLock text at all, so the exit code is
 * the only usable signal there.
 *
 * `exitCode` MUST be the code of a *self-inflicted* exit — i.e. the browser died on its own before
 * the handshake — and `null` when the browser was still alive and we killed it. That distinction is
 * what makes exit 0 meaningful: a healthy browser never exits before serving `/json/version`, and
 * Chromium's ProcessSingleton hands the command line to the instance that already owns the profile
 * and then exits *successfully*. Measured on Windows 10 / Chrome 141: the same lock yields 21 when
 * the holder is still starting up and 0 once it is fully up.
 */
export function classifyLaunchFailure(stderr: string, exitCode?: number | null): LaunchFailureKind {
	if (exitCode === CHROME_EXIT_PROFILE_IN_USE || exitCode === 0) return 'profile-lock';
	const text = stderr.toLowerCase();
	if (
		text.includes('singletonlock') ||
		text.includes('processsingleton') ||
		text.includes('profile appears to be in use') ||
		text.includes('the profile appears to be in use by another') ||
		text.includes('failed to create a processsingleton')
	) {
		return 'profile-lock';
	}
	if (
		text.includes('cannot start http server for devtools') ||
		text.includes('address already in use') ||
		text.includes('bind() returned an error')
	) {
		return 'port-conflict';
	}
	return 'other';
}

type StderrTap = { text(): string; stop(): Promise<void> };

function tapStderr(stream: ReadableStream<Uint8Array>): StderrTap {
	const chunks: string[] = [];
	let size = 0;
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	const pump = (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value !== undefined && size < MAX_STDERR_CAPTURE_CHARS) {
					chunks.push(value);
					size += value.length;
				}
			}
		} catch {
			// the pipe dies with the child; whatever we captured is what we report
		}
	})();
	return {
		text: () => chunks.join(''),
		stop: async () => {
			try {
				await reader.cancel();
			} catch {
				// already closed
			}
			await pump;
		},
	};
}

async function killChild(child: Deno.ChildProcess, gracefulMs: number): Promise<void> {
	const controller = new AbortController();
	let exited = false;
	try {
		try {
			// Windows note (ROADMAP.md R8): Deno maps SIGTERM to TerminateProcess, so the graceful
			// window is a no-op there and no process *tree* is reaped. M1 should prefer CDP
			// `Browser.close()` and fall back to this.
			child.kill('SIGTERM');
		} catch {
			// already exited
		}
		exited = await Promise.race([
			child.status.then(() => true),
			delay(gracefulMs, { signal: controller.signal }).then(() => false).catch(() => false),
		]);
	} finally {
		controller.abort();
	}
	if (!exited) {
		try {
			child.kill('SIGKILL');
		} catch {
			// exited between the race and here
		}
	}
	await child.status;
}

async function removeProfileDir(dir: string): Promise<void> {
	// Windows keeps profile handles open briefly after the browser exits; retry before giving up.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await Deno.remove(dir, { recursive: true });
			return;
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			if (attempt === 2) return; // doctor D8 sweeps stale bua-tmp-* dirs (SETUP-WIZARD.md §4.4)
			await delay(200);
		}
	}
}

async function makeTempProfileDir(root?: string): Promise<string> {
	const options: Deno.MakeTempOptions = root === undefined
		? { prefix: TEMP_PROFILE_PREFIX }
		: { prefix: TEMP_PROFILE_PREFIX, dir: root };
	return await Deno.makeTempDir(options);
}

function absolutize(path: string): string {
	if (isAbsolute(path)) return path;
	try {
		return resolve(path);
	} catch {
		// resolve() needs cwd access; an un-resolvable relative path is still usable by the child
		return path;
	}
}

async function waitForReadiness(
	cdpUrl: string,
	opts: {
		readonly child: Deno.ChildProcess;
		readonly exited: () => Deno.CommandStatus | null;
		readonly timeoutMs: number;
		readonly pollMs: number;
		readonly headers?: Record<string, string> | undefined;
		readonly signal?: AbortSignal | undefined;
	},
): Promise<JsonVersionDocument> {
	const deadline = Date.now() + opts.timeoutMs;
	let lastError: unknown = null;
	for (;;) {
		opts.signal?.throwIfAborted();
		const status = opts.exited();
		if (status !== null) {
			throw new BrowserLaunchError(
				`Browser exited with code ${status.code} before the /json/version handshake succeeded`,
				{ exitCode: status.code },
			);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			return await getJsonVersion(cdpUrl, {
				headers: opts.headers,
				timeoutMs: Math.min(HANDSHAKE_ATTEMPT_TIMEOUT_MS, remaining),
			});
		} catch (error) {
			lastError = error;
		}
		const left = deadline - Date.now();
		if (left <= 0) break;
		await delay(Math.min(opts.pollMs, left), opts.signal === undefined ? undefined : { signal: opts.signal });
	}
	throw new BrowserLaunchError(
		`Browser did not answer ${cdpUrl}/json/version within ${opts.timeoutMs}ms ` +
			`(polled every ${opts.pollMs}ms)`,
		{ cause: lastError },
	);
}

/**
 * Spawns a browser via `Deno.Command` and resolves once `/json/version` answers (D-BROWSER1).
 *
 * Guarantees, in order:
 * 1. `--user-data-dir` is asserted before anything is spawned — a caller that omits it gets a
 *    `BrowserLaunchError`, never a silent lock of the user's real Chrome profile.
 * 2. A random free ephemeral debug port is bound-and-released to learn its number.
 * 3. Launch args are composed (defaults + caller args + mandatory args).
 * 4. `/json/version` is polled at a 100 ms cadence with a 30 s cap.
 * 5. A profile-lock (or devtools bind) failure retries up to `maxAttempts` times, each retry on a
 *    fresh temp profile dir which is removed on `close()`.
 *
 * Permissions: `--allow-run=<resolved executable>` (never bare — SECURITY-AUTH.md §3.2),
 * `--allow-net=127.0.0.1` for the port pick and handshake, `--allow-write` for the profile dir.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
	// (1) normative guard — runs before discovery, spawn, or any permission-touching call.
	const requestedDir = opts.userDataDir;
	if (typeof requestedDir !== 'string' || requestedDir.trim().length === 0) {
		throw new BrowserLaunchError(
			'launchBrowser requires userDataDir: --user-data-dir MUST always be set (ARCHITECTURE.md ' +
				'§6.1, D-BROWSER1). Launching without one lets the browser lock the user profile.',
		);
	}

	const executablePath = opts.executablePath ??
		(await discoverBrowserExecutable({ channel: opts.channel })).path;
	const host = opts.host ?? '127.0.0.1';
	const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_LAUNCH_ATTEMPTS);
	const readinessTimeoutMs = opts.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
	const pollMs = opts.readinessPollIntervalMs ?? READINESS_POLL_INTERVAL_MS;

	let userDataDir = absolutize(requestedDir);
	const ownedProfileDirs: string[] = [];
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		opts.signal?.throwIfAborted();
		const port = opts.debugPort ?? pickFreePort(host);
		const args = composeLaunchArgs({
			userDataDir,
			port,
			headless: opts.headless,
			args: opts.args,
			ignoreDefaultArgs: opts.ignoreDefaultArgs,
			initialUrl: opts.initialUrl,
		});

		let child: Deno.ChildProcess;
		try {
			child = new Deno.Command(executablePath, {
				args,
				env: opts.env,
				clearEnv: opts.clearEnv ?? false,
				stdin: 'null',
				stdout: 'null',
				stderr: 'piped',
			}).spawn();
		} catch (error) {
			throw new BrowserLaunchError(
				`Failed to spawn ${executablePath}: ${error instanceof Error ? error.message : String(error)}. ` +
					'If this is a NotCapable error, the process needs --allow-run=<that exact path> ' +
					'(SECURITY-AUTH.md §3.2 — never a bare --allow-run).',
				{ executablePath, args, cause: error, attempts: attempt },
			);
		}

		const tap = tapStderr(child.stderr);
		let exitStatus: Deno.CommandStatus | null = null;
		const selfExit = (): Deno.CommandStatus | null => exitStatus;
		child.status.then((status) => {
			exitStatus = status;
		}).catch(() => {
			exitStatus = { success: false, code: -1, signal: null };
		});

		const cdpUrl = `http://${host}:${port}`;
		try {
			const document = await waitForReadiness(cdpUrl, {
				child,
				exited: selfExit,
				timeoutMs: readinessTimeoutMs,
				pollMs,
				headers: opts.headers,
				signal: opts.signal,
			});
			const launched: LaunchedBrowser = {
				cdpUrl,
				webSocketDebuggerUrl: document.webSocketDebuggerUrl,
				child,
				executablePath,
				userDataDir,
				port,
				args,
				close: async (closeOpts) => {
					await killChild(child, closeOpts?.gracefulMs ?? GRACEFUL_KILL_MS);
					await tap.stop();
					for (const dir of ownedProfileDirs) await removeProfileDir(dir);
				},
				[Symbol.asyncDispose]: async () => {
					await launched.close();
				},
			};
			return launched;
		} catch (error) {
			lastError = error;
			// Read the exit status BEFORE killing: `null` here means the browser was still alive and
			// simply never became ready, which is not a profile lock.
			const died = selfExit();
			await killChild(child, GRACEFUL_KILL_MS);
			await tap.stop();
			const stderr = tap.text();
			const kind = classifyLaunchFailure(stderr, died?.code ?? null);
			const retryable = kind !== 'other' && attempt < maxAttempts;
			if (!retryable) {
				for (const dir of ownedProfileDirs) await removeProfileDir(dir);
				throw new BrowserLaunchError(
					`Browser launch failed after ${attempt} attempt${attempt === 1 ? '' : 's'} ` +
						`(${kind}, exit ${died === null ? 'none' : died.code}): ` +
						`${error instanceof Error ? error.message : String(error)}`,
					{ executablePath, args, stderr, exitCode: died?.code ?? null, attempts: attempt, cause: error },
				);
			}
			if (kind === 'profile-lock') {
				// D-BROWSER1: retry on a fresh temp profile dir rather than fighting the SingletonLock.
				const fresh = opts.freshProfileDir === undefined
					? await makeTempProfileDir(opts.tempProfileRoot)
					: await opts.freshProfileDir();
				ownedProfileDirs.push(fresh);
				userDataDir = absolutize(fresh);
			}
		}
	}

	for (const dir of ownedProfileDirs) await removeProfileDir(dir);
	throw new BrowserLaunchError(
		`Browser launch failed after ${maxAttempts} attempts: ` +
			`${lastError instanceof Error ? lastError.message : String(lastError)}`,
		{ executablePath, attempts: maxAttempts, cause: lastError },
	);
}
