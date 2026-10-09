/**
 * C11 (D-101): the gateway's Prometheus exposition, `GET /metrics` when `TTK_METRICS=true`.
 *
 * **Every label is low-cardinality by construction.** `route` is the *matched route pattern*
 * (`/api/v1/sessions/:sessionId/files/:fileId`), never the request path, so a client cannot mint a series by
 * inventing a URL; `tool` is a catalog name, because the dispatcher answers an unknown name with a protocol error
 * before the observer runs; `status`, `outcome` and `state` are closed sets. Each family is still capped at
 * {@linkcode MAX_SERIES}, past which new label sets fold into one `other` series — a defect elsewhere must cost a
 * line of resolution, never the scraper's memory.
 *
 * Nothing here carries a credential, a principal, a URL, a session id or an argument. Counters live in this
 * process only: a restart resets them, which is what Prometheus `rate()` expects of a counter.
 *
 * The format is the text exposition 0.0.4: `# HELP` and `# TYPE` per family, one sample per line, label values
 * escaped (`\\`, `\"`, `\n`).
 */
import { type CallToolResult, isInputRequiredResult } from '@modelcontextprotocol/server';
import type { SessionSummary, ToolResult } from '@tykotech/mcp';

/**
 * The scope that reads `/metrics` without administrative power (C11, G11).
 *
 * Referenced by string because the vocabulary is `packages/mcp/src/scopes.ts`'s to declare; a credential holding
 * `admin` is admitted too, so the endpoint works before and after the vocabulary carries this name.
 */
export const METRICS_SCOPE = 'metrics:read';

/** The exposition's media type (Prometheus text format 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Distinct label sets one counter family keeps before folding new ones into `other`. */
export const MAX_SERIES = 512;

/** The label `route` takes when no registered route matched the request. */
export const UNMATCHED_ROUTE = 'unmatched';

/** How a tool call ended, as `ttk_tool_calls_total{outcome}` spells it. */
export type ToolOutcome = 'ok' | 'error' | 'input_required';

/** Whether a principal's scopes admit `/metrics`: `metrics:read`, or `admin`. */
export function mayReadMetrics(scopes: ReadonlySet<string>): boolean {
	return scopes.has(METRICS_SCOPE) || scopes.has('admin');
}

/** The outcome of one dispatched call: a sampling round, a result-level error, or a success. */
export function toolOutcome(result: ToolResult): ToolOutcome {
	if (isInputRequiredResult(result)) return 'input_required';
	return (result as CallToolResult).isError === true ? 'error' : 'ok';
}

