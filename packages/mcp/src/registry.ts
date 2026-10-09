/**
 * The browser session registry — the single owner of `BrowserSession`
 * instances and of takeover-lock state (SPECS/ARCHITECTURE.md §4).
 *
 * The 2026-07-28 MCP revision is stateless per request, so browser
 * statefulness lives here rather than on a transport session: tools address a
 * session by id, and an omitted id means the lazily-created `default` session.
 */
import {
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
import { attachWatchdogs } from '@tykotech/browser';
import { isAbsolute, join, resolve } from '@std/path';
import { encodeBase64Url } from '@std/encoding/base64url';
import { ulid } from '@std/ulid';
import { AuditLedger } from './audit.ts';
import { canonicalHost, isHostAllowed, originOf, ToolError } from './errors.ts';
import { ConsoleProducer } from './page_console.ts';
import { DomSettleProducer } from './page_dom_settle.ts';
import { downloadPayload, formatCursor, navigationTarget, NetworkIdleCounter, SessionEventRing } from './events.ts';
import { PageInputProducer } from './page_input.ts';
import { downloadsRootOf, SessionFiles } from './files.ts';
import { NetworkLog } from './network_log.ts';
import { reapplyViewport } from './page_viewport.ts';

/** The reserved id used when a tool call omits `session_id`. */
export const DEFAULT_SESSION_ID = 'default';

/**
 * One document request the browser refused before sending it (R3, enforcement point E0, D-115). The origin only:
 * the refused URL is where a one-time code would be (E-78). `frameId` is kept so a tool can tell its own
 * main-frame navigation from a frame's or a pop-up's (F25).
 */
export interface DocumentBlock {
	readonly targetId: string | null;
	readonly frameId: string | null;
	readonly origin: string;
	/** The registry clock when the block was reported. */
	readonly at: number;
	/**
	 * The hostname the refused request's redirect chain **began** at (review R2-2, ERRATUM(E-94)'s `chainStart`), or
	 * `null` when the browser did not say. A host, not a URL: enough to tell a tool's own chain from one a page started.
	 */
	readonly chainHost: string | null;
}

/**
 * A fresh {@linkcode SessionRecord.incarnation}: 9 random bytes, base64url — exactly 12 characters, no padding
 * (containment-otel-links design §2.0 item 3).
 */
function newIncarnation(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(9)));
}

/** How many {@linkcode DocumentBlock}s a session remembers; the oldest is forgotten first. */
export const DOCUMENT_BLOCK_MEMORY = 16;

/** How many frames' last main-frame commit a session remembers (review R2-2); the stalest is forgotten first. */
export const COMMIT_MEMORY = 32;

/**
 * How long a `browser_console_log` claim keeps console capture armed after the last call (R4, design §2.6). The
 * claim is the tool's own refcount on the ring's `console` kind; it is released by this idle timer or by the
 * session closing, whichever comes first.
 */
export const CONSOLE_CLAIM_IDLE_MS = 600_000;

/**
 * The origin of the newest **main-frame** E0 block on `targetId` that belongs to the navigation a tool issued at
 * `since`, or `null` (R3, F25; review R2-2).
 *
 * The tools that issued a navigation — `browser_navigate`, `browser_go_back`, `browser_download`, the live view's
 * `navigate` — read it right after their dispatch, on the success and the failure path alike, to answer
 * `navigation-blocked` naming the origin instead of a generic browser error. Only the tool's **own** request chain
 * counts (design §2.5, review R2-2):
 *
 * - a block in a child frame or another tab is not the tool's navigation; for a page target Chrome's main-frame id is
 *   the target id;
 * - **once the tab committed a document after `since`, nothing refused is the tool's**: a refused chain never
 *   commits, so a commit means the tool's navigation landed (or an error page stands in for it), and a block after
 *   it is the landed page's own script — visible on the ring and in `browser_network_log`, never the tool's failure;
 * - when the tool knows the URL its chain began at (`requested`), a block whose chain began on another host is a
 *   navigation the page made while the tool's was in flight. Hosts, not origins: Chrome may upgrade an `http:`
 *   request it was handed to `https:` before the first hop is paused.
 *
 * `since` is on the registry's clock ({@linkcode SessionRegistry.now}).
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

/** A URL's hostname for chain attribution (review R2-2), lower-cased by the WHATWG parser; `null` when unparseable. */
function hostOf(url: string): string | null {
	const parsed = URL.parse(url);
	return parsed === null || parsed.hostname === '' ? null : parsed.hostname;
}

/**
 * `BrowserErrorEvent.errorType` for every domain-policy block the vendored `SecurityWatchdog` reports
 * (`packages/browser/src/watchdogs/security.ts`, `NAVIGATION_BLOCKED_ERROR`, which the barrel does not
 * export). The enforcement point travels in `details.enforcementPoint`.
 */
const NAVIGATION_BLOCKED_ERROR = 'NavigationBlocked';

/**
 * Minimum gap between two `info` lines about contained navigations in one session (D-095).
 *
 * A page can open and have closed a blocked pop-up as fast as its script loop runs. The event ring has its
 * own structural rate cap; the process log had none, so blocks inside the window are counted and reported
 * on the next line rather than written one per block.
 */
const BLOCK_LOG_INTERVAL_MS = 1000;

/**
 * `TTK_ALLOWED_DOMAINS` in the vendored matcher's pattern syntax, or `null` for "unrestricted" (D-095, C1).
 *
 * The two layers read a list differently, and the vendored one must not be handed the raw entries. The MCP
 * rule ({@linkcode isHostAllowed}) is host-or-any-subdomain with the port ignored. The vendored matcher reads
 * `example.com` as that exact host plus its `www.` variant, needs `*.example.com` for the subdomains (the
 * base included), and never lets a wildcard match an IP literal. So each entry is canonicalised by the MCP
 * rule's own `canonicalHost` — which drops a port, as that rule does — and becomes `*.<host>`, or the bare
 * host for an IP literal. The two then agree on every host (`browser_policy_test.ts`'s table, which carries
 * IPv6 in both spellings, case, the FQDN root dot and an empty last label).
 *
 * An entry the MCP rule cannot canonicalise matches nothing there, and must match nothing in the browser
 * either — so it becomes {@linkcode unmatchablePattern}, which the matcher refuses at compile time. It is NOT
 * passed through verbatim (ERRATUM(E-92), review R3-3): the matcher is more lenient than `canonicalHost` about
 * some text, and measured, an unbracketed IPv6 entry (`::1`, `fe80::1`) that the MCP rule cannot read is
 * bracketed and ACCEPTED by `parsePattern`, so a redirect to `http://[::1]:8787/` was let through by the browser
 * while `browser_navigate` refused the same URL. Dropping the entry instead could empty the list, and an empty
 * `allowedDomains` means "no restriction" to the matcher — the precedence trap SECURITY-AUTH.md §4.2 names.
 * An empty `TTK_ALLOWED_DOMAINS` is unrestricted in both layers (D-020).
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
 * A pattern the vendored matcher refuses whatever `entry` holds, still naming the entry in the matcher's
 * one-time warning (operator configuration, not a secret).
 *
 * `parsePattern` rejects any pattern whose host part — or, past a `://`, whose scheme — contains a space
 * (`NON_HOST_CHARS`, `SCHEME_SHAPE`), so a fixed prefix ending in a space is refused before the entry's own
 * text is read at all.
 */
