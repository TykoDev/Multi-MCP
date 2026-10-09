/**
 * D-082: the configured private services, watched while the server runs.
 *
 * Before D-082 the sandbox and the ACP runner were probed once at start-up: a service that was down at boot never
 * got its tools, and one that died later kept them, answering every call with a failure that looked like a bug.
 * Now each configured service is probed every `intervalMs`; its tools follow its health (`ToolAvailability.services`)
 * and every change is logged and announced, so clients re-list.
 *
 * A probe is the service's own health check, bounded by its own timeout (5 s); two probes of one service never
 * overlap.
 */
import type { Logger } from './logger.ts';

export type ServiceName = 'sandbox' | 'agents';
export type ServiceStates = { readonly sandbox?: boolean; readonly agents?: boolean };

export const SERVICE_PROBE_INTERVAL_MS = 30_000;

const LABELS: Record<ServiceName, string> = {
	sandbox: 'coding sandbox',
	agents: 'ACP runner',
};

export class ServiceHealth {
	readonly #probes: Partial<Record<ServiceName, () => Promise<boolean>>>;
	readonly #states: { sandbox?: boolean; agents?: boolean } = {};
	readonly #listeners = new Set<(states: ServiceStates) => void>();
	readonly #logger: Logger | undefined;
	readonly #intervalMs: number;
	#timer: ReturnType<typeof setInterval> | undefined;
	#probing = false;

	constructor(
		probes: Partial<Record<ServiceName, () => Promise<boolean>>>,
		options: { logger?: Logger; intervalMs?: number } = {},
	) {
		this.#probes = probes;
		this.#logger = options.logger;
		this.#intervalMs = options.intervalMs ?? SERVICE_PROBE_INTERVAL_MS;
	}

	/** Whether any service is watched at all. */
	get watching(): boolean {
		return Object.keys(this.#probes).length > 0;
	}

	/** The last probe's answer per configured service. */
	states(): ServiceStates {
		return { ...this.#states };
	}

	/** Called after a probe round that changed anything. */
	onChange(listener: (states: ServiceStates) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Probes once now, then on the interval; resolves after the first round so start-up knows the states. */
	async start(): Promise<void> {
		await this.probe();
		if (!this.watching || this.#timer !== undefined) return;
		this.#timer = setInterval(() => void this.probe(), this.#intervalMs);
		Deno.unrefTimer(this.#timer as unknown as number);
	}

	stop(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/** One round: every configured service probed; listeners told when any state changed. */
	async probe(): Promise<void> {
		if (this.#probing) return;
		this.#probing = true;
		try {
			let changed = false;
			for (const [name, probe] of Object.entries(this.#probes) as [ServiceName, () => Promise<boolean>][]) {
				const up = await probe().catch(() => false);
				const before = this.#states[name];
				if (before === up) continue;
				this.#states[name] = up;
				changed = true;
				if (up) this.#logger?.info(`${LABELS[name]} is reachable; its tools are available`, { service: name });
				else this.#logger?.warn(`${LABELS[name]} is not reachable; its tools are withheld`, { service: name });
			}
			if (changed) {
				const states = this.states();
				for (const listener of this.#listeners) listener(states);
			}
		} finally {
			this.#probing = false;
		}
	}
}

/**
 * The ACP runner's health check: `GET /healthz` with a 5 s budget and no redirects. It replaced the one-shot start-up
 * probe `readyExpansion`, which was removed once nothing called it (D-082, D-107).
 */
export function bridgeProbe(url: URL | string, request: typeof fetch = fetch): () => Promise<boolean> {
	return async () => {
		try {
			const response = await request(new URL('/healthz', url), {
				redirect: 'error',
				signal: AbortSignal.timeout(5000),
			});
			await response.body?.cancel();
			return response.ok;
		} catch {
			return false;
		}
	};
}
