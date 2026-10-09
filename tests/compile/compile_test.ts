/**
 * R15: the single-binary distribution.
 *
 * Compiles for the host and then *runs* the result — the only way to learn
 * whether a compiled binary works, because everything that breaks in one
 * (a dynamic import the bundler could not see, a file read from a path that no
 * longer exists, a permission that cannot be re-granted at launch) is invisible
 * until the binary runs.
 *
 * Its own tier: compiling takes half a minute, which does not belong in the
 * unit loop.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { binaryName, permissions } from '../../scripts/compile.ts';
import { VERSION } from '../../packages/cli/mod.ts';

const ROOT = fromFileUrl(new URL('../..', import.meta.url));
const OUT = `${ROOT}/dist`;
const BINARY = `${OUT}/${binaryName(null)}`;

/** Compiles once for the whole suite. */
async function ensureBinary(): Promise<void> {
	// **Reuse only a binary this source tree produced.** Until B5 this returned
	// early on any existing `dist/` artefact, so a binary compiled before the
	// 0.2.0 bump satisfied the whole tier: the version assertions below passed
	// because they were pinned to the literal the STALE binary printed, and the
	// stdio and key-record checks exercised code from a previous release. A tier
	// that can pass without compiling the tree is not a tier. The binary is
	// rebuilt whenever it is older than the CLI module that decides what it
	// prints, which is the cheapest fact that moves on every release.
	try {
		const [binary, source] = await Promise.all([
			Deno.stat(BINARY),
			Deno.stat(`${ROOT}/packages/cli/mod.ts`),
		]);
		const built = binary.mtime?.getTime() ?? 0;
		const edited = source.mtime?.getTime() ?? Number.MAX_SAFE_INTEGER;
		if (built > edited) return;
	} catch {
		// Not built yet.
	}
	const build = new Deno.Command(Deno.execPath(), {
		args: ['run', '-A', 'scripts/compile.ts'],
		cwd: ROOT,
		stdout: 'piped',
		stderr: 'piped',
	});
	const result = await build.output();
	if (!result.success) {
		throw new Error(`compile failed: ${new TextDecoder().decode(result.stderr).slice(-2000)}`);
	}
}

/** Runs the binary with arguments and collects its output. */
async function run(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
	const command = new Deno.Command(BINARY, {
		args,
		cwd: ROOT,
		env: { ...env },
		clearEnv: true,
		stdout: 'piped',
		stderr: 'piped',
	});
	const { code, stdout, stderr } = await command.output();
	return { code, out: new TextDecoder().decode(stdout), err: new TextDecoder().decode(stderr) };
}

Deno.test('compile: the permission matrix is baked in, and it is the right one', () => {
	const flags = permissions('/usr/bin/chromium');
	// A deny outranks any later allow, so it has to come first.
	assertEquals(flags[0], '--deny-ffi');
	// Never a bare `--allow-run`: a browser-driving server with unrestricted
	// process spawning is the exact shape of a sandbox escape, and a compiled
	// binary cannot be re-flagged to take it back.
	assert(!flags.includes('--allow-run'), flags.join(' '));
	assert(flags.some((flag) => flag.startsWith('--allow-run=/usr/bin/chromium')));
});

Deno.test({
	name: 'compile: the binary reports its version and diagnoses its environment',
	async fn() {
		await ensureBinary();

		const version = await run(['version']);
		assertEquals(version.code, 0, version.err);
		// Derived, never a literal: a hard-coded version here is what let a stale
		// binary pass this tier through two releases (B5).
		assertEquals(version.out.trim(), VERSION);

		// `doctor` exercises the config parser and the dynamic import of the
		// gateway package — the part a bundler is most likely to have missed.
		const doctor = await run(['doctor']);
		assertEquals(doctor.code, 0, doctor.err);
		assertStringIncludes(doctor.out, `tykotech-mcp ${VERSION}`);
		assertStringIncludes(doctor.out, 'bind            127.0.0.1:8787');
		assertStringIncludes(doctor.out, 'role            all');
	},
});

Deno.test({
	name: 'compile: the binary generates a usable key record',
	async fn() {
		await ensureBinary();
		const result = await run(['doctor', '--new-key', 'compiled']);
		assertEquals(result.code, 0, result.err);
		assertStringIncludes(result.out, 'ttk_');
		// The record is JSON the operator pastes into TTK_API_KEYS, so it has to
		// parse — a broken one is discovered at the worst possible moment.
		const json = result.out.slice(result.out.indexOf('['));
		const records = JSON.parse(json) as Array<{ id: string; sha256: string }>;
		assertEquals(records[0]?.id, 'compiled');
		assertEquals(records[0]?.sha256.length, 64);
		// And the printed key never appears inside the record.
		const key = /ttk_[A-Za-z0-9_-]+/.exec(result.out)?.[0] ?? '';
		assert(key.length > 20);
		assertEquals(json.includes(key), false, 'the raw key leaked into the record');
	},
});

