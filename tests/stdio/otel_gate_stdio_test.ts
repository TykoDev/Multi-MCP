/**
 * D-137 / D-142 against the real runtime (design §2.3, AC4, AC5 real half; MB8).
 *
 * Spawns `deno run packages/cli/mod.ts …` with `OTEL_DENO=true`, so the runtime really exports, and two loopback
 * collector stubs: one listed in `TTK_OTEL_ENDPOINTS`, one not. `OTEL_METRIC_EXPORT_INTERVAL=100` makes a metric tick
 * fall inside module loading, which is the case where `Deno.exit` hung and a yield exported (O26, O28): a refusal must
 * still exit within 10 s, and in the 3 s after it neither stub may receive a log or a trace, nor any metric the
 * process itself produced (O27, MB8). Loopback only; nothing leaves the machine.
 *
 * **MB8, measured (deviation from the design's "0 requests"):** a metric tick that falls while the runtime is still
 * *loading* the module graph — before any user code, so before the gate can run — is exported by the runtime itself.
 * It carries the resource attributes and `v8js.gc.*` histograms only (`mb8_loading_body.log`): no request, URL,
 * console line or application instrument exists yet. A cold first run (258 ms) exported three such posts; warm runs
 * (120–190 ms) none. The assertion is therefore exact about what the gate controls: no `/v1/logs`, no `/v1/traces`,
 * and no metric body naming anything but the runtime's own pre-gate instruments. D-137 records the residual; the
 * owner accepted this narrowing of AC4 as a documented D-137 residual on 2026-10-05 (build finding SB-18).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { fromFileUrl } from '@std/path';

const ROOT = fromFileUrl(new URL('../..', import.meta.url));
const SIX = 'OTEL_DENO,OTEL_DENO_VSOCK,OTEL_EXPORTER_OTLP_ENDPOINT,OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,' +
	'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
/** The shipped tasks' env shape: TTK_* plus the six (T5). */
const SHIPPED_ENV = `--allow-env=TTK_*,${SIX}`;
/** What a child `deno` needs from this environment to find its cache; nothing OTEL_* leaks in from the developer. */
const PASS_THROUGH = [
	'SystemRoot',
	'PATH',
	'USERPROFILE',
	'LOCALAPPDATA',
	'APPDATA',
	'DENO_DIR',
	'HOME',
	'TEMP',
	'TMP',
];

/** A loopback collector stub recording each request's path and its body as Latin-1 text (OTLP protobuf strings). */
interface Stub {
	readonly origin: string;
	readonly paths: string[];
	readonly bodies: string[];
	close(): Promise<void>;
}

function collector(): Stub {
	const paths: string[] = [];
	const bodies: string[] = [];
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		bodies.push(new TextDecoder('latin1').decode(new Uint8Array(await request.arrayBuffer())));
		paths.push(new URL(request.url).pathname);
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	});
	return {
		origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
		paths,
		bodies,
		close: () => server.shutdown(),
	};
}

/** Forgets what a stub received, so each leg judges its own run. */
function reset(...stubs: Stub[]): void {
	for (const stub of stubs) {
		stub.paths.length = 0;
		stub.bodies.length = 0;
	}
}

/**
 * The instruments the runtime records before any user code runs (MB8): the only metric names a refused process may
 * have exported. Anything else — an HTTP-server or fetch instrument, a `ttk.*` counter — would mean code ran past the
 * gate.
 */
function onlyPreGateMetrics(body: string): boolean {
	const names = body.match(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+/g) ?? [];
	return names.every((name) =>
		/^(?:v8js\.gc\.|process\.runtime\.|telemetry\.sdk\.|service\.name)/.test(name) || /^\d/.test(name) ||
		name.startsWith('deno.')
	) && !/http\.|url\.|ttk\.|tykotech/.test(body);
}

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = { TTK_LOG_LEVEL: 'error' };
	for (const name of PASS_THROUGH) {
		const value = Deno.env.get(name);
		if (value !== undefined) env[name] = value;
	}
	return env;
}

interface Ran {
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}

