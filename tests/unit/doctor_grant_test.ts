/**
 * `doctor --grant <user> --scopes <list>` (G15, D-098, AC21): the offline repair for a store in which no enabled
 * account holds `admin` — the CLI round trip over `<data dir>/users.json`, upgrade included. The function under it
 * (and its cluster-KV form) is tested beside the store in `packages/gateway/src/account_migration_test.ts`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { main } from '../../packages/cli/mod.ts';
import { generateAdminUser, UserStore } from '@tykotech/gateway';

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

Deno.test('doctor --grant: rewrites one account in users.json, upgrading the store, and the gateway reads it back', async () => {
	const dir = join('tests/.scratch', `grant-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	try {
		const at = '2026-09-01T00:00:00.000Z';
		const { record: root } = await generateAdminUser('root', 'correct horse battery', ['view:watch']);
		const { record: alice } = await generateAdminUser('alice', 'correct horse battery', ['view:watch']);
		const { scopes: _dropped, ...legacy } = (await generateAdminUser('legacy', 'correct horse battery')).record;
		await Deno.writeTextFile(
			join(dir, 'users.json'),
			JSON.stringify({
				version: 1,
				users: [root, alice, legacy].map((user) => ({ ...user, created_at: at, updated_at: at })),
			}),
		);

		const granted = await run(['doctor', '--grant', 'alice', '--scopes', 'mcp:invoke, admin', '--data-dir', dir]);
		assertEquals(granted.code, 0, granted.err);
		assertStringIncludes(granted.out, 'granted alice: mcp:invoke, admin');
		assertStringIncludes(granted.out, 'upgraded 1 other account(s) to explicit scopes');

		const store = new UserStore({ dataDir: dir, seed: null });
		assertEquals([...store.scopesOf('alice')!], ['mcp:invoke', 'admin']);
		assert(store.scopesOf('legacy')!.has('admin'), 'the scope-less account kept its legacy grant');
		assertEquals([...store.scopesOf('root')!], ['view:watch'], 'nobody else changed');
		assertEquals(store.adminWarning(), null);

		// Refusals exit 1 with the reason and change nothing.
		const before = await Deno.readTextFile(join(dir, 'users.json'));
		const noScopes = await run(['doctor', '--grant', 'alice', '--data-dir', dir]);
		assertEquals(noScopes.code, 1);
		assertStringIncludes(noScopes.err, '--scopes');
		const unknown = await run(['doctor', '--grant', 'alice', '--scopes', 'admin,root', '--data-dir', dir]);
		assertEquals(unknown.code, 1);
		assertStringIncludes(unknown.err, 'unknown scopes: root');
		const ghost = await run(['doctor', '--grant', 'ghost', '--scopes', 'admin', '--data-dir', dir]);
		assertEquals(ghost.code, 1);
		assertStringIncludes(ghost.err, 'refused: no user "ghost"');
		assertEquals(await Deno.readTextFile(join(dir, 'users.json')), before, 'no refusal wrote anything');

		// Removing an admin is allowed while another enabled admin remains; removing the last one is not.
		const narrowed = await run(['doctor', '--grant', 'alice', '--scopes', 'mcp:invoke', '--data-dir', dir]);
		assertEquals(narrowed.code, 0, narrowed.err);
		const lastAdmin = await run(['doctor', '--grant', 'legacy', '--scopes', 'mcp:invoke', '--data-dir', dir]);
		assertEquals(lastAdmin.code, 1);
		assertStringIncludes(lastAdmin.err, 'admin scope');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