export function unmatchablePattern(entry: string): string {
	return `unreadable-entry ${entry}`;
}

/**
 * The environment names every child this server spawns — Chromium and the recorder's ffmpeg — receives blank (R7, F2,
 * design §2.15, D-127).
 *
 * A child inherits the whole process environment (`clearEnv` is false in the vendored launcher, `launch.ts`), and two
 * kinds of value there were never meant for a browser a hostile page runs in: the OpenTelemetry exporter's settings —
 * `OTEL_EXPORTER_OTLP_HEADERS` is where a collector token goes — and the inline spellings of this server's secrets,
 * which an operator may set instead of their `*_FILE` twins. Each is overridden with `''` rather than removed, because
 * removing one would need `clearEnv`, and clearing the environment also drops `HTTP(S)_PROXY`, `ALL_PROXY`,
 * `NO_PROXY`, `LANG` and `TZ`, which Chromium does need (F6). A blank value carries nothing: no endpoint, no header,
 * no secret.
 *
 * The OTLP names are the endpoint, headers and protocol for all signals and for each one; that is the set Deno's
 * runtime reads (measured M1, 2.9.7). Applied on every OS: the inheritance is the same on all three.
 *
 * The three model-key names (D-143, D-145) are blanked for the same reason, not because the gateway reads them — it
 * never does; a provider key lives in `TTK_MODEL_PROVIDERS_FILE` or sealed in the database (D-154) — but because an
 * operator shell that exports one (for the test tier, or out of habit) would otherwise hand it to the browser a hostile
 * page runs in.
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
	'TTK_AGENT_BRIDGE_TOKEN',
	// D-143 / D-145: model-provider keys an operator shell may export; the gateway never reads them (see above).
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'TTK_MODEL_API_KEY',
];

/**
 * The environment overrides a spawned child receives: every {@linkcode CHILD_ENV_BLANKED} name set to `''` (D-127).
 * A fresh object per call, so a caller that adds to it cannot change what the next child gets.
 */
export function childEnvOverrides(): Record<string, string> {
	return Object.fromEntries(CHILD_ENV_BLANKED.map((name) => [name, '']));
}

/** What {@linkcode sessionProfile} composes a launch profile from. */
export interface SessionProfileInput {
	readonly headless: boolean;
	/** Absolute, server-owned download directory (E-33). */
	readonly downloadsDir: string;
	readonly browserPath: string | null;
	readonly browserArgs: readonly string[];
	/** A named profile's user-data directory, or `null` for a temporary one. */
	readonly userDataDir: string | null;
	/** The storage-state document the vendored watchdog loads and saves, or `null`. */
	readonly storageState: string | null;
	/** `TTK_CHROMIUM_NO_SANDBOX` inverted (D-094). */
	readonly chromiumSandbox: boolean;
	/** `TTK_ALLOWED_DOMAINS`, in the MCP rule's spelling (D-095). */
	readonly allowedDomains: readonly string[];
	/**
	 * `TTK_ALLOWED_DOMAINS_SCOPE` (D-138); absent means `documents`. With `all` and a non-empty allowlist the profile
	 * carries `requestScope: 'all'` and the resolver layer of {@linkcode resolverLayerRules}.
	 */
	readonly allowedDomainsScope?: 'documents' | 'all';
}

/** The Chromium switch the resolver layer is carried in (D-138); the operator's own value is folded into it. */
export const HOST_RESOLVER_RULES_FLAG = '--host-resolver-rules';

/**
 * Chromium switches that route the browser's traffic through a proxy. Under one, name resolution happens at the
 * proxy, so the resolver layer is bypassed and a WebSocket to an off-list host — which `Fetch` never sees — is not
 * refused (measured, design C9). `--no-proxy-server` is the opposite and is not listed.
 */
export const PROXY_FLAGS: readonly string[] = ['--proxy-server', '--proxy-pac-url', '--proxy-auto-detect'];

/** The startup caveat for `all` under a proxy (D-138, AC8) — the doctor prints the same sentence. */
export const PROXY_WEBSOCKET_CAVEAT =
	'TTK_ALLOWED_DOMAINS_SCOPE=all with a proxy flag in TTK_BROWSER_ARGS: under a proxy, WebSockets to off-list ' +
	'hosts are not refused (no CDP control); HTTP requests still are';

/**
 * What a resolver-layer host token may contain; anything else is skipped, so a rule can never void the flag (F9).
 *
 * No `*` (build-gate finding SB-1, a narrowing of design §2.5's `[a-z0-9.:*-]`): an entry `*` or `*.org` would be
 * written as `EXCLUDE *` / `EXCLUDE *.org`, and an `EXCLUDE` voids every `MAP` for the hosts it matches — so the
 * layer's `MAP * ~NOTFOUND` would silently stop refusing WebSockets, dns-prefetch and preconnect for every name (or
 * every `.org` name). Such an entry admits nothing in either other layer — {@linkcode browserAllowedDomains} turns it
 * into a `*.*…` pattern the matcher refuses, and `isHostAllowed` compares canonical hosts — so skipping it with the
 * warning keeps the three layers in agreement. The `EXCLUDE *.h` written for a name below is built after this check.
 */
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

