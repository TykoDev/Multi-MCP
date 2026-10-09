/**
 * D-151: the token the sandbox service creates for itself under `docker-compose.yml`, and the grants it gives up
 * after reading it. `readServiceToken` and the real revocations run in the Linux tier (`tests/sandbox/runner_test.ts`)
 * in a process with exactly the image's grants: revoking a path here would revoke this test process's own `.` grant.
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from '@std/assert';
import {
	GENERATED_TOKEN_DIR,
	GENERATED_TOKEN_FILE,
	generateServiceToken,
	provisionServiceToken,
	releaseTokenGrants,
	SECRET_TOKEN_FILE,
	type TokenPermissions,
} from './token.ts';

/** The rule `readServiceToken` holds every token to: at least 32 characters and no whitespace. */
const ACCEPTED = /^\S{32,}$/;

async function scratch(): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	return await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-token-' });
}

Deno.test('D-151 token: the shipped locations are the volume folder, its one file, and the compose secret', () => {
	assertEquals(GENERATED_TOKEN_DIR, '/run/ttk-sandbox-token');
	assertEquals(GENERATED_TOKEN_FILE, '/run/ttk-sandbox-token/token');
	assertEquals(SECRET_TOKEN_FILE, '/run/secrets/ttk_sandbox_token');
});

Deno.test('D-151 token: a generated token is 256 random bits in hex, which the service and gateway both accept', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 16; i++) {
		const token = generateServiceToken();
		assertMatch(token, /^[0-9a-f]{64}$/);
		assertMatch(token, ACCEPTED);
		seen.add(token);
	}
	assertEquals(seen.size, 16, 'no two tokens alike');
});

Deno.test('D-151 token: created once, whole and owner-read-only; a later start leaves it exactly as it is', async () => {
	const dir = await scratch();
	try {
		const path = `${dir}/token`;
		assertEquals(await provisionServiceToken(path), true, 'the first start creates it');
		const first = await Deno.readTextFile(path);
		// One trailing newline: the gateway's reader strips exactly one, the service trims; neither sees whitespace.
		assertMatch(first, /^[0-9a-f]{64}\n$/);
		if (Deno.build.os !== 'windows') assertEquals((await Deno.lstat(path)).mode! & 0o777, 0o400);
		const left = [];
		for await (const entry of Deno.readDir(dir)) left.push(entry.name);
		assertEquals(left, ['token'], 'nothing but the token is left in the folder');
		assertEquals(await provisionServiceToken(path), false, 'a later start creates nothing');
		assertEquals(await Deno.readTextFile(path), first, 'and never replaces the token the gateway holds');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-151 token: what a crash left at the temporary name is discarded, and the token is whole', async () => {
	const dir = await scratch();
	try {
		const path = `${dir}/token`;
		await Deno.writeTextFile(`${path}.tmp`, 'trunc');
		assertEquals(await provisionServiceToken(path), true);
		assertMatch(await Deno.readTextFile(path), /^[0-9a-f]{64}\n$/);
		await assertRejects(() => Deno.lstat(`${path}.tmp`), Deno.errors.NotFound);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-151 token: a file already at the path is never replaced, even one that is not a token', async () => {
	const dir = await scratch();
	try {
		const path = `${dir}/token`;
		// readServiceToken refuses this at start-up, loudly; overwriting it would hide the operator's mistake.
		await Deno.writeTextFile(path, 'short\n');
		assertEquals(await provisionServiceToken(path), false);
		assertEquals(await Deno.readTextFile(path), 'short\n');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-151 token: a missing volume folder is a failed start, not a folder made somewhere else', async () => {
	const dir = await scratch();
	try {
		await assertRejects(() => provisionServiceToken(`${dir}/absent/token`), Deno.errors.NotFound);
		await assertRejects(() => Deno.lstat(`${dir}/absent`), Deno.errors.NotFound);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

/** A permissions API that records what is revoked and answers from a set of granted `name:path` entries. */
function fakePermissions(granted: Set<string>, sticky: ReadonlySet<string> = new Set()) {
	const revoked: string[] = [];
	const key = (descriptor: Deno.PermissionDescriptor): string =>
		`${descriptor.name}:${(descriptor as { path?: string }).path ?? ''}`;
	const status = (state: Deno.PermissionState) => ({ state }) as Deno.PermissionStatus;
	const permissions: TokenPermissions = {
		query: (descriptor) => Promise.resolve(status(granted.has(key(descriptor)) ? 'granted' : 'prompt')),
		revoke: (descriptor) => {
			revoked.push(key(descriptor));
			if (!sticky.has(key(descriptor))) granted.delete(key(descriptor));
			return Promise.resolve(status(granted.has(key(descriptor)) ? 'granted' : 'prompt'));
		},
	};
	return { permissions, revoked };
}

Deno.test('D-151 token: both token locations and the volume write grant are given up; the kept folders stay', async () => {
	const granted = new Set([
		`read:${SECRET_TOKEN_FILE}`,
		`read:${GENERATED_TOKEN_DIR}`,
		`write:${GENERATED_TOKEN_DIR}`,
		'read:/work',
		'write:/work',
		'write:/tmp/ttk-sandbox',
	]);
	const { permissions, revoked } = fakePermissions(granted);
	await releaseTokenGrants(['/work', '/tmp/ttk-sandbox'], undefined, permissions);
	assertEquals(revoked, [`read:${SECRET_TOKEN_FILE}`, `read:${GENERATED_TOKEN_DIR}`, `write:${GENERATED_TOKEN_DIR}`]);
	assertEquals([...granted].sort(), ['read:/work', 'write:/tmp/ttk-sandbox', 'write:/work']);
});

Deno.test('D-151 token: a grant that survives its revocation, or costs a kept folder, refuses the start', async () => {
	const locations = { secretFile: '/s/token', generatedDir: '/g' };
	const sticky = fakePermissions(new Set(['write:/g', 'write:/work']), new Set(['write:/g']));
	await assertRejects(
		() => releaseTokenGrants(['/work'], locations, sticky.permissions),
		Error,
		'/g still has write access',
	);
	// The folder the service writes its work to was granted only through the token folder's grant: refused.
	const nested = fakePermissions(new Set(['write:/g']));
	await assertRejects(
		() => releaseTokenGrants(['/work'], locations, nested.permissions),
		Error,
		'Grant write access to the sandbox token folder on its own, outside /work',
	);
	assertNotEquals(nested.revoked.length, 0, 'the grants were given up before the check');
	assert(nested.revoked.includes('write:/g'));
});
