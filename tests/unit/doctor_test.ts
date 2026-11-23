/**
 * `doctor` through the CLI: key minting (raw keys only on the credential streams, never through `console`), the
 * offline admin repair (`--grant`), and the model-providers report (never a key, never a URL path).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join, resolve } from '@std/path';
import { main } from '../../packages/cli/mod.ts';
import { generateAdminUser, SCOPES, UserStore } from '@tykotech/gateway';

/** Runs the CLI: `out`/`err` are what went through `console`, `shown` what reached the credential streams. */
async function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const console_ = { log: console.log, error: console.error };
	const previous = Object.keys(env).map((name) => [name, Deno.env.get(name)] as const);
	const out: string[] = [];
	const err: string[] = [];
	const shown = { out: '', err: '' };
	console.log = (...args: unknown[]) => void out.push(args.map(String).join(' '));
	console.error = (...args: unknown[]) => void err.push(args.map(String).join(' '));
	for (const [name, value] of Object.entries(env)) {
		value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
	}
	try {
		const code = await main(argv, { out: (text) => void (shown.out += text), err: (text) => void (shown.err += text) });
		return { out: out.join('\n'), err: err.join('\n'), shown, code };
	} finally {
		Object.assign(console, console_);
		for (const [name, value] of previous) value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
	}
}

Deno.test('doctor --new-key-set: one single-scope key per scope; raw keys only on the stderr stream', async () => {
	const captured = await run(['doctor', '--new-key-set', 'web']);
	assertEquals(captured.code, 0);
	const records = JSON.parse(captured.out) as Array<{ id: string; sha256: string; scopes?: string[] }>;
	assertEquals(records.length, SCOPES.length);
	for (const scope of SCOPES) {
		const record = records.find((entry) => entry.id === `web-${scope.replace(/:/g, '-')}`);
		assertEquals(record?.scopes, [scope], `${scope}: exactly its one scope`);
		assert(/^[0-9a-f]{64}$/.test(record?.sha256 ?? ''), `${scope}: a sha256, not a raw key`);
	}
	assert(captured.err.includes('web-mcp-invoke'), 'the ids are on stderr');
	assert(
		!`${captured.out}${captured.err}${captured.shown.out}`.includes('ttk_'),
		'no raw key through console or stdout',
	);
	assertEquals(captured.shown.err.match(/ttk_[A-Za-z0-9_-]+/g)?.length, SCOPES.length);

	const single = await run(['doctor', '--new-key', 'unit']);
	assertEquals(single.code, 0);
	assert((/ttk_[A-Za-z0-9_-]+/.exec(single.shown.out)?.[0] ?? '').length > 20, 'the raw key is on the stream');
	assert(!single.out.includes('ttk_'), 'no raw key through console');
	assertEquals(JSON.parse(single.out.slice(single.out.indexOf('['))).map((r: { id: string }) => r.id), ['unit']);
});

