/**
 * `setup` writes every file the shipped compose files mount (design: docs/security.md, Secrets), with
 * modes the containers can read, the stack's scopes on the credentials it prints, and `.env` from the one template.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { fromFileUrl, resolve } from '@std/path';
import { STACK_SCOPES } from '@tykotech/mcp';
import { type AppArmorHost, profileCommands, shellLine } from './apparmor.ts';
import {
	type CredentialStreams,
	ENV_TEMPLATE,
	localDefaults,
	localDefaultsLines,
	redactedUrl,
	runSetup,
	SETUP_UNITS,
	setupUnits,
} from './mod.ts';

const ROOT = new URL('../../', import.meta.url);
const posix = Deno.build.os !== 'windows';

/** A host without AppArmor: the unit does nothing there, and sudo must never run. */
const OFF: AppArmorHost = {
	enabled: () => Promise.resolve(false),
	installed: () => Promise.resolve(null),
	loaded: () => Promise.resolve(false),
	sudo: () => Promise.reject(new Error('sudo ran on a host without AppArmor')),
};

/** An AppArmor host without the profile, whose sudo records each command and answers with `answer`. */
function appArmorHost(answer: string | null, calls: string[][], out: string[]): AppArmorHost {
	let loaded = false;
	return {
		enabled: () => Promise.resolve(true),
		installed: () => Promise.resolve(null),
		loaded: () => Promise.resolve(loaded),
		sudo: (argv) => {
			calls.push([...argv]);
			out.push(`<sudo ${argv[0]}>`);
			loaded = answer === null && argv[0] === 'apparmor_parser';
			return Promise.resolve(answer);
		},
	};
}

/** What marks an entry of `checkout`'s `out` that was written to a credential stream rather than through `console`. */
const SHOWN = '[shown] ';

/** A scratch folder standing in for a checkout; removed after `body`. */
async function checkout(
	body: (root: string, out: string[], show: CredentialStreams) => Promise<void>,
): Promise<void> {
	const scratch = fromFileUrl(new URL('tests/.scratch/', ROOT));
	await Deno.mkdir(scratch, { recursive: true });
	const root = await Deno.makeTempDir({ dir: scratch, prefix: 'setup-' });
	const { log, error } = console;
	const out: string[] = [];
	console.log = console.error = (...parts: unknown[]) => void out.push(parts.join(' '));
	const shown = (text: string): void => {
		for (const line of text.replace(/\n$/, '').split('\n')) out.push(`${SHOWN}${line}`);
	};
	try {
		await body(root, out, { out: shown, err: shown });
	} finally {
		console.log = log;
		console.error = error;
		await Deno.remove(root, { recursive: true });
	}
}

const read = (root: string, path: string): Promise<string> => Deno.readTextFile(`${root}/${path}`);
const json = async (root: string, path: string): Promise<unknown> => JSON.parse(await read(root, path));
const mode = async (root: string, path: string): Promise<number> => (await Deno.stat(`${root}/${path}`)).mode! & 0o777;

/** Every file `setup` writes in `secrets/`, by name. */
const SETUP_SECRET_FILES = [
	'ttk_admin_user.json',
	'ttk_api_keys.json',
	'ttk_db_key',
	'ttk_git_remotes',
	'ttk_sandbox_token',
	'ttk_secrets.json',
];

/** Every `file: ./secrets/<name>` the shipped compose files declare. */
async function composeSecretFiles(): Promise<Set<string>> {
	const files = new Set<string>();
	for await (const entry of Deno.readDir(ROOT)) {
		if (!/^docker-compose(\.[a-z-]+)?\.yml$/.test(entry.name) || entry.name === 'docker-compose.override.yml') continue;
		const text = await Deno.readTextFile(new URL(entry.name, ROOT));
		for (const line of text.split(/\r?\n/)) {
			if (line.trim().startsWith('#')) continue;
			const match = /^\s+file: \.\/secrets\/(\S+)$/.exec(line);
			if (match !== null) files.add(match[1]!);
		}
	}
	return files;
}