/** Runs the CLI to completion (killed at 20 s, which then fails the timing assertion). */
async function cli(args: string[], env: Record<string, string>, envGrant = SHIPPED_ENV): Promise<Ran> {
	const started = performance.now();
	const child = new Deno.Command(Deno.execPath(), {
		args: ['run', '--no-prompt', '--allow-read=.', '--allow-net=127.0.0.1', envGrant, 'packages/cli/mod.ts', ...args],
		cwd: ROOT,
		env: { ...baseEnv(), ...env },
		clearEnv: true,
		stdin: 'null',
		stdout: 'piped',
		stderr: 'piped',
	}).spawn();
	const killer = setTimeout(() => {
		try {
			child.kill('SIGKILL');
		} catch { /* already gone */ }
	}, 20_000);
	const out = await child.output();
	clearTimeout(killer);
	return {
		code: out.code,
		stdout: new TextDecoder().decode(out.stdout),
		stderr: new TextDecoder().decode(out.stderr),
		ms: Math.round(performance.now() - started),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exporting, at a 100 ms metric interval (F5), with the listed stub on the allowlist. */
function exporting(listed: string, extra: Record<string, string>): Record<string, string> {
	return { OTEL_DENO: 'true', OTEL_METRIC_EXPORT_INTERVAL: '100', TTK_OTEL_ENDPOINTS: listed, ...extra };
}

/**
 * Asserts a refusal: exit 1 within 10 s, one stderr line, and — for 3 s — no log, no trace and no metric the process
 * produced at either stub. Pre-gate runtime metrics (MB8) are counted and printed, never accepted silently.
 */
async function assertRefused(
	ran: Ran,
	stubs: Stub[],
	label: string,
	reason: string,
): Promise<void> {
	assertEquals(ran.code, 1, `${label}: ${ran.stderr}`);
	assert(ran.ms < 10_000, `${label}: exited in ${ran.ms} ms`);
	const lines = ran.stderr.trim().split('\n');
	assertEquals(lines.length, 1, `${label}: one line, got ${ran.stderr}`);
	assert(lines[0]!.startsWith('tykotech-mcp: refusing to start: '), `${label}: ${lines[0]}`);
	assertStringIncludes(lines[0]!, reason, label);
	assertEquals(ran.stdout, '', `${label}: nothing on stdout`);
	await sleep(3_000);
	let preGate = 0;
	for (const stub of stubs) {
		for (const [index, path] of stub.paths.entries()) {
			assertEquals(path, '/v1/metrics', `${label}: a refused process exported ${path}`);
			assert(onlyPreGateMetrics(stub.bodies[index] ?? ''), `${label}: a metric past the gate was exported`);
			preGate += 1;
		}
	}
	console.log(`  ${label}: exit ${ran.code} in ${ran.ms} ms; pre-gate runtime metric posts: ${preGate}`);
	reset(...stubs);
}

Deno.test({
	name: 'AC4 (D-137): every refusal exits 1 within 10 s and sends nothing, at a 100 ms metric interval',
	sanitizeResources: true,
	async fn() {
		const listed = collector();
		const offList = collector();
		try {
			const offListEnv = exporting(listed.origin, { OTEL_EXPORTER_OTLP_ENDPOINT: offList.origin });
			// Off-list, on the stdio subcommand and on every other one — version, help and an unknown command (F4).
			for (const command of [['stdio'], ['version'], ['help'], ['no-such-command'], ['serve']]) {
				const ran = await cli(command, offListEnv);
				await assertRefused(ran, [listed, offList], `off-list ${command[0]}`, 'is not an allowlisted collector');
			}
			// The endpoint unset: the runtime default is never assumed (G2).
			await assertRefused(
				await cli(['stdio'], exporting(listed.origin, {})),
				[listed, offList],
				'unset endpoint',
				'http://localhost:4318',
			);
			// Userinfo: refused, and the password never reaches stderr.
			const userinfo = await cli(
				['stdio'],
				exporting(listed.origin, {
					OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin.replace('http://', 'http://otel:pw-stdio-secret@'),
				}),
			);
			await assertRefused(userinfo, [listed, offList], 'userinfo', 'credentials belong in OTEL_EXPORTER_OTLP_HEADERS');
			assert(!userinfo.stderr.includes('pw-stdio-secret'), userinfo.stderr);
			// A launcher granting TTK_* only, exporting: refused naming the grant (F2).
			await assertRefused(
				await cli(
					['stdio'],
					exporting(listed.origin, { OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin }),
					'--allow-env=TTK_*',
				),
				[listed, offList],
				'TTK_* only, exporting',
				`add --allow-env=${SIX}`,
			);
			// D-142: key and account generation, exporting to the LISTED collector — refused, nothing minted, no /v1/logs.
			for (const flags of [['--new-key', 'x'], ['--new-key-set', 'p'], ['--new-admin', 'u']]) {
				const ran = await cli(
					['doctor', ...flags],
					exporting(listed.origin, { OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin }),
				);
				await assertRefused(ran, [listed, offList], `doctor ${flags[0]}`, 'prints a credential to the console');
				assert(!ran.stdout.includes('ttk_') && !/Password/i.test(ran.stdout), 'nothing was generated');
			}
			// Malformed allowlist, with OpenTelemetry off: refused in every mode.
			const malformed = await cli(['version'], { TTK_OTEL_ENDPOINTS: `${listed.origin}/` });
			await assertRefused(malformed, [listed, offList], 'malformed list, OTel off', 'TTK_OTEL_ENDPOINTS entry 1');
		} finally {
			await listed.close();
			await offList.close();
		}
	},
});

/** Speaks `initialize` over stdio and returns once it is answered (or 30 s pass), leaving the child running. */
async function initialize(
	env: Record<string, string>,
	envGrant: string,
): Promise<{ answered: boolean; stop(): Promise<void> }> {
	const child = new Deno.Command(Deno.execPath(), {
		args: ['run', '--no-prompt', '--allow-read=.', '--allow-net=127.0.0.1', envGrant, 'packages/cli/mod.ts', 'stdio'],
		cwd: ROOT,
		env: { ...baseEnv(), ...env },
		clearEnv: true,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'null',
	}).spawn();
	const writer = child.stdin.getWriter();
	await writer.write(
		new TextEncoder().encode(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'otel-gate', version: '0' } },
			}) + '\n',
		),
	);
	const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	let answered = false;
	const deadline = Date.now() + 30_000;
	while (!answered && Date.now() < deadline) {
		let idle: ReturnType<typeof setTimeout> | undefined;
		const chunk = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((resolve) => {
				idle = setTimeout(() => resolve({ done: true, value: undefined }), 5_000);
			}),
		]).finally(() => clearTimeout(idle));
		if (chunk.done) break;
		buffer += chunk.value ?? '';
		answered = buffer.split('\n').some((line) => line.includes('"id":1') && line.includes('"result"'));
	}
	return {
		answered,
		stop: async () => {
			await writer.close().catch(() => {});
			await reader.cancel().catch(() => {});
			try {
				child.kill('SIGKILL');
			} catch { /* already gone */ }
			await child.status;
		},
	};
}

