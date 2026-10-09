/**
 * C6 and C9 (D-099): the administrator seed is validated like every other credential, and accounts count as
 * credentials for the bind policy.
 *
 * C6: an invalid `TTK_ADMIN_USER` used to be read as "no seed" — a server nobody could sign in to, started without a
 * word; both forms set was silently resolved; and the implicit `secrets/ttk_admin_user.json` swallowed every error.
 * C9: `checkBindPolicy` counted keys and OAuth only, so a non-loopback deployment whose one credential was an account
 * was refused while the verifier was perfectly able to authenticate it.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { generateAdminUser } from './admin_auth.ts';
import { checkBindPolicy, ConfigError, loadConfig } from './config.ts';
import { DEFAULT_ADMIN_USER_FILE, resolveSecrets, SecretError } from './secrets.ts';

async function record(): Promise<string> {
	return JSON.stringify((await generateAdminUser('root', 'correct horse battery')).record);
}

/** A reader over a fixed set of files; anything else is absent, as on a real disk. */
function disk(files: Record<string, string>): (path: string) => Promise<string> {
	return (path) =>
		files[path] === undefined ? Promise.reject(new Deno.errors.NotFound(path)) : Promise.resolve(files[path]);
}

Deno.test('config: an invalid TTK_ADMIN_USER refuses startup, naming the variable and never the value (C6)', async () => {
	const valid = await record();
	assertEquals(loadConfig({ TTK_ADMIN_USER: valid }).adminUser?.username, 'root');

	const notJson = assertThrows(() => loadConfig({ TTK_ADMIN_USER: '{"username":"root","hash":"s3cr3t' }), ConfigError);
	assertStringIncludes(notJson.message, 'TTK_ADMIN_USER');
	assertStringIncludes(notJson.message, 'not valid JSON');
	assert(!notJson.message.includes('s3cr3t'), 'the value is never echoed');

	const shape = assertThrows(
		() => loadConfig({ TTK_ADMIN_USER: JSON.stringify({ username: 'root', salt: 'zz', hash: 'secret-hash' }) }),
		ConfigError,
	);
	assertStringIncludes(shape.message, 'TTK_ADMIN_USER');
	assertStringIncludes(shape.message, 'not a valid admin user record');
	assert(!shape.message.includes('secret-hash'));

	const scope = assertThrows(
		() => loadConfig({ TTK_ADMIN_USER: JSON.stringify({ ...JSON.parse(valid), scopes: ['root-everything'] }) }),
		ConfigError,
	);
	assertStringIncludes(scope.message, 'scopes');

	// An empty value is "not set", as for every other variable.
	assertEquals(loadConfig({ TTK_ADMIN_USER: '  ' }).adminUser, null);
});

Deno.test('config: TTK_ADMIN_USER and TTK_ADMIN_USER_FILE together are refused (C6)', async () => {
	const valid = await record();
	const both = assertThrows(
		() =>
			loadConfig(
				{ TTK_ADMIN_USER: valid, TTK_ADMIN_USER_FILE: '/run/secrets/admin' },
				{ secrets: { TTK_ADMIN_USER: valid } },
			),
		ConfigError,
	);
	assertStringIncludes(both.message, 'set either TTK_ADMIN_USER or TTK_ADMIN_USER_FILE, not both');

	// The file form alone is validated under its own name.
	const file = assertThrows(
		() => loadConfig({ TTK_ADMIN_USER_FILE: '/run/secrets/admin' }, { secrets: { TTK_ADMIN_USER: '[]' } }),
		ConfigError,
	);
	assertStringIncludes(file.message, 'TTK_ADMIN_USER_FILE:');
});