/** A host as a resolver-rule token: lowercase, IPv6 unbracketed (`EXCLUDE ::1` works, `[::1]` does not — C8). */
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
 * The resolver layer for `TTK_ALLOWED_DOMAINS_SCOPE=all` (D-138, design §2.5): **one** `--host-resolver-rules` value
 * under which every name off the allowlist fails to resolve. It is the WebSocket control — `Fetch` never sees a
 * handshake (measured, C3) — and defence in depth for everything else (DNS, preconnect, a target `Fetch` could not
 * arm). In order, comma-joined:
 *
 * 1. the operator's own `--host-resolver-rules` value from `TTK_BROWSER_ARGS` (the last one, as Chromium reads it),
 *    first, because the first matching `MAP` wins (measured);
 * 2. per raw allowlist entry, from `canonicalHost` — not {@linkcode browserAllowedDomains}, whose output carries `*.`
 *    prefixes and unreadable-entry sentinels (F9): an IP literal becomes `EXCLUDE <ip>` (IPv6 unbracketed), a name `h`
 *    becomes `EXCLUDE h, EXCLUDE *.h` (exact does not cover subdomains, and the allowlist admits them). An entry
 *    `canonicalHost` cannot read, or whose host holds a character outside `[a-z0-9.:-]` (an `_` included, N7, and a
 *    `*`, SB-1), is skipped with a warning: it matches nothing in the matcher either, so skipping it fails closed;
 * 3. `EXCLUDE <proxy host>` for each host a `--proxy-server` names, so the proxy itself stays reachable;
 * 4. `MAP * ~NOTFOUND`.
 *
 * **An `EXCLUDE` voids every `MAP` for its host, the operator's included** (measured on Chrome 154 in the build: an
 * allowlisted name the operator maps, `MAP ttk-site-b.test 127.0.0.1`, stopped resolving once `EXCLUDE ttk-site-b.test`
 * joined the value, and Chromium's rule matcher checks the exclusions after a `MAP` matches). So a token an operator
 * `MAP` pattern already matches is not excluded: the operator's rule precedes the catch-all and gives the host its
 * address, which is what the exclusion was for. A port-qualified operator pattern counts for its host on every port —
 * the other ports then meet `MAP * ~NOTFOUND`, which fails closed.
 *
 * `onSkip` receives each skipped entry's warning (operator configuration, never a secret). A local browser only:
 * an attached one takes no launch arguments, and a proxy resolves names itself (C9) — the startup caveat.
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
 * The `BrowserProfile` a session launches with — the one place registry configuration becomes vendored
 * profile fields, so a test can assert on it without spawning Chromium.
 *
 * `chromiumSandbox` is set only when it is off, so a sandboxed launch carries exactly the profile it did
 * before D-094. `allowedDomains` is set only when the deployment restricts navigation (D-095); left unset it
 * is the vendored default `null`, which is unrestricted.
 *
 * `env` is always set (D-127): the blank overrides of {@linkcode childEnvOverrides}, which the vendored profile
 * already carries to the spawn (`toLaunchPlan` → `launchBrowser`), so no vendored code changes and E-104 is unused.
 *
 * D-138: with `allowedDomainsScope: 'all'` and a restricting allowlist, `requestScope: 'all'` reaches the vendored
 * profile (ERRATUM(E-114)) and the args carry exactly one `--host-resolver-rules`, the operator's own folded into the
 * {@linkcode resolverLayerRules} value. With `documents` the profile is byte-identical to before.
 */
export function sessionProfile(input: SessionProfileInput): BrowserProfileInit {
	const allowedDomains = browserAllowedDomains(input.allowedDomains);
	// D-138: `all` takes effect only over a non-empty allowlist (config refuses it without one). `documents` — and an
	// unrestricted deployment — leave the profile, and so the launch arguments, exactly as they were.
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

/**
 * A profile name that is safe as one path segment.
 *
 * A profile name reaches the filesystem, so it is constrained rather than
 * escaped: anything outside the allowed set becomes `_`, and traversal is
 * impossible because `.` and `/` are simply not in it.
 */
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
	/** The credential's label, shown to other viewers as `holderName` when this viewer holds the lock (B2.3). */
	readonly holderName?: string | null;
	/** Delivers a server→client control message. Implemented by the gateway. */
	send(message: unknown): void;
	/** Terminates the viewer connection. */
	close(reason: string): void;
}

/** Exclusive human control over a session. */
export interface TakeoverLock {
	readonly holder: string;
	readonly principal: string;
	readonly takenAt: number;
	/**
	 * The holder's credential label (`ApiKeyRecord.label`), for the `lock` message every viewer
	 * receives; `null` when the credential has none. Never written to the event ring, which carries
	 * the viewer id only (SR2-m4).
	 */
	readonly holderName: string | null;
}

/**
 * Who may reach a session (R8, `TTK_SESSION_OWNERSHIP`, design §2.16, D-128).
 *
 * `shared` (the default) is the behaviour every release before this one had: every principal holding `mcp:invoke`
 * reaches every session, and a session id is not authorization (SECURITY-AUTH §8.3). `owner` binds each session to
 * the principal that created it: another principal is answered `unknown-session` — never "forbidden", which would
 * confirm the session exists — unless it holds `admin`; and an omitted or `default` session id means *the caller's
 * own* default session, `default-<ulid>`, rather than one session everybody shares.
 */
export type SessionOwnership = 'shared' | 'owner';

/**
 * The caller a session lookup is made for (R8, design §2.16). Threaded through every lookup; `shared` mode ignores
 * it and `owner` mode filters on it. `owner` is the realm-qualified owner (D-068), `admin` whether the caller holds
 * the `admin` scope (an admin reaches every session, the `browser_audit` precedent).
 */
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
	/** The persistent profile backing this session, if any (R3). */
	profile?: string;
}

/**
 * One in-flight `browser_run_task` run (R2).
 *
 * It lives on the session rather than in `requestState` because `requestState`
 * round-trips through the client: a growing transcript there would be a large
 * attacker-controllable blob to re-validate every round, for no gain.
 */
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

/**
 * Something changed that a connected MCP client would want to know about (R4/R5).
 *
 * The registry is the only place that sees all of it — sessions coming and
 * going, locks being taken, pages navigating — so it is the only honest place
 * to announce it from. The gateway turns these into `notifications/tools/list_changed`
 * and `notifications/resources/updated`.
 */
export type RegistryChange =
	| { kind: 'session-added'; sessionId: string }
	| { kind: 'session-removed'; sessionId: string }
	| { kind: 'lock-changed'; sessionId: string }
	| { kind: 'page-changed'; sessionId: string }
	/** A download finished and became readable (E-33); the file resource list changed. */
	| { kind: 'files-changed'; sessionId: string };

/**
 * What a launcher hands back (E-33): the session, plus the download ledger the
 * attach step constructed and the directory it was told to write into. Tests
 * and edge nodes may still return a bare `BrowserSession`; the registry then
 * records a session with no files.
 */
