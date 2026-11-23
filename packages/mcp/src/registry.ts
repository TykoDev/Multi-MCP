/** The browser session registry — the single owner of `BrowserSession` instances and of takeover-lock state. */
import {
	attachWatchdogs,
	BrowserErrorEvent,
	type BrowserProfileInit,
	BrowserReconnectedEvent,
	BrowserSession,
	DialogOpenedEvent,
	DownloadsWatchdog,
	FileDownloadedEvent,
	isIpLiteralHost,
	NavigationCompleteEvent,
	PopupsWatchdog,
	TabClosedEvent,
	TabCreatedEvent,
	TargetCrashedEvent,
} from '@tykotech/browser';
import { isAbsolute, join, resolve } from '@std/path';
import { encodeBase64Url } from '@std/encoding/base64url';
import { encodeHex } from '@std/encoding/hex';
import { ulid } from '@std/ulid';
import { AuditLedger } from './audit.ts';
import { canonicalHost, isHostAllowed, originOf, ToolError } from './errors.ts';
import { ConsoleProducer, DomSettleProducer, PageInputProducer } from './page_producers.ts';
import { downloadPayload, formatCursor, navigationTarget, NetworkIdleCounter, SessionEventRing } from './events.ts';
import { downloadsRootOf, SessionFiles } from './files.ts';
import { NetworkLog } from './network_log.ts';
import { reapplyViewport } from './page_viewport.ts';

/** The reserved id used when a tool call omits `session_id`. */
export const DEFAULT_SESSION_ID = 'default';

/** One document request the browser refused before sending it (enforcement point E0). */
interface DocumentBlock {
	readonly targetId: string | null;
	readonly frameId: string | null;
	readonly origin: string;
	/** The registry clock when the block was reported. */
	readonly at: number;
	/**
	 * The hostname the refused request's redirect chain **began** at (the browser layer's `chainStart`), or
	 * `null` when the browser did not say. A host, not a URL: enough to tell a tool's own chain from one a page started.
	 */
	readonly chainHost: string | null;
}

/** A fresh {@linkcode SessionRecord.incarnation}: 9 random bytes, base64url — exactly 12 characters, no padding. */
function newIncarnation(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(9)));
}

/** How many {@linkcode DocumentBlock}s a session remembers; the oldest is forgotten first. */
export const DOCUMENT_BLOCK_MEMORY = 16;

/** How many frames' last main-frame commit a session remembers; the stalest is forgotten first. */
const COMMIT_MEMORY = 32;

/** How long a `browser_console_log` claim keeps console capture armed after the last call. */
export const CONSOLE_CLAIM_IDLE_MS = 600_000;

/**
 * The origin of the newest **main-frame** E0 block on
 * `targetId` that belongs to the navigation a tool issued at `since`, or `null`.
 */
export function blockedSince(
	record: SessionRecord,
	targetId: string | null,
	since: number,
	requested: string | null = null,
): string | null {
	if (targetId === null) return null;
	const committed = record.commits?.get(targetId);
	if (committed !== undefined && committed >= since) return null;
	const host = requested === null ? null : hostOf(requested);
	const blocks = record.documentBlocks ?? [];
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (block === undefined || block.at < since) continue;
		if (block.targetId !== targetId || block.frameId !== targetId) continue;
		const chainHost = block.chainHost ?? null;
		if (host !== null && chainHost !== null && chainHost !== host) continue;
		return block.origin;
	}
	return null;
}

/** A URL's hostname for chain attribution, lower-cased by the WHATWG parser; `null` when unparseable. */
function hostOf(url: string): string | null {
	const parsed = URL.parse(url);
	return parsed === null || parsed.hostname === '' ? null : parsed.hostname;
}

/**
 * `BrowserErrorEvent.errorType` for every domain-policy block the vendored `SecurityWatchdog` reports
 * (`packages/browser/src/watchdogs/security.ts`, `NAVIGATION_BLOCKED_ERROR`, which the barrel does not export).
 */
const NAVIGATION_BLOCKED_ERROR = 'NavigationBlocked';

/** Minimum gap between two `info` lines about contained navigations in one session. */
const BLOCK_LOG_INTERVAL_MS = 1000;

/**
 * `TTK_ALLOWED_DOMAINS` in the vendored matcher's pattern syntax, or `null` for "unrestricted".
 * An entry the MCP rule cannot read becomes an unmatchable pattern: verbatim, the laxer matcher might accept it;
 * dropped, the list could empty, which the matcher reads as "no restriction".
 */
export function browserAllowedDomains(allowedDomains: readonly string[]): string[] | null {
	if (allowedDomains.length === 0) return null;
	return allowedDomains.map((entry) => {
		const host = canonicalHost(entry);
		if (host === null) return unmatchablePattern(entry);
		return isIpLiteralHost(host) ? host : `*.${host}`;
	});
}

/**
 * A pattern the vendored matcher refuses whatever `entry` holds, still naming the entry in the matcher's one-time
 * warning (operator configuration, not a secret).
 */
function unmatchablePattern(entry: string): string {
	return `unreadable-entry ${entry}`;
}

/**
 * The environment names every child this server spawns — Chromium and the recorder's ffmpeg — receives blank.
 * A child inherits the whole environment, and OTEL exporter settings, inline secret spellings and model keys must not
 * reach a browser a hostile page runs in. Blanked, not removed: `clearEnv` would also drop the proxy, locale and TZ
 * variables Chromium needs.
 */
export const CHILD_ENV_BLANKED: readonly string[] = [
	'OTEL_DENO',
	'OTEL_DENO_CONSOLE',
	'OTEL_SERVICE_NAME',
	'OTEL_RESOURCE_ATTRIBUTES',
	'OTEL_PROPAGATORS',
	...['', 'TRACES_', 'METRICS_', 'LOGS_'].flatMap((signal) =>
		['ENDPOINT', 'HEADERS', 'PROTOCOL'].map((part) => `OTEL_EXPORTER_OTLP_${signal}${part}`)
	),
	'TTK_API_KEYS',
	'TTK_SECRETS',
	'TTK_ADMIN_USER',
	'TTK_SANDBOX_TOKEN',
	// Model-provider keys an operator shell may export; the server itself never reads them.
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'TTK_MODEL_API_KEY',
];

/**
 * Launcher-wrapper names a spawned child also receives blank, kept apart from {@linkcode CHILD_ENV_BLANKED} because
 * the browser process legitimately holds a value for them afterwards.
 * Debian's chromium wrapper word-splits them onto the command line: an inherited `--no-sandbox` would bypass the
 * sandbox rules.
 */
export const CHILD_ENV_LAUNCHER_BLANKED: readonly string[] = ['CHROMIUM_FLAGS', 'CHROMIUM_USER_FLAGS'];

/**
 * The environment overrides a spawned child receives: every {@linkcode CHILD_ENV_BLANKED} and
 * {@linkcode CHILD_ENV_LAUNCHER_BLANKED} name set to `''`.
 */
export function childEnvOverrides(): Record<string, string> {
	return Object.fromEntries([...CHILD_ENV_BLANKED, ...CHILD_ENV_LAUNCHER_BLANKED].map((name) => [name, '']));
}

/**
 * The browser-wide permissions a session's Chromium grants every origin without a prompt. Not the vendored
 * `clipboardReadWrite`: any page could read what the agent or a live-view human last copied.
 */
export const SESSION_BROWSER_PERMISSIONS: readonly string[] = ['notifications'];