Deno.test('setup: .env.example is the template setup writes, byte for byte', async () => {
	assertEquals(await Deno.readTextFile(new URL('.env.example', ROOT)), ENV_TEMPLATE);
});

Deno.test('setup: the stack scopes are scopes, and never the explicit grants nobody gets unasked', async () => {
	const { SCOPES } = await import('@tykotech/gateway');
	for (const scope of STACK_SCOPES) assert((SCOPES as readonly string[]).includes(scope), scope);
	for (const scope of ['task', 'evaluate', 'admin', 'metrics:read', 'network:read']) {
		assert(!(STACK_SCOPES as readonly string[]).includes(scope), `${scope} is not a stack scope`);
	}
	// The features the default stack runs are reachable with the key setup prints.
	for (const scope of ['sandbox:execute', 'agent:invoke', 'a2ui:publish', 'model:invoke', 'files:write']) {
		assert((STACK_SCOPES as readonly string[]).includes(scope), scope);
	}
});

Deno.test('doctor: a URL on a diagnostic line never carries its username or password', () => {
	assertEquals(redactedUrl(new URL('https://idp.example.com/realms/main')), 'https://idp.example.com/realms/main');
	assertEquals(
		redactedUrl(new URL('https://ops:hunter2@idp.example.com/realms/main?x=1')),
		'https://idp.example.com/realms/main?x=1',
	);
	assertEquals(redactedUrl(new URL('http://ops@127.0.0.1:8787/')), 'http://127.0.0.1:8787/');
});

Deno.test('setup: --only names units, and nothing else', () => {
	assertEquals(setupUnits(undefined), null);
	assertEquals(setupUnits('sandbox-token, env'), ['sandbox-token', 'env']);
	assertEquals(setupUnits('env,nope'), undefined);
	// The retired units of the bundled A2A peer and the ACP runner overlay are unknown now.
	for (const retired of ['peer', 'agent-token', 'agent-commands']) {
		assertEquals(setupUnits(retired), undefined, retired);
	}
	assertEquals(setupUnits(','), undefined);
	assertEquals(setupUnits(SETUP_UNITS.join(',')), [...SETUP_UNITS]);
});

Deno.test('setup: a fresh checkout gets every file a shipped compose file mounts, readable by the containers', async () => {
	await checkout(async (root, out, show) => {
		assertEquals(await runSetup({}, root, OFF, show), 0);
		// The generated password and key are written to the stream itself; neither is a console line (a log line).
		const value = (label: string): string =>
			out.find((line) => line.startsWith(`${SHOWN}  ${label}`))?.slice(`${SHOWN}  ${label}`.length).trim() ?? '';
		const credentials = [value('password'), value('api key')];
		assert(credentials[0]!.length >= 20 && credentials[1]!.startsWith('ttk_'), 'both are shown');
		const logged = out.filter((line) => !line.startsWith(SHOWN)).join('\n');
		for (const credential of credentials) assert(!logged.includes(credential), 'a credential went through console');
		assert(logged.includes('Shown once, stored only as hashes'), 'the heading is an ordinary line');

		// Exactly these files, and among them every secret file a compose file declares.
		const written = (await Array.fromAsync(Deno.readDir(`${root}/secrets`))).map((entry) => entry.name).sort();
		assertEquals(written, SETUP_SECRET_FILES);
		const declared = await composeSecretFiles();
		assert(declared.size >= 5, `the compose files declare ${declared.size} secret files`);
		for (const name of declared) assert(SETUP_SECRET_FILES.includes(name), `setup writes secrets/${name}`);
		for (const name of SETUP_SECRET_FILES) {
			assert((await Deno.stat(`${root}/secrets/${name}`)).isFile, `secrets/${name}`);
			if (posix) assertEquals(await mode(root, `secrets/${name}`), 0o644, `secrets/${name} mode`);
		}
		if (posix) assertEquals(await mode(root, 'secrets'), 0o700, 'the directory keeps them private');
		assertEquals(await read(root, '.env'), ENV_TEMPLATE);

		// The client key and the administrator hold the stack's scopes.
		const keys = await json(root, 'secrets/ttk_api_keys.json') as Array<{ id: string; scopes: string[] }>;
		assertEquals(keys.map((key) => [key.id, key.scopes]), [['client', [...STACK_SCOPES]]]);
		const admin = await json(root, 'secrets/ttk_admin_user.json') as { username: string; scopes: string[] };
		assertEquals([admin.username, admin.scopes], ['admin', [...STACK_SCOPES, 'admin']]);
		assertEquals((await read(root, 'secrets/ttk_db_key')).trim().length, 43);

		// Placeholders that configure nothing until filled in.
		assertEquals(await json(root, 'secrets/ttk_secrets.json'), {});
		assertEquals(await json(root, 'secrets/ttk_git_remotes'), []);
		// The sandbox's bearer, which Compose mounts into both the gateway and the sandbox.
		const sandboxToken = await Deno.lstat(`${root}/secrets/ttk_sandbox_token`);
		assert(sandboxToken.isFile && !sandboxToken.isSymlink && sandboxToken.size <= 4096, 'a plain small file');
		assert(/^[0-9a-f]{64}\n$/.test(await read(root, 'secrets/ttk_sandbox_token')), '64 hex characters and one newline');
		if (posix) assertEquals(await mode(root, 'secrets/ttk_sandbox_token'), 0o644, 'the sandbox uid reads it');
	});
});