export interface LaunchedSession {
	readonly session: BrowserSession;
	readonly downloads: DownloadsWatchdog | null;
	/**
	 * The dialog watchdog, when this launcher built one (B2.5, E-53).
	 *
	 * `browser_handle_dialog` answers a dialog through it, and the event ring arms manual handling on
	 * it. Optional and nullable for the same reason `downloads` is: an injected launcher in a test, or
	 * a remote attach, may produce a session with no watchdogs at all, and that costs the dialog tool
	 * rather than the launch.
	 */
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
	/** The session's downloaded files: listing, validated reads, and directory lifetime (E-33). */
	readonly files: SessionFiles;
	/**
	 * The dialog watchdog this session's launcher built, or `null` (B2.5, E-53).
	 *
	 * `browser_handle_dialog` answers through **this** instance and no other: the one that armed
	 * `Page.javascriptDialogOpening` is the only one holding anything to answer, which is the same
	 * rule `files` follows for the download ledger. `null` costs the dialog tool, never a launch.
	 */
	readonly popups: PopupsWatchdog | null;
	/**
	 * The download watchdog this session's launcher built, or `null` (A3, E-77).
	 *
	 * `browser_set_session_options {accept_downloads}` re-applies the download behaviour through **this**
	 * instance, for the reason `files` reads its ledger and `popups` answers its dialogs: it is the one that
	 * set `Browser.setDownloadBehavior` at connect and owns the directory that behaviour names. Re-issuing the
	 * command from anywhere else would move the browser without moving the watchdog.
	 */
	readonly downloads: DownloadsWatchdog | null;
	/**
	 * The session's event ring: the one owner of `seq`, the gap contract and the
	 * redaction contract (report_design.md §7). It sits beside `files` because
	 * both are per-session state that must outlive every viewer.
	 */
	readonly events: SessionEventRing;
	/**
	 * The session's audit ledger: every use of a server-held secret and every evaluated expression
	 * (B2.7, B2.8; design §6.5). It sits beside `files` and `events` for the same reason both do —
	 * per-session state that must outlive every viewer and die with the session. In memory only: a
	 * persistent record of which credential was spent against which origin is a target (SEC-08).
	 */
	readonly audit: AuditLedger;
	label?: string;
	/** The persistent profile this session is bound to, if any (R3). */
	profile?: string;
	/** The paused or in-flight agent run, if any (R2). */
	run?: AgentRun;
	/**
	 * The viewport this session is emulating, once a tool set one (B2.6).
	 *
	 * Undefined means "whatever the profile launched with", which is what `browser_get_session`
	 * reports then. Set here rather than on the vendored profile because a tool reaching into
	 * `BrowserSession.profile` would be mutating a vendored object from outside its package; the
	 * override outlives the tab it was set from because `TabCreatedEvent` re-applies it.
	 */
	viewport?: { width: number; height: number; device_scale: number };
	/**
	 * When this session last had **input** dispatched to it, as opposed to being read (B2.6).
	 *
	 * `lastUsedAt` moves on every tool call including a state read, so it cannot answer "is anyone
	 * actually driving this?". `browser_get_session` reports both, and `null` for a session that has
	 * only ever been observed.
	 */
	lastInputAt?: number;
	/**
	 * Per-session idle timeout in milliseconds (B2.6), overriding the registry-wide one.
	 *
	 * `sessionTtlMs` is registry-wide and `reap()` computed one global cutoff, so `idle_timeout_s` had
	 * no per-session concept at all until this field. Undefined means the registry's value.
	 */
	idleTimeoutMs?: number;
	/** Detaches the change watchers this record installed on its session. */
	detach?: () => void;
	/**
	 * The last focus this session *observed*, as an opaque signature (B1.9).
	 *
	 * The `focus` kind has no continuous source: focus is resolved from the
	 * accessibility tree during a state read, so a record is minted when a read
	 * finds the focus somewhere other than where the previous read left it. One
	 * bit of per-session memory is what turns "the focus is here" into "the focus
	 * moved", and it lives on the record rather than in a module-level map so it
	 * dies with the session it describes.
	 */
	lastFocus?: string | null;
	/**
	 * Downloads the ledger gate refused, guid to blocked **origin** — never the
	 * URL, which may carry a token. `browser_download` reads it to answer
	 * `navigation-blocked` naming only the origin.
	 */
	blockedDownloads?: Map<string, string>;
	/**
	 * The one server-drawn highlight this session may hold (B2.2), with the timer that hides it and
	 * the CDP session it was drawn in. Lives on the record so it dies with the session.
	 */
	highlight?: { readonly sessionId: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	/**
	 * The owner that created this session (R8, design §2.16, D-128), stamped at creation in `owner` mode; `null`
	 * in `shared` mode, which never reads it. Never rendered: a summary, a detail record and the event ring carry
	 * no owner.
	 */
	readonly owner: string | null;
	/**
	 * This record's incarnation (containment-otel-links design §2.0 item 3, §2.7, D-140): 12 base64url characters from
	 * 9 random bytes, drawn once at creation and never reused. A session id can be recreated after a close (`default`,
	 * always); the incarnation cannot, so a signed link bound to it stops at the close instead of reaching the next
	 * session under the same id. Never rendered: identifies the record to the link route only. S0: set, unread.
	 */
	readonly incarnation: string;
	/**
	 * The last {@linkcode DOCUMENT_BLOCK_MEMORY} document requests the browser refused before sending them (R3, E0),
	 * newest last; read through {@linkcode blockedSince}. Origins only.
	 */
	readonly documentBlocks: DocumentBlock[];
	/**
	 * Review R2-2: the registry-clock time of each frame's latest **main-frame** commit (`Page.frameNavigated` without a
	 * parent, or a same-document `Page.navigatedWithinDocument`), bounded by {@linkcode COMMIT_MEMORY}. What
	 * {@linkcode blockedSince} reads to tell the tool's own refused chain from the landed page's.
	 */
	readonly commits: Map<string, number>;
	/**
	 * The session's request log (R4, D-116): bounded metadata of every request its pages made, redacted at mint.
	 * Always on, re-armed across a reconnect, closed with the session.
	 */
	readonly network: NetworkLog;
	/**
	 * `browser_console_log`'s claim on the ring's `console` kind (R4), or `undefined` while no claim is held: when
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
	/**
	 * Root for persistent state (R3). `null` means every session is ephemeral:
	 * a fresh temporary profile that Chromium discards on exit.
	 */
	readonly dataDir?: string | null;
	/** Extra Chromium arguments. */
	readonly browserArgs?: readonly string[];
	readonly headless?: boolean;
	/** Injected clock so tests can drive expiry deterministically. */
	readonly now?: () => number;
	/** Sweep interval; `0` disables the background reaper (tests). */
	readonly reapIntervalMs?: number;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/**
	 * Builds and starts the browser for a session. Overridable so the registry's
	 * lifecycle rules can be tested without launching Chromium; production code
	 * leaves it unset and gets {@linkcode SessionRegistry.launchBrowserSession}.
	 */
	readonly launch?: (id: string, profile?: string) => Promise<BrowserSession | LaunchedSession>;
	/**
	 * `TTK_ALLOWED_DOMAINS`, applied at the download ledger (owner item 6) and, since D-095, handed to every
	 * session's vendored profile through {@linkcode browserAllowedDomains}.
	 *
	 * The tools gate the URL they are *given*; the browser follows redirects,
	 * and a `download.started` URL is the final one. A download that lands
	 * outside the list is cancelled through `Browser.cancelDownload` and its
	 * file record carries `navigation-blocked`. A navigation this server issued
	 * that lands outside it — a redirect, or a script navigation while the page
	 * loads — is parked on `about:blank`, and a pop-up that opens outside it is
	 * closed, by the vendored `SecurityWatchdog`. Since R3 (D-115, ERRATUM(E-94))
	 * the browser also refuses every off-list **document request** before it is
	 * sent — a clicked link, a script or meta-refresh navigation, a form POST, each
	 * redirect hop, a pop-up's or an iframe's first document — so the off-list host
	 * sees no request at all; E2/E3 remain as defence in depth. Empty means
	 * unrestricted, as everywhere else (D-020).
	 */
	readonly allowedDomains?: readonly string[];
	/**
	 * `false` launches Chromium without its sandbox (`TTK_CHROMIUM_NO_SANDBOX`, D-094). Default `true`.
	 *
	 * The registry is the one place this reaches the vendored profile, and {@linkcode SessionRegistry.chromiumSandboxed}
	 * reports it back from here — the value the launcher actually uses, never a second copy.
	 */
	readonly chromiumSandbox?: boolean;
	/** Session ownership (R8, `TTK_SESSION_OWNERSHIP`, design §2.16, D-128). Default `shared`. */
	readonly ownership?: SessionOwnership;
	/**
	 * Review R2-7: the server's secret redaction (`SecretStore.redact`), for the per-session buffers that **cap** text
	 * at mint — the request log's URLs and paths, the ring's console lines — so a configured secret is replaced before
	 * the cut and can never leave a prefix behind. The identity when absent (no secrets configured, or a test).
	 */
	readonly redact?: (text: string) => string;
	/**
	 * `TTK_ALLOWED_DOMAINS_SCOPE` (D-138). Default `documents`. Handed to {@linkcode sessionProfile} on every launch; with
	 * `all` under a proxy flag the constructor logs {@linkcode PROXY_WEBSOCKET_CAVEAT} once.
	 */
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
	/**
	 * `owner` mode (D-128): each owner's own default session, owner → session id. The mapping is dropped when that
	 * session closes, so the owner's next omitted id creates a fresh one, as `default` does in `shared` mode.
	 */
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
	/**
	 * The one-time sweep of the dedicated downloads subtree (E-33). Every directory
	 * under `<dataDir>/downloads` at startup belonged to a session of a previous
	 * process and can never be addressed again, so it is removed. Nothing else
	 * under the data root is touched — profiles, storage state and recordings are
	 * other owners' data. Launches await this so a fresh directory cannot be swept.
	 */
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

		// D-094: loud, once, at startup — and only where this registry will actually launch Chromium. An
		// injected launcher (an edge node, a test) never reaches the profile this setting changes.
		if (!this.#opts.chromiumSandbox && options.launch === undefined) {
			this.#opts.logger?.warn(
				'TTK_CHROMIUM_NO_SANDBOX is set: Chromium will be launched WITHOUT its sandbox (--no-sandbox). Every ' +
					'page it loads is untrusted content; use this only where the container or VM is the boundary.',
			);
		}