/** What {@linkcode sessionProfile} composes a launch profile from. */
interface SessionProfileInput {
	readonly headless: boolean;
	/** Absolute, server-owned download directory. */
	readonly downloadsDir: string;
	readonly browserPath: string | null;
	readonly browserArgs: readonly string[];
	/** A named profile's user-data directory, or `null` for a temporary one. */
	readonly userDataDir: string | null;
	/** The storage-state document the vendored watchdog loads and saves, or `null`. */
	readonly storageState: string | null;
	/** `TTK_CHROMIUM_NO_SANDBOX` inverted. */
	readonly chromiumSandbox: boolean;
	/** `TTK_ALLOWED_DOMAINS`, in the MCP rule's spelling. */
	readonly allowedDomains: readonly string[];
	/**
	 * `TTK_ALLOWED_DOMAINS_SCOPE`; absent means `documents`. With `all` and a non-empty allowlist the profile
	 * carries `requestScope: 'all'` and the resolver layer of {@linkcode resolverLayerRules}.
	 */
	readonly allowedDomainsScope?: 'documents' | 'all';
}

/** The Chromium switch the resolver layer is carried in; the operator's own value is folded into it. */
const HOST_RESOLVER_RULES_FLAG = '--host-resolver-rules';

/** Chromium switches that route the browser's traffic through a proxy. */
const PROXY_FLAGS: readonly string[] = ['--proxy-server', '--proxy-pac-url', '--proxy-auto-detect'];

/** The startup caveat for `all` under a proxy — the doctor prints the same sentence. */
export const PROXY_WEBSOCKET_CAVEAT =
	'TTK_ALLOWED_DOMAINS_SCOPE=all with a proxy flag in TTK_BROWSER_ARGS: under a proxy, WebSockets to off-list ' +
	'hosts are not refused (no CDP control); HTTP requests still are';

/** What a resolver-layer host token may contain; anything else is skipped, so a rule can never void the flag. */
const RESOLVER_HOST_SHAPE = /^[a-z0-9.:-]+$/;

/** The value of the last `--<name>=` switch in `args`, or `null`; Chromium reads the last occurrence. */
function switchValue(args: readonly string[], name: string): string | null {
	let value: string | null = null;
	for (const arg of args) if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
	return value;
}

