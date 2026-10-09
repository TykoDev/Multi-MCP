/**
 * @module
 * `BrowserProfile` behaviour: launch-arg composition and dedup, viewport/display resolution, and
 * downloads/profile directory resolution.
 *
 * Contract owners: SPECS/DATA-MODEL.md §5.2 (the field surface — the *type* lives in
 * `packages/core/src/types.ts`; this file owns the behaviour), SPECS/ARCHITECTURE.md §6.1
 * (LocalBrowserWatchdog: "composes launch args from the profile … asserts `--user-data-dir` is
 * set"), SPECS/ROADMAP.md R8 (no portable display-size API in Deno ⇒ headless defaults to
 * 1920×1080), SPECS/SECURITY-AUTH.md §3.2 (`--allow-run` scoping stays in `@tykotech/cdp`).
 *
 * Division of labour with `@tykotech/cdp` (frozen at M0, not re-implemented here):
 * - `@tykotech/cdp` owns per-OS executable discovery, the free debug port, `--remote-debugging-port`,
 *   its own small privacy/first-run default arg set, `--headless=new`, and the final `argv` order.
 * - This module owns everything derived from the *profile*: which args exist, what they contain,
 *   and which directory each path-bearing arg points at. {@linkcode toLaunchPlan} hands the result
 *   over in exactly the shape `launchBrowser` accepts.
 *
 * Everything here is pure: no filesystem access, no ambient `Deno.env` read (the environment is
 * injected), no process spawning. The watchdog creates directories and spawns; this module decides.
 */

import type { BrowserChannel } from '@tykotech/cdp';
import type { ProxySettings, ViewportSize, WindowPosition } from '../types.ts';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type TargetOs = 'windows' | 'darwin' | 'linux';

/**
 * The `BrowserProfile` subset this module's behaviour reads (DATA-MODEL.md §5.2). Declared
 * structurally rather than as `Pick<BrowserProfile, …>` so callers can resolve a partial profile in
 * a test without constructing all sixty fields; `BrowserProfile` from `../types.ts` is assignable to
 * it, and `profile_test.ts` pins that at compile time so the two cannot drift.
 */
export type BrowserProfileLaunchInput = {
	readonly executablePath?: string | null | undefined;
	readonly channel?: BrowserChannel | null | undefined;
	readonly headless?: boolean | null | undefined;
	readonly args?: readonly string[] | undefined;
	readonly ignoreDefaultArgs?: boolean | readonly string[] | undefined;
	readonly env?: Readonly<Record<string, string>> | null | undefined;
	readonly chromiumSandbox?: boolean | undefined;
	readonly devtools?: boolean | undefined;
	readonly downloadsPath?: string | null | undefined;
	readonly userDataDir?: string | null | undefined;
	readonly profileDirectory?: string | undefined;
	readonly enableDefaultExtensions?: boolean | undefined;
	readonly windowSize?: ViewportSize | null | undefined;
	readonly windowPosition?: WindowPosition | null | undefined;
	readonly viewport?: ViewportSize | null | undefined;
	readonly screen?: ViewportSize | null | undefined;
	readonly noViewport?: boolean | null | undefined;
	readonly deviceScaleFactor?: number | null | undefined;
	readonly userAgent?: string | null | undefined;
	readonly disableSecurity?: boolean | undefined;
	readonly crossOriginIframes?: boolean | undefined;
	readonly proxy?: ProxySettings | null | undefined;
	readonly deterministicRendering?: boolean | undefined;
};

export type ProfileResolutionOptions = {
	/** Defaults to the running platform. Injected so the display heuristic is testable everywhere. */
	readonly os?: TargetOs | undefined;
	/**
	 * Environment slice for display detection. Injected rather than read from `Deno.env`: reading it
	 * would need an `--allow-env` grant this module has no business requiring (SECURITY-AUTH.md §3).
	 * An empty environment therefore reads as "no display" on Linux.
	 */
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
	/** Used when `profile.userDataDir` is null; the caller mints it (`@tykotech/cdp` owns `bua-tmp-*`). */
	readonly tempProfileDir?: string | null | undefined;
	/** Used when `profile.downloadsPath` is null, before falling back inside the profile dir. */
	readonly defaultDownloadsDir?: string | null | undefined;
	/** Unpacked extension directories to load. Empty until extension provisioning ships. */
	readonly extensionDirs?: readonly string[] | undefined;
	/** Non-fatal resolution notes; omit for silence. Warnings are also returned on the result. */
	readonly onWarn?: ((message: string) => void) | null | undefined;
};