Deno.test('setup: a second run keeps everything and repairs a mode the containers cannot read', async () => {
	await checkout(async (root, _out, show) => {
		assertEquals(await runSetup({}, root, OFF, show), 0);
		const before = await read(root, 'secrets/ttk_api_keys.json');
		if (posix) await Deno.chmod(`${root}/secrets/ttk_db_key`, 0o600);
		assertEquals(await runSetup({}, root, OFF, show), 0);
		assertEquals(await read(root, 'secrets/ttk_api_keys.json'), before);
		if (posix) assertEquals(await mode(root, 'secrets/ttk_db_key'), 0o644);
	});
});

Deno.test('setup: --force replaces generated files, and yours only when --only names them', async () => {
	await checkout(async (root, _out, show) => {
		assertEquals(await runSetup({}, root, OFF, show), 0);
		const yours = '{ "github_pw": { "value": "x", "domains": ["github.com"] } }\n';
		await Deno.writeTextFile(`${root}/secrets/ttk_secrets.json`, yours);
		const key = await read(root, 'secrets/ttk_db_key');
		const sandboxToken = await read(root, 'secrets/ttk_sandbox_token');

		assertEquals(await runSetup({ force: true }, root, OFF, show), 0);
		assertNotEquals(await read(root, 'secrets/ttk_db_key'), key, 'a generated file is replaced');
		assertNotEquals(await read(root, 'secrets/ttk_sandbox_token'), sandboxToken, 'the sandbox token too');
		assertEquals(await read(root, 'secrets/ttk_secrets.json'), yours, 'a file you filled in is not');

		// --only sandbox-token --force: that file is replaced, and nothing else.
		const db = await read(root, 'secrets/ttk_db_key');
		const before = await read(root, 'secrets/ttk_sandbox_token');
		assertEquals(await runSetup({ force: true, only: 'sandbox-token' }, root, OFF, show), 0);
		assertNotEquals(await read(root, 'secrets/ttk_sandbox_token'), before);
		assertEquals(await read(root, 'secrets/ttk_db_key'), db);

		// Named, a file of yours is replaced too.
		assertEquals(await runSetup({ force: true, only: 'browser-secrets' }, root, OFF, show), 0);
		assertEquals(await json(root, 'secrets/ttk_secrets.json'), {});
	});
});