/** Escapes a label value for the text format. */
export function escapeLabel(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** A counter family keyed by its label values, bounded at {@linkcode MAX_SERIES}. */
class CounterFamily {
	readonly #labels: readonly string[];
	readonly #series = new Map<string, { values: readonly string[]; count: number }>();

	constructor(labels: readonly string[]) {
		this.#labels = labels;
	}

	inc(values: readonly string[]): void {
		let key = values.join('\u0000');
		if (!this.#series.has(key) && this.#series.size >= MAX_SERIES) {
			values = this.#labels.map(() => 'other');
			key = values.join('\u0000');
		}
		const entry = this.#series.get(key);
		if (entry === undefined) this.#series.set(key, { values, count: 1 });
		else entry.count += 1;
	}

	samples(name: string): string[] {
		return [...this.#series.values()].map(({ values, count }) =>
			`${name}{${this.#labels.map((label, i) => `${label}="${escapeLabel(values[i] ?? '')}"`).join(',')}} ${count}`
		);
	}
}

/** What the scrape reads from the live process; injected so a test can pin it. */
export interface MetricsSnapshot {
	readonly sessions: readonly Pick<SessionSummary, 'tab_count' | 'viewer_count' | 'human_has_control'>[];
	/** `Deno.memoryUsage()`, or `null` where it cannot be read. */
	readonly memory: Deno.MemoryUsage | null;
}

/** One gateway's counters. Created only when `TTK_METRICS` is on, so a deployment without it pays nothing. */
export class GatewayMetrics {
	readonly #requests = new CounterFamily(['route', 'status']);
	readonly #tools = new CounterFamily(['tool', 'outcome']);
	#rateLimited = 0;
	#loginFailures = 0;

	/**
	 * One answered HTTP request, observed at the gateway's front so a refusal there (host, origin, body cap, drain)
	 * is counted like any other answer. A 429 is a rate-limit refusal, whether the per-principal limiter or the
	 * sign-in guard gave it; a 401 from the sign-in route is a failed sign-in.
	 */
	observeRequest(method: string, route: string, status: number): void {
		this.#requests.inc([route, String(status)]);
		if (status === 429) this.#rateLimited += 1;
		if (status === 401 && method === 'POST' && route === '/api/v1/auth/login') this.#loginFailures += 1;
	}

	/** One dispatched tool call (MCP `tools/call` or an agent task's executor). */
	observeToolCall(tool: string, outcome: ToolOutcome): void {
		this.#tools.inc([tool, outcome]);
	}

	/** The exposition text for one scrape. */
	render(snapshot: MetricsSnapshot): string {
		const lines: string[] = [];
		const family = (name: string, type: 'counter' | 'gauge', help: string, samples: readonly string[]): void => {
			lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
		};
		family(
			'ttk_http_requests_total',
			'counter',
			'HTTP requests answered, by matched route pattern and status code.',
			this.#requests.samples('ttk_http_requests_total'),
		);
		family(
			'ttk_tool_calls_total',
			'counter',
			'Tool calls dispatched, by tool and outcome (ok, error, input_required).',
			this.#tools.samples('ttk_tool_calls_total'),
		);
		const states = { active: 0, idle: 0, human_control: 0 };
		let viewers = 0;
		for (const session of snapshot.sessions) {
			viewers += session.viewer_count;
			if (session.human_has_control) states.human_control += 1;
			else if (session.tab_count > 0) states.active += 1;
			else states.idle += 1;
		}
		family(
			'ttk_sessions',
			'gauge',
			'Browser sessions, by state (active: has a tab; idle: none; human_control: a viewer holds the lock).',
			Object.entries(states).map(([state, count]) => `ttk_sessions{state="${state}"} ${count}`),
		);
		family('ttk_viewers', 'gauge', 'Live-view viewers connected across all sessions.', [`ttk_viewers ${viewers}`]);
		family('ttk_rate_limited_total', 'counter', 'Requests refused with 429 (rate limiter and sign-in guard).', [
			`ttk_rate_limited_total ${this.#rateLimited}`,
		]);
		family('ttk_login_failures_total', 'counter', 'Sign-in attempts refused with 401.', [
			`ttk_login_failures_total ${this.#loginFailures}`,
		]);
		const memory = snapshot.memory;
		if (memory !== null) {
			family('ttk_process_resident_memory_bytes', 'gauge', 'Resident set size of the gateway process.', [
				`ttk_process_resident_memory_bytes ${memory.rss}`,
			]);
			family('ttk_process_heap_total_bytes', 'gauge', 'V8 heap reserved.', [
				`ttk_process_heap_total_bytes ${memory.heapTotal}`,
			]);
			family('ttk_process_heap_used_bytes', 'gauge', 'V8 heap in use.', [
				`ttk_process_heap_used_bytes ${memory.heapUsed}`,
			]);
			family('ttk_process_external_memory_bytes', 'gauge', 'Memory held outside the V8 heap.', [
				`ttk_process_external_memory_bytes ${memory.external}`,
			]);
		}
		return `${lines.join('\n')}\n`;
	}
}

/** `Deno.memoryUsage()`, or `null` when this runtime refuses it. */
export function readMemory(): Deno.MemoryUsage | null {
	try {
		return Deno.memoryUsage();
	} catch {
		return null;
	}
}