/** What the session and the watchdogs consume. */
export type ResolvedBrowserProfile = {
	readonly headless: boolean;
	readonly userDataDir: string;
	readonly profileDirectory: string;
	readonly downloadsPath: string;
	/** `true` ⇒ the real browser window is the viewport and `viewport` is `null` (§5.2 invariant). */
	readonly noViewport: boolean;
	readonly viewport: ViewportSize | null;
	readonly screen: ViewportSize;
	readonly windowSize: ViewportSize | null;
	readonly windowPosition: WindowPosition | null;
	/** `null` in no-viewport mode; otherwise ≥ 1 (§5.2 invariant). */
	readonly deviceScaleFactor: number | null;
	/** Composed, `ignoreDefaultArgs`-filtered and deduped. Always contains `--user-data-dir`. */
	readonly args: readonly string[];
	readonly warnings: readonly string[];
};

/** Structurally the `LaunchOptions` subset of `@tykotech/cdp`'s `launchBrowser` that a profile decides. */
export type BrowserLaunchPlan = {
	readonly userDataDir: string;
	readonly executablePath: string | undefined;
	readonly channel: BrowserChannel | undefined;
	readonly headless: boolean;
	readonly args: readonly string[];
	readonly env: Record<string, string> | undefined;
	readonly ignoreDefaultArgs: boolean | readonly string[] | undefined;
};

/** Configuration errors that make a launch impossible. Never a string throw (AGENTS.md §3). */
export class BrowserProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserProfileError';
	}
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/**
 * ROADMAP.md R8: Deno exposes no portable display-size API, so headless mode gets a fixed, honest
 * default instead of a guess. Headful runs without an explicit `windowSize` inherit it as the
 * *screen* figure but do not force a window size on the user's desktop.
 */
export const DEFAULT_SCREEN: ViewportSize = { width: 1920, height: 1080 };

export const DEFAULT_PROFILE_DIRECTORY = 'Default';

/** Downloads land here when neither the profile nor the caller names a directory. */
export const DEFAULT_DOWNLOADS_DIRNAME = 'bua-downloads';

/** Args this module always emits; `ignoreDefaultArgs` cannot drop them (ARCHITECTURE.md §6.1). */
export const MANDATORY_ARG_NAMES: readonly string[] = ['--user-data-dir'];

/** Owned by `launchBrowser` (it picks the free port) — a profile that sets it is a config error. */
const CDP_OWNED_ARG_NAMES: readonly string[] = ['--remote-debugging-port', '--remote-debugging-pipe'];

/** The `disableSecurity` / `crossOriginIframes: false` feature switches (DATA-MODEL.md §5.2). */
const SITE_ISOLATION_FEATURES: readonly string[] = ['IsolateOrigins', 'site-per-process'];

// ---------------------------------------------------------------------------
// arg primitives
// ---------------------------------------------------------------------------

/** `--flag=value` ⇒ `--flag`; a valueless flag is its own key. */
export function argKey(arg: string): string {
	const equals = arg.indexOf('=');
	return equals < 0 ? arg : arg.slice(0, equals);
}

/**
 * Deterministic dedup with a single precedence rule:
 *
 * > **A later occurrence of a switch wins its value; the switch keeps the position of its first
 * > occurrence.**
 *
 * Value-from-the-last means an explicit `profile.args` entry beats the default composed earlier —
 * which is the whole point of `args` existing. Position-from-the-first means the composed argv is
 * stable under override, so a diff of two launches shows the value that changed and nothing else.
 *
 * Note for comma-list switches (`--disable-features`, `--enable-features`): Chrome itself honours
 * only the last occurrence, so this module composes each of them once, from a set, rather than
 * emitting several and hoping. An override in `profile.args` therefore *replaces* the composed list
 * — pass the full list you want.
 */