Deno.test('doctor --grant: rewrites one account, upgrading the store; refusals change nothing; the last admin stays', async () => {
	const dir = join('tests/.scratch', `grant-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	try {
		const at = '2026-09-01T00:00:00.000Z';
		const { record: root } = await generateAdminUser('root', 'correct horse battery', ['view:watch']);
		const { record: alice } = await generateAdminUser('alice', 'correct horse battery', ['view:watch']);
		const { scopes: _dropped, ...legacy } = (await generateAdminUser('legacy', 'correct horse battery')).record;
		const users = [root, alice, legacy].map((user) => ({ ...user, created_at: at, updated_at: at }));
		await Deno.writeTextFile(join(dir, 'users.json'), JSON.stringify({ version: 1, users }));
		const grant = (user: string, ...scopes: string[]) =>
			run(['doctor', '--grant', user, ...scopes.flatMap((list) => ['--scopes', list]), '--data-dir', dir]);

		const granted = await grant('alice', 'mcp:invoke, admin');
		assertEquals(granted.code, 0, granted.err);
		assertStringIncludes(granted.out, 'granted alice: mcp:invoke, admin');
		assertStringIncludes(granted.out, 'upgraded 1 other account(s) to explicit scopes');
		const store = new UserStore({ dataDir: dir, seed: null });
		assertEquals([...store.scopesOf('alice')!], ['mcp:invoke', 'admin']);
		assert(store.scopesOf('legacy')!.has('admin'), 'the scope-less account kept its legacy grant');
		assertEquals([...store.scopesOf('root')!], ['view:watch']);
		assertEquals(store.adminWarning(), null);

		const before = await Deno.readTextFile(join(dir, 'users.json'));
		for (
			const [refused, reason] of [
				[await grant('alice'), '--scopes'],
				[await grant('alice', 'admin,root'), 'unknown scopes: root'],
				[await grant('ghost', 'admin'), 'refused: no user "ghost"'],
			] as const
		) {
			assertEquals(refused.code, 1);
			assertStringIncludes(refused.err, reason);
		}
		assertEquals(await Deno.readTextFile(join(dir, 'users.json')), before, 'no refusal wrote anything');
		assertEquals((await grant('alice', 'mcp:invoke')).code, 0, 'another enabled admin remains');
		const lastAdmin = await grant('legacy', 'mcp:invoke');
		assertEquals(lastAdmin.code, 1);
		assertStringIncludes(lastAdmin.err, 'admin scope');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

const INLINE_KEY = 'sk-inline-0123456789abcdefghijklmnop';
const FILE_KEY = 'sk-file-0123456789abcdefghijklmnopqrst';

/** `doctor` over a providers file (an `api_key_file` entry points at a real key file); never a key in the output. */
async function doctorWith(providers: Array<Record<string, unknown>>) {
	const dir = resolve(join('tests/.scratch', `providers-${crypto.randomUUID().slice(0, 8)}`));
	await Deno.mkdir(dir, { recursive: true });
	try {
		await Deno.writeTextFile(join(dir, 'key'), `${FILE_KEY}\n`);
		const file = join(dir, 'providers.json');
		const withPaths = providers.map((p) => 'api_key_file' in p ? { ...p, api_key_file: join(dir, 'key') } : p);
		await Deno.writeTextFile(file, JSON.stringify({ version: 1, providers: withPaths }));
		const captured = await run(['doctor'], { TTK_MODEL_PROVIDERS_FILE: file });
		const everything = `${captured.out}\n${captured.err}`;
		for (const secret of [INLINE_KEY, FILE_KEY, 'sk-short']) assert(!everything.includes(secret), 'a key reached it');
		return captured;
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test('doctor: the model providers line names id, kind, host, model count, key source and warnings', async () => {
	const listed = await doctorWith([
		{
			id: 'claude',
			kind: 'anthropic',
			base_url: 'https://api.anthropic.com/v1/secret-path',
			models: ['c'],
			api_key_file: '',
		},
		{ id: 'local', kind: 'openai', base_url: 'http://127.0.0.1:11434/v1', models: ['a', 'b'], api_key: INLINE_KEY },
		{ id: 'ollama', kind: 'openai', base_url: 'http://ollama:11434/v1', models: ['a'], allow_http: true },
	]);
	assertEquals(listed.code, 0, listed.err);
	assertStringIncludes(
		listed.out,
		'\nmodel providers claude (anthropic, api.anthropic.com:443, 1 models, key: file), ' +
			'local (openai, 127.0.0.1:11434, 2 models, key: inline), ' +
			'ollama (openai, ollama:11434, 1 models, key: none); default: none\n' +
			'warning: model provider ollama: allow_http is set, plaintext HTTP to ollama:11434 is permitted\n',
	);
	assert(!listed.out.includes('/v1'), 'no URL path');

	const sole = await doctorWith([
		{ id: 'local', kind: 'openai', base_url: 'http://localhost:11434', models: ['m'], api_key: 'sk-short' },
	]);
	assertStringIncludes(
		sole.out,
		'\nmodel providers local (openai, localhost:11434, 1 models, key: inline); default: local\n',
	);
	assertStringIncludes(sole.out, '\nwarning: model provider local: short key: not redacted from task output\n');

	const plaintext = await doctorWith([
		{ id: 'o', kind: 'openai', base_url: 'http://ollama:11434', models: ['m'], allow_http: true, api_key: INLINE_KEY },
	]);
	assertEquals(plaintext.code, 0, plaintext.err);
	assertStringIncludes(plaintext.out, 'is permitted; its API key travels in plaintext\n');

	assertStringIncludes(
		(await run(['doctor'], { TTK_MODEL_PROVIDERS_FILE: undefined })).out,
		'\nmodel providers none\n',
	);
});

Deno.test('doctor: a refused providers file exits 1 naming the entry and the field, never the value', async () => {
	const header = await doctorWith([
		{
			id: 'l',
			kind: 'openai',
			base_url: 'https://api.example.com/v1',
			models: ['m'],
			headers: { authorization: `Bearer ${INLINE_KEY}` },
		},
	]);
	assertEquals(header.code, 1);
	assertStringIncludes(header.err, 'configuration error: TTK_MODEL_PROVIDERS_FILE (');
	assertStringIncludes(header.err, 'a credential header is refused; use api_key, entry 1, field headers.authorization');
	assert(!header.out.includes('model providers'));
	const publicHttp = await doctorWith([
		{ id: 'p', kind: 'openai', base_url: 'https://8.8.8.8/v1', models: ['m'], allow_http: true, api_key: INLINE_KEY },
	]);
	assertEquals(publicHttp.code, 1);
	assertStringIncludes(
		publicHttp.err,
		'allow_http with a key needs a loopback, private or named host, entry 1, field allow_http',
	);
});
