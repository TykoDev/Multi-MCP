/**
 * D-084 (G): accounts and sign-ins shared through the cluster KV. Two "nodes" are two store pairs on two separate
 * KV handles over one file, which is how separate processes see a shared local KV (a watch does not cross handles,
 * so the replicas' poll is what carries the change).
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { generateAdminUser } from './admin_auth.ts';
import { VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { LoginStore } from './logins.ts';
import { UserStore, UserStoreError } from './users.ts';

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

Deno.test({
	name: 'cluster stores: a sign-in made on node A resolves on node B; account changes reach both (D-084)',
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const dir = join('tests/.scratch', `cluster-${crypto.randomUUID().slice(0, 8)}`);
		await Deno.mkdir(dir, { recursive: true });
		const file = join(dir, 'cluster.kv');
		const { record, password } = await generateAdminUser('root');
		const config = loadConfig({ TTK_ADMIN_USER: JSON.stringify(record) });
		const kvA = await Deno.openKv(file);
		const kvB = await Deno.openKv(file);
		// Node A starts first with the seed and carries it in; node B starts with nothing of its own.
		const usersA = new UserStore({ dataDir: join(dir, 'a'), seed: record });
		const loginsA = new LoginStore({ dataDir: join(dir, 'a') });
		const usersB = new UserStore({ dataDir: join(dir, 'b'), seed: null });
		const loginsB = new LoginStore({ dataDir: join(dir, 'b') });
		try {
			await usersA.attachCluster(kvA, { pollMs: 50 });
			await loginsA.attachCluster(kvA, { pollMs: 50 });
			await usersB.attachCluster(kvB, { pollMs: 50 });
			await loginsB.attachCluster(kvB, { pollMs: 50 });
			assertEquals(usersB.list().map((user) => user.username), ['root'], 'B adopted the accounts A carried in');
			assertEquals(usersB.status, 'cluster');

			const nodeA = new VerifierChain({ config, allowAnonymous: false, users: usersA, logins: loginsA });
			const nodeB = new VerifierChain({ config, allowAnonymous: false, users: usersB, logins: loginsB });
			const admin = await nodeA.verifyAdmin('root', password);
			assert(admin);
			const { token } = await nodeA.mintSession(admin);
			// Immediately, before any poll: B reads the sign-in through from the KV.
			assertEquals((await nodeB.resolve(token))?.id, 'admin:root');

			// An account made on B can sign in on A once A's replica has moved.
			await usersB.create({ username: 'ops', password: 'correct horse', scopes: ['mcp:invoke'] });
			await until(() => usersA.get('ops') !== null, 'A seeing the new account');
			assert(await usersA.verify('ops', 'correct horse'));

			// Disabling root on A ends root's sign-in on B as well (B re-derives from the shared account).
			await usersA.create({ username: 'second', password: 'correct horse', scopes: ['admin'] });
			await usersA.update('root', { disabled: true });
			await until(() => usersB.get('root')?.disabled === true, 'B seeing root disabled');
			assertEquals(await nodeB.resolve(token), null);

			// Closing a sign-in on one node closes it on the other.
			const ops = await nodeB.verifyAdmin('ops', 'correct horse');
			assert(ops);
			const opsSession = await nodeB.mintSession(ops);
			assert(await nodeA.resolve(opsSession.token));
			await nodeA.closeSession(opsSession.token);
			await loginsA.flush();
			await until(() => loginsB.countFor('user:ops') === 0, 'B seeing the close');
			assertEquals(await nodeB.resolve(opsSession.token), null);

			// Concurrent changes from both nodes both land: the loser retries against fresh state.
			await Promise.all([
				usersA.create({ username: 'from-a', password: 'correct horse' }),
				usersB.create({ username: 'from-b', password: 'correct horse' }),
			]);
			await until(() => usersA.get('from-b') !== null && usersB.get('from-a') !== null, 'both creations');
			// And a rule is judged against the cluster's state, not a stale replica.
			await assertRejects(() => usersB.create({ username: 'from-a', password: 'correct horse' }), UserStoreError);
		} finally {
			for (const store of [usersA, usersB, loginsA, loginsB]) store.detachCluster();
			kvA.close();
			kvB.close();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		}
	},
});