export function dedupeArgs(args: readonly string[]): string[] {
	const result: string[] = [];
	const positions = new Map<string, number>();
	for (const arg of args) {
		const key = argKey(arg);
		const at = positions.get(key);
		if (at === undefined) {
			positions.set(key, result.length);
			result.push(arg);
			continue;
		}
		result[at] = arg;
	}
	return result;
}

/** ARCHITECTURE.md §6.1: the launch args MUST carry a profile directory. */
export function assertUserDataDirPresent(args: readonly string[]): void {
	for (const arg of args) {
		if (argKey(arg) === '--user-data-dir') return;
	}
	throw new BrowserProfileError(
		'composed launch args carry no --user-data-dir; refusing to let Chrome fall back to (and lock) the real user profile',
	);
}

// ---------------------------------------------------------------------------
// display resolution
// ---------------------------------------------------------------------------

/**
 * DATA-MODEL.md §5.2 `headless: null (auto)` — "headful iff a display exists". Deno cannot ask the
 * OS for a display (R8), so: Linux is judged by `DISPLAY`/`WAYLAND_DISPLAY`, and Windows/macOS are
 * assumed to have one. With no environment injected, Linux reads as headless — the safe answer for
 * a container or CI runner.
 */
export function hasDisplay(os: TargetOs, env: Readonly<Record<string, string | undefined>>): boolean {
	if (os !== 'linux') return true;
	const x11 = env['DISPLAY'] ?? '';
	const wayland = env['WAYLAND_DISPLAY'] ?? '';
	return x11 !== '' || wayland !== '';
}

type DisplayResolution = {
	readonly noViewport: boolean;
	readonly viewport: ViewportSize | null;
	readonly screen: ViewportSize;
	readonly windowSize: ViewportSize | null;
	readonly windowPosition: WindowPosition | null;
	readonly deviceScaleFactor: number | null;
};

/**
 * Resolves the three §5.2 display invariants:
 * `noViewport ⇒ viewport === null`; viewport mode ⇒ `deviceScaleFactor ≥ 1`; never
 * (headless ∧ noViewport).
 *
 * A conflicting explicit `noViewport: true` is coerced rather than fatal: `headless` may itself have
 * been auto-resolved from the environment, and a config that throws only on machines without a
 * display is a worse failure mode than one that says what it did.
 */
function resolveDisplay(
	profile: BrowserProfileLaunchInput,
	headless: boolean,
	warn: (message: string) => void,
): DisplayResolution {
	const screen = profile.screen ?? profile.windowSize ?? DEFAULT_SCREEN;
	const requestedScale = profile.deviceScaleFactor ?? null;
	const forcedViewport = headless || profile.viewport != null || requestedScale !== null;
	const requestedNoViewport = profile.noViewport ?? !forcedViewport;
	const noViewport = requestedNoViewport && !forcedViewport;
	if (profile.noViewport === true && forcedViewport) {
		warn(
			'noViewport: true was overridden — headless mode, an explicit viewport, or a deviceScaleFactor forces viewport mode (DATA-MODEL.md §5.2)',
		);
	}
	if (requestedScale !== null && requestedScale < 1) {
		throw new BrowserProfileError(
			`deviceScaleFactor must be >= 1 in viewport mode, got ${requestedScale} (DATA-MODEL.md §5.2)`,
		);
	}
	const windowSize = profile.windowSize ?? (headless ? screen : null);
	const windowPosition = profile.windowPosition ?? (windowSize === null ? null : { x: 0, y: 0 });
	return {
		noViewport,
		viewport: noViewport ? null : profile.viewport ?? screen,
		screen,
		windowSize,
		windowPosition,
		deviceScaleFactor: noViewport ? null : requestedScale ?? 1,
	};
}

// ---------------------------------------------------------------------------
// directory resolution
// ---------------------------------------------------------------------------

