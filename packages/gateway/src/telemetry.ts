/**
 * OpenTelemetry for tool calls (R7 + F2, design §2.15, D-127).
 *
 * **The runtime does the exporting; this module adds one span and one counter.** Deno 2.9.7 exports traces, metrics
 * and `console.*` output over OTLP by itself when it is started with `OTEL_DENO=true` (`=1` is refused by 2.9.7 and
 * leaves telemetry off — D-021 was corrected for that), and instruments `Deno.serve` and `fetch` automatically. What
 * it cannot see is which *tool* a `POST /mcp` ran, so each dispatched call gets a `ttk.tool` span — a child of the
 * request's own server span — and a `ttk.tool.calls{tool,outcome}` count, through `Deno.telemetry`, with no npm
 * package (the `@opentelemetry/api` route would be a new dependency).
 *
 * **This module never reads an `OTEL_*` variable.** Whether the runtime exports is learned by asking it: with telemetry
 * off `Deno.telemetry`'s providers throw `otel not initialized`, so the probe below runs once, inside `try`, and an
 * inactive instance is a no-op that can never throw into a tool call. The six `OTEL_*` names the process *does* read
 * are read once, at the process edge, by the CLI's egress gate (`packages/cli/otel_gate.ts`, D-137), which refuses to
 * start while any endpoint names a collector outside `TTK_OTEL_ENDPOINTS` — so by the time this module runs, an active
 * runtime is exporting to an allowlisted collector. The gate duplicates the probe below rather than importing it: the
 * layering runs `gateway → cli`, never back.
 *
 * **Attributes are `tool` and `outcome`, and nothing else** — the D-101 label rule `/metrics` already follows: no
 * arguments, URLs, principals or session ids, and a name outside the catalog arrives as `(unknown)`
 * (`UNKNOWN_TOOL`), so a caller cannot mint a series.
 *
 * **What the runtime adds is not this module's to narrow, and M1 measured it** (2.9.7, loopback collector): the
 * automatic `Deno.serve` and `fetch` spans carry `url.full` and `url.query` — a live-view socket's `?ticket=`, a
 * signed link's `?t=` — and `console.*` lines are exported as OTel logs unless `OTEL_DENO_CONSOLE=ignore`. M2: none of
 * it needs `--allow-net` or `--allow-env`; the exporter dials outside the permission matrix — which is why D-137 bounds
 * the *destination* at the process edge instead. M3: a `deno compile` binary takes OTel from its *compile-time*
 * environment, so the slim image (built without `OTEL_DENO`) never exports, and its gate refuses `OTEL_DENO=true` as a
 * no-op. Hence the startup warning, and D-127's requirement that a deployment redacts URL attributes at its collector:
 * the gate judges where the export goes, never what it carries.
 */
import type { ToolCallOutcome, ToolTracer } from '@tykotech/mcp';
import type { Logger } from './logger.ts';

/** The instrumentation scope, and the service's own name for its span and counter. */
export const TELEMETRY_SCOPE = 'tykotech-mcp';
/** The span every dispatched tool call opens. */
export const TOOL_SPAN = 'ttk.tool';
/** The counter every dispatched tool call increments, by `tool` and `outcome`. */
export const TOOL_COUNTER = 'ttk.tool.calls';

/** The `SpanStatusCode.ERROR` value of the OTel API, which `Deno.telemetry` spans accept. */
const STATUS_ERROR = 2;

/**
 * The startup warning (M1): what the runtime's own export carries that a collector must be told to drop. Logged once
 * per {@linkcode createTelemetry} that finds telemetry active. Names variables and attribute keys only.
 */
export const TELEMETRY_WARNING = 'OpenTelemetry export is on (OTEL_DENO=true): the runtime exports request URLs with ' +
	'their query strings (url.full, url.query: live-view tickets, signed links) and console output as logs to the ' +
	'allowlisted collector (TTK_OTEL_ENDPOINTS). Configure attribute redaction for url.full and url.query at the ' +
	'collector, and set OTEL_DENO_CONSOLE=ignore unless console lines are wanted there.';

/** The part of `Deno.telemetry` this module uses, structurally — so a test can hand in a recording fake. */
export interface TelemetryApi {
	readonly tracerProvider: {
		getTracer(name: string): {
			startSpan(name: string, options?: { attributes?: Record<string, string> }): TelemetrySpan;
		};
	};
	readonly meterProvider: {
		getMeter(name: string): {
			createCounter(name: string, options?: { description?: string }): {
				add(value: number, attributes?: Record<string, string>): void;
			};
		};
	};
}

/** The span methods this module calls. */
export interface TelemetrySpan {
	setAttribute(key: string, value: string): unknown;
	setStatus(status: { code: number }): unknown;
	end(): void;
}

/** Tool-call telemetry for one process. */
export interface Telemetry {
	/** Whether the runtime is exporting (`OTEL_DENO=true` at start); `false` means every method is a no-op. */
	readonly active: boolean;
	/** Opens a `ttk.tool` span for `tool`; `end` closes it and counts the call. Wired as `McpDeps.traceTool`. */
	readonly traceTool: ToolTracer;
}

/** The instance a process with telemetry off holds: nothing to open, nothing to count. */
const INACTIVE: Telemetry = {
	active: false,
	traceTool: () => ({ end: () => {} }),
};

/**
 * Probes the runtime once and returns the process's tool-call telemetry.
 *
 * `api` defaults to `Deno.telemetry`; a test passes a fake. Any throw from the probe — `otel not initialized` with
 * telemetry off, or an API this build lacks — yields the inactive instance, and the active one swallows every later
 * throw, because telemetry must never be the reason a tool call fails.
 */
export function createTelemetry(logger: Pick<Logger, 'warn'>, api?: TelemetryApi): Telemetry {
	let tracer: ReturnType<TelemetryApi['tracerProvider']['getTracer']>;
	let counter: ReturnType<ReturnType<TelemetryApi['meterProvider']['getMeter']>['createCounter']>;
	try {
		const source = api ?? (Deno.telemetry as unknown as TelemetryApi);
		// The meter is the probe: `getMeter` throws while OTel is off, where `getTracer` does not.
		const meter = source.meterProvider.getMeter(TELEMETRY_SCOPE);
		counter = meter.createCounter(TOOL_COUNTER, { description: 'Tool calls dispatched, by tool and outcome' });
		tracer = source.tracerProvider.getTracer(TELEMETRY_SCOPE);
	} catch {
		return INACTIVE;
	}
	logger.warn(TELEMETRY_WARNING);
	return {
		active: true,
		traceTool: (tool: string) => {
			let span: TelemetrySpan | null = null;
			try {
				span = tracer.startSpan(TOOL_SPAN, { attributes: { tool } });
			} catch {
				span = null;
			}
			let ended = false;
			return {
				end: (outcome: ToolCallOutcome): void => {
					if (ended) return;
					ended = true;
					try {
						span?.setAttribute('outcome', outcome);
						if (outcome === 'error') span?.setStatus({ code: STATUS_ERROR });
						span?.end();
					} catch { /* never into the call */ }
					try {
						counter.add(1, { tool, outcome });
					} catch { /* never into the call */ }
				},
			};
		},
	};
}
