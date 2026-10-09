/**
 * The OpenTelemetry egress gate (D-137, design §2.1–§2.3), the cli package's own process-edge code.
 *
 * **Why it exists.** With `OTEL_DENO=true` the Deno runtime exports traces (request URLs with their query strings —
 * live-view tickets, signed links), metrics and `console.*` lines over OTLP, and the exporter dials **outside** the
 * permission matrix (D-127, M2): `--allow-net` does not bound it. The only control a process has is to refuse to run
 * while the runtime would export somewhere the operator did not name. `TTK_OTEL_ENDPOINTS` is that name list; this
 * module judges the runtime's six endpoint-bearing variables against it before anything else in the process runs.
 *
 * **Why it has no imports (F5).** `packages/cli/mod.ts` imports this module statically, so the static graph that is
 * evaluated before the gate is `@std/cli/parse-args` plus this file and nothing else — every gateway, MCP or browser
 * module is a later `await import(…)`. No span, log or console line is produced before the refusal. The gateway imports
 * nothing from here (strict downward layering), which is also why {@linkcode runtimeExporting} duplicates the 5-line
 * probe of `packages/gateway/src/telemetry.ts` instead of sharing it (D-137).
 *
 * **Why a refusal is a stderr write plus a natural exit (O26–O29).** `console.*` and an uncaught throw are exported as
 * OTel logs (O10–O12); a `Deno.stderr` write is not (O8, O9). `Deno.exit(1)` after synchronous work that spanned a
 * metric tick hung for ≥ 90 s (O26), and yielding once before it exported `/v1/metrics` twice (O28); ending naturally
 * with `Deno.exitCode = 1` exported nothing and exited in ~155 ms, 3/3 (O27). So {@linkcode enforceOtelEgress} writes
 * one line, sets the exit code and returns — it never calls `console.*`, never throws, never awaits, never exits.
 *
 * **What it reads.** Exactly {@linkcode OTEL_GATE_ENV_NAMES} plus `TTK_OTEL_ENDPOINTS`, each only after
 * `Deno.permissions.querySync` says it is granted (F2), so there is never a prompt and never a `NotCapable` throw.
 * `OTEL_EXPORTER_OTLP_HEADERS` and every `*_HEADERS`, `*_CERTIFICATE` or `*_CLIENT_KEY` name is never read.
 *
 * **Not judged** (D-137): what the export carries, and the route it takes — the exporter ignored `HTTP(S)_PROXY` and
 * `ALL_PROXY` for the loopback endpoints measured (O15, O24); were a future runtime to honour one, the export would go
 * through it and the gate would still judge only the origin. Any Deno upgrade re-runs the `OTEL_` name extraction from
 * the binary (§2.9 "bin"): a new endpoint-bearing name joins {@linkcode OTEL_GATE_ENV_NAMES} and rule T5.
 *
 * @module
 */

/**
 * The six `OTEL_*` names this process may read, and every launcher must grant (rule T5 in `scripts/check_tasks.ts`
 * holds a copy, pinned equal by `tests/unit/check_tasks_test.ts`). The base endpoint, the three per-signal endpoints,
 * vsock, and the switch itself: the endpoint-bearing names in the Deno 2.9.7 binary (§2.9 "bin").
 */
