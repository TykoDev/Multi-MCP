/**
 * D-137 / D-142: the OpenTelemetry egress gate (design §2.2, §2.3; AC1–AC3, AC5 decision half) and the stdio
 * composition's single `SecretStore` (NF-3, AC26 stdio half).
 *
 * Everything here is the pure decision and the edge with its effects injected: the unit tier never runs with
 * `OTEL_DENO`, and the real runtime — refusal timing, zero requests at a loopback collector — is
 * `tests/stdio/otel_gate_stdio_test.ts`'s (AC4). N1: `packages/cli/` is in `test:unit` and `cov:unit`, so this file
 * runs in `deno task ok`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	checkOtelEgress,
	enforceOtelEgress,
	OTEL_ENDPOINTS_MAX,
	OTEL_GATE_ENV_NAMES,
	otelDoctorLines,
	type OtelGateInputs,
	type OtelGateResult,
	parseOtelEndpoints,
	redactEndpoint,
} from './otel_gate.ts';
import { doctorScopeLines, oneSecretStore } from './mod.ts';
import { PROXY_WEBSOCKET_CAVEAT } from '@tykotech/mcp';

const LISTED = 'http://127.0.0.1:4318';
const OTHER = 'https://collector.example.test';

/** Inputs over a fixed environment; `denied` names are unreadable. Records every name read. */
function inputs(
	env: Record<string, string>,
	options: { exporting?: boolean; denied?: readonly string[]; argv?: readonly string[] } = {},
): OtelGateInputs & { readonly reads: string[]; readonly queried: string[] } {
	const reads: string[] = [];
	const queried: string[] = [];
	return {
		exporting: options.exporting ?? false,
		readable: (name) => {
			queried.push(name);
			return !(options.denied ?? []).includes(name);
		},
		read: (name) => {
			reads.push(name);
			return env[name];
		},
		argv: options.argv ?? ['serve'],
		reads,
		queried,
	};
}

/** The reason of a refusal; fails the test on a pass. */
function refusal(result: OtelGateResult): string {
	assert(!result.ok, `expected a refusal, got ${JSON.stringify(result)}`);
	return result.reason;
}

// --- AC1: parseOtelEndpoints --------------------------------------------------------------------------------------

Deno.test('AC1: canonical http(s) origins are accepted, trimmed, empties dropped', () => {
	assertEquals(parseOtelEndpoints(` ${LISTED} ,, ${OTHER} ,`), { ok: true, origins: [LISTED, OTHER] });
	assertEquals(parseOtelEndpoints(''), { ok: true, origins: [] });
	assertEquals(parseOtelEndpoints('http://[::1]:4318'), { ok: true, origins: ['http://[::1]:4318'] });
	// A default port is dropped by `origin`, so the bare host is the canonical spelling.
	assertEquals(parseOtelEndpoints('http://c'), { ok: true, origins: ['http://c'] });
	assertEquals(parseOtelEndpoints('https://xn--bcher-kva.test'), { ok: true, origins: ['https://xn--bcher-kva.test'] });
});

Deno.test('AC1: every non-origin spelling is refused, naming the variable and the 1-based position', () => {
	const refused: Array<[string, string]> = [
		['http://c/', 'canonical origin'],
		['http://c/v1/traces', 'canonical origin'],
		['http://c?x=1', 'canonical origin'],
		['http://c#f', 'canonical origin'],
		['http://c:80', 'canonical origin'],
		['https://c:443', 'canonical origin'],
		['HTTP://C', 'canonical origin'],
		['http://bücher.test', 'canonical origin'],
		['http://u:p@c', 'canonical origin'],
		['http://*.example.test', 'wildcard'],
		['*', 'not an http: or https: origin'],
		['grpc://c:4317', 'not an http: or https: origin'],
		['unix:///run/otel.sock', 'not an http: or https: origin'],
		['c:4318', 'not an http: or https: origin'],
	];
	for (const [entry, why] of refused) {
		const parsed = parseOtelEndpoints(`${LISTED},${entry}`);
		assert(!parsed.ok, entry);
		assertStringIncludes(parsed.reason, 'TTK_OTEL_ENDPOINTS entry 2', entry);
		assertStringIncludes(parsed.reason, why, entry);
	}
	const twice = parseOtelEndpoints(`${LISTED},${OTHER},${LISTED}`);
	assert(!twice.ok);
	assertStringIncludes(twice.reason, 'entry 3');
	assertStringIncludes(twice.reason, 'listed twice');
	const many = Array.from({ length: OTEL_ENDPOINTS_MAX + 1 }, (_, i) => `http://c${i}.test`).join(',');
	const tooMany = parseOtelEndpoints(many);
	assert(!tooMany.ok);
	assertStringIncludes(tooMany.reason, 'at most 16');
	assert(parseOtelEndpoints(many.split(',').slice(0, OTEL_ENDPOINTS_MAX).join(',')).ok, 'sixteen is allowed');
});