Deno.test('setup: a bad --only or scope writes nothing', async () => {
	await checkout(async (root, _out, show) => {
		assertEquals(await runSetup({ only: 'nope' }, root, OFF, show), 1);
		assertEquals(await runSetup({ only: 'peer' }, root, OFF, show), 1);
		assertEquals(await runSetup({ scopes: 'mcp:invoke,bogus' }, root, OFF, show), 1);
		assertEquals(await Array.fromAsync(Deno.readDir(root)), [], 'nothing was written');
	});
});

/** A scratch checkout's copy of the sandbox's AppArmor profile, at the path setup hands to sudo. */
async function profileSource(root: string): Promise<string> {
	await Deno.mkdir(`${root}/docker`, { recursive: true });
	await Deno.writeTextFile(`${root}/docker/apparmor-sandbox`, 'profile tykotech-sandbox {}\n');
	// Resolved the way setup resolves it, so the path matches on Windows too.
	return resolve(root, 'docker', 'apparmor-sandbox');
}

Deno.test('setup: on an AppArmor host the profile is installed through sudo, after the credentials are on screen', async () => {
	await checkout(async (root, out, show) => {
		const source = await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({}, root, appArmorHost(null, calls, out), show), 0);
		assertEquals(calls, profileCommands(source));
		const password = out.findIndex((line) => line.startsWith(`${SHOWN}  password`));
		assert(password >= 0 && password < out.indexOf('<sudo install>'), 'the password is shown before sudo can prompt');
		assert(out.some((line) => line.includes('is installed and loaded')), 'and the outcome is reported');
	});
});

Deno.test('setup: when sudo fails it exits 1, naming AppArmor and the commands to run by hand', async () => {
	await checkout(async (root, out, show) => {
		const source = await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({}, root, appArmorHost('sudo install exited with 1', calls, out), show), 1);
		assertEquals(calls.length, 1, 'nothing runs after the refusal');
		const error = out.find((line) => line.includes('error: AppArmor')) ?? '';
		assert(error.includes('could not be installed: sudo install exited with 1.'), 'the reason');
		assert(error.includes('unable to apply apparmor profile'), 'what Docker says without the profile');
		for (const argv of profileCommands(source)) {
			assert(error.includes(`\n  sudo ${shellLine(argv)}\n`), `the manual command: sudo ${argv.join(' ')}`);
		}
		assert((await Deno.stat(`${root}/secrets/ttk_db_key`)).isFile, 'every file is written all the same');
		assert(!out.some((line) => line.includes('Next: docker compose up')), 'and it does not say the stack is ready');
	});
});

Deno.test('setup: --only apparmor installs the profile and writes no file', async () => {
	await checkout(async (root, out, show) => {
		await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({ only: 'apparmor' }, root, appArmorHost(null, calls, out), show), 0);
		assertEquals(calls.map((argv) => argv[0]), ['install', 'apparmor_parser']);
		assertEquals(await Array.fromAsync(Deno.readDir(`${root}/secrets`)), []);
		assertEquals(await Array.fromAsync(Deno.readDir(root)).then((entries) => entries.map((e) => e.name).sort()), [
			'docker',
			'secrets',
		]);
	});
});

/** A checkout whose `present` answers from `files` alone. */
const checkoutWith = (...files: string[]) => (path: string): Promise<boolean> => Promise.resolve(files.includes(path));
const SET_UP = [
	'secrets/ttk_db_key',
	'secrets/ttk_api_keys.json',
	'secrets/ttk_secrets.json',
	'secrets/ttk_sandbox_token',
];

