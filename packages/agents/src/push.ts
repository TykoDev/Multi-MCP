/**
 * A11 (D-106): A2A push notifications — per-task webhook configurations and their delivery.
 *
 * A webhook is a URL a **caller** chooses and this server then dials on its own, which is the shape of a server-side
 * request forgery. So push is not on by default and is bounded at every step:
 *
 * - **Offered only by the operator.** The runtime offers push only when its composition root passes
 *   {@linkcode PushOptions}; the gateway does that only when `TTK_A2A_PUSH_ALLOWED_HOSTS` is non-empty **and** the
 *   process holds a proven outbound net grant for every host on it (handoff obligation N1). Otherwise every push
 *   method answers `-32003` and the card says `pushNotifications: false`.
 * - **The URL.** `https:` only, no credentials, no fragment, and its host (with a non-default port named exactly)
 *   must be on the operator's list. An IP-literal host on a private, loopback, link-local, CGNAT or metadata range is
 *   refused when the configuration is created.
 * - **Every delivery re-checks the URL against the policy as it is now** (review R2-4), and so does a restart for
 *   every configuration it restores: one whose host left the list is dropped, never dialled.
 * - **Every delivery attempt re-checks the address**: the host is resolved and every address it resolves to must be
 *   public — a DNS answer mixing a public and a private address is refused — immediately before connecting. `fetch`
 *   resolves the name again itself, so a DNS-rebinding window remains between the check and the connect; it is
 *   bounded to hosts the operator listed, and documented (design §2.7).
 * - **The request.** `POST` of the task status update as JSON, `redirect: 'error'`, 5 s per attempt, at most three
 *   retries for a network failure, a timeout, `408`, `429` or a `5xx`; never for another status. The configuration's
 *   token is echoed in `X-A2A-Notification-Token` and never logged; a log line names the webhook's origin only (a
 *   path or query can carry a capability URL).
 *
 * The address classifier is injected ({@linkcode PushOptions.forbiddenAddress}) rather than restated: the gateway
 * passes the one `@tykotech/mcp` uses for `browser_head`, and this package stays dependency-free for the runner image.
 */
import { AgentError, identifier, object } from './util.ts';

/** At most this many webhook configurations per task (design §2.7). */
export const MAX_PUSH_CONFIGS_PER_TASK = 4;
/** One delivery attempt's budget. */
export const PUSH_TIMEOUT_MS = 5_000;
/** Retries after the first attempt. */
export const PUSH_RETRIES = 3;
/** Deliveries in flight at once across every task; more wait their turn. */
const PUSH_CONCURRENCY = 8;
/** Deliveries queued at once; past this, new ones are dropped and logged rather than held without bound. */
const PUSH_QUEUE = 256;

/** One stored webhook. The token is kept to be echoed, and never returned by a read (secrets never round-trip). */
export interface PushConfig {
	readonly id: string;
	readonly url: string;
	readonly token?: string;
}

/** The operator's push policy; its presence is what offers push at all. */
export interface PushOptions {
	/** Exact hosts, lower case: `host` (default port only) or `host:port`; IPv6 bracketed. */
	readonly allowedHosts: readonly string[];
	/**
	 * Whether a bare IP address (dotted IPv4, or IPv6 without brackets) is one this server must never dial:
	 * private, loopback, link-local, CGNAT, metadata, multicast, reserved.
	 */
	readonly forbiddenAddress: (address: string) => boolean;
	/** The host's addresses; `Deno.resolveDns` for A and AAAA by default. */
	readonly resolve?: (hostname: string) => Promise<readonly string[]>;
	/**
	 * Whether push may be offered right now (build gate B-6). Under a scoped net grant every delivery's address check
	 * needs the DNS resolver's own grant, which no permission query can prove ahead of time; the gateway answers this
	 * from a one-time resolver probe. Absent means ready.
	 */
	readonly ready?: () => boolean;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly retries?: number;
	/** First retry delay; doubled for each later one. */
	readonly backoffMs?: number;
	/**
	 * Tests only: accept `http:` to a loopback literal on the allowlist, exempt from the address check. Nothing in
	 * the gateway's configuration can set it.
	 */
	readonly allowLoopbackHttp?: boolean;
	readonly logger?: { warn(message: string): void };
}