function joinPath(base: string, child: string): string {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const trimmed = base.endsWith('/') || base.endsWith('\\') ? base.slice(0, -1) : base;
	return `${trimmed}${separator}${child}`;
}

function resolveUserDataDir(profile: BrowserProfileLaunchInput, options: ProfileResolutionOptions): string {
	const configured = profile.userDataDir ?? options.tempProfileDir ?? null;
	if (configured === null || configured === '') {
		throw new BrowserProfileError(
			'no userDataDir: set BrowserProfile.userDataDir or pass ProfileResolutionOptions.tempProfileDir ' +
				'(a fresh bua-tmp-* directory). Chrome MUST NOT be launched against its default profile.',
		);
	}
	return configured;
}

// ---------------------------------------------------------------------------
// arg composition
// ---------------------------------------------------------------------------

function validateProfileArgs(args: readonly string[]): void {
	for (const arg of args) {
		if (!arg.startsWith('--')) {
			throw new BrowserProfileError(`BrowserProfile.args entries must start with '--', got ${JSON.stringify(arg)}`);
		}
		const key = argKey(arg);
		if (MANDATORY_ARG_NAMES.includes(key)) {
			throw new BrowserProfileError(
				`${key} is owned by the profile — set BrowserProfile.userDataDir instead of passing it in args`,
			);
		}
		if (CDP_OWNED_ARG_NAMES.includes(key)) {
			throw new BrowserProfileError(`${key} is owned by launchBrowser, which picks a free ephemeral port`);
		}
	}
}

/**
 * The profile-derived default args. Deliberately small and fully traceable to DATA-MODEL.md §5.2 —
 * `@tykotech/cdp` contributes the first-run/telemetry suppression set, and anything else the operator
 * wants belongs in `profile.args`, where it is visible.
 */