Deno.test('AC1: an error shows the redacted entry, never its password, path or query', () => {
	const parsed = parseOtelEndpoints('http://user:hunter2-secret@c:4318/path?token=q-secret');
	assert(!parsed.ok);
	assertStringIncludes(parsed.reason, 'http://***@c:4318');
	for (const secret of ['hunter2-secret', 'user', 'q-secret', '/path']) assert(!parsed.reason.includes(secret), secret);
});

Deno.test('AC1: redactEndpoint renders scheme, ***@ for userinfo, and host[:port] only', () => {
	assertEquals(redactEndpoint('http://a:b@h:1/p?q#f'), 'http://***@h:1');
	assertEquals(redactEndpoint('https://h/p'), 'https://h');
	assertEquals(redactEndpoint('http://u@h'), 'http://***@h');
	assertEquals(redactEndpoint('not a url'), '<unparseable>');
	assertEquals(redactEndpoint(''), '<unparseable>');
});

// --- AC2: checkOtelEgress ------------------------------------------------------------------------------------------

Deno.test('AC2: not exporting — unset passes, unreadable passes (F2), OTEL_DENO=true refuses as a no-op', () => {
	assertEquals(checkOtelEgress(inputs({})), { ok: true });
	assertEquals(checkOtelEgress(inputs({ OTEL_DENO: 'false' })), { ok: true });
	// A launcher granting TTK_* only: OTEL_DENO is never read, and nothing is refused while OpenTelemetry is off.
	const ttkOnly = inputs({ OTEL_DENO: 'true' }, { denied: OTEL_GATE_ENV_NAMES });
	assertEquals(checkOtelEgress(ttkOnly), { ok: true });
	assert(!ttkOnly.reads.includes('OTEL_DENO'), 'an ungranted name is never read');
	const reason = refusal(checkOtelEgress(inputs({ OTEL_DENO: ' true ' })));
	assertStringIncludes(reason, 'not exporting');
	assertStringIncludes(reason, 'unset OTEL_DENO');
	// Off-list endpoints are not judged while nothing is exported.
	assertEquals(checkOtelEgress(inputs({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere:4318' })), { ok: true });
});

Deno.test('DX-2: OTEL_DENO is read case-insensitively, as Deno reads it — TRUE on a non-exporting build refuses too', () => {
	// Deno 2.9.7 exports with OTEL_DENO=TRUE (review DX-2, j1_otel_doctor.log D3); the not-exporting refusal matched only
	// lower-case `true`, so `TRUE` on the slim image started silently with nothing exported.
	for (const value of ['TRUE', 'True', ' tRuE ']) {
		assertStringIncludes(refusal(checkOtelEgress(inputs({ OTEL_DENO: value }))), 'not exporting', value);
	}
	for (const value of ['FALSE', 'False', '', '1', 'yes']) {
		assertEquals(checkOtelEgress(inputs({ OTEL_DENO: value })), { ok: true }, JSON.stringify(value));
	}
});

Deno.test('AC2: a malformed list is refused in both modes', () => {
	for (const exporting of [false, true]) {
		const reason = refusal(
			checkOtelEgress(
				inputs({ TTK_OTEL_ENDPOINTS: `${LISTED}/`, OTEL_DENO: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: LISTED }, {
					exporting,
				}),
			),
		);
		assertStringIncludes(reason, 'TTK_OTEL_ENDPOINTS entry 1');
	}
});

/** A passing exporting environment: the base endpoint on the listed collector. */
const EXPORTING = { OTEL_DENO: 'true', TTK_OTEL_ENDPOINTS: LISTED, OTEL_EXPORTER_OTLP_ENDPOINT: LISTED };

Deno.test('AC2: exporting — base listed passes with the signal map', () => {
	assertEquals(checkOtelEgress(inputs(EXPORTING, { exporting: true })), {
		ok: true,
		signals: { traces: LISTED, metrics: LISTED, logs: LISTED },
	});
	// A base with a path keeps its origin (O5); per-signal URLs are used as-is (O3/O4).
	assertEquals(
		checkOtelEgress(
			inputs({
				...EXPORTING,
				TTK_OTEL_ENDPOINTS: `${LISTED},${OTHER}`,
				OTEL_EXPORTER_OTLP_ENDPOINT: `${LISTED}/prefix`,
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${OTHER}/v1/logs`,
			}, { exporting: true }),
		),
		{ ok: true, signals: { traces: LISTED, metrics: LISTED, logs: OTHER } },
	);
});

Deno.test('AC2: exporting — a name the process may not read refuses, naming the grant (F2)', () => {
	const reason = refusal(
		checkOtelEgress(inputs(EXPORTING, { exporting: true, denied: ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] })),
	);
	assertStringIncludes(reason, 'may not read OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
	assertStringIncludes(reason, `--allow-env=${OTEL_GATE_ENV_NAMES.join(',')}`);
	const all = refusal(checkOtelEgress(inputs(EXPORTING, { exporting: true, denied: OTEL_GATE_ENV_NAMES })));
	assertStringIncludes(all, 'may not read OTEL_DENO, OTEL_DENO_VSOCK,');
});

Deno.test('AC2: exporting — an empty list refuses', () => {
	const reason = refusal(checkOtelEgress(inputs({ ...EXPORTING, TTK_OTEL_ENDPOINTS: ' , ' }, { exporting: true })));
	assertStringIncludes(reason, 'set TTK_OTEL_ENDPOINTS');
	// And an unreadable list is an empty one.
	refusal(checkOtelEgress(inputs(EXPORTING, { exporting: true, denied: ['TTK_OTEL_ENDPOINTS'] })));
});

Deno.test('AC2: exporting — an unset endpoint refuses, naming the runtime default (G2)', () => {
	const reason = refusal(
		checkOtelEgress(inputs({ OTEL_DENO: 'true', TTK_OTEL_ENDPOINTS: LISTED }, { exporting: true })),
	);
	assertStringIncludes(reason, 'traces, metrics, logs');
	assertStringIncludes(reason, 'http://localhost:4318');
	// One signal left to the default is enough.
	const one = refusal(
		checkOtelEgress(
			inputs({
				OTEL_DENO: 'true',
				TTK_OTEL_ENDPOINTS: LISTED,
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${LISTED}/v1/traces`,
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${LISTED}/v1/metrics`,
				// MB5: an empty per-signal value is unset to the runtime, so logs fall to the default here.
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
			}, { exporting: true }),
		),
	);
	assertStringIncludes(one, 'would export logs to the runtime default http://localhost:4318');
});

Deno.test('AC2: exporting — MB5: an empty base is refused (the runtime does not read it as unset)', () => {
	const reason = refusal(
		checkOtelEgress(
			inputs({
				OTEL_DENO: 'true',
				TTK_OTEL_ENDPOINTS: LISTED,
				OTEL_EXPORTER_OTLP_ENDPOINT: '',
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${LISTED}/v1/traces`,
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${LISTED}/v1/metrics`,
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${LISTED}/v1/logs`,
			}, { exporting: true }),
		),
	);
	assertStringIncludes(reason, 'OTEL_EXPORTER_OTLP_ENDPOINT is set but empty');
});

Deno.test('AC2: exporting — a per-signal endpoint off the list refuses, naming the variable', () => {
	const reason = refusal(
		checkOtelEgress(
			inputs({ ...EXPORTING, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:9999/v1/metrics' }, {
				exporting: true,
			}),
		),
	);
	assertStringIncludes(reason, 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT (http://127.0.0.1:9999) is not an allowlisted');
	assert(!reason.includes('/v1/metrics'), 'the path is never rendered');
});

Deno.test('AC2: exporting — all three signals listed but an off-list base still refuses (F3)', () => {
	const reason = refusal(
		checkOtelEgress(
			inputs({
				OTEL_DENO: 'true',
				TTK_OTEL_ENDPOINTS: LISTED,
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://off-list.test:4318',
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${LISTED}/v1/traces`,
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${LISTED}/v1/metrics`,
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${LISTED}/v1/logs`,
			}, { exporting: true }),
		),
	);
	assertStringIncludes(reason, 'OTEL_EXPORTER_OTLP_ENDPOINT (http://off-list.test:4318)');
});

Deno.test('AC2: exporting — userinfo refuses as ***@, the password absent', () => {
	const reason = refusal(
		checkOtelEgress(
			inputs({ ...EXPORTING, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:pa55-secret@127.0.0.1:4318' }, {
				exporting: true,
			}),
		),
	);
	assertStringIncludes(reason, 'http://***@127.0.0.1:4318');
	assertStringIncludes(reason, 'credentials belong in OTEL_EXPORTER_OTLP_HEADERS');
	assert(!reason.includes('pa55-secret') && !reason.includes('otel:'), reason);
	// Another scheme, or no URL at all, is refused as not http(s).
	for (const value of ['grpc://127.0.0.1:4317', 'nonsense']) {
		assertStringIncludes(
			refusal(checkOtelEgress(inputs({ ...EXPORTING, OTEL_EXPORTER_OTLP_ENDPOINT: value }, { exporting: true }))),
			'is not an http: or https: URL',
		);
	}
});

Deno.test('AC2: exporting — OTEL_DENO_VSOCK refuses', () => {
	const reason = refusal(checkOtelEgress(inputs({ ...EXPORTING, OTEL_DENO_VSOCK: '3:4317' }, { exporting: true })));
	assertStringIncludes(reason, 'vsock export cannot be allowlisted');
});

Deno.test('AC2: querySync is the only permission path, and the reader sees the six names and TTK_OTEL_ENDPOINTS only', () => {
	const allowed = new Set<string>([...OTEL_GATE_ENV_NAMES, 'TTK_OTEL_ENDPOINTS']);
	for (
		const probe of [
			inputs({}),
			inputs({ OTEL_DENO: 'true' }),
			inputs(EXPORTING, { exporting: true }),
			inputs(EXPORTING, { exporting: true, argv: ['doctor', '--new-key', 'x'] }),
			inputs({ ...EXPORTING, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x' }, { exporting: true }),
		]
	) {
		checkOtelEgress(probe);
		for (const name of probe.reads) assert(allowed.has(name), `read ${name}`);
		for (const name of probe.reads) assert(probe.queried.includes(name), `${name} read without asking querySync`);
		assert(!probe.reads.some((name) => /HEADERS|CERTIFICATE|CLIENT_KEY/.test(name)), probe.reads.join(','));
	}
	// The edge's own reader: querySync, never `Deno.permissions.request` or a bare read (source-level, F2).
	const source = Deno.readTextFileSync(new URL('./otel_gate.ts', import.meta.url));
	assertStringIncludes(source, "Deno.permissions.querySync({ name: 'env', variable: name })");
	assert(!/permissions\.(request|query)\(/.test(source), 'no prompting or async permission path');
});

Deno.test('AC2: a non-loopback http: collector passes with a warning; loopback and https do not warn', () => {
	const warned = checkOtelEgress(
		inputs({
			...EXPORTING,
			TTK_OTEL_ENDPOINTS: 'http://collector.lan:4318',
			OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.lan:4318',
		}, {
			exporting: true,
		}),
	);
	assert(warned.ok);
	assertEquals(warned.warnings?.length, 1);
	assertStringIncludes(warned.warnings?.[0] ?? '', 'http://collector.lan:4318 over plain http');
	for (const origin of ['http://localhost:4318', 'http://127.0.0.1:4318', 'http://[::1]:4318', OTHER]) {
		const quiet = checkOtelEgress(
			inputs({ ...EXPORTING, TTK_OTEL_ENDPOINTS: origin, OTEL_EXPORTER_OTLP_ENDPOINT: origin }, { exporting: true }),
		);
		assert(quiet.ok && quiet.warnings === undefined, origin);
	}
});

// --- D-142 (AC5, decision half) ------------------------------------------------------------------------------------

Deno.test('D-142 (AC5): key and account generation are refused while exporting; --grant is not', () => {
	for (
		const argv of [
			['doctor', '--new-key', 'x'],
			['doctor', '--new-key-set', 'p'],
			['doctor', '--new-admin', 'u'],
			['doctor', '--new-key=x'],
			// `parseArgs` reads the command from the first positional, wherever the flag sits.
			['--new-admin', 'u', 'doctor'],
			// D-154: `setup` prints the generated admin password and API key.
			['setup'],
			['setup', '--force'],
		]
	) {
		const reason = refusal(checkOtelEgress(inputs(EXPORTING, { exporting: true, argv })));
		assertStringIncludes(reason, 'prints a credential to the console, which OpenTelemetry exports');
		assertStringIncludes(reason, 'run it with OTEL_DENO unset');
		assert(!reason.includes('=x'), 'a flag value is never echoed');
	}
	// `--grant` prints a username and scope names, no credential (cli/mod.ts runGrant): the doctor's own class.
	assert(
		checkOtelEgress(inputs(EXPORTING, { exporting: true, argv: ['doctor', '--grant', 'u', '--scopes', 'admin'] })).ok,
	);
	assert(checkOtelEgress(inputs(EXPORTING, { exporting: true, argv: ['doctor'] })).ok);
	// With OpenTelemetry off all four behave as today.
	for (const flag of ['--new-key', '--new-key-set', '--new-admin', '--grant']) {
		assertEquals(checkOtelEgress(inputs({}, { argv: ['doctor', flag, 'x'] })), { ok: true });
	}
	assertEquals(checkOtelEgress(inputs({}, { argv: ['setup'] })), { ok: true });
});

// --- AC3: the edge -------------------------------------------------------------------------------------------------

Deno.test('AC3: a refusal writes one stderr line, sets exit code 1, returns false — no console, exit or throw', () => {
	const lines: string[] = [];
	const codes: number[] = [];
	const consoleCalls: string[] = [];
	const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, exit: Deno.exit };
	console.log =
		console.error =
		console.warn =
		console.info =
			(...args: unknown[]) => void consoleCalls.push(String(args));
	(Deno as { exit: unknown }).exit = () => {
		throw new Error('Deno.exit called');
	};
	let returned: unknown;
	try {
		returned = enforceOtelEgress(['stdio'], {
			inputs: inputs({ ...EXPORTING, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://u:pw-secret@off.test' }, { exporting: true }),
			write: (line) => void lines.push(line),
			setExitCode: (code) => void codes.push(code),
		});
	} finally {
		Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
		(Deno as { exit: unknown }).exit = saved.exit;
	}
	assertEquals(returned, false, 'returns synchronously, not a promise');
	assertEquals(codes, [1]);
	assertEquals(lines.length, 1);
	assert(lines[0]!.startsWith('tykotech-mcp: refusing to start: '), lines[0]);
	assert(!lines[0]!.includes('pw-secret'));
	assertEquals(consoleCalls, []);
});

Deno.test('AC3: a pass writes nothing but warnings and leaves the exit code alone', () => {
	const lines: string[] = [];
	const codes: number[] = [];
	const deps = { write: (line: string) => void lines.push(line), setExitCode: (code: number) => void codes.push(code) };
	assertEquals(enforceOtelEgress(['version'], { ...deps, inputs: inputs({}) }), true);
	assertEquals(enforceOtelEgress(['serve'], { ...deps, inputs: inputs(EXPORTING, { exporting: true }) }), true);
	assertEquals([lines, codes], [[], []]);
	enforceOtelEgress(['serve'], {
		...deps,
		inputs: inputs({ ...EXPORTING, TTK_OTEL_ENDPOINTS: 'http://c.lan', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c.lan' }, {
			exporting: true,
		}),
	});
	assertEquals(lines.length, 1);
	assert(lines[0]!.startsWith('tykotech-mcp: warning: OpenTelemetry exports to http://c.lan over plain http'));
	assertEquals(codes, []);
});

Deno.test('AC3: a throwing reader fails closed instead of throwing', () => {
	const lines: string[] = [];
	const codes: number[] = [];
	const ok = enforceOtelEgress(['serve'], {
		inputs: {
			exporting: true,
			readable: () => true,
			read: () => {
				throw new Error('boom');
			},
			argv: ['serve'],
		},
		write: (line) => void lines.push(line),
		setExitCode: (code) => void codes.push(code),
	});
	assertEquals([ok, codes, lines.length], [false, [1], 1]);
});

Deno.test('AC3 (F5): otel_gate.ts imports nothing, and never calls console, Deno.exit or await', () => {
	const source = Deno.readTextFileSync(new URL('./otel_gate.ts', import.meta.url));
	const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	assert(!/^\s*(import|export\s+[^;]*\sfrom)\s/m.test(code), 'no static import or re-export');
	assert(!/\bimport\s*\(/.test(code), 'no dynamic import');
	assert(!/\bconsole\./.test(code), 'no console');
	assert(!/Deno\.exit\(/.test(code), 'no Deno.exit');
	assert(!/\bawait\b|\basync\b/.test(code), 'nothing asynchronous');
	assert(!/\bthrow\b/.test(code), 'nothing thrown');
});

// --- AC8 (doctor) --------------------------------------------------------------------------------------------------

Deno.test('AC8: the doctor prints otel off, the signal map, or the refusal; scope with the proxy caveat', () => {
	assertEquals(otelDoctorLines({ ok: true }), ['otel            off']);
	assertEquals(otelDoctorLines({ ok: true, signals: { traces: LISTED, metrics: LISTED, logs: OTHER } }), [
		`otel            exporting: traces→${LISTED}, metrics→${LISTED}, logs→${OTHER} (allowlisted)`,
	]);
	assertEquals(otelDoctorLines({ ok: false, reason: 'r' }), ['otel            refused: r']);
	assertEquals(doctorScopeLines('documents', ['--proxy-server=http://p:3128']), ['scope           documents']);
	assertEquals(doctorScopeLines('all', []), ['scope           all']);
	for (const flag of ['--proxy-server=http://p:3128', '--proxy-pac-url=http://p/pac', '--proxy-auto-detect']) {
		const lines = doctorScopeLines('all', ['--lang=en', flag]);
		assertEquals(lines.length, 2, flag);
		assertStringIncludes(lines[1]!, 'WebSockets to off-list hosts are not refused');
	}
	assertEquals(doctorScopeLines('all', ['--proxy-bypass-list=x']).length, 1, 'not a proxy');
});

Deno.test('D-138: the doctor and the registry warn about WebSockets under a proxy in the same words', () => {
	// The doctor cannot import the registry's constant (the edge's static graph stays import-free, D-137), so the two
	// texts are pinned to each other here: the doctor's line is the registry's sentence after its variable prefix.
	const [, warning] = doctorScopeLines('all', ['--proxy-server=http://p:3128']);
	assertEquals(warning, `warning: ${PROXY_WEBSOCKET_CAVEAT.slice(PROXY_WEBSOCKET_CAVEAT.indexOf(': ') + 2)}`);
});

// --- AC26 (NF-3, stdio half) ---------------------------------------------------------------------------------------

Deno.test('AC26: the stdio composition builds one SecretStore for redaction and the tools', () => {
	let made = 0;
	const store = {
		redact: (text: string) => text.replaceAll('s3cret', '[redacted]'),
	};
	const wired = oneSecretStore(() => {
		made += 1;
		return store;
	});
	assertEquals(made, 1);
	assert(wired.secrets === store, 'ctx.secrets is the built instance');
	assertEquals(wired.redact('a s3cret b'), 'a [redacted] b', 'redaction delegates to that same instance');
	// And the stdio mount uses it for both (source-level: runStdio needs a browser and a transport to run).
	const source = Deno.readTextFileSync(new URL('./mod.ts', import.meta.url));
	assertEquals(source.match(/new SecretStore\(/g)?.length, 1, 'one construction site in the CLI');
	assertStringIncludes(source, 'redact: stdioSecrets.redact,');
	assertStringIncludes(source, 'secrets: stdioSecrets.secrets,');
});