/** A delivery the address policy refuses: logged once, never retried. */
class PushRefused extends Error {}

/**
 * The webhook a create request names, in either spelling A2A clients send: a `PushNotificationConfig` itself
 * (`{id?, url, token?}`) or a `TaskPushNotificationConfig` wrapping one (`{pushNotificationConfig: {...}}`).
 * `authentication` with schemes or credentials is refused: holding a third party's credential to replay at a webhook
 * is not something this server does, and the token covers the receiver's check.
 */
export function pushConfigInput(value: unknown, configId?: unknown): { id?: string; url: string; token?: string } {
	const raw = object(value);
	const inner = raw.pushNotificationConfig === undefined ? raw : object(raw.pushNotificationConfig);
	if (typeof inner.url !== 'string' || inner.url.length > 2048) {
		throw new AgentError(-32602, 'Invalid push notification URL');
	}
	const token = inner.token;
	if (token !== undefined && (typeof token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(token))) {
		throw new AgentError(-32602, 'Invalid push notification token');
	}
	if (inner.authentication !== undefined) {
		const authentication = object(inner.authentication);
		const schemes = authentication.schemes;
		if (authentication.credentials !== undefined || (Array.isArray(schemes) && schemes.length > 0)) {
			throw new AgentError(-32602, 'Push authentication schemes are unsupported; use token');
		}
	}
	const id = configId ?? inner.id ?? (inner === raw ? undefined : raw.id);
	if (id !== undefined && id !== '' && (identifier(id).length > 128)) {
		throw new AgentError(-32602, 'Invalid push notification config id');
	}
	return {
		...(id === undefined || id === '' ? {} : { id: String(id) }),
		url: inner.url,
		...(token === undefined ? {} : { token: token as string }),
	};
}

/** A webhook's origin for a log line (a path or query can carry a capability URL), or a placeholder. */
export function pushOrigin(raw: string): string {
	try {
		return new URL(raw).origin;
	} catch {
		return 'an unparseable URL';
	}
}

/** The bare IP address a URL hostname spells, or `null` for a name. */
function ipLiteral(hostname: string): string | null {
	if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? hostname : null;
}

