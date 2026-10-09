/**
 * D-143 (model-providers-ui W1, backend §2.5): the doctor's `model providers` line — each provider as
 * `id (kind, host, N models, key: file|inline|none)`, the default, one `warning:` per `allow_http` provider — and the
 * fail-fast on a refused file, which names the entry and the field.
 *
 * The security claim: the captured output, stdout and stderr both, never carries a key (inline or file-backed) and
 * never a URL path; a refused file reports the field, never the value.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join, resolve } from '@std/path';
import { main } from '../../packages/cli/mod.ts';
import { modelProvidersDoctorLines } from '../../packages/cli/mod.ts';
import { providerNetHost } from '@tykotech/gateway';

interface Captured {
	out: string;
	err: string;
	code: number;
}

async function run(argv: string[]): Promise<Captured> {
	const outParts: string[] = [];
	const errParts: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...args: unknown[]) => void outParts.push(args.map(String).join(' '));
	console.error = (...args: unknown[]) => void errParts.push(args.map(String).join(' '));
	try {
		const code = await main(argv);
		return { out: outParts.join('\n'), err: errParts.join('\n'), code };
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
}

async function withEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, Deno.env.get(name));
		if (value === undefined) Deno.env.delete(name);
		else Deno.env.set(name, value);
	}
	try {
		await body();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) Deno.env.delete(name);
			else Deno.env.set(name, value);
		}
	}
}

const INLINE_KEY = 'sk-inline-0123456789abcdefghijklmnop';
const FILE_KEY = 'sk-file-0123456789abcdefghijklmnopqrst';

/** A providers file and a key file under the scratch tree; the key file by absolute path, as the parser requires. */
async function scratchFiles(providers: unknown[]): Promise<{ dir: string; file: string }> {
	const dir = resolve(join('tests/.scratch', `providers-${crypto.randomUUID().slice(0, 8)}`));
	await Deno.mkdir(dir, { recursive: true });
	await Deno.writeTextFile(join(dir, 'key'), `${FILE_KEY}\n`);
	const file = join(dir, 'providers.json');
	const withPaths = providers.map((p) =>
		typeof p === 'object' && p !== null && 'api_key_file' in p ? { ...p, api_key_file: join(dir, 'key') } : p
	);
	await Deno.writeTextFile(file, `${JSON.stringify({ version: 1, providers: withPaths })}\n`);
	return { dir, file };
}

