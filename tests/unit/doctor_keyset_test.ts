/**
 * `doctor --new-key-set <prefix>` (owner item 5): one single-scope key per scope
 * in the vocabulary, raw keys to stderr, hashed records to stdout as one array.
 *
 * A generated credential is written to the stream itself and never through `console`, the process's log (CodeQL
 * js/clear-text-logging on `packages/cli/mod.ts`): `run` captures the two apart, as `out`/`err` and `shown`.
 *
 * The security claim is per-key least privilege: each record holds exactly one
 * scope, so a role composed from a subset of these keys can do exactly that
 * subset and no more. And it adds no default-grant site (BF-2): every key names
 * its one scope explicitly and none consults `DEFAULT_SCOPES`.
 */
import { assert, assertEquals } from '@std/assert';
import { main } from '../../packages/cli/mod.ts';
import { SCOPES } from '@tykotech/gateway';

interface Captured {
	/** What went through `console.log` / `console.error`. */
	out: string;
	err: string;
	/** What was written to the credential streams. */
	shown: { out: string; err: string };
	code: number;
}

async function run(argv: string[]): Promise<Captured> {
	const outParts: string[] = [];
	const errParts: string[] = [];
	const shown = { out: '', err: '' };
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...args: unknown[]) => void outParts.push(args.map(String).join(' '));
	console.error = (...args: unknown[]) => void errParts.push(args.map(String).join(' '));
	try {
		const code = await main(argv, {
			out: (text) => void (shown.out += text),
			err: (text) => void (shown.err += text),
		});
		return { out: outParts.join('\n'), err: errParts.join('\n'), shown, code };
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
}

Deno.test('doctor --new-key-set: one single-scope key per scope, hashed records to stdout', async () => {
	const captured = await run(['doctor', '--new-key-set', 'web']);
	assertEquals(captured.code, 0);

	const records = JSON.parse(captured.out) as Array<{ id: string; sha256: string; scopes?: string[] }>;
	assertEquals(records.length, SCOPES.length, 'one record per scope in the vocabulary');

	for (const scope of SCOPES) {
		const id = `web-${scope.replace(/:/g, '-')}`;
		const record = records.find((entry) => entry.id === id);
		assert(record !== undefined, `missing record for ${scope} (id ${id})`);
		assertEquals(record.scopes, [scope], `${id} must hold exactly its one scope`);
		assert(/^[0-9a-f]{64}$/.test(record.sha256), `${id} carries a sha256, not a raw key`);
	}
	// `evaluate` is included precisely because it is the scope an operator must
	// deliberately choose — withholding it here would hide it.
	assert(records.some((entry) => entry.scopes?.[0] === 'evaluate'), 'the evaluate key is minted too');

	// The raw keys are on stderr and NOT on stdout — a redirect of stdout to a
	// file yields hashed records with no secret in them.
	assertEquals(captured.out.includes('ttk_'), false, 'no raw key may reach stdout');
	assertEquals(captured.shown.out, '', 'no raw key may reach stdout');
	assert(captured.err.includes('web-mcp-invoke'), 'the ids are on stderr');
	// And they are written to the stream itself: no raw key is a console line.
	assertEquals(captured.err.includes('ttk_'), false, 'no raw key may go through console');
	assertEquals(captured.shown.err.match(/ttk_[A-Za-z0-9_-]+/g)?.length, SCOPES.length, 'one raw key per scope');
});

Deno.test('doctor --new-key: the raw key is written to stdout itself, the record through console', async () => {
	const captured = await run(['doctor', '--new-key', 'unit']);
	assertEquals(captured.code, 0);
	const key = /ttk_[A-Za-z0-9_-]+/.exec(captured.shown.out)?.[0] ?? '';
	assert(key.length > 20, 'the raw key is shown');
	assertEquals(captured.out.includes('ttk_'), false, 'no raw key may go through console');
	const records = JSON.parse(captured.out.slice(captured.out.indexOf('['))) as Array<{ id: string; sha256: string }>;
	assertEquals(records.map((record) => record.id), ['unit']);
	assertEquals(captured.shown.err, '');
});

/**
 * D-142 (design §2.3 step 6, AC5): while the runtime exports, the doctor's key and account generation is refused at
 * the process edge — each prints a credential to the console, and the console is exported — before `main()` runs, so
 * nothing is minted and nothing is printed. `--grant` prints a username and scope names only and is not refused. With
 * OpenTelemetry off all four behave as today (the test above, and `doctor_grant_test.ts`). The real runtime, with a
 * loopback collector receiving no `/v1/logs`, is `tests/stdio/otel_gate_stdio_test.ts`.
 */
Deno.test('D-142 (AC5): key and account generation never reach main() while exporting; --grant does', async () => {
	const { enforceOtelEgress } = await import('../../packages/cli/otel_gate.ts');
	const listed = 'http://127.0.0.1:4318';
	const env: Record<string, string> = {
		OTEL_DENO: 'true',
		TTK_OTEL_ENDPOINTS: listed,
		OTEL_EXPORTER_OTLP_ENDPOINT: listed,
	};
	const exporting = (argv: string[]) => ({
		exporting: true,
		readable: () => true,
		read: (name: string) => env[name],
		argv,
	});
	for (const argv of [['doctor', '--new-key', 'x'], ['doctor', '--new-key-set', 'p'], ['doctor', '--new-admin', 'u']]) {
		const lines: string[] = [];
		const codes: number[] = [];
		const passed = enforceOtelEgress(argv, {
			inputs: exporting(argv),
			write: (line) => void lines.push(line),
			setExitCode: (code) => void codes.push(code),
		});
		assertEquals([passed, codes], [false, [1]], argv.join(' '));
		assertEquals(lines.length, 1);
		assert(!lines[0]!.includes('ttk_'), 'no credential in the refusal');
	}
	const grant = ['doctor', '--grant', 'u', '--scopes', 'mcp:invoke'];
	assert(enforceOtelEgress(grant, { inputs: exporting(grant), write: () => {}, setExitCode: () => {} }));
});

Deno.test('AC8 (D-137, D-138): doctor prints the otel and scope lines', async () => {
	const captured = await run(['doctor']);
	// The unit tier never exports, so OpenTelemetry is off and the scope is the default.
	assert(captured.out.includes('\notel            off\n'), captured.out);
	assert(captured.out.includes('\nscope           documents\n'), captured.out);
});