function isLoopbackLiteral(hostname: string): boolean {
	return hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** A and AAAA together; a name that answers neither is an error, and a single failing family is not. */
async function resolveHost(hostname: string): Promise<readonly string[]> {
	const results = await Promise.allSettled([Deno.resolveDns(hostname, 'A'), Deno.resolveDns(hostname, 'AAAA')]);
	const addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
	if (addresses.length === 0) {
		const failure = results.find((result) => result.status === 'rejected');
		throw failure?.status === 'rejected' ? failure.reason : new Error('no address');
	}
	return addresses;
}

/** Validates webhook URLs against the policy and delivers status updates to them. */
export class PushDispatcher {
	readonly #options: PushOptions;
	readonly #fetch: typeof fetch;
	readonly #resolve: (hostname: string) => Promise<readonly string[]>;
	readonly #controller = new AbortController();
	readonly #chains = new Map<string, Promise<void>>();
	#queued = 0;
	#active = 0;
	#waiting: (() => void)[] = [];
	#closed = false;

	constructor(options: PushOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
		this.#resolve = options.resolve ?? resolveHost;
	}

	/** The URL a configuration may name, or a `-32602` naming what is wrong (never echoing the URL itself). */
	target(raw: string): URL {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new AgentError(-32602, 'Invalid push notification URL');
		}
		if (url.username || url.password || url.hash) {
			throw new AgentError(-32602, 'A push notification URL may carry no credentials or fragment');
		}
		const loopbackTest = this.#loopbackTest(url);
		if (url.protocol !== 'https:' && !loopbackTest) {
			throw new AgentError(-32602, 'A push notification URL must use https');
		}
		const host = url.hostname.toLowerCase();
		const named = url.port === '' ? host : `${host}:${url.port}`;
		if (!this.#options.allowedHosts.includes(named)) {
			throw new AgentError(-32602, 'Push notification host is not on the operator allowlist');
		}
		const literal = ipLiteral(host);
		if (!loopbackTest && literal !== null && this.#options.forbiddenAddress(literal)) {
			throw new AgentError(-32602, 'Push notification address is private, loopback or link-local');
		}
		return url;
	}

	/** Queues one POST of `payload` to each configuration, in order per configuration. */
	deliver(taskId: string, configs: readonly PushConfig[], payload: Record<string, unknown>): void {
		if (this.#closed || configs.length === 0) return;
		const body = JSON.stringify(payload);
		for (const config of configs) {
			if (this.#queued >= PUSH_QUEUE) {
				this.#options.logger?.warn('push notification queue is full; a status update was not delivered');
				continue;
			}
			this.#queued++;
			const key = `${taskId}\u0000${config.id}`;
			const next: Promise<void> = (this.#chains.get(key) ?? Promise.resolve())
				.then(() => this.#send(config, body))
				.catch(() => {})
				.finally(() => {
					this.#queued--;
					if (this.#chains.get(key) === next) this.#chains.delete(key);
				});
			this.#chains.set(key, next);
		}
	}

	/** Aborts every attempt and backoff in flight; queued deliveries are dropped. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#controller.abort();
		for (const wake of this.#waiting.splice(0)) wake();
		await Promise.allSettled([...this.#chains.values()]);
	}

	#loopbackTest(url: URL): boolean {
		return this.#options.allowLoopbackHttp === true && url.protocol === 'http:' && isLoopbackLiteral(url.hostname);
	}

	/** Every address the host resolves to must be public; checked before each attempt, never cached. */
	async #check(url: URL): Promise<void> {
		if (this.#loopbackTest(url)) return;
		const literal = ipLiteral(url.hostname);
		const addresses = literal === null ? await this.#resolve(url.hostname) : [literal];
		if (addresses.length === 0) throw new PushRefused('the host resolved to no address');
		if (addresses.some((address) => this.#options.forbiddenAddress(address))) {
			throw new PushRefused('the host resolves to a private, loopback or link-local address');
		}
	}

	async #slot(): Promise<void> {
		while (this.#active >= PUSH_CONCURRENCY && !this.#closed) {
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		this.#active++;
	}

	#release(): void {
		this.#active--;
		this.#waiting.shift()?.();
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const signal = this.#controller.signal;
			const timer = setTimeout(done, ms);
			function done(): void {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			}
			signal.addEventListener('abort', done, { once: true });
		});
	}

	async #send(config: PushConfig, body: string): Promise<void> {
		// Review R2-4: the configuration is held to the operator's policy as it is now, not as it was when the
		// configuration was created (or restored): a host taken off the list is never dialled again.
		let url: URL;
		try {
			url = this.target(config.url);
		} catch {
			this.#options.logger?.warn(
				`push notification to ${pushOrigin(config.url)} refused: the URL is no longer allowed by the operator policy`,
			);
			return;
		}
		const retries = this.#options.retries ?? PUSH_RETRIES;
		const backoffMs = this.#options.backoffMs ?? 1_000;
		let outcome = 'no attempt was made';
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (this.#closed) return;
			if (attempt > 0) await this.#sleep(backoffMs * 2 ** (attempt - 1));
			if (this.#closed) return;
			await this.#slot();
			try {
				await this.#check(url);
				const response = await this.#fetch(url, {
					method: 'POST',
					redirect: 'error',
					headers: {
						'content-type': 'application/json',
						'a2a-version': '1.0',
						...(config.token === undefined ? {} : { 'x-a2a-notification-token': config.token }),
					},
					body,
					signal: AbortSignal.any([
						this.#controller.signal,
						AbortSignal.timeout(this.#options.timeoutMs ?? PUSH_TIMEOUT_MS),
					]),
				});
				await response.body?.cancel().catch(() => {});
				if (response.ok) return;
				outcome = `status ${response.status}`;
				if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
			} catch (cause) {
				if (cause instanceof PushRefused) {
					this.#options.logger?.warn(`push notification to ${url.origin} refused: ${cause.message}`);
					return;
				}
				if (this.#closed) return;
				outcome = cause instanceof DOMException && cause.name === 'TimeoutError'
					? 'timed out'
					: cause instanceof Deno.errors.NotCapable
					? 'no outbound net grant for the host or its resolver'
					: 'network failure';
			} finally {
				this.#release();
			}
		}
		this.#options.logger?.warn(`push notification to ${url.origin} was not delivered (${outcome})`);
	}
}
