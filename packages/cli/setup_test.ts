/**
 * `setup` writes every file the shipped compose files mount (design: docs/design/stack-tooling-and-secrets.md), with
 * modes the containers can read, the stack's scopes on the credentials it prints, and `.env` from the one template.
 * Run against a scratch checkout under `tests/.scratch`, the only place the unit tier may write. The host's AppArmor is
 * stood in for (`apparmor_test.ts` covers the unit itself): off, unless a test says otherwise.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { A2A_PEER_SCOPES as PEER_SCOPES, STACK_SCOPES } from '@tykotech/mcp';
import { type AppArmorHost, profileCommands, shellLine } from './apparmor.ts';
import { ENV_TEMPLATE, runSetup, SETUP_UNITS, setupUnits } from './mod.ts';

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

/**
 * A scratch folder standing in for a checkout; removed after `body`. Console output (the printed keys) is kept from
 * the terminal and handed to `body`, one entry per call.
 */
async function checkout(body: (root: string, out: string[]) => Promise<void>): Promise<void> {
	const scratch = fromFileUrl(new URL('tests/.scratch/', ROOT));
	await Deno.mkdir(scratch, { recursive: true });
	const root = await Deno.makeTempDir({ dir: scratch, prefix: 'setup-' });
	const { log, error } = console;
	const out: string[] = [];
	console.log = console.error = (...parts: unknown[]) => void out.push(parts.join(' '));
	try {
		await body(root, out);
	} finally {
		console.log = log;
		console.error = error;
		await Deno.remove(root, { recursive: true });
	}
}

const read = (root: string, path: string): Promise<string> => Deno.readTextFile(`${root}/${path}`);
const json = async (root: string, path: string): Promise<unknown> => JSON.parse(await read(root, path));
const mode = async (root: string, path: string): Promise<number> => (await Deno.stat(`${root}/${path}`)).mode! & 0o777;

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

Deno.test('setup: the stack and peer scopes are scopes, and never the explicit grants nobody gets unasked', async () => {
	const { SCOPES } = await import('@tykotech/gateway');
	for (const scope of [...STACK_SCOPES, ...PEER_SCOPES]) assert((SCOPES as readonly string[]).includes(scope), scope);
	for (const scope of ['task', 'evaluate', 'admin', 'metrics:read', 'network:read']) {
		assert(!(STACK_SCOPES as readonly string[]).includes(scope), `${scope} is not a stack scope`);
		assert(!(PEER_SCOPES as readonly string[]).includes(scope), `${scope} is not a peer scope`);
	}
	// The features the default stack runs are reachable with the key setup prints.
	for (const scope of ['sandbox:execute', 'agent:invoke', 'a2ui:publish', 'model:invoke', 'files:write']) {
		assert((STACK_SCOPES as readonly string[]).includes(scope), scope);
	}
});

Deno.test('setup: --only names units, and nothing else', () => {
	assertEquals(setupUnits(undefined), null);
	assertEquals(setupUnits('peer, env'), ['peer', 'env']);
	assertEquals(setupUnits('peer,nope'), undefined);
	assertEquals(setupUnits(','), undefined);
	assertEquals(setupUnits(SETUP_UNITS.join(',')), [...SETUP_UNITS]);
});