		// D-138 (AC8, AC13): the request scope's two startup notices, once, and only where this registry launches
		// Chromium — an attached or injected browser never receives the resolver layer. Allowlist entries the layer
		// cannot carry are named (F9, N7); under a proxy the WebSocket gap is stated (C9).
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

	/**
	 * The Chromium arguments this deployment launches with (`TTK_BROWSER_ARGS`).
	 *
	 * Published because `browser_head` has to know whether the browser was given a
	 * proxy flag it cannot follow (SR3-M2, D-049): the two egress paths are
	 * configured separately, and a tool that answered about the wrong one would be
	 * wrong in the shape of being right. Reading it from the registry keeps that
	 * check against the args the launcher **actually uses**, rather than against a
	 * second copy threaded through the tool context that could disagree.
	 */
	get browserArgs(): readonly string[] {
		return this.#opts.browserArgs;
	}

	/**
	 * Whether sessions launch with Chromium's sandbox (D-094) — `false` only under `TTK_CHROMIUM_NO_SANDBOX`.
	 *
	 * Read by `capabilities.tykotech.browser.sandboxed` and the diagnostics document for the same reason
	 * {@linkcode browserArgs} is published: from the registry the launcher reads, not from a second copy.
	 */
	get chromiumSandboxed(): boolean {
		return this.#opts.chromiumSandbox;
	}

	/** The session ownership mode this registry was built with (R8, `TTK_SESSION_OWNERSHIP`, D-128). */
	get ownership(): SessionOwnership {
		return this.#opts.ownership;
	}

