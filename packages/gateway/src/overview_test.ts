/**
 * D-155: `GET /api/v1/overview` — each section only for the scope that already reads it (omitted, never zero),
 * owner-scoped stores the caller's own unless the listing it mirrors widens for `admin`, counts and byte totals only
 * (no name, no content), and bounded walks cached across callers.
 */
import { assert, assertEquals, assertFalse } from '@std/assert';
import { join } from '@std/path';
import { LibraryStore, type SessionAccess, SessionRegistry, type SessionSummary } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { generateApiKey, type Principal, VerifierChain } from './auth.ts';
import { loadConfig, type Scope } from './config.ts';
import { createLogger } from './logger.ts';
import { createOverview, measureTree, OVERVIEW_CACHE_MS, type OverviewSources, taskStateKey } from './overview.ts';

const ORIGIN = 'http://127.0.0.1:8787';

async function scratch(name: string): Promise<string> {
	const dir = join('tests/.scratch', `${name}-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	return dir;
}

function principal(id: string, scopes: Scope[]): Principal {
	return { kind: 'api-key', id, scopes: new Set(scopes) };
}

function summary(id: string, tabs: number, viewers: number, held: boolean): SessionSummary {
	return {
		session_id: id,
		created_at: '2026-10-07T00:00:00.000Z',
		last_used_at: '2026-10-07T00:00:00.000Z',
		tab_count: tabs,
		viewer_count: viewers,
		human_has_control: held,
	};
}

Deno.test('D-155: measureTree counts files, folders and bytes, and stops at its cap as a floor', async () => {
	const dir = await scratch('overview-walk');
	try {
		await Deno.mkdir(join(dir, 'a/b'), { recursive: true });
		await Deno.writeTextFile(join(dir, 'one.txt'), 'abc');
		await Deno.writeTextFile(join(dir, 'a/two.txt'), 'hello');
		await Deno.writeTextFile(join(dir, 'a/b/three.txt'), '1234567');
		assertEquals(await measureTree(dir, 1_000), { files: 3, directories: 2, bytes: 15, truncated: false });
		const capped = await measureTree(dir, 2);
		assert(capped.truncated, 'past the cap the walk says its numbers are floors');
		assert(capped.files + capped.directories <= 2);
		assertEquals(await measureTree(join(dir, 'missing'), 10), { files: 0, directories: 0, bytes: 0, truncated: false });
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test({
	name: 'D-155: measureTree neither follows nor counts a symbolic link',
	// `Deno.symlink` needs the unscoped read and write grants, which the unit tier does not hold.
	ignore: Deno.permissions.querySync({ name: 'write' }).state !== 'granted',
	fn: async () => {
		const dir = await scratch('overview-link');
		const outside = await scratch('overview-outside');
		try {
			await Deno.writeTextFile(join(outside, 'big.bin'), 'x'.repeat(4096));
			await Deno.writeTextFile(join(dir, 'own.txt'), 'ab');
			await Deno.symlink(await Deno.realPath(outside), join(dir, 'link'));
			assertEquals(await measureTree(dir, 100), { files: 1, directories: 0, bytes: 2, truncated: false });
		} finally {
			await Deno.remove(dir, { recursive: true });
			await Deno.remove(outside, { recursive: true });
		}
	},
});

Deno.test('D-155: task states lose the protocol prefix', () => {
	assertEquals(taskStateKey('TASK_STATE_INPUT_REQUIRED'), 'input_required');
	assertEquals(taskStateKey('TASK_STATE_COMPLETED'), 'completed');
});

/** Fake stores with two owners, alice and bob; `admin` reaches both where the real listing lets it. */
function fakeSources(dataDir: string | null, calls: string[] = []): OverviewSources {
	const sessions: Record<string, SessionSummary[]> = {
		'api-key:alice': [summary('a1', 2, 1, false), summary('a2', 1, 0, true)],
		'api-key:bob': [summary('b1', 3, 0, false)],
	};
	return {
		registry: {
			ownership: 'owner',
			listFor: (access?: SessionAccess) =>
				access?.admin === true ? Object.values(sessions).flat() : sessions[access?.owner ?? ''] ?? [],
		},
		dataDir,
		recorder: null,
		sandbox: {
			call: (owner) => {
				calls.push(owner);
				return Promise.resolve({ workspaces: owner === 'api-key:alice' ? [{}, {}] : [] });
			},
		},
		sandboxUp: () => true,
		tasks: {
			list: (owner) =>
				owner === 'api-key:alice'
					? [
						{ status: { state: 'TASK_STATE_COMPLETED' } },
						{ status: { state: 'TASK_STATE_COMPLETED' } },
						{ status: { state: 'TASK_STATE_WORKING' } },
						{ status: { state: 'TASK_STATE_FAILED' } },
					]
					: [],
		},
		surfaces: { list: (owner) => ({ surfaces: owner === 'api-key:alice' ? [{}] : [] }) },
		providers: () => ({ providers: [{ reachable: true }, { reachable: false }] }),
		memory: {
			collections: (owner) => owner === 'api-key:alice' ? [{ items: 4 }, { items: 6 }] : [],
			summary: () => [{ collections: 2, items: 10 }, { collections: 1, items: 5 }],
		},
	};
}

Deno.test('D-155: every section is gated by the scope that reads it, and omitted without it', async () => {
	const overview = createOverview(fakeSources(null));
	const none = await overview(principal('alice', []));
	assertEquals(Object.keys(none), ['generated_at'], 'no scope, no section — not a section of zeros');

	const browser = await overview(principal('alice', ['mcp:invoke']));
	assertEquals(browser.sessions, { scope: 'own', count: 2, tabs: 3, viewers: 1, in_use: 1 });
	assertEquals(browser.tasks, undefined);
	assertEquals(browser.memory, undefined);
	assertEquals(browser.profiles, undefined, 'no data directory: no profiles to count');

	const agent = await overview(principal('alice', ['agent:invoke']));
	assertEquals(agent.sessions, undefined);
	assertEquals(agent.tasks, {
		scope: 'own',
		count: 4,
		active: 1,
		by_state: { completed: 2, working: 1, failed: 1 },
	});
	assertEquals(agent.surfaces, { scope: 'own', count: 1 });
	assertEquals(agent.providers, { count: 2, reachable: 1 });
	assertEquals(agent.workspaces, undefined);

	const coder = await overview(principal('alice', ['sandbox:execute']));
	assertEquals(coder.workspaces, { scope: 'own', count: 2 });

	const reader = await overview(principal('alice', ['files:read']));
	assertEquals(reader.memory, { scope: 'own', collections: 2, items: 10 });
	assertEquals(reader.disk, undefined);
});

Deno.test('D-155: owner-scoped sections are the caller own; admin widens exactly where the listing does', async () => {
	const calls: string[] = [];
	const overview = createOverview(fakeSources(null, calls));
	const bob = await overview(principal('bob', ['mcp:invoke', 'agent:invoke', 'files:read', 'sandbox:execute']));
	assertEquals(bob.sessions?.count, 1);
	assertEquals(bob.tasks?.count, 0);
	assertEquals(bob.surfaces?.count, 0);
	assertEquals(bob.memory, { scope: 'own', collections: 0, items: 0 });
	assertEquals(bob.workspaces?.count, 0);
	assertEquals(calls, ['api-key:bob'], 'the sandbox is asked for the caller, never for everyone');

	const admin = await overview(principal('root', ['mcp:invoke', 'agent:invoke', 'files:read', 'admin']));
	assertEquals(admin.sessions, { scope: 'all', count: 3, tabs: 6, viewers: 1, in_use: 1 });
	assertEquals(admin.memory, { scope: 'all', collections: 3, items: 15 }, 'the totals /system/memory gives an admin');
	assertEquals(admin.tasks?.scope, 'own', 'no task route widens for admin, so neither does this');
	assertEquals(admin.tasks?.count, 0);
	// Admin without agent:invoke still sees the provider counts (the admin providers route shows the whole list).
	const plainAdmin = await overview(principal('root', ['admin']));
	assertEquals(plainAdmin.providers, { count: 2, reachable: 1 });
	assertEquals(plainAdmin.tasks, undefined);
});

Deno.test('D-155: a sandbox that is down or fails reads as unknown, not as zero', async () => {
	const down = createOverview({ ...fakeSources(null), sandboxUp: () => false });
	assertEquals((await down(principal('alice', ['sandbox:execute']))).workspaces, { scope: 'own', count: null });
	const failing = createOverview({
		...fakeSources(null),
		sandbox: { call: () => Promise.reject(new Error('unavailable')) },
	});
	assertEquals((await failing(principal('alice', ['sandbox:execute']))).workspaces, { scope: 'own', count: null });
});

Deno.test('D-155: profiles, storage states, recordings and the data directory are counted on disk, cached', async () => {
	const dir = await scratch('overview-disk');
	try {
		await Deno.mkdir(join(dir, 'profiles/work/Default'), { recursive: true });
		await Deno.writeTextFile(join(dir, 'profiles/work/Default/Cookies'), 'c'.repeat(100));
		await Deno.mkdir(join(dir, 'storage'), { recursive: true });
		await Deno.writeTextFile(join(dir, 'storage/login.json'), '{"cookies":[]}');
		await Deno.writeTextFile(join(dir, 'storage/stray.txt'), 'not a state');
		await Deno.mkdir(join(dir, 'recordings'), { recursive: true });
		await Deno.writeTextFile(join(dir, 'recordings/mine.webm'), 'v'.repeat(50));
		await Deno.writeTextFile(join(dir, 'recordings/theirs.webm'), 'v'.repeat(70));
		let clock = 1_000_000;
		const overview = createOverview({
			...fakeSources(dir),
			recorder: { dir: join(dir, 'recordings'), mayRead: (name, access) => access.admin || name === 'mine' },
			now: () => clock,
		});
		const alice = await overview(principal('alice', ['mcp:invoke', 'view:watch']));
		assertEquals(alice.profiles, { count: 1, bytes: 100, truncated: false });
		assertEquals(alice.storage_states, { count: 1, bytes: 14 });
		assertEquals(alice.recordings, { scope: 'own', count: 1, bytes: 50 }, 'only what the recording route serves');
		assertEquals(alice.disk, undefined);
		const admin = await overview(principal('root', ['admin', 'view:watch']));
		assertEquals(admin.recordings, { scope: 'all', count: 2, bytes: 120 });
		const total = admin.disk!.bytes;
		assertEquals(total, 100 + 14 + 11 + 50 + 70);

		// Within the cache window a new file is not seen; after it, it is.
		await Deno.writeTextFile(join(dir, 'storage/second.json'), '{}');
		assertEquals((await overview(principal('alice', ['mcp:invoke']))).storage_states?.count, 1);
		clock += OVERVIEW_CACHE_MS;
		assertEquals((await overview(principal('alice', ['mcp:invoke']))).storage_states?.count, 2);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('D-155: GET /api/v1/overview — authenticated, scope-shaped, counts only, never a name or a byte of content', async () => {
	const dir = await scratch('overview-route');
	const plain = await generateApiKey('plain', ['mcp:invoke']);
	const reader = await generateApiKey('reader', ['mcp:invoke', 'files:read']);
	const admin = await generateApiKey('root', ['mcp:invoke', 'files:read', 'agent:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([plain.record, reader.record, admin.record]),
		TTK_DATA_DIR: dir,
	});
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	await library.writeBytes('reports/quarterly-secret-plan.txt', new TextEncoder().encode('TOPSECRET-CONTENT'));
	await library.putPrompt('confidential-prompt', { template: 'hello {{name}}', arguments: [{ name: 'name' }] });
	await library.refresh();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry,
		version: 'overview-test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
		library,
	});
	const get = (key: string | null) =>
		gateway.app.request(`${ORIGIN}/api/v1/overview`, {
			headers: { host: '127.0.0.1:8787', ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
		});
	try {
		const anonymous = await get(null);
		assertEquals(anonymous.status, 401);
		await anonymous.body?.cancel();

		const plainBody = await (await get(plain.key)).json();
		assertEquals(plainBody.sessions, { scope: 'all', count: 0, tabs: 0, viewers: 0, in_use: 0 });
		assertEquals(plainBody.files, undefined, 'mcp:invoke alone does not read the share');
		assertEquals(plainBody.skills, undefined);
		assertEquals(plainBody.disk, undefined);

		const response = await get(reader.key);
		assertEquals(response.status, 200);
		assertEquals(response.headers.get('cache-control'), 'no-store');
		const text = await response.text();
		const body = JSON.parse(text);
		assertEquals(body.files, { count: 1, folders: 1, bytes: 17, truncated: false });
		assertEquals(body.prompts, { count: 1 });
		assertEquals(body.skills, { count: 0 });
		for (const leak of ['quarterly-secret-plan', 'TOPSECRET', 'confidential-prompt', 'reports', dir]) {
			assertFalse(text.includes(leak), `the overview carries no name, path or content (${leak})`);
		}

		const adminBody = await (await get(admin.key)).json();
		assertEquals(Object.keys(adminBody), [
			'generated_at',
			'sessions',
			'profiles',
			'storage_states',
			'files',
			'skills',
			'prompts',
			'tasks',
			'surfaces',
			'providers',
			'disk',
		], 'a fixed key order, whichever walk finished first');
		assertEquals(adminBody.providers, { count: 0, reachable: 0 });
		assertEquals(adminBody.tasks, { scope: 'own', count: 0, active: 0, by_state: {} });
		assertEquals(adminBody.surfaces, { scope: 'own', count: 0 });
		assert(typeof adminBody.disk?.bytes === 'number' && adminBody.disk.bytes >= 17, 'the data directory is measured');
		assertEquals(adminBody.disk.truncated, false);
	} finally {
		await gateway.close();
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});
