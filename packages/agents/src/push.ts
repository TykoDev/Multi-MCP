/**
 * A2A push notifications. A webhook is a URL a caller chooses and this server dials, the shape of an SSRF, so:
 *
 * - Push is offered only when the gateway passes {@linkcode PushOptions} (`TTK_A2A_PUSH_ALLOWED_HOSTS` set and a
 *   proven net grant for every host); otherwise every push method answers `-32003`.
 * - The URL is `https:`, without credentials or fragment, its host (with a non-default port named exactly) on the
 *   operator's list; a private/loopback/link-local IP literal is refused at creation.
 * - Every delivery and every restart re-checks the URL against the policy as it is now.
 * - Every attempt resolves the host and refuses it unless every address is public. `fetch` resolves again, so a
 *   DNS-rebinding window remains, bounded to hosts the operator listed.
 * - `POST`, `redirect: 'error'`, 5 s per attempt, at most three retries for a network failure, timeout, 408, 429 or
 *   5xx. The token travels in `X-A2A-Notification-Token` and is never logged; log lines name the origin only.
 */
import { AgentError, identifier, object } from './util.ts';

/** At most this many webhook configurations per task. */
export const MAX_PUSH_CONFIGS_PER_TASK = 4;
/** One delivery attempt's budget. */
const PUSH_TIMEOUT_MS = 5_000;
/** Retries after the first attempt. */
const PUSH_RETRIES = 3;
/** Deliveries in flight at once across every task. */
const PUSH_CONCURRENCY = 8;
/** Deliveries queued at once; past this, new ones are dropped and logged. */
const PUSH_QUEUE = 256;

/** One stored webhook. The token is echoed to the receiver and never returned by a read. */
export interface PushConfig {
	readonly id: string;
	readonly url: string;
	readonly token?: string;
}

/** The operator's push policy; its presence is what offers push at all. */
export interface PushOptions {
	/** Exact hosts, lower case: `host` (default port only) or `host:port`; IPv6 bracketed. */
	readonly allowedHosts: readonly string[];
	/** Whether a bare IP address is one this server must never dial (the same classifier as `browser_head`). */
	readonly forbiddenAddress: (address: string) => boolean;
	/** The host's addresses; `Deno.resolveDns` for A and AAAA by default. */
	readonly resolve?: (hostname: string) => Promise<readonly string[]>;
	/** Whether push may be offered now (the gateway's resolver-grant probe). Absent means ready. */
	readonly ready?: () => boolean;
	readonly fetch?: typeof fetch;
	/** First retry delay; doubled for each later one. */
	readonly backoffMs?: number;
	/** Tests only: accept `http:` to a loopback literal on the allowlist. Nothing in the gateway can set it. */
	readonly allowLoopbackHttp?: boolean;
	readonly logger?: { warn(message: string): void };
}

/** A delivery the address policy refuses: logged once, never retried. */
class PushRefused extends Error {}

/**
 * The webhook a create request names: a `PushNotificationConfig` (`{id?, url, token?}`) or a
 * `TaskPushNotificationConfig` wrapping one. `authentication` schemes or credentials are refused: this server does
 * not hold third-party credentials to replay; the token covers the receiver's check.
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
	if (id !== undefined && id !== '' && identifier(id).length > 128) {
		throw new AgentError(-32602, 'Invalid push notification config id');
	}
	return {
		...(id === undefined || id === '' ? {} : { id: String(id) }),
		url: inner.url,
		...(token === undefined ? {} : { token: token as string }),
	};
}

/** A webhook's origin for a log line (a path or query can carry a capability URL). */
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

/** A and AAAA together; a name that answers neither is an error, a single failing family is not. */
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
	readonly #controller = new AbortController();
	readonly #chains = new Map<string, Promise<void>>();
	#queued = 0;
	#active = 0;
	#waiting: (() => void)[] = [];
	#closed = false;

	constructor(options: PushOptions) {
		this.#options = options;
	}

	/** The URL a configuration may name, or a `-32602` naming what is wrong (never echoing the URL). */
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
		if (!this.#options.allowedHosts.includes(url.port === '' ? host : `${host}:${url.port}`)) {
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
		return this.#options.allowLoopbackHttp === true && url.protocol === 'http:' &&
			(url.hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname));
	}

	/** Every address the host resolves to must be public; checked before each attempt, never cached. */
	async #check(url: URL): Promise<void> {
		if (this.#loopbackTest(url)) return;
		const literal = ipLiteral(url.hostname);
		const addresses = literal === null ? await (this.#options.resolve ?? resolveHost)(url.hostname) : [literal];
		if (addresses.length === 0) throw new PushRefused('the host resolved to no address');
		if (addresses.some((address) => this.#options.forbiddenAddress(address))) {
			throw new PushRefused('the host resolves to a private, loopback or link-local address');
		}
	}

	async #send(config: PushConfig, body: string): Promise<void> {
		const warn = (message: string): void => this.#options.logger?.warn(message);
		let url: URL;
		try {
			url = this.target(config.url);
		} catch {
			return warn(
				`push notification to ${pushOrigin(config.url)} refused: the URL is no longer allowed by the operator policy`,
			);
		}
		const backoffMs = this.#options.backoffMs ?? 1_000;
		let outcome = 'no attempt was made';
		for (let attempt = 0; attempt <= PUSH_RETRIES; attempt++) {
			if (this.#closed) return;
			if (attempt > 0) await this.#sleep(backoffMs * 2 ** (attempt - 1));
			while (this.#active >= PUSH_CONCURRENCY && !this.#closed) {
				await new Promise<void>((resolve) => this.#waiting.push(resolve));
			}
			if (this.#closed) return;
			this.#active++;
			try {
				await this.#check(url);
				const response = await (this.#options.fetch ?? fetch)(url, {
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
						AbortSignal.timeout(PUSH_TIMEOUT_MS),
					]),
				});
				await response.body?.cancel().catch(() => {});
				if (response.ok) return;
				outcome = `status ${response.status}`;
				if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
			} catch (cause) {
				if (cause instanceof PushRefused) return warn(`push notification to ${url.origin} refused: ${cause.message}`);
				if (this.#closed) return;
				outcome = cause instanceof DOMException && cause.name === 'TimeoutError'
					? 'timed out'
					: cause instanceof Deno.errors.NotCapable
					? 'no outbound net grant for the host or its resolver'
					: 'network failure';
			} finally {
				this.#active--;
				this.#waiting.shift()?.();
			}
		}
		warn(`push notification to ${url.origin} was not delivered (${outcome})`);
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const signal = this.#controller.signal;
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener('abort', done, { once: true });
		});
	}
}