export const OTEL_GATE_ENV_NAMES = [
	'OTEL_DENO',
	'OTEL_DENO_VSOCK',
	'OTEL_EXPORTER_OTLP_ENDPOINT',
	'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
	'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
	'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/** The allowlist variable (G8). Covered by `TTK_*` in every launcher, so it needs no grant of its own. */
export const OTEL_ENDPOINTS_ENV = 'TTK_OTEL_ENDPOINTS';

/** At most this many collector origins (§2.2). */
export const OTEL_ENDPOINTS_MAX = 16;

/** Where the runtime exports a signal no variable names (O2): never assumed allowlisted (G2). */
export const OTEL_RUNTIME_DEFAULT_ENDPOINT = 'http://localhost:4318';

/** The three OTLP signals, and the per-signal variable that overrides the base endpoint for each (O3/O4). */
const SIGNALS = [
	['traces', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
	['metrics', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
	['logs', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'],
] as const;

/** One OTLP signal. */
export type OtelSignal = (typeof SIGNALS)[number][0];

/** The key-generation flags D-142 refuses while the runtime exports: each prints a credential to the console. */
const KEY_GENERATION_FLAGS = ['--new-key', '--new-key-set', '--new-admin'] as const;

/**
 * What a log line may say about an endpoint: `scheme://` + `***@` when userinfo was present + `host[:port]`. Path,
 * query, fragment and the userinfo itself are never rendered; an unparseable value is `<unparseable>`.
 */
export function redactEndpoint(url: string): string {
	const parsed = URL.parse(url);
	if (parsed === null) return '<unparseable>';
	const userinfo = parsed.username !== '' || parsed.password !== '' ? '***@' : '';
	return `${parsed.protocol}//${userinfo}${parsed.host}`;
}

/** The outcome of {@linkcode parseOtelEndpoints}: the canonical origins, or the reason the list is refused. */
export type OtelEndpointsParse =
	| { readonly ok: true; readonly origins: readonly string[] }
	| { readonly ok: false; readonly reason: string };

/**
 * Parses `TTK_OTEL_ENDPOINTS` (§2.2): split on `,`, trimmed, empties dropped, at most 16 entries, each a canonical
 * `http:`/`https:` origin — `URL.parse(entry)?.origin === entry`, the `TTK_MCP_APPS_ORIGINS` rule of D-134. That one
 * comparison refuses a trailing `/`, a path, query, fragment or userinfo, non-canonical case and non-punycode, and a
 * spelled-out default port (`http://c:80` — the origin drops it). No wildcards, no duplicates. A refusal names the
 * variable, the 1-based position and the redacted entry — never the raw text, which could carry a password.
 */
export function parseOtelEndpoints(raw: string): OtelEndpointsParse {
	const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
	if (entries.length > OTEL_ENDPOINTS_MAX) {
		return { ok: false, reason: `${OTEL_ENDPOINTS_ENV} lists ${entries.length} collectors; at most 16 are allowed` };
	}
	const origins: string[] = [];
	for (const [index, entry] of entries.entries()) {
		const at = `${OTEL_ENDPOINTS_ENV} entry ${index + 1} (${redactEndpoint(entry)})`;
		const parsed = URL.parse(entry);
		if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
			return { ok: false, reason: `${at} is not an http: or https: origin` };
		}
		if (entry.includes('*')) return { ok: false, reason: `${at} is a wildcard; name each collector origin` };
		if (parsed.origin !== entry) {
			return {
				ok: false,
				reason: `${at} is not a canonical origin (scheme://host[:port] — lower case, no path, slash, ` +
					'query, fragment, credentials or default port)',
			};
		}
		if (origins.includes(entry)) return { ok: false, reason: `${at} is listed twice` };
		origins.push(entry);
	}
	return { ok: true, origins };
}

/** What {@linkcode checkOtelEgress} reads, injected so the decision is pure. */
export interface OtelGateInputs {
	/** Whether the runtime is exporting (`OTEL_DENO=true` honoured at start). */
	readonly exporting: boolean;
	/** Whether `name` may be read without a prompt: granted, per `Deno.permissions.querySync`. */
	readonly readable: (name: string) => boolean;
	/** The value of a readable `name`, or `undefined` when unset. Only ever called after `readable(name)`. */
	readonly read: (name: string) => string | undefined;
	/** The process arguments (`Deno.args`), for D-142. */
	readonly argv: readonly string[];
}

/** Where each signal goes while exporting: the collector origin, after the gate allowed it. */
export type OtelSignalMap = Readonly<Record<OtelSignal, string>>;

/** The gate's decision. `signals` is present only while exporting; `warnings` only when something is worth saying. */
export type OtelGateResult =
	| { readonly ok: true; readonly signals?: OtelSignalMap; readonly warnings?: readonly string[] }
	| { readonly ok: false; readonly reason: string };

/** Whether a URL's host is loopback: `localhost`, `127.0.0.0/8` or `[::1]`. */
function loopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The gate's decision (§2.3), pure, in the design's order:
 *
 * 1. A non-empty, readable `TTK_OTEL_ENDPOINTS` is parsed; a malformed list refuses in every mode.
 * 2. Not exporting: `OTEL_DENO=true` refuses — the setting is a no-op here (a compiled binary takes OpenTelemetry from
 *    its build environment, so the slim image never exports; or `OTEL_SDK_DISABLED` is set), and an operator who set
 *    it believes something false (G2). An unreadable `OTEL_DENO` passes (F2): a launcher granting only `TTK_*`, such as
 *    the documented stdio client configs, is unaffected while OpenTelemetry is off.
 * 3. Exporting: every one of the six names must be readable (F2); vsock is refused (it cannot be allowlisted); the list
 *    must be non-empty; every non-empty endpoint value — the base included even when all three signals override it
 *    (F3) — must be a credential-free http(s) URL on a listed origin; no signal may fall through to the runtime default
 *    (G2); and D-142 refuses the doctor's key and account generation, which print a credential to the console, which
 *    the runtime exports. Then it passes, with the signal map and a warning per non-loopback `http:` collector.
 *
 * MB5 (Deno 2.9.7, measured): an *empty* per-signal variable is unset to the runtime (the signal falls back to the
 * base), so only non-empty values are judged; an empty *base* is not unset — the runtime then exports nothing at all,
 * reaching neither a listed collector nor the default — so a set-but-empty base is refused as unparseable (the
 * design's fallback), rather than reasoned about.
 */
export function checkOtelEgress(inputs: OtelGateInputs): OtelGateResult {
	const { exporting, readable, read, argv } = inputs;
	const value = (name: string): string | undefined => (readable(name) ? read(name) : undefined);

	// 1. The allowlist: malformed configuration, refused whatever the runtime is doing.
	let origins: readonly string[] = [];
	const listed = value(OTEL_ENDPOINTS_ENV);
	if (listed !== undefined && listed.trim() !== '') {
		const parsed = parseOtelEndpoints(listed);
		if (!parsed.ok) return parsed;
		origins = parsed.origins;
	}

	// 2. Not exporting.
	if (!exporting) {
		// DX-2: case-insensitive, as Deno 2.9.7 reads it (`TRUE` exports), so `TRUE` on a non-exporting build refuses too.
		if (value('OTEL_DENO')?.trim().toLowerCase() === 'true') {
			return {
				ok: false,
				reason: 'OTEL_DENO=true but this build is not exporting — a compiled binary takes OpenTelemetry from its ' +
					'build environment (the slim image never exports), or OTEL_SDK_DISABLED is set; unset OTEL_DENO',
			};
		}
		return { ok: true };
	}

	// 3.1 Every name the decision needs must be readable, or the decision is a guess (F2).
	const unreadable = OTEL_GATE_ENV_NAMES.filter((name) => !readable(name));
	if (unreadable.length > 0) {
		return {
			ok: false,
			reason: `OpenTelemetry export is on, but this process may not read ${unreadable.join(', ')}; add ` +
				`--allow-env=${OTEL_GATE_ENV_NAMES.join(',')}`,
		};
	}

	// 3.2 A vsock export has no origin to compare.
	if ((read('OTEL_DENO_VSOCK') ?? '') !== '') {
		return { ok: false, reason: 'OTEL_DENO_VSOCK is set: vsock export cannot be allowlisted; unset it' };
	}

	// 3.3 Nothing is allowlisted, so nothing may be exported.
	if (origins.length === 0) {
		return {
			ok: false,
			reason: `OpenTelemetry export is on (OTEL_DENO=true) and no collector is allowlisted; set ` +
				`${OTEL_ENDPOINTS_ENV} to the collector origins`,
		};
	}

	// 3.4 Every non-empty endpoint, the base included (F3).
	const judged = new Map<string, string>();
	const base = read('OTEL_EXPORTER_OTLP_ENDPOINT');
	if (base === '') {
		return {
			ok: false,
			reason: 'OTEL_EXPORTER_OTLP_ENDPOINT is set but empty, which this runtime does not read as unset; ' +
				'unset it or set it to an allowlisted collector origin',
		};
	}
	for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', ...SIGNALS.map(([, variable]) => variable)]) {
		const raw = read(name) ?? '';
		if (raw === '') continue;
		const parsed = URL.parse(raw);
		if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
			return { ok: false, reason: `${name} (${redactEndpoint(raw)}) is not an http: or https: URL` };
		}
		if (parsed.username !== '' || parsed.password !== '') {
			return {
				ok: false,
				reason: `${name} (${redactEndpoint(raw)}) carries credentials in the URL; credentials belong in ` +
					'OTEL_EXPORTER_OTLP_HEADERS',
			};
		}
		if (!origins.includes(parsed.origin)) {
			return {
				ok: false,
				reason: `${name} (${redactEndpoint(raw)}) is not an allowlisted collector; add its origin to ` +
					`${OTEL_ENDPOINTS_ENV} or point it at one listed there`,
			};
		}
		judged.set(name, parsed.origin);
	}

	// 3.5 A signal with neither a per-signal nor a base value goes to the runtime default (G2: never assumed).
	const baseOrigin = judged.get('OTEL_EXPORTER_OTLP_ENDPOINT');
	const signals: Partial<Record<OtelSignal, string>> = {};
	const defaulted: OtelSignal[] = [];
	for (const [signal, variable] of SIGNALS) {
		const origin = judged.get(variable) ?? baseOrigin;
		if (origin === undefined) defaulted.push(signal);
		else signals[signal] = origin;
	}
	if (defaulted.length > 0) {
		return {
			ok: false,
			reason: `OpenTelemetry would export ${defaulted.join(', ')} to the runtime default ` +
				`${OTEL_RUNTIME_DEFAULT_ENDPOINT}; set OTEL_EXPORTER_OTLP_ENDPOINT to an allowlisted collector origin`,
		};
	}

	// 3.6 D-142: credentials are printed to the console, and the console is exported. Matched anywhere in argv, not
	// only after `doctor` in first position: `parseArgs` takes `--new-key x doctor` as the same command.
	const generating = argv.find((arg) =>
		(KEY_GENERATION_FLAGS as readonly string[]).some((flag) => arg === flag || arg.startsWith(`${flag}=`))
	);
	if (generating !== undefined) {
		return {
			ok: false,
			reason: `${generating.split('=')[0]} prints a credential to the console, which OpenTelemetry exports; run ` +
				'it with OTEL_DENO unset',
		};
	}
	// D-154: `setup` prints a generated password and API key the same way. Matched as any word, the refusing direction.
	if (argv.includes('setup')) {
		return {
			ok: false,
			reason: 'setup prints a credential to the console, which OpenTelemetry exports; run it with OTEL_DENO unset',
		};
	}

	// 3.7 Pass. A non-loopback `http:` collector receives the export, OTLP headers included, in clear.
	const warnings = [...new Set(Object.values(signals))]
		.filter((origin) => {
			const url = new URL(origin);
			return url.protocol === 'http:' && !loopbackHost(url.hostname);
		})
		.map((origin) =>
			`OpenTelemetry exports to ${origin} over plain http: the export and OTEL_EXPORTER_OTLP_HEADERS travel in clear`
		);
	return { ok: true, signals: signals as OtelSignalMap, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Whether the runtime is exporting. `Deno.telemetry`'s meter provider throws `otel not initialized` while OpenTelemetry
 * is off; the probe duplicates `telemetry.ts`'s because the layering forbids sharing it (D-137).
 */
export function runtimeExporting(): boolean {
	try {
		(Deno.telemetry as unknown as { meterProvider: { getMeter(name: string): unknown } }).meterProvider.getMeter(
			'tykotech-mcp-gate',
		);
		return true;
	} catch {
		return false;
	}
}

/** Whether `name` is granted: never a prompt, never a throw (F2). */
export function envReadable(name: string): boolean {
	try {
		return Deno.permissions.querySync({ name: 'env', variable: name }).state === 'granted';
	} catch {
		return false;
	}
}

/** The value of a granted `name`; `undefined` when unset or, defensively, when the read throws anyway. */
export function envRead(name: string): string | undefined {
	try {
		return Deno.env.get(name);
	} catch {
		return undefined;
	}
}

/** The process's own inputs, for the edge and for `doctor`'s re-run of the same pure decision (N5). */
export function processOtelInputs(argv: readonly string[]): OtelGateInputs {
	return { exporting: runtimeExporting(), readable: envReadable, read: envRead, argv };
}

/** What {@linkcode enforceOtelEgress} touches, injected by tests. */
export interface OtelGateDeps {
	readonly inputs?: OtelGateInputs;
	readonly write?: (line: string) => void;
	readonly setExitCode?: (code: number) => void;
}

/** One whole line to stderr, synchronously — not a `console` call, so it is never exported (O8, O9). */
function writeStderr(line: string): void {
	try {
		const bytes = new TextEncoder().encode(`${line}\n`);
		let written = 0;
		while (written < bytes.length) written += Deno.stderr.writeSync(bytes.subarray(written));
	} catch {
		// A closed stderr cannot be reported to; the exit code still says it.
	}
}

/**
 * The process edge: judges the environment and, on refusal, writes one line — `tykotech-mcp: refusing to start:
 * <reason>` — sets `Deno.exitCode = 1` and returns `false`, so the module ends with nothing pending and the process
 * exits naturally (O27). On a pass it returns `true`, after one `tykotech-mcp: warning: …` line per non-loopback
 * `http:` collector (N5: the edge is that warning's producer, in every mode). Never `console.*`, never a throw, never an
 * `await`, never `Deno.exit`.
 */
export function enforceOtelEgress(argv: readonly string[], deps: OtelGateDeps = {}): boolean {
	const write = deps.write ?? writeStderr;
	let result: OtelGateResult;
	try {
		result = checkOtelEgress(deps.inputs ?? processOtelInputs(argv));
	} catch {
		// Unreachable by construction; fail closed rather than let a throw reach the exporter as a log record.
		result = { ok: false, reason: 'the OpenTelemetry egress check failed unexpectedly' };
	}
	if (!result.ok) {
		write(`tykotech-mcp: refusing to start: ${result.reason}`);
		(deps.setExitCode ?? ((code: number) => (Deno.exitCode = code)))(1);
		return false;
	}
	for (const warning of result.warnings ?? []) write(`tykotech-mcp: warning: ${warning}`);
	return true;
}

/** `doctor`'s `otel` line(s) for a decision (N5: the doctor re-runs {@linkcode checkOtelEgress}, it does not guess). */
export function otelDoctorLines(result: OtelGateResult): string[] {
	if (!result.ok) return [`otel            refused: ${result.reason}`];
	if (result.signals === undefined) return ['otel            off'];
	const { traces, metrics, logs } = result.signals;
	return [
		`otel            exporting: traces→${traces}, metrics→${metrics}, logs→${logs} (allowlisted)`,
		...(result.warnings ?? []).map((warning) => `warning: ${warning}`),
	];
}
