/** The configured private services, watched while the server runs. */
import type { Logger } from './logger.ts';

export type ServiceName = 'sandbox';
export type ServiceStates = { readonly sandbox?: boolean };

const SERVICE_PROBE_INTERVAL_MS = 30_000;

const LABELS: Record<ServiceName, string> = {
	sandbox: 'coding sandbox',
};

export class ServiceHealth {
	readonly #probes: Partial<Record<ServiceName, () => Promise<boolean>>>;
	readonly #states: { sandbox?: boolean } = {};
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