/** Whether `args` carries switch `name`, bare or with a value. */
function hasSwitch(args: readonly string[], name: string): boolean {
	return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** A host as a resolver-rule token: lowercase, IPv6 unbracketed (`EXCLUDE ::1` works, `[::1]` does not). */
function resolverHost(host: string): string {
	const lower = host.toLowerCase();
	return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * The host patterns of the `MAP` rules in an operator's `--host-resolver-rules` value, as Chromium's `MatchPattern`
 * reads them (`*` any run, `?` one character; lowercase), with a `:port` suffix dropped — see
 * {@linkcode resolverLayerRules} for why they matter.
 */
function operatorMapPatterns(value: string): RegExp[] {
	const patterns: RegExp[] = [];
	for (const rule of value.split(',')) {
		const match = /^\s*MAP\s+(\S+)\s+\S+/i.exec(rule);
		if (match === null) continue;
		const host = (match[1] ?? '').toLowerCase().replace(/:\d+$/, '');
		const source = host.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
		patterns.push(new RegExp(`^${source}$`));
	}
	return patterns;
}

/** The proxy hosts a `--proxy-server` value names — `[scheme=]uri[,uri…]` lists, `;`-separated; `direct://` skipped. */
function proxyHosts(value: string): string[] {
	const hosts: string[] = [];
	for (const rule of value.split(';')) {
		const list = rule.includes('=') ? rule.slice(rule.indexOf('=') + 1) : rule;
		for (const raw of list.split(',')) {
			const entry = raw.trim();
			if (entry === '' || entry.toLowerCase().startsWith('direct://')) continue;
			const parsed = URL.parse(entry.includes('://') ? entry : `http://${entry}`);
			if (parsed !== null && parsed.hostname !== '') hosts.push(resolverHost(parsed.hostname));
		}
	}
	return hosts;
}

/**
 * The resolver layer for `TTK_ALLOWED_DOMAINS_SCOPE=all`: **one** `--host-resolver-rules` value under which every
 * name off the allowlist fails to resolve (the WebSocket control: `Fetch` never sees a handshake).
 * Order: the operator's own rules (the first matching `MAP` wins); `EXCLUDE` per allowed host, skipping hosts an
 * operator `MAP` covers since an `EXCLUDE` voids every `MAP` for its host; `EXCLUDE` per proxy host; `MAP * ~NOTFOUND`.
 * Unreadable entries are skipped via `onSkip`, which fails closed.
 */
export function resolverLayerRules(
	allowedDomains: readonly string[],
	browserArgs: readonly string[],
	onSkip: (message: string) => void = () => {},
): string {
	const rules: string[] = [];
	const operator = switchValue(browserArgs, HOST_RESOLVER_RULES_FLAG);
	if (operator !== null && operator.trim() !== '') rules.push(operator.trim());
	const operatorMaps = operatorMapPatterns(operator ?? '');
	const mappedByOperator = (token: string): boolean => operatorMaps.some((pattern) => pattern.test(token));
	const push = (token: string): void => {
		if (!mappedByOperator(token)) rules.push(`EXCLUDE ${token}`);
	};
	const exclude = (host: string, wildcard: boolean, source: string): void => {
		if (!RESOLVER_HOST_SHAPE.test(host)) {
			onSkip(
				`TTK_ALLOWED_DOMAINS_SCOPE=all: ${JSON.stringify(source)} cannot be written as a resolver rule and is left ` +
					'out of the resolver layer, so that host does not resolve in the browser',
			);
			return;
		}
		push(host);
		if (wildcard) push(`*.${host}`);
	};
	for (const entry of allowedDomains) {
		const host = canonicalHost(entry);
		if (host === null) {
			onSkip(
				`TTK_ALLOWED_DOMAINS_SCOPE=all: the allowlist entry ${JSON.stringify(entry)} is unreadable and is left out ` +
					'of the resolver layer (it matches nothing, so nothing is admitted for it)',
			);
			continue;
		}
		exclude(resolverHost(host), !isIpLiteralHost(host), entry);
	}
	const proxy = switchValue(browserArgs, '--proxy-server');
	if (proxy !== null) { for (const host of proxyHosts(proxy)) exclude(host, false, `--proxy-server host ${host}`); }
	rules.push('MAP * ~NOTFOUND');
	return rules.join(', ');
}

/** Whether `TTK_BROWSER_ARGS` routes the browser through a proxy ({@linkcode PROXY_FLAGS}). */
export function browserArgsUseProxy(browserArgs: readonly string[]): boolean {
	return PROXY_FLAGS.some((flag) => hasSwitch(browserArgs, flag));
}

/**
 * The `BrowserProfile` a session launches with — the one place registry configuration becomes vendored profile
 * fields, so a test can assert on it without spawning Chromium.
 */
export function sessionProfile(input: SessionProfileInput): BrowserProfileInit {
	const allowedDomains = browserAllowedDomains(input.allowedDomains);
	// `all` takes effect only over a non-empty allowlist (config refuses it without one). `documents` — and an
	// unrestricted deployment — add no request scope and pass the launch arguments through unchanged.
	const all = input.allowedDomainsScope === 'all' && allowedDomains !== null;
	const args = all
		? [
			...input.browserArgs.filter((arg) => !arg.startsWith(`${HOST_RESOLVER_RULES_FLAG}=`)),
			`${HOST_RESOLVER_RULES_FLAG}=${resolverLayerRules(input.allowedDomains, input.browserArgs)}`,
		]
		: input.browserArgs;
	return {
		headless: input.headless,
		env: childEnvOverrides(),
		// Never the vendored default's origin-less clipboard grant.
		permissions: [...SESSION_BROWSER_PERMISSIONS],
		downloadsPath: input.downloadsDir,
		...(input.browserPath === null ? {} : { executablePath: input.browserPath }),
		...(args.length === 0 ? {} : { args: [...args] }),
		...(input.userDataDir === null ? {} : { userDataDir: input.userDataDir }),
		...(input.storageState === null ? {} : { storageState: input.storageState }),
		...(input.chromiumSandbox ? {} : { chromiumSandbox: false }),
		...(allowedDomains === null ? {} : { allowedDomains }),
		...(all ? { requestScope: 'all' as const } : {}),
	};
}

/** A profile name that is safe as one path segment: constrained, not escaped, so `.` and `/` never survive. */
export function safeProfileName(name: string): string {
	const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (cleaned === '') {
		throw new ToolError('invalid-arguments', `profile name ${JSON.stringify(name)} has no usable characters`);
	}
	return cleaned.slice(0, 64);
}

/** A live viewer attached to a session's live view. */
export interface LiveViewerHandle {
	readonly id: string;
	readonly mode: 'watch' | 'control';
	readonly principal: string;
	/** The credential's label, shown to other viewers as `holderName` when this viewer holds the lock. */
	readonly holderName?: string | null;
	/** Delivers a server→client control message. Implemented by the gateway. */
	send(message: unknown): void;
	/** Terminates the viewer connection. */
	close(reason: string): void;
}

/** Exclusive human control over a session. */
interface TakeoverLock {
	readonly holder: string;
	readonly principal: string;
	readonly takenAt: number;
	/**
	 * The holder's credential label (`ApiKeyRecord.label`), for the `lock` message every viewer receives; `null` when
	 * the credential has none. Never written to the event ring, which carries the viewer id only.
	 */
	readonly holderName: string | null;
}

/** Who may reach a session (`TTK_SESSION_OWNERSHIP`). */
export type SessionOwnership = 'shared' | 'owner';

/** The caller a session lookup is made for. */
export interface SessionAccess {
	readonly owner: string;
	readonly admin: boolean;
}

/** Wire-facing summary of one session. */
export interface SessionSummary {
	session_id: string;
	label?: string;
	created_at: string;
	last_used_at: string;
	tab_count: number;
	viewer_count: number;
	human_has_control: boolean;
	/** The persistent profile backing this session, if any. */
	profile?: string;
}

/** One in-flight `browser_run_task` run. */
export interface AgentRun {
	readonly id: string;
	readonly task: string;
	/** Steps allowed before the run parks itself as resumable. */
	budget: number;
	steps: number;
	/** One line per step, which is the memory the model is shown each round. */
	readonly history: string[];
	readonly startedAt: number;
	answer?: string;
}

/** Something changed that a connected MCP client would want to know about. */
export type RegistryChange =
	| { kind: 'session-added'; sessionId: string }
	| { kind: 'session-removed'; sessionId: string }
	| { kind: 'lock-changed'; sessionId: string }
	| { kind: 'page-changed'; sessionId: string }
	/** A download finished and became readable; the file resource list changed. */
	| { kind: 'files-changed'; sessionId: string };

/**
 * What a launcher hands back: the session, plus the download ledger the attach step constructed and the directory it
 * was told to write into.
 */
export interface LaunchedSession {
	readonly session: BrowserSession;
	readonly downloads: DownloadsWatchdog | null;
	/** The dialog watchdog, when this launcher built one. */
	readonly popups?: PopupsWatchdog | null;
	/** Absolute, server-owned, per-incarnation directory; `null` when capture is off. */
	readonly downloadsDir: string | null;
}

export interface SessionRecord {
	readonly id: string;
	readonly session: BrowserSession;
	readonly createdAt: number;
	lastUsedAt: number;
	readonly viewers: Map<string, LiveViewerHandle>;
	lock: TakeoverLock | null;
	/** The session's downloaded files: listing, validated reads, and directory lifetime. */
	readonly files: SessionFiles;
	/** The dialog watchdog this session's launcher built, or `null`. */
	readonly popups: PopupsWatchdog | null;
	/** The download watchdog this session's launcher built, or `null`. */
	readonly downloads: DownloadsWatchdog | null;
	/**
	 * The session's event ring: the one owner of `seq`, the gap contract and the redaction contract. It sits beside
	 * `files` because both are per-session state that must outlive every viewer.
	 */
	readonly events: SessionEventRing;
	/**
	 * The session's audit ledger: every use of a server-held secret and every evaluated expression. In memory only:
	 * a persistent record of which credential was spent where is a target.
	 */
	readonly audit: AuditLedger;
	label?: string;
	/** The persistent profile this session is bound to, if any. */
	profile?: string;
	/** The paused or in-flight agent run, if any. */
	run?: AgentRun;
	/** The viewport this session is emulating, once a tool set one. */
	viewport?: { width: number; height: number; device_scale: number };
	/** When this session last had **input** dispatched to it, as opposed to being read. */
	lastInputAt?: number;
	/**
	 * Per-session idle timeout in milliseconds, overriding the registry-wide `sessionTtlMs`; `reap()` computes
	 * each record's cutoff from it. Undefined means the registry's value.
	 */
	idleTimeoutMs?: number;
	/** Detaches the change watchers this record installed on its session. */
	detach?: () => void;
	/** The last focus this session *observed*, as an opaque signature. */
	lastFocus?: string | null;
	/**
	 * Downloads the ledger gate refused, guid to blocked **origin** — never the URL, which may carry a token.
	 * `browser_download` reads it to answer `navigation-blocked` naming only the origin.
	 */
	blockedDownloads?: Map<string, string>;
	/**
	 * The one server-drawn highlight this session may hold, with the timer that hides it and
	 * the CDP session it was drawn in. Lives on the record so it dies with the session.
	 */
	highlight?: { readonly sessionId: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	/**
	 * The owner that created this session, stamped at creation in `owner` mode; `null` in `shared` mode, which never
	 * reads it. Never rendered: a summary, a detail record and the event ring carry no owner.
	 */
	readonly owner: string | null;
	/**
	 * This record's incarnation: 12 base64url characters from 9 random bytes, drawn once at creation and never
	 * reused.
	 */
	readonly incarnation: string;
	/**
	 * The last {@linkcode DOCUMENT_BLOCK_MEMORY} document requests the browser refused before sending them (E0),
	 * newest last; read through {@linkcode blockedSince}. Origins only.
	 */
	readonly documentBlocks: DocumentBlock[];
	/**
	 * The registry-clock time of each frame's latest **main-frame** commit (`Page.frameNavigated` without a parent,
	 * or a same-document `Page.navigatedWithinDocument`), bounded by {@linkcode COMMIT_MEMORY}.
	 */
	readonly commits: Map<string, number>;
	/**
	 * The session's request log: bounded metadata of every request its pages made, redacted at mint.
	 * Always on, re-armed across a reconnect, closed with the session.
	 */
	readonly network: NetworkLog;
	/**
	 * `browser_console_log`'s claim on the ring's `console` kind, or `undefined` while no claim is held: when
	 * it armed (registry clock), the ring cursor capture starts after, and the idle timer that releases it.
	 */
	consoleClaim?: { readonly armedAt: number; readonly cursor: string; timer: ReturnType<typeof setTimeout> };
}

export interface SessionRegistryOptions {
	/** Hard cap on concurrent sessions. */
	readonly maxSessions?: number;
	/** Idle milliseconds before a session is reaped. */
	readonly sessionTtlMs?: number;
	/** Chromium executable; `null` defers to platform discovery. */
	readonly browserPath?: string | null;
	/** Root for persistent state. */
	readonly dataDir?: string | null;
	/** Extra Chromium arguments. */
	readonly browserArgs?: readonly string[];
	readonly headless?: boolean;
	/** Injected clock so tests can drive expiry deterministically. */
	readonly now?: () => number;
	/** Sweep interval; `0` disables the background reaper (tests). */
	readonly reapIntervalMs?: number;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/** Builds and starts the browser for a session. */
	readonly launch?: (id: string, profile?: string) => Promise<BrowserSession | LaunchedSession>;
	/**
	 * `TTK_ALLOWED_DOMAINS`, applied at the download ledger and handed to every session's vendored profile through
	 * {@linkcode browserAllowedDomains}.
	 */
	readonly allowedDomains?: readonly string[];
	/** `false` launches Chromium without its sandbox (`TTK_CHROMIUM_NO_SANDBOX`). Default `true`. */
	readonly chromiumSandbox?: boolean;
	/** Session ownership (`TTK_SESSION_OWNERSHIP`). Default `shared`. */
	readonly ownership?: SessionOwnership;
	/**
	 * The server's secret redaction (`SecretStore.redact`), for the per-session buffers that **cap** text
	 * at mint — the request log's URLs and paths, the ring's console lines — so a configured secret is replaced before
	 * the cut and can never leave a prefix behind. The identity when absent (no secrets configured, or a test).
	 */
	readonly redact?: (text: string) => string;
	/** `TTK_ALLOWED_DOMAINS_SCOPE`. Default `documents`. */
	readonly allowedDomainsScope?: 'documents' | 'all';
}

/** `owner` mode: who a session being created belongs to, and whether it is that owner's default session. */
interface OwnedCreation {
	readonly owner: string;
	readonly ownerDefault: boolean;
}

const DEFAULTS = {
	maxSessions: 8,
	sessionTtlMs: 1_800_000,
	reapIntervalMs: 60_000,
} as const;

export class SessionRegistry {
	readonly #records = new Map<string, SessionRecord>();
	/** In-flight creations, so concurrent first calls never double-launch. */
	readonly #creating = new Map<string, Promise<SessionRecord>>();
	/** `owner` mode: each owner's own default session, owner → session id. */
	readonly #ownerDefaults = new Map<string, string>();
	/**
	 * `owner` mode: an owner's default session while it launches, so two first calls from one owner share one browser
	 * — the job {@linkcode #creating} does for `default`, keyed by owner because the id is minted per launch.
	 */
	readonly #creatingDefaults = new Map<string, Promise<SessionRecord>>();
	readonly #opts:
		& Required<
			Omit<SessionRegistryOptions, 'logger' | 'browserPath' | 'browserArgs' | 'launch' | 'dataDir'>
		>
		& {
			browserPath: string | null;
			dataDir: string | null;
			browserArgs: readonly string[];
			logger: SessionRegistryOptions['logger'];
			launch: (id: string, profile?: string) => Promise<BrowserSession | LaunchedSession>;
		};
	// `ReturnType<typeof setInterval>`, not `number`: the npm dependency graph
	// pulls Node typings in, under which timers are `Timeout` objects.
	#reaper: ReturnType<typeof setInterval> | null = null;
	#closed = false;
	#draining = false;
	readonly #watchers = new Set<(change: RegistryChange) => void>();
	/** The one-time sweep of the dedicated downloads subtree. */
	readonly #downloadsReady: Promise<void>;

	constructor(options: SessionRegistryOptions = {}) {
		this.#opts = {
			maxSessions: options.maxSessions ?? DEFAULTS.maxSessions,
			sessionTtlMs: options.sessionTtlMs ?? DEFAULTS.sessionTtlMs,
			reapIntervalMs: options.reapIntervalMs ?? DEFAULTS.reapIntervalMs,
			browserPath: options.browserPath ?? null,
			dataDir: options.dataDir ?? null,
			browserArgs: options.browserArgs ?? [],
			headless: options.headless ?? true,
			now: options.now ?? (() => Date.now()),
			logger: options.logger,
			launch: options.launch ?? ((id, profile) => this.launchBrowserSession(id, profile)),
			allowedDomains: options.allowedDomains ?? [],
			chromiumSandbox: options.chromiumSandbox ?? true,
			ownership: options.ownership ?? 'shared',
			redact: options.redact ?? ((text) => text),
			allowedDomainsScope: options.allowedDomainsScope ?? 'documents',
		};

		// Loud, once, at startup — and only where this registry will actually launch Chromium. An
		// injected launcher (a test) never reaches the profile this setting changes.
		if (!this.#opts.chromiumSandbox && options.launch === undefined) {
			this.#opts.logger?.warn(
				'TTK_CHROMIUM_NO_SANDBOX is set: Chromium will be launched WITHOUT its sandbox (--no-sandbox). Every ' +
					'page it loads is untrusted content; use this only where the container or VM is the boundary.',
			);
		}

		// The request scope's two startup notices, once, and only where this registry launches Chromium — an attached
		// or injected browser never receives the resolver layer.
		if (
			this.#opts.allowedDomainsScope === 'all' && this.#opts.allowedDomains.length > 0 && options.launch === undefined
		) {
			resolverLayerRules(this.#opts.allowedDomains, this.#opts.browserArgs, (message) => {
				this.#opts.logger?.warn(message);
			});
			if (browserArgsUseProxy(this.#opts.browserArgs)) this.#opts.logger?.warn(PROXY_WEBSOCKET_CAVEAT);
		}

		if (this.#opts.reapIntervalMs > 0) {
			this.#reaper = setInterval(() => void this.reap(), this.#opts.reapIntervalMs);
			// The reaper must never be the reason the process stays alive.
			Deno.unrefTimer(this.#reaper);
		}

		this.#downloadsReady = this.#opts.dataDir === null ? Promise.resolve() : this.#sweepStaleDownloads();
	}

	/** The Chromium arguments this deployment launches with (`TTK_BROWSER_ARGS`). */
	get browserArgs(): readonly string[] {
		return this.#opts.browserArgs;
	}

	/** Whether sessions launch with Chromium's sandbox — `false` only under `TTK_CHROMIUM_NO_SANDBOX`. */
	get chromiumSandboxed(): boolean {
		return this.#opts.chromiumSandbox;
	}

	/** The session ownership mode this registry was built with (`TTK_SESSION_OWNERSHIP`). */
	get ownership(): SessionOwnership {
		return this.#opts.ownership;
	}

	/** `owner` mode is on. */
	get #owned(): boolean {
		return this.#opts.ownership === 'owner';
	}

	/**
	 * The registry's clock: what {@linkcode DocumentBlock.at} is stamped with, so a tool's `since` for
	 * {@linkcode blockedSince} is read from the same source as the blocks it is compared with.
	 */
	now(): number {
		return this.#opts.now();
	}

	/** Takes — or refreshes — `browser_console_log`'s claim on a session's console capture. */
	claimConsole(record: SessionRecord): { readonly armedAt: number; readonly cursor: string } {
		const held = record.consoleClaim;
		if (held !== undefined) clearTimeout(held.timer);
		const claim = held ?? (() => {
			// The cursor is taken before arming, so the `console-armed` control record is the first thing after it.
			const cursor = formatCursor(record.events.epoch, record.events.highWaterMark);
			record.events.armConsole();
			return { armedAt: this.#opts.now(), cursor };
		})();
		const timer = setTimeout(() => this.#releaseConsoleClaim(record), CONSOLE_CLAIM_IDLE_MS);
		// The idle release must never be the reason the process stays alive.
		Deno.unrefTimer(timer);
		record.consoleClaim = { armedAt: claim.armedAt, cursor: claim.cursor, timer };
		return { armedAt: claim.armedAt, cursor: claim.cursor };
	}

	/** Releases a held console claim: the timer, and the ring's refcount. Idempotent. */
	#releaseConsoleClaim(record: SessionRecord): void {
		const claim = record.consoleClaim;
		if (claim === undefined) return;
		clearTimeout(claim.timer);
		record.consoleClaim = undefined;
		record.events.disarmConsole();
	}

	/** The root every session's download directory is created under, or `null` without a data root. */
	get downloadsRoot(): string | null {
		return this.#opts.dataDir === null ? null : downloadsRootOf(resolve(this.#opts.dataDir));
	}

	async #sweepStaleDownloads(): Promise<void> {
		const root = this.downloadsRoot;
		if (root === null) return;
		try {
			for await (const entry of Deno.readDir(root)) {
				await Deno.remove(join(root, entry.name), { recursive: true }).catch((error: unknown) => {
					this.#opts.logger?.warn(`stale download directory ${entry.name} could not be removed: ${String(error)}`);
				});
			}
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			this.#opts.logger?.warn(`download root ${root} could not be swept: ${String(error)}`);
		}
	}

	/** Subscribes to registry changes. Returns an unsubscribe function. */
	watch(watcher: (change: RegistryChange) => void): () => void {
		this.#watchers.add(watcher);
		return () => this.#watchers.delete(watcher);
	}

	#announce(change: RegistryChange): void {
		for (const watcher of this.#watchers) {
			try {
				watcher(change);
			} catch { /* a broken consumer is not a broken browser */ }
		}
	}

	/** Sessions currently held, in creation order. */
	list(): SessionSummary[] {
		return [...this.#records.values()].map((record) => this.#summarize(record));
	}

	get size(): number {
		return this.#records.size;
	}

	/** Every live record, for the callers that need more than a `SessionSummary`. */
	get records(): readonly SessionRecord[] {
		return [...this.#records.values()];
	}

	/** Looks up a record without creating one. */
	peek(sessionId: string): SessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	/** {@linkcode peek} on behalf of a caller: never creates a session. */
	peekFor(sessionId: string | undefined, access?: SessionAccess): SessionRecord | undefined {
		if (!this.#owned) return this.peek(sessionId ?? DEFAULT_SESSION_ID);
		if (access === undefined) return undefined;
		if (sessionId === undefined || sessionId === DEFAULT_SESSION_ID) {
			const own = this.#ownerDefaults.get(access.owner);
			return own === undefined ? undefined : this.#records.get(own);
		}
		const record = this.#records.get(sessionId);
		return record !== undefined && this.canAccess(record, access) ? record : undefined;
	}

	/** The live records a caller may see, in creation order: all of them in `shared` mode or for `admin`. */
	visibleTo(access?: SessionAccess): readonly SessionRecord[] {
		if (!this.#owned) return this.records;
		return this.records.filter((record) => this.canAccess(record, access));
	}

	/** The session summaries a caller may see; {@linkcode list} in `shared` mode. */
	listFor(access?: SessionAccess): SessionSummary[] {
		if (!this.#owned) return this.list();
		return this.visibleTo(access).map((record) => this.#summarize(record));
	}

	/**
	 * Whether a caller may reach `record`: always in `shared` mode; in `owner` mode when the caller created
	 * it or holds `admin`, and never without an `access` to judge.
	 */
	canAccess(record: SessionRecord, access?: SessionAccess): boolean {
		if (!this.#owned) return true;
		if (access === undefined) return false;
		return access.admin || (record.owner !== null && record.owner === access.owner);
	}

	/** Resolves a session id to a live record. */
	async resolve(sessionId?: string | undefined, access?: SessionAccess): Promise<SessionRecord> {
		this.#assertOpen();
		if (this.#owned) return await this.#resolveOwned(sessionId, access);
		const id = sessionId ?? DEFAULT_SESSION_ID;
		const existing = this.#records.get(id);
		if (existing !== undefined) {
			existing.lastUsedAt = this.#opts.now();
			return existing;
		}
		if (sessionId !== undefined && sessionId !== DEFAULT_SESSION_ID) {
			throw new ToolError('unknown-session', `no session with id ${sessionId}`);
		}
		this.#assertNotDraining();
		return await this.#create(DEFAULT_SESSION_ID);
	}

	async #resolveOwned(sessionId: string | undefined, access: SessionAccess | undefined): Promise<SessionRecord> {
		const named = sessionId !== undefined && sessionId !== DEFAULT_SESSION_ID;
		if (access === undefined) {
			throw new ToolError('unknown-session', `no session with id ${sessionId ?? DEFAULT_SESSION_ID}`);
		}
		const existing = this.peekFor(sessionId, access);
		if (existing !== undefined) {
			existing.lastUsedAt = this.#opts.now();
			return existing;
		}
		if (named) throw new ToolError('unknown-session', `no session with id ${sessionId}`);
		this.#assertNotDraining();
		const inFlight = this.#creatingDefaults.get(access.owner);
		if (inFlight !== undefined) return await inFlight;
		const pending = this.#create(`${DEFAULT_SESSION_ID}-${ulid().toLowerCase()}`, undefined, {
			owner: access.owner,
			ownerDefault: true,
		});
		this.#creatingDefaults.set(access.owner, pending);
		try {
			return await pending;
		} finally {
			this.#creatingDefaults.delete(access.owner);
		}
	}

	/** Creates a new session under a freshly minted id. */
	async createNew(label?: string, profile?: string, access?: SessionAccess): Promise<SessionRecord> {
		this.#assertOpen();
		this.#assertNotDraining();
		if (this.#owned && access === undefined) {
			throw new ToolError('unknown-session', 'a new session needs a caller to own it');
		}
		if (profile !== undefined) {
			if (this.#opts.dataDir === null) {
				throw new ToolError(
					'invalid-arguments',
					'named profiles need a data directory; start the server with TTK_DATA_DIR set',
				);
			}
			const held = [...this.#records.values()].find((record) => record.profile === profile);
			if (held !== undefined) {
				// A foreign session id is never named, so the refusal cannot be used to learn one.
				throw new ToolError(
					'session-limit',
					this.canAccess(held, access)
						? `profile ${profile} is already open as session ${held.id}; close it first`
						: `profile ${profile} is already open in another session`,
				);
			}
		}
		const record = await this.#create(
			ulid(),
			profile,
			this.#owned && access !== undefined ? { owner: access.owner, ownerDefault: false } : undefined,
		);
		if (label !== undefined) record.label = label;
		if (profile !== undefined) record.profile = profile;
		return record;
	}

	/** The directory a named profile persists into, or `null` when off. */
	profileDir(profile: string): string | null {
		if (this.#opts.dataDir === null) return null;
		return `${this.#opts.dataDir}/profiles/${safeProfileName(profile)}`;
	}

	/** The root for saved storage-state documents, or `null` when off. */
	get storageDir(): string | null {
		return this.#opts.dataDir === null ? null : `${this.#opts.dataDir}/storage`;
	}

	/** The directory a caller's named storage-state documents live in, or `null` when off. */
	async storageDirFor(access?: SessionAccess): Promise<string | null> {
		const root = this.storageDir;
		if (root === null || !this.#owned) return root;
		if (access === undefined) throw new ToolError('unknown-session', 'no session is reachable without a caller');
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`ttk-storage-owner\0${access.owner}`),
		);
		return `${root}/owners/${encodeHex(new Uint8Array(digest)).slice(0, 32)}`;
	}

	/** The registry-wide idle timeout, in milliseconds. */
	get sessionTtlMs(): number {
		return this.#opts.sessionTtlMs;
	}

	async #create(id: string, profile?: string, owned?: OwnedCreation): Promise<SessionRecord> {
		const inFlight = this.#creating.get(id);
		if (inFlight !== undefined) return await inFlight;

		if (this.#records.size >= this.#opts.maxSessions) {
			throw new ToolError(
				'session-limit',
				`at most ${this.#opts.maxSessions} concurrent sessions (close one first)`,
			);
		}

		const pending = this.#launch(id, profile, owned);
		this.#creating.set(id, pending);
		try {
			return await pending;
		} finally {
			this.#creating.delete(id);
		}
	}

	/** Allocates the absolute, server-owned download directory for one session incarnation. */
	async #allocateDownloadsDir(id: string): Promise<string> {
		const root = this.downloadsRoot;
		try {
			if (root === null) return await Deno.makeTempDir({ prefix: `ttk-downloads-${safeProfileName(id)}-` });
			const dir = join(root, `${safeProfileName(id)}-${ulid().toLowerCase()}`);
			await Deno.mkdir(dir, { recursive: true });
			return dir;
		} catch (cause) {
			throw new ToolError(
				'browser-unavailable',
				`could not create the session's download directory: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	}

	/** Launches a real Chromium-backed session. The default {@linkcode SessionRegistryOptions.launch}. */
	async launchBrowserSession(id: string, profile?: string): Promise<LaunchedSession> {
		// A named profile pins both the Chromium user-data directory (cookies, localStorage, the whole profile) and
		// the storage-state document the vendored watchdog writes on stop, which is what makes a login survive a
		// restart rather than only a navigation.
		const dir = profile === undefined ? null : this.profileDir(profile);
		if (dir !== null) await Deno.mkdir(dir, { recursive: true }).catch(() => {});

		// The download directory is decided *before* the browser exists and handed to the
		// profile, because the watchdog reads `profile.downloadsPath` when the browser connects and
		// a path that is not absolute is refused by the containment contract.
		const downloadsDir = await this.#allocateDownloadsDir(id);
		if (!isAbsolute(downloadsDir)) {
			throw new ToolError('browser-unavailable', `download directory ${downloadsDir} is not absolute`);
		}

		// With a data root configured, *every* session gets a storage-state path, not only profiled ones.
		const scratchState = dir === null && this.#opts.dataDir !== null
			? `${this.#opts.dataDir}/sessions/${id}.json`
			: null;
		if (scratchState !== null) {
			await Deno.mkdir(`${this.#opts.dataDir}/sessions`, { recursive: true }).catch(() => {});
		}

		// The deployment allowlist reaches the vendored profile here, so `BrowserSession`'s own pre-navigation check
		// and the `SecurityWatchdog`'s three enforcement points — the veto, containment of a redirect or load-time
		// script navigation in a navigation this session issued, and new-tab containment — run with the policy the
		// tools gate on, never with the vendored `null` (unrestricted) default.
		const session = new BrowserSession({
			id,
			profile: sessionProfile({
				headless: this.#opts.headless,
				downloadsDir,
				browserPath: this.#opts.browserPath,
				browserArgs: this.#opts.browserArgs,
				userDataDir: dir,
				storageState: dir === null ? scratchState : `${dir}/storage_state.json`,
				chromiumSandbox: this.#opts.chromiumSandbox,
				allowedDomains: this.#opts.allowedDomains,
				// `all` adds the request scope and the resolver layer; `documents` changes nothing.
				allowedDomainsScope: this.#opts.allowedDomainsScope,
			}),
		});
		let downloads: DownloadsWatchdog | null = null;
		let popups: PopupsWatchdog | null = null;
		try {
			// Watchdogs attach before the session itself, as `@tykotech/browser`'s own module note requires: handlers
			// run in registration order, and the session's `BrowserStopEvent` handler is the one that closes the CDP
			// socket.
			const attached = attachWatchdogs(session);
			downloads = attached.find((w): w is DownloadsWatchdog => w instanceof DownloadsWatchdog) ?? null;
			// The same "keep the instance `attachWatchdogs` built" rule as the download ledger.
			// The one that armed `Page.javascriptDialogOpening` is the only one that can hold a dialog.
			popups = attached.find((w): w is PopupsWatchdog => w instanceof PopupsWatchdog) ?? null;
			session.attach();
			await session.start();
		} catch (cause) {
			// Never leave a half-started browser behind, nor its empty download directory.
			await session.kill().catch(() => {});
			await Deno.remove(downloadsDir, { recursive: true }).catch(() => {});
			throw new ToolError(
				'browser-unavailable',
				cause instanceof Error ? cause.message : String(cause),
			);
		}
		return { session, downloads, downloadsDir, popups };
	}

	async #launch(id: string, profile?: string, owned?: OwnedCreation): Promise<SessionRecord> {
		// The stale-directory sweep must finish before any launcher — the real one
		// or an injected one — can create a directory the sweep would then remove.
		await this.#downloadsReady;
		const launched = await this.#opts.launch(id, profile);
		const { session, downloads, downloadsDir, popups = null }: LaunchedSession =
			launched instanceof BrowserSession || !('session' in launched)
				? { session: launched as BrowserSession, downloads: null, downloadsDir: null, popups: null }
				: launched;
		const now = this.#opts.now();
		const record: SessionRecord = {
			id,
			session,
			createdAt: now,
			lastUsedAt: now,
			viewers: new Map(),
			lock: null,
			popups,
			downloads,
			viewport: undefined,
			files: new SessionFiles({
				dir: downloadsDir,
				ledger: downloads,
				// An artifact (`browser_pdf {delivery:'file'}`) announces itself like a finished download.
				onChange: () => this.#announce({ kind: 'files-changed', sessionId: id }),
				...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			}),
			events: new SessionEventRing({
				now: this.#opts.now,
				...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			}),
			audit: new AuditLedger({ now: this.#opts.now }),
			// Stamped before the record is visible to anyone, so no lookup or `session-added` watcher can
			// see an owned session without its owner.
			owner: owned?.owner ?? null,
			// The one creation site, so every record has exactly one incarnation.
			incarnation: newIncarnation(),
			// Document blocks (E0), commits and the request log: per-session state that dies with the session, like `events` and `audit`.
			documentBlocks: [],
			commits: new Map(),
			network: new NetworkLog({ now: this.#opts.now, redact: this.#opts.redact }),
		};
		this.#records.set(id, record);
		if (owned?.ownerDefault === true) this.#ownerDefaults.set(owned.owner, id);

		// The `console` producer.
		const consoleProducer = ConsoleProducer.attach(record, this.#opts.redact);
		if (consoleProducer !== null) record.events.setConsoleArmed(consoleProducer.setArmed);

		// The same shape for dialogs.
		if (popups !== null) record.events.setDialogArmed((armed) => popups.setManualHandling(armed));

		// The page changing is the event a resource subscriber is waiting for, and the registry is where every
		// session can be watched from — the live view's own subscription exists only while a viewer is attached.
		const containedNavigations = new Set<string>();
		const offNavigate = session.eventBus.on(NavigationCompleteEvent, (event) => {
			if (containedNavigations.delete(`${event.targetId}\n${event.url}`)) {
				this.#announce({ kind: 'page-changed', sessionId: id });
				return;
			}
			// origin + path + has_query, never a URL string: a navigation URL is
			// exactly where a one-time code or session token appears.
			record.events.append('navigation', {
				frame_id: event.targetId,
				...navigationTarget(event.url),
				// `null`, not `'user'`. The bus event carries no commit cause, and a hard-coded
				// `'user'` would attribute a hostile page's own `location.href =` redirect to the human in a
				// cross-principal audit record.
				reason: null,
				committed: event.errorMessage === null,
			}, event.targetId);
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		const offOpened = session.eventBus.on(TabCreatedEvent, (event) => {
			record.events.append('tab', { action: 'opened', tab_id: event.targetId, opener_tab_id: null }, event.targetId);
			// A tool-set viewport outlives the tab it was set from.
			void reapplyViewport(record, event.targetId).catch(() => {});
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		const offClosed = session.eventBus.on(TabClosedEvent, (event) => {
			record.events.append('tab', { action: 'closed', tab_id: event.targetId, opener_tab_id: null }, event.targetId);
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		// A finished download is a new resource; subscribers learn of it the same way they learn of a navigation.
		const offDownloaded = session.eventBus.on(FileDownloadedEvent, () => {
			// **No ring record is minted here.** The watchdog's `completed` phase already mints one below, through
			// `downloadPayload`, and this event fires for the same download — so a record here would double-count
			// every completion and put a second, unguarded producer beside an event object that carries `url`.
			this.#announce({ kind: 'files-changed', sessionId: id });
		});
		// `message` is page-authored text and is capped at mint. A `prompt`'s
		// *entered* text never appears in any event.
		const offDialog = session.eventBus.on(DialogOpenedEvent, (event) => {
			record.events.append('dialog', {
				// The id the watchdog holds the dialog under, which is what makes `browser_handle_dialog`
				// addressable (`Page.javascriptDialogOpening` carries no frameId to use instead); it is
				// `''` when no subscriber armed the hold, because nothing is held.
				dialog_id: event.dialogId,
				kind: event.dialogType,
				message: event.message,
				truncated: false,
			}, event.frameId);
		});
		// `network.idle` over the `Network.*` events the attach cascade already
		// enables per session. One record per quiet transition, not per tick.
		const idle = new NetworkIdleCounter({
			emit: (inflight, quietMs) => void record.events.append('network.idle', { inflight, quiet_ms: quietMs }),
		});
		const noteCommit = (frameId: string): void => {
			record.commits.delete(frameId);
			record.commits.set(frameId, this.#opts.now());
			while (record.commits.size > COMMIT_MEMORY) {
				const stalest = record.commits.keys().next().value;
				if (stalest === undefined) break;
				record.commits.delete(stalest);
			}
		};
		let offNetwork: Array<() => void> = [];
		const armNetwork = (): void => {
			for (const off of offNetwork) off();
			offNetwork = [];
			const client = session.cdpClient;
			if (client === null || client === undefined || typeof client.on !== 'function') return;
			offNetwork = [
				client.on('Network.requestWillBeSent', (params) => idle.started(params.requestId)),
				client.on('Network.loadingFinished', (params) => idle.finished(params.requestId)),
				client.on('Network.loadingFailed', (params) => idle.finished(params.requestId)),
				// The request log rides the same arming, so a reconnect re-arms it on the new client.
				record.network.attach(client),
				// Main-frame commits, which end a tool's own navigation chain (`blockedSince`).
				client.on('Page.frameNavigated', (params) => {
					if (params.frame.parentId === undefined) noteCommit(params.frame.id);
				}),
				client.on('Page.navigatedWithinDocument', (params) => noteCommit(params.frameId)),
			];
		};
		armNetwork();
		// The recovery marker.
		const offRecovered = session.eventBus.on(BrowserReconnectedEvent, () => {
			idle.reset();
			armNetwork();
			record.events.appendControl('browser-recovered');
		});
		// A crashed target or a browser that could not be reconnected leaves nothing to drive or watch.
		let crashed = false;
		const fatal = (message: string): void => {
			if (crashed) return;
			crashed = true;
			record.events.appendControl('browser-crashed');
			for (const viewer of record.viewers.values()) {
				try {
					viewer.send({ type: 'error', code: 'browser-crashed', message });
				} catch { /* already gone */ }
			}
			this.#opts.logger?.warn(`session ${id}: ${message}; closing it`);
			queueMicrotask(() => void this.close(id, 'browser-crashed').catch(() => {}));
		};
		const offCrashed = session.eventBus.on(TargetCrashedEvent, (event) => {
			fatal(`the browser tab crashed (${String(event.error).slice(0, 200)})`);
		});
		// What the domain policy contained, on the stream and in the log.
		let blocksSinceLog = 0;
		let lastBlockLogAt = Number.NEGATIVE_INFINITY;
		const contained = (details: Record<string, unknown>): void => {
			const point = details.enforcementPoint;
			if (point !== 'E0' && point !== 'E2' && point !== 'E3') return;
			const url = typeof details.url === 'string' ? details.url : '';
			// A refused subresource or hint (`requestKind`) is no one's navigation.
			const requestKind = details.requestKind;
			if (point === 'E0' && (requestKind === 'subresource' || requestKind === 'hint')) {
				logBlock(`request refused before it was sent (${requestKind})`, url, 'request-blocked');
				return;
			}
			const targetId = typeof details.targetId === 'string' ? details.targetId : null;
			// E0 names the frame whose document was refused; E2/E3 act on a whole tab.
			const frameId = typeof details.frameId === 'string' ? details.frameId : null;
			const containment = point === 'E0'
				? 'request-blocked'
				: typeof details.containment === 'string'
				? details.containment
				: 'failed';
			if ((point === 'E2' || point === 'E0') && targetId !== null) {
				if (containedNavigations.size >= 16) containedNavigations.clear();
				containedNavigations.add(`${targetId}\n${url}`);
			}
			// A refused speculative request (`Prefetch`) is recorded, but it is nobody's navigation, so it
			// never answers a tool through `blockedSince`.
			if (point === 'E0' && details.resourceType !== 'Prefetch') {
				// What `blockedSince` reads. Origin only, as everywhere a blocked URL is kept — plus
				// the host the refused chain began at, which is what attributes it.
				const chainStart = typeof details.chainStart === 'string' ? details.chainStart : null;
				record.documentBlocks.push({
					targetId,
					frameId,
					origin: navigationTarget(url).origin,
					at: this.#opts.now(),
					chainHost: chainStart === null ? null : hostOf(chainStart),
				});
				if (record.documentBlocks.length > DOCUMENT_BLOCK_MEMORY) {
					record.documentBlocks.splice(0, record.documentBlocks.length - DOCUMENT_BLOCK_MEMORY);
				}
			}
			record.events.append('navigation', {
				frame_id: point === 'E0' ? frameId ?? targetId ?? '' : targetId ?? '',
				// Redacted at mint exactly like every other navigation record: no URL string.
				...navigationTarget(url),
				reason: null,
				// E2's navigation reached the page before it was parked; E3's tab is closed on the first URL it
				// reports, and whether that document committed is not observed — so it is not claimed.
				committed: point === 'E2',
				blocked: true,
				containment,
			}, targetId);
			this.#announce({ kind: 'page-changed', sessionId: id });
			const what = point === 'E0'
				? 'document request refused before it was sent'
				: point === 'E2'
				? 'navigation parked on about:blank'
				: 'new tab closed';
			logBlock(what, url, containment);
		};
		/** The one rate-limited `info` line for every kind of block. Origin only: the URL is where a token would be. */
		const logBlock = (what: string, url: string, containment: string): void => {
			blocksSinceLog += 1;
			const now = this.#opts.now();
			if (now - lastBlockLogAt < BLOCK_LOG_INTERVAL_MS) return;
			const more = blocksSinceLog > 1 ? ` (${blocksSinceLog} blocks since the last report)` : '';
			this.#opts.logger?.info(
				`session ${id}: ${what}: ${originOf(url)} is not in TTK_ALLOWED_DOMAINS (${containment})${more}`,
			);
			blocksSinceLog = 0;
			lastBlockLogAt = now;
		};
		const offFailed = session.eventBus.on(BrowserErrorEvent, (event) => {
			if (event.errorType === 'ReconnectionFailed') fatal('the browser could not be reconnected');
			else if (event.errorType === NAVIGATION_BLOCKED_ERROR) contained(event.details);
		});
		// The started/failed halves come from the watchdog's synchronous channel: the bus has no failure event, and
		// `download.failed` must carry the closed reason enum rather than the watchdog's free-text `error`.
		const offDownloadSignal = typeof downloads?.addDownloadListener !== 'function'
			? undefined
			: downloads.addDownloadListener((signal) => {
				if (signal.phase === 'started') {
					record.events.append('download.started', downloadPayload('download.started', signal.download));
					// The ledger gate.
					const host = URL.parse(signal.download.url)?.hostname ?? '';
					if (!isHostAllowed(host, this.#opts.allowedDomains)) {
						(record.blockedDownloads ??= new Map()).set(signal.download.guid, originOf(signal.download.url));
						queueMicrotask(() => {
							if (typeof downloads?.cancelDownload !== 'function') return;
							void downloads.cancelDownload(signal.download.guid, 'navigation-blocked').catch(() => {});
						});
					}
					return;
				}
				if (signal.phase === 'completed') {
					record.events.append('download.done', downloadPayload('download.done', signal.download));
					// The digest is started here because this is the moment the bytes stop changing, and it is the
					// cheapest point to pay for the hash - by the time a caller lists the session's files it is
					// usually already there.
					record.files.startDigest(signal.download.guid);
					return;
				}
				if (signal.phase === 'failed' || signal.phase === 'canceled') {
					record.events.append('download.failed', downloadPayload('download.failed', signal.download));
				}
			});
		// The `dom.settled` producer. It owns the settle debounce and the token read; the shared injection reports
		// mutation counts to it through the input producer's `onMutation`.
		const settle = new DomSettleProducer({
			record,
			...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
		});

		// The `input` producer. It is armed beside the network subscriptions and re-armed on the same reconnect,
		// because both attach to a CDP client a reconnect replaces.
		let input = PageInputProducer.attach({
			record,
			onMutation: settle.onMutation,
			...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
		});
		let consoleProd = consoleProducer;
		const offInputRearm = session.eventBus.on(BrowserReconnectedEvent, () => {
			const previous = input;
			input = null;
			void previous?.dispose().catch(() => {});
			input = PageInputProducer.attach({
				record,
				onMutation: settle.onMutation,
				...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			});
			// The console producer's client was replaced too; rebuild it and hand the ring the new arm callback so a
			// live console subscription keeps receiving records across the reconnect.
			consoleProd?.dispose();
			consoleProd = ConsoleProducer.attach(record);
			if (consoleProd !== null) record.events.setConsoleArmed(consoleProd.setArmed);
		});
		record.detach = () => {
			// Removal first: without it the injected listener and a live binding survive in every frame for the
			// session's life after its last subscriber has gone.
			offInputRearm();
			const producer = input;
			input = null;
			void producer?.dispose().catch(() => {});
			consoleProd?.dispose();
			settle.dispose();
			offNavigate();
			offOpened();
			offClosed();
			offDownloaded();
			offDialog();
			offRecovered();
			offCrashed();
			offFailed();
			offDownloadSignal?.();
			for (const off of offNetwork) off();
			offNetwork = [];
			idle.dispose();
		};

		this.#opts.logger?.info(`session ${id} started`);
		this.#announce({ kind: 'session-added', sessionId: id });
		return record;
	}

	/** Marks a session as used, deferring its reap. */
	touch(sessionId: string): void {
		const record = this.#records.get(sessionId);
		if (record !== undefined) record.lastUsedAt = this.#opts.now();
	}

	// --- takeover lock ------------------------------------------------------

	/** Refuses a mutating operation while a human holds the session. */
	assertUnlocked(record: SessionRecord): void {
		if (record.lock !== null) {
			throw new ToolError(
				'human-has-control',
				`a live-view user has taken control of session ${record.id}`,
			);
		}
	}

	/** Grants exclusive control to a viewer. Returns false if already held. */
	takeControl(record: SessionRecord, viewer: LiveViewerHandle): boolean {
		if (record.lock !== null) return record.lock.holder === viewer.id;
		record.lock = {
			holder: viewer.id,
			principal: viewer.principal,
			takenAt: this.#opts.now(),
			holderName: viewer.holderName ?? null,
		};
		// A human taking the session is a coverage boundary for every consumer of the ring, not only for the viewers
		// the lock broadcast reaches. `holder_name` is the viewer's server-minted id, not its identity.
		record.events.appendControl('taken', { holder_name: viewer.id });
		this.#broadcastLock(record);
		this.#announce({ kind: 'lock-changed', sessionId: record.id });
		return true;
	}

	/** Releases control if `viewerId` holds it. */
	releaseControl(record: SessionRecord, viewerId: string): void {
		if (record.lock === null || record.lock.holder !== viewerId) return;
		record.lock = null;
		record.events.appendControl('released', { holder_name: viewerId });
		this.#broadcastLock(record);
		this.#announce({ kind: 'lock-changed', sessionId: record.id });
	}

	addViewer(record: SessionRecord, viewer: LiveViewerHandle): void {
		record.viewers.set(viewer.id, viewer);
		record.lastUsedAt = this.#opts.now();
	}

	removeViewer(record: SessionRecord, viewerId: string): void {
		record.viewers.delete(viewerId);
		// A dropped socket must not strand the lock.
		this.releaseControl(record, viewerId);
	}

	#broadcastLock(record: SessionRecord): void {
		const message = { type: 'lock', lock: record.lock };
		for (const viewer of record.viewers.values()) {
			try {
				viewer.send(message);
			} catch {
				// A viewer that cannot be written to is already gone; the socket's own close path removes it.
			}
		}
	}

	// --- teardown -----------------------------------------------------------

	/** Closes one session regardless of lock state (admin intent wins). */
	async close(sessionId: string, reason = 'session-closed'): Promise<boolean> {
		const record = this.#records.get(sessionId);
		if (record === undefined) return false;
		this.#records.delete(sessionId);
		// The owner's next omitted id makes a fresh default, as `default` does in `shared` mode.
		if (record.owner !== null && this.#ownerDefaults.get(record.owner) === sessionId) {
			this.#ownerDefaults.delete(record.owner);
		}
		record.detach?.();
		// A highlight timer must not outlive its session.
		if (record.highlight !== undefined) {
			clearTimeout(record.highlight.timer);
			record.highlight = undefined;
		}
		// The console claim's idle timer must not outlive its session, and the request log goes with it.
		this.#releaseConsoleClaim(record);
		record.network.close();
		// The ring is in memory and dies with the session: closing it releases every waiter (a `browser_wait_for` in
		// flight, an attached stream) rather than leaving them to their own timeouts.
		record.events.close();
		for (const viewer of record.viewers.values()) {
			try {
				viewer.close(reason);
			} catch { /* already gone */ }
		}
		record.viewers.clear();
		record.lock = null;
		await record.session.stop({ force: true, reason }).catch(() => record.session.kill().catch(() => {}));
		// Files live exactly as long as the session: capture has stopped with
		// the browser, so the directory goes — now, or once open reads have drained.
		await record.files.dispose();
		// An unprofiled session leaves nothing on disk, whatever it did while alive.
		if (record.profile === undefined && this.#opts.dataDir !== null) {
			await Deno.remove(`${this.#opts.dataDir}/sessions/${sessionId}.json`).catch(() => {});
		}
		this.#opts.logger?.info(`session ${sessionId} closed (${reason})`);
		this.#announce({ kind: 'session-removed', sessionId });
		return true;
	}

	/** Closes every session. Returns how many were closed. */
	async closeAll(reason = 'session-closed'): Promise<number> {
		const ids = [...this.#records.keys()];
		await Promise.all(ids.map((id) => this.close(id, reason)));
		return ids.length;
	}

	/** Closes sessions idle beyond the TTL. A session with viewers is never reaped. */
	async reap(): Promise<number> {
		const now = this.#opts.now();
		// Per record, not one global cutoff. A session that asked for a longer idle timeout gets
		// it; every other session keeps the registry's.
		const stale = [...this.#records.values()].filter(
			(record) =>
				record.viewers.size === 0 && record.lastUsedAt < now - (record.idleTimeoutMs ?? this.#opts.sessionTtlMs),
		);
		await Promise.all(stale.map((record) => this.close(record.id, 'idle-timeout')));
		return stale.length;
	}

	/** Stops the reaper, drains the startup sweep, and closes every session. */
	async shutdown(reason = 'server-shutdown'): Promise<void> {
		this.#closed = true;
		if (this.#reaper !== null) {
			clearInterval(this.#reaper);
			this.#reaper = null;
		}
		// The sweep is started in the constructor and normally awaited by the first launch.
		await this.#downloadsReady;
		await this.closeAll(reason);
	}

	#assertOpen(): void {
		if (this.#closed) throw new ToolError('browser-unavailable', 'the server is shutting down');
	}

	/** Shutdown has begun. */
	drain(): void {
		this.#draining = true;
	}

	get draining(): boolean {
		return this.#draining;
	}

	#assertNotDraining(): void {
		if (this.#draining) throw new ToolError('browser-unavailable', 'the server is shutting down');
	}

	#summarize(record: SessionRecord): SessionSummary {
		const summary: SessionSummary = {
			session_id: record.id,
			created_at: new Date(record.createdAt).toISOString(),
			last_used_at: new Date(record.lastUsedAt).toISOString(),
			tab_count: record.session.tabs.length,
			viewer_count: record.viewers.size,
			human_has_control: record.lock !== null,
		};
		if (record.label !== undefined) summary.label = record.label;
		if (record.profile !== undefined) summary.profile = record.profile;
		return summary;
	}
}