Deno.test('setup: a fresh checkout gets every file a shipped compose file mounts, readable by the containers', async () => {
	await checkout(async (root) => {
		assertEquals(await runSetup({}, root, OFF), 0);
		// Every secret file compose declares exists, except the one only you can write (the providers overlay's).
		const declared = await composeSecretFiles();
		assert(declared.size >= 11, `the compose files declare ${declared.size} secret files`);
		for (const name of declared) {
			if (name === 'ttk_model_providers.json') continue;
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

		// The peer pair: the gateway presents the token; the peer's key file holds its hash, A2A scopes only.
		const token = (await read(root, 'secrets/ttk_peer_token')).trim();
		const peerKeys = await json(root, 'secrets/ttk_peer_api_keys.json') as Array<Record<string, unknown>>;
		assertEquals(peerKeys, [{ id: 'gateway', sha256: await sha256(token), scopes: [...PEER_SCOPES] }]);
		assertEquals(await json(root, 'secrets/ttk_agent_peers.json'), [
			{ id: 'peer', url: 'http://a2a-peer:8787', token_file: '/run/secrets/ttk_peer_token' },
		]);

		// Placeholders that configure nothing until filled in, and the overlays' tokens.
		assertEquals(await json(root, 'secrets/ttk_secrets.json'), {});
		assertEquals(await json(root, 'secrets/ttk_git_remotes'), []);
		for (const name of ['ttk_sandbox_token', 'ttk_agent_bridge_token']) {
			assert(/^[0-9a-f]{64}$/.test((await read(root, `secrets/${name}`)).trim()), name);
		}
		const commands = await json(root, 'secrets/ttk_agent_commands.json') as Array<Record<string, unknown>>;
		assertEquals(commands.map((command) => [command.id, command.executable]), [['default', '/opt/agents/agent']]);
	});
});

Deno.test('setup: a second run keeps everything and repairs a mode the containers cannot read', async () => {
	await checkout(async (root) => {
		assertEquals(await runSetup({}, root, OFF), 0);
		const before = await read(root, 'secrets/ttk_api_keys.json');
		if (posix) await Deno.chmod(`${root}/secrets/ttk_db_key`, 0o600);
		assertEquals(await runSetup({}, root, OFF), 0);
		assertEquals(await read(root, 'secrets/ttk_api_keys.json'), before);
		if (posix) assertEquals(await mode(root, 'secrets/ttk_db_key'), 0o644);
	});
});

Deno.test('setup: --force replaces generated files, and yours only when --only names them', async () => {
	await checkout(async (root) => {
		assertEquals(await runSetup({}, root, OFF), 0);
		const yours = '{ "github_pw": { "value": "x", "domains": ["github.com"] } }\n';
		await Deno.writeTextFile(`${root}/secrets/ttk_secrets.json`, yours);
		const key = await read(root, 'secrets/ttk_db_key');
		const token = await read(root, 'secrets/ttk_peer_token');

		assertEquals(await runSetup({ force: true }, root, OFF), 0);
		assertNotEquals(await read(root, 'secrets/ttk_db_key'), key, 'a generated file is replaced');
		assertEquals(await read(root, 'secrets/ttk_secrets.json'), yours, 'a file you filled in is not');

		// --only peer --force: the pair is replaced together, and nothing else.
		const db = await read(root, 'secrets/ttk_db_key');
		assertEquals(await runSetup({ force: true, only: 'peer' }, root, OFF), 0);
		const replaced = (await read(root, 'secrets/ttk_peer_token')).trim();
		assertNotEquals(replaced, token.trim());
		const peerKeys = await json(root, 'secrets/ttk_peer_api_keys.json') as Array<{ sha256: string }>;
		assertEquals(peerKeys[0]?.sha256, await sha256(replaced));
		assertEquals(await read(root, 'secrets/ttk_db_key'), db);

		// Named, a file of yours is replaced too.
		assertEquals(await runSetup({ force: true, only: 'browser-secrets' }, root, OFF), 0);
		assertEquals(await json(root, 'secrets/ttk_secrets.json'), {});
	});
});

Deno.test('setup: a half-written peer pair is rewritten whole, and a bad --only or scope writes nothing', async () => {
	await checkout(async (root) => {
		assertEquals(await runSetup({ only: 'nope' }, root, OFF), 1);
		assertEquals(await runSetup({ scopes: 'mcp:invoke,bogus' }, root, OFF), 1);
		assertEquals(await Array.fromAsync(Deno.readDir(root)), [], 'nothing was written');

		assertEquals(await runSetup({ only: 'peer' }, root, OFF), 0);
		await Deno.remove(`${root}/secrets/ttk_peer_api_keys.json`);
		assertEquals(await runSetup({ only: 'peer' }, root, OFF), 0);
		const token = (await read(root, 'secrets/ttk_peer_token')).trim();
		const peerKeys = await json(root, 'secrets/ttk_peer_api_keys.json') as Array<{ sha256: string }>;
		assertEquals(peerKeys[0]?.sha256, await sha256(token));
	});
});

/** A scratch checkout's copy of the sandbox's AppArmor profile, at the path setup hands to sudo. */
async function profileSource(root: string): Promise<string> {
	await Deno.mkdir(`${root}/docker`, { recursive: true });
	await Deno.writeTextFile(`${root}/docker/apparmor-sandbox`, 'profile tykotech-sandbox {}\n');
	return `${root}/docker/apparmor-sandbox`;
}

Deno.test('setup: on an AppArmor host the profile is installed through sudo, after the credentials are on screen', async () => {
	await checkout(async (root, out) => {
		const source = await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({}, root, appArmorHost(null, calls, out)), 0);
		assertEquals(calls, profileCommands(source));
		const password = out.findIndex((line) => line.startsWith('  password'));
		assert(password >= 0 && password < out.indexOf('<sudo install>'), 'the password is shown before sudo can prompt');
		assert(out.some((line) => line.includes('is installed and loaded')), 'and the outcome is reported');
	});
});

Deno.test('setup: when sudo fails it exits 1, naming AppArmor and the commands to run by hand', async () => {
	await checkout(async (root, out) => {
		const source = await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({}, root, appArmorHost('sudo install exited with 1', calls, out)), 1);
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
	await checkout(async (root, out) => {
		await profileSource(root);
		const calls: string[][] = [];
		assertEquals(await runSetup({ only: 'apparmor' }, root, appArmorHost(null, calls, out)), 0);
		assertEquals(calls.map((argv) => argv[0]), ['install', 'apparmor_parser']);
		assertEquals(await Array.fromAsync(Deno.readDir(`${root}/secrets`)), []);
		assertEquals(await Array.fromAsync(Deno.readDir(root)).then((entries) => entries.map((e) => e.name).sort()), [
			'docker',
			'secrets',
		]);
	});
});