Deno.test({
	name: 'AC4 (D-137): TTK_*-only with OTel off, and a listed collector while exporting, both serve stdio',
	async fn() {
		const listed = collector();
		try {
			// F2: the documented client configs grant TTK_* only; with OpenTelemetry off nothing changes for them.
			const off = await initialize({}, '--allow-env=TTK_*');
			await off.stop();
			assert(off.answered, 'initialize over a TTK_*-only grant with OpenTelemetry off');

			// Listed: the gate passes, initialize is answered, and the listed collector receives the export.
			const on = await initialize(
				exporting(listed.origin, { OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin }),
				SHIPPED_ENV,
			);
			for (let waited = 0; waited < 5_000 && listed.paths.length === 0; waited += 100) await sleep(100);
			await on.stop();
			assert(on.answered, 'initialize while exporting to the listed collector');
			assert(listed.paths.some((path) => path.startsWith('/v1/')), `listed stub saw ${JSON.stringify(listed.paths)}`);
		} finally {
			await listed.close();
		}
	},
});

Deno.test({
	name: 'AC5/AC8 (D-142, D-137): exporting, doctor --grant still runs and doctor prints the signal map',
	async fn() {
		const listed = collector();
		try {
			// The default metric interval here: these legs run `main()` and end in `Deno.exit`, which can hang past a
			// missed tick (O26, N6) — the residual D-137 records — and that is not what these legs are about.
			const env = { OTEL_DENO: 'true', TTK_OTEL_ENDPOINTS: listed.origin, OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin };
			const grant = await cli(['doctor', '--grant', 'someone', '--scopes', 'mcp:invoke'], env);
			assert(!grant.stderr.includes('refusing to start'), grant.stderr);
			assertStringIncludes(grant.stderr, '--grant needs the data directory', 'the grant itself ran');
			const doctor = await cli(['doctor'], env);
			assertStringIncludes(
				doctor.stdout,
				`otel            exporting: traces→${listed.origin}, metrics→${listed.origin}, logs→${listed.origin} ` +
					'(allowlisted)',
			);
			assertStringIncludes(doctor.stdout, 'scope           documents');
		} finally {
			await listed.close();
		}
	},
});