Deno.test('local defaults: --local-defaults names what setup wrote, by path, for each variable left unset', async () => {
	const input = { TTK_LOG_LEVEL: 'debug' };
	const defaults = await localDefaults(input, { apiKeys: true }, checkoutWith(...SET_UP));
	assertEquals(defaults.env, {
		TTK_LOG_LEVEL: 'debug',
		TTK_DATA_DIR: 'data',
		TTK_DB_KEY_FILE: 'secrets/ttk_db_key',
		TTK_API_KEYS_FILE: 'secrets/ttk_api_keys.json',
		TTK_SECRETS_FILE: 'secrets/ttk_secrets.json',
	});
	assertEquals(input, { TTK_LOG_LEVEL: 'debug' }, 'the input is not changed');
	assert(defaults.setUp);
	assertEquals(localDefaultsLines(defaults), {
		info: [
			'local defaults from deno task setup: TTK_DATA_DIR=data, TTK_DB_KEY_FILE=secrets/ttk_db_key, ' +
			'TTK_API_KEYS_FILE=secrets/ttk_api_keys.json, TTK_SECRETS_FILE=secrets/ttk_secrets.json',
		],
		warn: [],
	});
	// stdio and seed authenticate nobody; the sandbox token goes only beside a sandbox URL.
	const stdio = await localDefaults(
		{ TTK_SANDBOX_URL: 'http://127.0.0.1:8080' },
		{ apiKeys: false },
		checkoutWith(...SET_UP),
	);
	assertEquals(stdio.env.TTK_API_KEYS_FILE, undefined);
	assertEquals(stdio.env.TTK_SANDBOX_TOKEN_FILE, 'secrets/ttk_sandbox_token');
});

Deno.test('local defaults: an explicit variable, or another form of it, wins; a missing file is not named', async () => {
	const defaults = await localDefaults(
		{
			TTK_DATA_DIR: '/srv/ttk',
			TTK_API_KEYS: '[]',
			TTK_SECRETS_REF: 'vault:kv/ttk#secrets',
			TTK_SANDBOX_URL: 'http://127.0.0.1:8080',
			TTK_SANDBOX_TOKEN_FILE: '/run/secrets/token',
		},
		{ apiKeys: true },
		checkoutWith('secrets/ttk_db_key', 'secrets/ttk_api_keys.json', 'secrets/ttk_secrets.json'),
	);
	assertEquals(defaults.applied, ['TTK_DB_KEY_FILE=secrets/ttk_db_key']);
	assertEquals(defaults.env.TTK_DATA_DIR, '/srv/ttk');
	assertEquals(defaults.env.TTK_SANDBOX_TOKEN_FILE, '/run/secrets/token');
	for (const name of ['TTK_API_KEYS_FILE', 'TTK_SECRETS_FILE']) assertEquals(defaults.env[name], undefined, name);
});

Deno.test('local defaults: a checkout without setup starts without them, and is told how to get the files', async () => {
	const defaults = await localDefaults({}, { apiKeys: true }, checkoutWith('secrets/ttk_secrets.json'));
	// No key: no data directory either, so the server stays stateless; a file setup would write is still offered.
	assertEquals(defaults.env, { TTK_SECRETS_FILE: 'secrets/ttk_secrets.json' });
	assertEquals(defaults.setUp, false);
	const { warn } = localDefaultsLines(defaults);
	assertEquals(warn.length, 1);
	assert(warn[0]!.includes('run deno task setup'), warn[0]);
	// A key file of the operator's own needs no advice, and brings no data directory with it.
	const own = await localDefaults({ TTK_DB_KEY_FILE: '/keys/ttk_db_key' }, { apiKeys: true }, checkoutWith());
	assertEquals([own.applied, localDefaultsLines(own).warn], [[], []]);
});

Deno.test('local defaults: they hold on a real checkout setup wrote', async () => {
	await checkout(async (root, _out, show) => {
		assertEquals(await runSetup({}, root, OFF, show), 0);
		const present = async (path: string) => (await Deno.lstat(`${root}/${path}`).catch(() => null)) !== null;
		const defaults = await localDefaults({}, { apiKeys: true }, present);
		assert(defaults.setUp);
		assertEquals(defaults.applied.length, 4, defaults.applied.join(', '));
	});
});