Deno.test('secrets: the implicit admin-record file is optional when absent and fatal when invalid (C6)', async () => {
	const valid = await record();
	// Absent: no seed, no error.
	const absent = await resolveSecrets({ env: {}, readFile: disk({}) });
	assertEquals(absent.TTK_ADMIN_USER, undefined);
	assertEquals(loadConfig({}, { secrets: absent }).adminUser, null);

	// Present and valid: it seeds, as before.
	const present = await resolveSecrets({ env: {}, readFile: disk({ [DEFAULT_ADMIN_USER_FILE]: `${valid}\n` }) });
	assertEquals(loadConfig({}, { secrets: present }).adminUser?.username, 'root');

	// Present and invalid: a ConfigError naming the default path.
	const broken = await resolveSecrets({ env: {}, readFile: disk({ [DEFAULT_ADMIN_USER_FILE]: '{"username":' }) });
	const error = assertThrows(() => loadConfig({}, { secrets: broken }), ConfigError);
	assertStringIncludes(error.message, `TTK_ADMIN_USER_FILE (default ${DEFAULT_ADMIN_USER_FILE})`);

	// Present but unreadable, or not normalisable: refused, never swallowed.
	await assertRejects(
		() => resolveSecrets({ env: {}, readFile: () => Promise.reject(new Deno.errors.PermissionDenied('denied')) }),
		SecretError,
		DEFAULT_ADMIN_USER_FILE,
	);
	await assertRejects(
		() => resolveSecrets({ env: {}, readFile: disk({ [DEFAULT_ADMIN_USER_FILE]: '' }) }),
		SecretError,
		'empty',
	);
	// Out of this runtime's read grant is the grant's decision, not the operator's: treated as absent.
	const ungranted = await resolveSecrets({
		env: {},
		readFile: () => Promise.reject(new Deno.errors.NotCapable('not granted')),
	});
	assertEquals(ungranted.TTK_ADMIN_USER, undefined);

	// An operator who set the record inline never has the implicit file read at all.
	let read = false;
	const inline = await resolveSecrets({
		env: { TTK_ADMIN_USER: valid },
		readFile: () => {
			read = true;
			return Promise.resolve('{"username":');
		},
	});
	assertEquals(read, false);
	assertEquals(loadConfig({ TTK_ADMIN_USER: valid }, { secrets: inline }).adminUser?.username, 'root');
});

Deno.test('config: the bind policy counts user accounts as credentials (C9)', async () => {
	const dir = join('tests/.scratch', `bind-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const publicBind = { TTK_HOST: '0.0.0.0', TTK_PUBLIC_URL: 'http://192.168.1.10:8787' };
	const warnings: string[] = [];
	const warn = (message: string) => void warnings.push(message);
	try {
		// Nothing: refused, and the message names the account form as a way out.
		const refused = assertThrows(() => checkBindPolicy(loadConfig(publicBind), warn), ConfigError);
		assertStringIncludes(refused.message, 'TTK_ADMIN_USER');

		// The seed record alone is a credential.
		checkBindPolicy(loadConfig({ ...publicBind, TTK_ADMIN_USER: await record() }), warn);

		// So is a non-empty, readable users.json in the data directory.
		const { record: stored } = await generateAdminUser('root', 'correct horse battery');
		const at = new Date().toISOString();
		await Deno.writeTextFile(
			join(dir, 'users.json'),
			JSON.stringify({ version: 2, users: [{ ...stored, created_at: at, updated_at: at }] }),
		);
		checkBindPolicy(loadConfig({ ...publicBind, TTK_DATA_DIR: dir }), warn);

		// An empty store or an unreadable one signs nobody in, so it counts as nothing.
		await Deno.writeTextFile(join(dir, 'users.json'), JSON.stringify({ version: 2, users: [] }));
		assertThrows(() => checkBindPolicy(loadConfig({ ...publicBind, TTK_DATA_DIR: dir }), warn), ConfigError);
		await Deno.writeTextFile(join(dir, 'users.json'), '{ not json');
		assertThrows(() => checkBindPolicy(loadConfig({ ...publicBind, TTK_DATA_DIR: dir }), warn), ConfigError);
		assertEquals(warnings, [], 'a credentialed public bind with a public name is silent');

		// On loopback, an account means the anonymous development mode is not in force, so it is not announced.
		checkBindPolicy(loadConfig({ TTK_ADMIN_USER: await record() }), warn);
		assert(!warnings.some((message) => message.includes('loopback development mode')));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