function composeArgs(
	profile: BrowserProfileLaunchInput,
	display: DisplayResolution,
	userDataDir: string,
	profileDirectory: string,
	extensionDirs: readonly string[],
	warn: (message: string) => void,
): string[] {
	const args: string[] = [`--user-data-dir=${userDataDir}`, `--profile-directory=${profileDirectory}`];
	const disableFeatures = new Set<string>();

	if (display.windowSize !== null) args.push(`--window-size=${display.windowSize.width},${display.windowSize.height}`);
	if (display.windowPosition !== null) {
		args.push(`--window-position=${display.windowPosition.x},${display.windowPosition.y}`);
	}
	if (display.deviceScaleFactor !== null) args.push(`--force-device-scale-factor=${display.deviceScaleFactor}`);

	if (profile.userAgent != null) args.push(`--user-agent=${profile.userAgent}`);
	if (profile.chromiumSandbox === false) args.push('--no-sandbox', '--disable-setuid-sandbox');
	if (profile.devtools === true) args.push('--auto-open-devtools-for-tabs');

	if (profile.proxy != null) {
		// Only the server and bypass list go on the command line: `ps` is world-readable on most
		// systems, so proxy credentials are answered over CDP `Fetch.authRequired` instead
		// (DATA-MODEL.md §5.2, SECURITY-AUTH.md §2.1 A1).
		args.push(`--proxy-server=${profile.proxy.server}`);
		if (profile.proxy.bypass != null) args.push(`--proxy-bypass-list=${profile.proxy.bypass}`);
	}

	if (profile.disableSecurity === true) {
		args.push('--disable-web-security', '--allow-running-insecure-content', '--ignore-certificate-errors');
	}
	// Site isolation is what puts cross-origin iframes in their own processes; turning OOPIFs off
	// means turning it off. Default is `crossOriginIframes: true` (DECISION-REGISTER.md I-11), so
	// this arm is opt-out only.
	if (profile.crossOriginIframes === false || profile.disableSecurity === true) {
		args.push('--disable-site-isolation-trials');
		for (const feature of SITE_ISOLATION_FEATURES) disableFeatures.add(feature);
	}

	if (profile.deterministicRendering === true) {
		warn('deterministicRendering is on: rendering flags are pinned, which costs performance and GPU features');
		args.push('--deterministic-mode', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text');
	}

	if (profile.enableDefaultExtensions !== false && extensionDirs.length > 0) {
		const paths = extensionDirs.join(',');
		args.push(`--disable-extensions-except=${paths}`, `--load-extension=${paths}`);
	}

	if (disableFeatures.size > 0) args.push(`--disable-features=${[...disableFeatures].join(',')}`);
	return args;
}

function applyIgnoreDefaultArgs(
	defaults: readonly string[],
	ignore: boolean | readonly string[] | undefined,
): string[] {
	if (ignore === undefined || ignore === false) return [...defaults];
	const dropped = ignore === true ? null : new Set(ignore.map(argKey));
	return defaults.filter((arg) => {
		const key = argKey(arg);
		if (MANDATORY_ARG_NAMES.includes(key)) return true;
		return dropped === null ? false : !dropped.has(key);
	});
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/**
 * Resolves a profile into the directories, display geometry and launch args a session needs.
 * Pure — the caller creates directories and spawns the process.
 */
export function resolveBrowserProfile(
	profile: BrowserProfileLaunchInput,
	options: ProfileResolutionOptions = {},
): ResolvedBrowserProfile {
	const warnings: string[] = [];
	const sink = options.onWarn;
	const warn = (message: string): void => {
		warnings.push(message);
		if (sink != null) sink(message);
	};

	const os = options.os ?? currentTargetOs();
	const headless = profile.headless ?? !hasDisplay(os, options.env ?? {});
	if (headless && profile.devtools === true) {
		throw new BrowserProfileError('devtools: true is incompatible with headless mode (DATA-MODEL.md §5.2)');
	}

	const userDataDir = resolveUserDataDir(profile, options);
	const profileDirectory = profile.profileDirectory ?? DEFAULT_PROFILE_DIRECTORY;
	const downloadsPath = profile.downloadsPath ?? options.defaultDownloadsDir ??
		joinPath(userDataDir, DEFAULT_DOWNLOADS_DIRNAME);
	const display = resolveDisplay(profile, headless, warn);

	const profileArgs = profile.args ?? [];
	validateProfileArgs(profileArgs);
	const defaults = composeArgs(
		profile,
		display,
		userDataDir,
		profileDirectory,
		options.extensionDirs ?? [],
		warn,
	);
	const args = dedupeArgs([...applyIgnoreDefaultArgs(defaults, profile.ignoreDefaultArgs), ...profileArgs]);
	assertUserDataDirPresent(args);

	return {
		headless,
		userDataDir,
		profileDirectory,
		downloadsPath,
		noViewport: display.noViewport,
		viewport: display.viewport,
		screen: display.screen,
		windowSize: display.windowSize,
		windowPosition: display.windowPosition,
		deviceScaleFactor: display.deviceScaleFactor,
		args,
		warnings,
	};
}

/**
 * Maps an OS name onto the three families the discovery tables cover. Split out from
 * {@linkcode currentTargetOs} so every arm is reachable from a single-platform test run.
 */
export function targetOsFor(os: typeof Deno.build.os): TargetOs {
	if (os === 'windows') return 'windows';
	return os === 'darwin' ? 'darwin' : 'linux';
}

/** The running platform, mapped onto the three families the discovery tables cover. */
export function currentTargetOs(): TargetOs {
	return targetOsFor(Deno.build.os);
}

/**
 * Hands the resolved profile to `@tykotech/cdp`'s `launchBrowser`. `ignoreDefaultArgs` is passed through
 * unchanged so it also governs that package's own default set, which is what "`true` drops all
 * defaults" means end to end.
 */
export function toLaunchPlan(
	profile: BrowserProfileLaunchInput,
	resolved: ResolvedBrowserProfile,
): BrowserLaunchPlan {
	return {
		userDataDir: resolved.userDataDir,
		executablePath: profile.executablePath ?? undefined,
		channel: profile.channel ?? undefined,
		headless: resolved.headless,
		args: resolved.args,
		env: profile.env == null ? undefined : { ...profile.env },
		ignoreDefaultArgs: profile.ignoreDefaultArgs,
	};
}
