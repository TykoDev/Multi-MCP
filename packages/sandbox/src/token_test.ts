/**
 * The grant the service gives up after reading its token. `readServiceToken` and the real revocations run in the
 * Linux tier (`tests/sandbox/runner_test.ts`) in a process with exactly the image's grants: revoking a path here would
 * revoke this test process's own `.` grant.
 */
import { assertEquals, assertRejects } from '@std/assert';
import { releaseTokenGrant, SECRET_TOKEN_FILE, type TokenPermissions } from './token.ts';

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

Deno.test('token: the secret location read grant is given up; the kept folders stay', async () => {
	const granted = new Set([`read:${SECRET_TOKEN_FILE}`, 'read:/work', 'write:/work', 'write:/tmp/ttk-sandbox']);
	const { permissions, revoked } = fakePermissions(granted);
	await releaseTokenGrant(undefined, permissions);
	assertEquals(revoked, [`read:${SECRET_TOKEN_FILE}`]);
	assertEquals([...granted].sort(), ['read:/work', 'write:/tmp/ttk-sandbox', 'write:/work']);
});

Deno.test('token: a grant that survives its revocation refuses the start', async () => {
	const sticky = fakePermissions(new Set(['read:/s/token']), new Set(['read:/s/token']));
	await assertRejects(() => releaseTokenGrant('/s/token', sticky.permissions), Error, '/s/token still has read access');
});