Deno.test({
	name: 'compile: the binary answers MCP over stdio',
	async fn() {
		await ensureBinary();

		// The real thing an MCP host does: spawn the binary and speak JSON-RPC.
		const child = new Deno.Command(BINARY, {
			args: ['stdio'],
			cwd: ROOT,
			env: { TTK_LOG_LEVEL: 'error' },
			clearEnv: true,
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
		}).spawn();

		const writer = child.stdin.getWriter();
		const encoder = new TextEncoder();
		const send = (message: unknown) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`));

		await send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'compile-test', version: '1' },
			},
		});
		await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

		const responses = new Map<number, Record<string, unknown>>();
		const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		const deadline = Date.now() + 30_000;
		while (!responses.has(2) && Date.now() < deadline) {
			// The read is raced against a deadline so a silent child cannot hang the
			// suite — and the loser's timer is cleared, or every iteration leaves a
			// five-second timer pending and the op sanitizer (rightly) fails the test.
			let idle: ReturnType<typeof setTimeout> | undefined;
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) => {
					idle = setTimeout(() => resolve({ done: true, value: undefined }), 5_000);
				}),
			]).finally(() => clearTimeout(idle));
			if (chunk.done) break;
			buffer += chunk.value ?? '';
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim() === '') continue;
				try {
					const message = JSON.parse(line) as { id?: number };
					if (typeof message.id === 'number') responses.set(message.id, message as Record<string, unknown>);
				} catch { /* a partial line; the next chunk completes it */ }
			}
		}

		await writer.close().catch(() => {});
		await reader.cancel().catch(() => {});
		try {
			child.kill('SIGKILL');
		} catch { /* already gone */ }
		await child.status;
		await child.stderr.cancel().catch(() => {});

		const listed = responses.get(2) as { result?: { tools?: Array<{ name: string }> } } | undefined;
		assert(listed !== undefined, `no tools/list response; saw ids ${[...responses.keys()].join(',')}`);
		const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
		// The catalog the compiled binary serves is the catalog, not a subset the
		// bundler happened to reach.
		assert(names.includes('browser_navigate'), names.join(','));
		assert(names.includes('browser_get_state'), names.join(','));
		assert(names.length >= 15, `only ${names.length} tools: ${names.join(',')}`);
	},
});

Deno.test({
	name: 'D-137 (MB4): the compiled binary never exports, so it refuses OTEL_DENO=true as a no-op, for every subcommand',
	async fn() {
		await ensureBinary();
		// A `deno compile` binary takes OpenTelemetry from its build environment (M3), and this one was built without
		// OTEL_DENO: the runtime is not exporting, the baked bare --allow-env lets the gate read the name, and an
		// operator who set it is told so rather than left believing it works (G2). The slim image is this binary.
		for (const args of [['version'], ['stdio'], ['doctor'], ['healthcheck']]) {
			const refused = await run(args, { OTEL_DENO: 'true' });
			assertEquals(refused.code, 1, `${args[0]}: ${refused.err}`);
			assertEquals(refused.out, '', `${args[0]}: nothing ran`);
			assert(refused.err.startsWith('tykotech-mcp: refusing to start: OTEL_DENO=true but this build is not exporting'));
			assertEquals(refused.err.trim().split('\n').length, 1, 'one line');
		}
		// A malformed allowlist is refused in every mode, OpenTelemetry off included; the password is never echoed.
		const malformed = await run(['version'], { TTK_OTEL_ENDPOINTS: 'http://u:pw-compiled@collector.test:4318/' });
		assertEquals(malformed.code, 1, malformed.err);
		assertStringIncludes(malformed.err, 'TTK_OTEL_ENDPOINTS entry 1 (http://***@collector.test:4318)');
		assertEquals(malformed.err.includes('pw-compiled'), false);
		// OTEL_DENO unset or false: unchanged, and a valid list alone changes nothing.
		for (
			const env of [{}, { OTEL_DENO: 'false' }, { TTK_OTEL_ENDPOINTS: 'http://127.0.0.1:4318' }] as Record<
				string,
				string
			>[]
		) {
			const version = await run(['version'], env);
			assertEquals([version.code, version.out.trim(), version.err], [0, VERSION, ''], JSON.stringify(env));
		}
	},
});