	/** `owner` mode is on. */
	get #owned(): boolean {
		return this.#opts.ownership === 'owner';
	}

	/**
	 * The registry's clock (R3): what {@linkcode DocumentBlock.at} is stamped with, so a tool's `since` for
	 * {@linkcode blockedSince} is read from the same source as the blocks it is compared with.
	 */
	now(): number {
		return this.#opts.now();
	}

	/**
	 * Takes — or refreshes — `browser_console_log`'s claim on a session's console capture (R4, design §2.6).
	 *
	 * The first call arms the ring's `console` kind (one refcount, the same mechanism a stream subscriber uses) and
	 * remembers where capture began; every call restarts the {@linkcode CONSOLE_CLAIM_IDLE_MS} idle timer. The claim
	 * is released by that timer or by {@linkcode close}, so a model that stops asking stops costing the page a
	 * listener. The answer is the coverage boundary: console output from before `armedAt` was never captured for
	 * this claim, and a caller must not read its absence as quiet.
	 */
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

	/**
	 * Subscribes to registry changes. Returns an unsubscribe function.
	 *
	 * Watchers are notified synchronously and their exceptions are swallowed: a
	 * notification consumer must never be able to fail a browser operation.
	 */
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

	/**
	 * Every live record, for the callers that need more than a `SessionSummary` (B2.6).
	 *
	 * `browser_list_sessions` must carry the same fields `browser_get_session` does (AC-P1-26), and
	 * the only way to build one detail record from a summary would be to look the record up again by
	 * id — one lookup per session, and a second place that could disagree about what a session is.
	 */
	get records(): readonly SessionRecord[] {
		return [...this.#records.values()];
	}

	/** Looks up a record without creating one. */
	peek(sessionId: string): SessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	/**
	 * {@linkcode peek} on behalf of a caller (R8, design §2.16): never creates a session.
	 *
	 * In `shared` mode this is exactly `peek(sessionId ?? 'default')`. In `owner` mode an omitted or `default` id is
	 * the caller's own default session, and any other id is found only when the caller owns it or holds `admin`; a
	 * caller with no `access` finds nothing (fail closed).
	 */
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

	/** The live records a caller may see, in creation order (R8): all of them in `shared` mode or for `admin`. */
	visibleTo(access?: SessionAccess): readonly SessionRecord[] {
		if (!this.#owned) return this.records;
		return this.records.filter((record) => this.canAccess(record, access));
	}

	/** The session summaries a caller may see (R8); {@linkcode list} in `shared` mode. */
	listFor(access?: SessionAccess): SessionSummary[] {
		if (!this.#owned) return this.list();
		return this.visibleTo(access).map((record) => this.#summarize(record));
	}

	/**
	 * Whether a caller may reach `record` (R8, D-128): always in `shared` mode; in `owner` mode when the caller created
	 * it or holds `admin`, and never without an `access` to judge.
	 */
	canAccess(record: SessionRecord, access?: SessionAccess): boolean {
		if (!this.#owned) return true;
		if (access === undefined) return false;
		return access.admin || (record.owner !== null && record.owner === access.owner);
	}

	/**
	 * Resolves a session id to a live record.
	 *
	 * An omitted id resolves to {@linkcode DEFAULT_SESSION_ID}, which is
	 * created on demand. An explicit id that is not held is an error: silently
	 * minting a fresh session under a stale id would hand the caller a blank
	 * browser while it believed it had its own.
	 *
	 * `owner` mode (D-128): an omitted or `default` id is the caller's own default, `default-<ulid>`, created on
	 * demand and owned by it; an id another owner holds is `unknown-session` exactly as an id nobody holds is, so the
	 * answer confirms nothing, unless the caller holds `admin`. No `access` at all is refused the same way.
	 */
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

	/**
	 * Creates a new session under a freshly minted id.
	 *
	 * A `profile` name (R3) binds the session to a persistent Chromium user-data
	 * directory under the configured data root, so cookies and logins outlive the
	 * session. Two live sessions cannot share one profile: Chromium locks a
	 * user-data directory, and the second launch would fail in a way that reads
	 * like a browser crash.
	 *
	 * `owner` mode (D-128): the new session is owned by `access.owner`, and a call with no `access` is refused
	 * `unknown-session` (fail closed). Named profiles stay shared (G8): any caller may open one that is not open, and
	 * the "already open" refusal names the holding session only to a caller that could reach it.
	 */
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
				// F4: a foreign session id is never named, so the refusal cannot be used to learn one.
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

	/**
	 * The registry-wide idle timeout, in milliseconds (B2.6).
	 *
	 * Exposed because `browser_get_session` must report the timeout a session is **actually** subject
	 * to, and for every session that has not set its own that is this number. Reading it from the
	 * options rather than restating it in the tool is what stops the two from disagreeing.
	 */
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

	/**
	 * Allocates the absolute, server-owned download directory for one session incarnation (E-33).
	 *
	 * Under a data root it is `<dataDir>/downloads/<sessionId>-<ulid>`: the ulid means a recreated
	 * `default` can never inherit the previous incarnation's files or ids. Without a data root it is a
	 * fresh temporary directory in the same temp root the browser's own temporary profile lives in, so
	 * no launch surface needs a grant it did not already have. A directory that cannot be created is a
	 * visible failure, not a session that silently drops every download.
	 */
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
		// A named profile pins both the Chromium user-data directory (cookies,
		// localStorage, the whole profile) and the storage-state document the
		// vendored watchdog writes on stop, which is what makes a login survive a
		// restart rather than only a navigation.
		const dir = profile === undefined ? null : this.profileDir(profile);
		if (dir !== null) await Deno.mkdir(dir, { recursive: true }).catch(() => {});

		// E-33: the download directory is decided *before* the browser exists and handed to the
		// profile, because the watchdog reads `profile.downloadsPath` when the browser connects and
		// a path that is not absolute is refused by the containment contract.
		const downloadsDir = await this.#allocateDownloadsDir(id);
		if (!isAbsolute(downloadsDir)) {
			throw new ToolError('browser-unavailable', `download directory ${downloadsDir} is not absolute`);
		}

		// With a data root configured, *every* session gets a storage-state path,
		// not only profiled ones. The watchdog that implements save and load is
		// attached only when the profile names one (`shouldAttachStorageStateWatchdog`),
		// so without this `browser_storage_state` would dispatch into a session
		// with no handler and report success having done nothing. The auto-save at
		// teardown still only fires for a session that loaded state, and
		// {@linkcode SessionRegistry.close} removes the scratch file for an
		// unprofiled session — ephemeral has to stay ephemeral, cookies included.
		const scratchState = dir === null && this.#opts.dataDir !== null
			? `${this.#opts.dataDir}/sessions/${id}.json`
			: null;
		if (scratchState !== null) {
			await Deno.mkdir(`${this.#opts.dataDir}/sessions`, { recursive: true }).catch(() => {});
		}

		// D-095 (C1): the deployment allowlist reaches the vendored profile here, so `BrowserSession`'s own
		// pre-navigation check and the `SecurityWatchdog`'s three enforcement points — the veto, containment of
		// a redirect or load-time script navigation in a navigation this session issued, and new-tab
		// containment — run with the policy the tools gate on, rather than with the `null` policy they had
		// before. D-094: the sandbox setting rides the same profile.
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
				// D-138: `all` adds the request scope and the resolver layer; `documents` changes nothing.
				allowedDomainsScope: this.#opts.allowedDomainsScope,
			}),
		});
		let downloads: DownloadsWatchdog | null = null;
		let popups: PopupsWatchdog | null = null;
		try {
			// ERRATUM(E-20). These two were the other way round, which is exactly
			// the order `@tykotech/browser`'s own module note forbids: handlers run
			// in registration order, and the session's `BrowserStopEvent` handler
			// is the one that closes the CDP socket. Registering it first meant
			// every watchdog that needs a live connection at teardown got a dead
			// one — measured as `final storage-state save failed:
			// CdpDisconnectedError` on every close, so R3's whole promise (a login
			// that survives a restart) quietly did not hold. The same ordering also
			// governs the screencast's `Page.stopScreencast` and HAR body fetches.
			// E-33: keep the download ledger `attachWatchdogs` built. It is the one
			// instance that saw every CDP download event; attaching a second would
			// give the file tools a ledger of nothing.
			const attached = attachWatchdogs(session);
			downloads = attached.find((w): w is DownloadsWatchdog => w instanceof DownloadsWatchdog) ?? null;
			// E-53: the same "keep the instance `attachWatchdogs` built" rule as the download ledger.
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
				// K-3: an artifact (`browser_pdf {delivery:'file'}`) announces itself like a finished download (E-33).
				onChange: () => this.#announce({ kind: 'files-changed', sessionId: id }),
				...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			}),
			events: new SessionEventRing({
				now: this.#opts.now,
				...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			}),
			audit: new AuditLedger({ now: this.#opts.now }),
			// R8 (D-128): stamped before the record is visible to anyone, so no lookup or `session-added` watcher can
			// see an owned session without its owner.
			owner: owned?.owner ?? null,
			// D-140 (design §2.0 item 3): the one creation site, so every record has exactly one incarnation.
			incarnation: newIncarnation(),
			// R3 (E0) and R4: per-session state that dies with the session, like `events` and `audit`.
			documentBlocks: [],
			commits: new Map(),
			network: new NetworkLog({ now: this.#opts.now, redact: this.#opts.redact }),
		};
		this.#records.set(id, record);
		if (owned?.ownerDefault === true) this.#ownerDefaults.set(owned.owner, id);

		// The `console` producer (item 3 / B1.9's console half). It attaches its
		// CDP listeners only while the ring's console refcount is above zero, so
		// the ring drives it through `setConsoleArmed` — console output before the
		// first subscriber does not exist, and the arm/disarm transitions are on
		// the stream as control records. A session with no CDP client (remote
		// attach) gets no producer and the refcount still exists, so a consumer
		// always reads a coverage boundary rather than inferring one.
		const consoleProducer = ConsoleProducer.attach(record, this.#opts.redact);
		if (consoleProducer !== null) record.events.setConsoleArmed(consoleProducer.setArmed);

		// E-53, the same shape for dialogs. A held dialog blocks the whole CDP channel for its target,
		// so the hold is armed only while something is actually listening for `dialog` records — a
		// client that asked to be told about dialogs is by construction one that can answer them, and
		// with no subscriber the watchdog answers by policy exactly as it did in 0.1.0.
		if (popups !== null) record.events.setDialogArmed((armed) => popups.setManualHandling(armed));

		// The page changing is the event a resource subscriber is waiting for, and
		// the registry is where every session can be watched from — the live view's
		// own subscription exists only while a viewer is attached. The same
		// subscriptions feed the event ring, because this is already the one place
		// a per-session subscription outlives its viewers.
		// D-095: navigations the `SecurityWatchdog` contained (E2) whose own `NavigationCompleteEvent` has not
		// reached the handler below yet. The watchdog runs first — watchdogs attach before this subscription —
		// and its `blocked` record already describes that navigation, so a plain record minted after it would
		// tell a consumer the tab is on a page it was just taken off. Keyed by target and URL; bounded.
		const containedNavigations = new Set<string>();
		const offNavigate = session.eventBus.on(NavigationCompleteEvent, (event) => {
			if (containedNavigations.delete(`${event.targetId}\n${event.url}`)) {
				this.#announce({ kind: 'page-changed', sessionId: id });
				return;
			}
			// origin + path + has_query, never a URL string: a navigation URL is
			// exactly where a one-time code or session token appears (SECURITY-AUTH §8.3).
			record.events.append('navigation', {
				frame_id: event.targetId,
				...navigationTarget(event.url),
				// `null`, not `'user'`. The bus event carries no commit cause, and a
				// hard-coded `'user'` attributed a hostile page's own
				// `location.href =` redirect to the human in a cross-principal audit
				// record. An unknown reported as unknown is worth more than a
				// plausible one that is wrong; a later slice reading
				// `Page.frameNavigated`'s own type can fill it in.
				reason: null,
				committed: event.errorMessage === null,
			}, event.targetId);
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		const offOpened = session.eventBus.on(TabCreatedEvent, (event) => {
			record.events.append('tab', { action: 'opened', tab_id: event.targetId, opener_tab_id: null }, event.targetId);
			// B2.6: a tool-set viewport outlives the tab it was set from. Without this a session that
			// opened a second tab would silently be emulating two different viewports, and a recording
			// replaying into a popup would replay at the wrong one.
			void reapplyViewport(record, event.targetId).catch(() => {});
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		const offClosed = session.eventBus.on(TabClosedEvent, (event) => {
			record.events.append('tab', { action: 'closed', tab_id: event.targetId, opener_tab_id: null }, event.targetId);
			this.#announce({ kind: 'page-changed', sessionId: id });
		});
		// A finished download is a new resource (E-33); subscribers learn of it the
		// same way they learn of a navigation.
		const offDownloaded = session.eventBus.on(FileDownloadedEvent, () => {
			// **No ring record is minted here.** The watchdog's `completed` phase
			// already mints one below, through `downloadPayload`, and this event
			// fires for the same download — so a literal here both double-counted
			// every completion and put a second, unguarded producer beside an event
			// object that carries `url`. `downloadPayload`'s input type has no
			// `url` field at all, which is the whole point: the redaction cannot be
			// undone by an edit that looks like a tidy-up. This subscription now
			// does only what it did before B1.7 — announce that the file list
			// changed (E-33).
			this.#announce({ kind: 'files-changed', sessionId: id });
		});
		// `message` is page-authored text and is capped at mint. A `prompt`'s
		// *entered* text never appears in any event.
		const offDialog = session.eventBus.on(DialogOpenedEvent, (event) => {
			record.events.append('dialog', {
				// E-53. Was `event.frameId ?? ''` — and `Page.javascriptDialogOpening` carries no frameId,
				// so the field the wire calls `dialog_id` was always the empty string. It is now the id
				// the watchdog holds the dialog under, which is what makes `browser_handle_dialog`
				// addressable; it stays `''` when no subscriber armed the hold, because nothing is held.
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
				// R4 (D-116): the request log rides the same arming, so a reconnect re-arms it on the new client.
				record.network.attach(client),
				// Review R2-2: main-frame commits, which end a tool's own navigation chain (`blockedSince`).
				client.on('Page.frameNavigated', (params) => {
					if (params.frame.parentId === undefined) noteCommit(params.frame.id);
				}),
				client.on('Page.navigatedWithinDocument', (params) => noteCommit(params.frameId)),
			];
		};
		armNetwork();
		// U-5's marker. Whether the record — and with it the `seq` counter and the
		// ring — survives a browser crash is unproven; either way the discontinuity
		// is on the stream, so a consumer never has to infer it from silence. The
		// network subscriptions are re-armed here because a reconnect replaces the
		// client the first arming subscribed to.
		const offRecovered = session.eventBus.on(BrowserReconnectedEvent, () => {
			idle.reset();
			armNetwork();
			record.events.appendControl('browser-recovered');
		});
		// F4 (ARCHITECTURE §5): a crashed target or a browser that could not be reconnected leaves nothing to drive or
		// watch. Viewers are told why, the stream records it, and the session is torn down — deferred, so the teardown
		// never runs inside the bus handler that reported the crash. Other `BrowserErrorEvent`s (a blocked navigation,
		// a rejected download) are refusals the session survives.
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
		// D-095 (C1): what the domain policy contained, on the stream and in the log. E2 is a navigation that
		// landed off the allowlist (a redirect, or a script navigation inside a navigation this session issued)
		// and was parked on `about:blank`; E3 is a new tab that opened, or first navigated, off the allowlist
		// and was closed. E1 — the pre-navigation veto — is a refusal the calling tool already reports, and
		// nothing happened in the browser to record. R3 (D-115): E0 is a document request — any frame, any tab,
		// any cause, each redirect hop — the browser refused before sending it; the vendored watchdog suppresses
		// its own E2/E3 for the same block, so one refusal is one record here.
		let blocksSinceLog = 0;
		let lastBlockLogAt = Number.NEGATIVE_INFINITY;
		const contained = (details: Record<string, unknown>): void => {
			const point = details.enforcementPoint;
			if (point !== 'E0' && point !== 'E2' && point !== 'E3') return;
			const url = typeof details.url === 'string' ? details.url : '';
			// D-138 / D-139 (F16): a refused subresource or hint (ERRATUM(E-114/E-115), `requestKind`) is no one's
			// navigation. It takes the log path only — no ring record, no `documentBlocks` (so never `blockedSince`), no
			// `containedNavigations`, no `page-changed` — and is counted by the same rate-limited, origin-only line. The
			// vendored side already reports only the first refusal of an origin per tab per document (and none for
			// non-page targets), so this cannot flood either; per-request detail is in the request log.
			const requestKind = details.requestKind;
			if (point === 'E0' && (requestKind === 'subresource' || requestKind === 'hint')) {
				logBlock(`request refused before it was sent (${requestKind})`, url, 'request-blocked');
				return;
			}
			const targetId = typeof details.targetId === 'string' ? details.targetId : null;
			// R3 / F25: E0 names the frame whose document was refused; E2/E3 act on a whole tab.
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
			// Review R2-1: a refused speculative request (`Prefetch`) is recorded, but it is nobody's navigation, so it
			// never answers a tool through `blockedSince`.
			if (point === 'E0' && details.resourceType !== 'Prefetch') {
				// R3 (D-115): what `blockedSince` reads. Origin only, as everywhere a blocked URL is kept — plus, review R2-2,
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
				// reports, and whether that document committed is not observed — so it is not claimed. E0's request
				// was never sent, so nothing committed.
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
		// The started/failed halves come from the watchdog's synchronous channel:
		// the bus has no failure event, and `download.failed` must carry the closed
		// reason enum rather than the watchdog's free-text `error`.
		// Guarded rather than called through the declared type: `LaunchedSession`
		// permits an injected ledger, and the tree's test doubles implement the
		// listing half without the synchronous channel. A missing channel costs
		// the started/failed halves, never a launch.
		const offDownloadSignal = typeof downloads?.addDownloadListener !== 'function'
			? undefined
			: downloads.addDownloadListener((signal) => {
				if (signal.phase === 'started') {
					record.events.append('download.started', downloadPayload('download.started', signal.download));
					// The ledger gate. `signal.download.url` is the URL Chromium is
					// downloading *from* — final, after every redirect — so this is
					// where an off-allowlist redirect from `browser_download {url}`,
					// a JS-driven download from `{index}`, and any other path that
					// ends in a download are all caught by one rule. Deferred a
					// microtask: the listener runs inside the watchdog's own emit
					// loop and must not re-enter it.
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
					// B2.9: the digest is started here because this is the moment the bytes stop changing,
					// and it is the cheapest point to pay for the hash - by the time a caller lists the
					// session's files it is usually already there. Deliberately not awaited and deliberately
					// not on the event: `download.done` is minted synchronously inside the watchdog's emit
					// loop, so putting `sha256` on it would mean either delaying the record or emitting a
					// null nobody could distinguish from "no digest". `browser_list_files` is authoritative.
					record.files.startDigest(signal.download.guid);
					return;
				}
				if (signal.phase === 'failed' || signal.phase === 'canceled') {
					record.events.append('download.failed', downloadPayload('download.failed', signal.download));
				}
			});
		// The `dom.settled` producer (item 3, D-8). It owns the settle debounce and
		// the token read; the shared injection reports mutation counts to it
		// through the input producer's `onMutation`. Minting is gated on the ring's
		// dom.settled refcount, so an unwatched session does no reads.
		const settle = new DomSettleProducer({
			record,
			...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
		});

		// The `input` producer (B1.9). It is armed beside the network subscriptions
		// and re-armed on the same reconnect, because both attach to a CDP client a
		// reconnect replaces. The producer is the page, so every field of the
		// record it mints is derived server-side — see `page_input.ts`.
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
			// The console producer's client was replaced too; rebuild it and hand
			// the ring the new arm callback so a live console subscription keeps
			// receiving records across the reconnect.
			consoleProd?.dispose();
			consoleProd = ConsoleProducer.attach(record);
			if (consoleProd !== null) record.events.setConsoleArmed(consoleProd.setArmed);
		});
		record.detach = () => {
			// Removal first: without it the injected listener and a live binding
			// survive in every frame for the session's life after its last
			// subscriber has gone.
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

	/**
	 * Refuses a mutating operation while a human holds the session.
	 *
	 * Read-only tools never call this: observation stays available so a model
	 * can see what the human is doing rather than going blind mid-task.
	 */
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
		// A human taking the session is a coverage boundary for every consumer of
		// the ring, not only for the viewers the lock broadcast reaches.
		// `holder_name` is the viewer's server-minted id, not its identity. The
		// principal is deliberately absent: the ring is replayable to every
		// `mcp:invoke` holder, `browser_list_sessions` publishes only
		// `human_has_control: boolean`, and I-8 permits nothing an ordinary read
		// could not already obtain. Under anonymous loopback the principal is
		// `anonymous:<remoteAddr>`, so this would have put a human's network
		// address on an event stream.
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
				// A viewer that cannot be written to is already gone; the socket's
				// own close path removes it.
			}
		}
	}

	// --- teardown -----------------------------------------------------------

	/** Closes one session regardless of lock state (admin intent wins). */
	async close(sessionId: string, reason = 'session-closed'): Promise<boolean> {
		const record = this.#records.get(sessionId);
		if (record === undefined) return false;
		this.#records.delete(sessionId);
		// D-128: the owner's next omitted id makes a fresh default, as `default` does in `shared` mode.
		if (record.owner !== null && this.#ownerDefaults.get(record.owner) === sessionId) {
			this.#ownerDefaults.delete(record.owner);
		}
		record.detach?.();
		// A highlight timer must not outlive its session (B2.2).
		if (record.highlight !== undefined) {
			clearTimeout(record.highlight.timer);
			record.highlight = undefined;
		}
		// R4: the console claim's idle timer must not outlive its session, and the request log goes with it.
		this.#releaseConsoleClaim(record);
		record.network.close();
		// The ring is in memory and dies with the session: closing it releases every
		// waiter (a `browser_wait_for` in flight, an attached stream) rather than
		// leaving them to their own timeouts.
		record.events.close();
		for (const viewer of record.viewers.values()) {
			try {
				viewer.close(reason);
			} catch { /* already gone */ }
		}
		record.viewers.clear();
		record.lock = null;
		await record.session.stop({ force: true, reason }).catch(() => record.session.kill().catch(() => {}));
		// Files live exactly as long as the session (E-33): capture has stopped with
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
		// B2.6: per record, not one global cutoff. A session that asked for a longer idle timeout gets
		// it; every other session keeps the registry's, which is what the single cutoff used to mean.
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
		// The sweep is started in the constructor and normally awaited by the first
		// launch. A registry that shuts down before ever launching must still wait
		// for it: an unawaited directory read outliving its owner is a leaked async
		// operation, which is a flaky test today and an unexplained warning later.
		await this.#downloadsReady;
		await this.closeAll(reason);
	}

	#assertOpen(): void {
		if (this.#closed) throw new ToolError('browser-unavailable', 'the server is shutting down');
	}

	/**
	 * F5 (BACKEND §7 stage 1): shutdown has begun. Sessions that exist keep serving the work already in flight; no
	 * new one is launched, since it would only be torn down a moment later.
	 */
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