Deno.test('doctor: the model providers line names id, kind, host, model count and key source — never the key or the path', async () => {
	const { dir, file } = await scratchFiles([
		{
			id: 'claude',
			kind: 'anthropic',
			base_url: 'https://api.anthropic.com/v1/secret-path',
			models: ['claude-sonnet-4-5'],
			api_key_file: '',
		},
		{
			id: 'local',
			kind: 'openai',
			base_url: 'http://127.0.0.1:11434/v1',
			models: ['llama3', 'qwen3'],
			api_key: INLINE_KEY,
		},
		{ id: 'ollama', kind: 'openai', base_url: 'http://ollama:11434/v1', models: ['llama3'], allow_http: true },
	]);
	try {
		await withEnv({ TTK_MODEL_PROVIDERS_FILE: file }, async () => {
			const captured = await run(['doctor']);
			assertEquals(captured.code, 0, captured.err);
			assertStringIncludes(
				captured.out,
				'\nmodel providers claude (anthropic, api.anthropic.com:443, 1 models, key: file), ' +
					'local (openai, 127.0.0.1:11434, 2 models, key: inline), ' +
					'ollama (openai, ollama:11434, 1 models, key: none); default: none\n',
			);
			assertStringIncludes(
				captured.out,
				'\nwarning: model provider ollama: allow_http is set, plaintext HTTP to ollama:11434 is permitted\n',
			);
			const everything = `${captured.out}\n${captured.err}`;
			assert(!everything.includes(INLINE_KEY), 'the inline key reached the doctor output');
			assert(!everything.includes(FILE_KEY), 'the file-backed key reached the doctor output');
			assert(!everything.includes('secret-path'), 'the URL path reached the doctor output');
			assert(!everything.includes('/v1'), 'the URL path reached the doctor output');
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('doctor: a sole provider is the default; a short key adds a warning line', async () => {
	const { dir, file } = await scratchFiles([
		{ id: 'local', kind: 'openai', base_url: 'http://localhost:11434', models: ['llama3'], api_key: 'sk-short' },
	]);
	try {
		await withEnv({ TTK_MODEL_PROVIDERS_FILE: file }, async () => {
			const captured = await run(['doctor']);
			assertEquals(captured.code, 0, captured.err);
			assertStringIncludes(
				captured.out,
				'\nmodel providers local (openai, localhost:11434, 1 models, key: inline); default: local\n',
			);
			assertStringIncludes(captured.out, '\nwarning: model provider local: short key: not redacted from task output\n');
			assert(!captured.out.includes('sk-short'));
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('doctor: a refused file exits 1 naming the entry and the field — headers.authorization — and never the value', async () => {
	const { dir, file } = await scratchFiles([
		{
			id: 'local',
			kind: 'openai',
			base_url: 'https://api.example.com/v1',
			models: ['m'],
			headers: { authorization: `Bearer ${INLINE_KEY}` },
		},
	]);
	try {
		await withEnv({ TTK_MODEL_PROVIDERS_FILE: file }, async () => {
			const captured = await run(['doctor']);
			assertEquals(captured.code, 1);
			assertStringIncludes(captured.err, 'configuration error: TTK_MODEL_PROVIDERS_FILE (');
			assertStringIncludes(
				captured.err,
				'a credential header is refused; use api_key, entry 1, field headers.authorization',
			);
			assert(!`${captured.out}${captured.err}`.includes(INLINE_KEY), 'the header value reached the doctor output');
			assert(!captured.out.includes('model providers'), 'no providers line is printed for a refused file');
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('doctor: branch (v) is reported with its field, never the key', async () => {
	const { dir, file } = await scratchFiles([
		{
			id: 'ollama',
			kind: 'openai',
			base_url: 'http://ollama:11434',
			models: ['m'],
			allow_http: true,
			api_key: INLINE_KEY,
		},
	]);
	try {
		await withEnv({ TTK_MODEL_PROVIDERS_FILE: file }, async () => {
			const captured = await run(['doctor']);
			assertEquals(captured.code, 1);
			assertStringIncludes(captured.err, 'a key never travels in plaintext off the host, entry 1, field allow_http');
			assert(!`${captured.out}${captured.err}`.includes(INLINE_KEY));
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('doctor: without the variable the line says none', async () => {
	await withEnv({ TTK_MODEL_PROVIDERS_FILE: undefined }, async () => {
		const captured = await run(['doctor']);
		assertStringIncludes(captured.out, '\nmodel providers none\n');
	});
});

Deno.test('doctor: modelProvidersDoctorLines renders the line and the warnings from the resolved shape alone — the host as providerNetHost spells it (DX-1 / CR2-11 / BUG-12)', () => {
	assertEquals(modelProvidersDoctorLines(null, [], providerNetHost), ['model providers none']);
	assertEquals(modelProvidersDoctorLines({ default: null, providers: [] }, ['ignored'], providerNetHost), [
		'model providers none',
	]);
	assertEquals(
		modelProvidersDoctorLines(
			{
				default: 'a',
				providers: [
					{ id: 'a', kind: 'openai', host: 'h:1', baseUrl: 'http://h:1/v1', models: ['x'], keySource: 'file' },
					{
						id: 'b',
						kind: 'anthropic',
						host: 'api.anthropic.com',
						baseUrl: 'https://api.anthropic.com/v1',
						models: ['x', 'y'],
						keySource: 'inline',
					},
				],
			},
			['model provider a: allow_http is set, plaintext HTTP to h:1 is permitted'],
			providerNetHost,
		),
		[
			'model providers a (openai, h:1, 1 models, key: file), b (anthropic, api.anthropic.com:443, 2 models, key: inline); default: a',
			'warning: model provider a: allow_http is set, plaintext HTTP to h:1 is permitted',
		],
	);
});
