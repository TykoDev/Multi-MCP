/** The scope partition, and the deny paths that make it real. */
import { assert, assertEquals } from '@std/assert';
import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { dispatchToolCall } from './dispatch.ts';
import { type McpDeps, registerCatalog } from './server.ts';
import {
	ADMIN_SCOPES,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	type Scope,
	SCOPE_GRANTS,
	SCOPELESS_ACCOUNT_SCOPES,
	SCOPES,
	unknownScopes,
} from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { CATALOG } from './catalog.ts';

const sorted = (names: readonly string[]) => [...names].sort();

Deno.test('scopes: DEFAULT_SCOPES and EXPLICIT_SCOPES partition SCOPES', () => {
	assertEquals(sorted([...DEFAULT_SCOPES, ...EXPLICIT_SCOPES]), sorted(SCOPES));
	assertEquals(DEFAULT_SCOPES.filter((s) => EXPLICIT_SCOPES.includes(s)), []);
	assertEquals(EXPLICIT_SCOPES.filter((s) => DEFAULT_SCOPES.includes(s)), []);
});

Deno.test('scopes: the explicit execution and publication grants are pinned', () => {
	assertEquals(sorted(EXPLICIT_SCOPES), [
		'a2ui:publish',
		'admin',
		'agent:invoke',
		'evaluate',
		'files:write',
		'metrics:read',
		'model:invoke',
		'network:read',
		'sandbox:execute',
		'task',
	]);
	assertEquals(SCOPE_GRANTS['metrics:read'], 'Read server metrics');
	assertEquals(SCOPE_GRANTS['network:read'], 'Read full request URLs and response bodies');
	assert(!DEFAULT_SCOPES.includes('network:read'), '`network:read` must not be in the default grant');
	assertEquals(SCOPES.length, 14);
	assertEquals(SCOPE_GRANTS['model:invoke'], 'Run text tasks on a configured model provider');
	assert(!DEFAULT_SCOPES.includes('model:invoke'), '`model:invoke` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('model:invoke'), '`model:invoke` must be an explicit grant');
});

/** `admin` is not in the default grant: a key record without `scopes` holds none. */
Deno.test('scopes: `admin` must be named to be held; the v1 migration grant is DEFAULT_SCOPES plus admin', () => {
	assert(!DEFAULT_SCOPES.includes('admin'), '`admin` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('admin'), '`admin` must be an explicit grant');
	assertEquals([...SCOPELESS_ACCOUNT_SCOPES], ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'files:read']);
	assertEquals(sorted(ADMIN_SCOPES), sorted([...DEFAULT_SCOPES, 'admin']));
});

/**
 * `task` grants an autonomous loop that acts without a per-action confirmation, so it is an `EXPLICIT_SCOPES` member:
 * nobody holds autonomous browser control unless an operator granted it deliberately.
 */
Deno.test('scopes: `task` must be named to be held', () => {
	assert(!DEFAULT_SCOPES.includes('task'), '`task` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('task' as Scope), '`task` must be an explicit grant');
});

Deno.test('scopes: the vocabulary has exactly one declaration in the tree', async () => {
	const declarations: string[] = [];
	const root = new URL('../../', import.meta.url);
	for await (const entry of walk(root)) {
		if (entry.href.endsWith('_test.ts')) continue;
		const source = await Deno.readTextFile(entry);
		if (/'mcp:invoke'[\s\S]{0,200}?'view:watch'/.test(source)) declarations.push(entry.href.replace(root.href, ''));
	}
	assertEquals(
		declarations,
		['mcp/src/scopes.ts'],
		`the scope list is written out in more than one place: ${declarations.join(', ')}`,
	);
});

Deno.test('scopes: the identifier ALL_SCOPES exists nowhere in the tree', async () => {
	const hits: string[] = [];
	const root = new URL('../../', import.meta.url);
	for await (const entry of walk(root)) {
		if (entry.href.endsWith('scopes_test.ts')) continue;
		if ((await Deno.readTextFile(entry)).includes('ALL_SCOPES')) hits.push(entry.href.replace(root.href, ''));
	}
	assertEquals(hits, [], `ALL_SCOPES survives in ${hits.join(', ')}`);
});

/** Every `.ts` file under the workspace, as a URL the permission check accepts. */
async function* walk(dir: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(dir)) {
		if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
		const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
		if (entry.isDirectory) yield* walk(child);
		else if (entry.name.endsWith('.ts')) yield child;
	}
}

/** Deny path 4 of 4: the CLI key minter. */
Deno.test('scopes: the CLI key minter defaults to DEFAULT_SCOPES, not the vocabulary', async () => {
	const source = await Deno.readTextFile(new URL('../../cli/mod.ts', import.meta.url));
	assert(
		/args\.scopes === undefined\s*\n?\s*\?\s*DEFAULT_SCOPES/.test(source),
		'ttk doctor --new-key must default to DEFAULT_SCOPES',
	);
	assert(source.includes("args.scopes.split(',')"), 'an explicit --scopes list must still be honoured');
});

Deno.test('scopes: unknownScopes names every member that is not in the vocabulary', () => {
	assertEquals(unknownScopes(['mcp:invoke', 'evaluate']), []);
	assertEquals(unknownScopes(['mcp:invoke', 'nonsense', 'admin', 'ttk:admin']), ['nonsense', 'ttk:admin']);
});

// --- deny path 3 of 4: the stdio / no-credential mount ----------------------

Deno.test('scopes: a principal with no credential holds DEFAULT_SCOPES, never an explicit one', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		const admitted = (anonScopes?: readonly Scope[]) =>
			sorted([
				...registerCatalog(
					new McpServer({ name: 't', version: '0' }),
					{ registry, version: '0', ...(anonScopes === undefined ? {} : { anonScopes }) },
					undefined,
				).permitted,
			]);

		const expected = sorted(
			CATALOG
				.filter((tool) => tool.scope === undefined || (DEFAULT_SCOPES as readonly string[]).includes(tool.scope))
				.map((tool) => tool.name),
		);
		assertEquals(admitted(), expected);

		assertEquals(
			admitted([...DEFAULT_SCOPES, 'evaluate']).filter((name) => !expected.includes(name)),
			['browser_evaluate'],
		);
		assert(!expected.includes('browser_evaluate'), 'browser_evaluate must not be reachable on the default grant');

		assertEquals(
			admitted([]),
			sorted(CATALOG.filter((tool) => tool.scope === undefined).map((tool) => tool.name)),
		);
	} finally {
		await registry.shutdown();
	}
});

// --- the tool the partition exists for --------------------------------------

/** The explicit `evaluate` grant, on all four principal paths at once. */
Deno.test('scopes: browser_evaluate is absent on all four principal paths without an explicit grant', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		const permitted = (deps: Partial<McpDeps>, authInfo: AuthInfo | undefined) =>
			registerCatalog(new McpServer({ name: 't', version: '0' }), { registry, version: '0', ...deps }, authInfo)
				.permitted;

		const paths: Array<[string, () => ReadonlySet<string>]> = [
			[
				'a credential naming its scopes',
				() => permitted({}, { clientId: 'k1', scopes: [...DEFAULT_SCOPES] } as unknown as AuthInfo),
			],
			[
				'a credential naming none (the verifier substitutes the defaults)',
				() => permitted({}, { clientId: 'k2', scopes: [...DEFAULT_SCOPES] } as unknown as AuthInfo),
			],
			['the anonymous loopback principal', () => permitted({}, undefined)],
			['the stdio mount', () => permitted({ anonScopes: DEFAULT_SCOPES }, undefined)],
		];
		for (const [name, run] of paths) {
			assert(!run().has('browser_evaluate'), `browser_evaluate is reachable on ${name}`);
		}

		assert(permitted({ anonScopes: [...DEFAULT_SCOPES, 'evaluate'] }, undefined).has('browser_evaluate'));
	} finally {
		await registry.shutdown();
	}
});

Deno.test('scopes: a tools/call for browser_evaluate without the grant answers scope-required, not "not found"', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		const dispatch = registerCatalog(
			new McpServer({ name: 't', version: '0' }),
			{ registry, version: '0' },
			undefined,
		);
		const result = await dispatchToolCall(dispatch, 'browser_evaluate', { expression: '1' });
		assertEquals((result as { isError?: boolean }).isError, true);
		const payload = (result as { structuredContent?: { error?: { code?: string; message?: string } } })
			.structuredContent;
		assertEquals(payload?.error?.code, 'scope-required');
		assert(!(payload?.error?.message ?? '').includes('evaluate scope'));
		const text = ((result.content as Array<{ text?: string }>)[0]?.text) ?? '';
		assertEquals(text.startsWith('Error: scope-required: '), true, text);
	} finally {
		await registry.shutdown();
	}
});

/** The word that must not appear. */
Deno.test('scopes: browser_evaluate never describes itself as sandboxed, isolated or restricted', () => {
	const tool = CATALOG.find((entry) => entry.name === 'browser_evaluate');
	assert(tool !== undefined);
	const prose = `${tool.title} ${tool.description}`.toLowerCase();
	for (const forbidden of ['sandbox', 'sandboxed', 'isolated world', 'safely', 'read-only subset']) {
		assert(!prose.includes(forbidden), `browser_evaluate's description claims "${forbidden}"`);
	}
	assert(prose.includes('main world'));
	assert(prose.includes('ttk_allowed_domains'));
});

// --- every grant site, enumerated from the tree and pinned by name -----------

/** The five sites that can hand a principal a scope, and the rule each obeys. */
Deno.test('scopes: no default-grant site can hand out `task` (all five)', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		assert(!DEFAULT_SCOPES.includes('task'), 'site 1: the verifier fallback');

		const permitted = (anonScopes?: readonly Scope[]) =>
			registerCatalog(
				new McpServer({ name: 't', version: '0' }),
				{ registry, version: '0', ...(anonScopes === undefined ? {} : { anonScopes }) },
				undefined,
			).permitted;
		assert(!permitted().has('browser_run_task'), 'site 2: the anonymous loopback principal');
		assert(!permitted(DEFAULT_SCOPES).has('browser_run_task'), 'site 3: the stdio mount');

		const cli = await Deno.readTextFile(new URL('../../cli/mod.ts', import.meta.url));
		assert(
			/args\.scopes === undefined\s*\??\s*\?\s*DEFAULT_SCOPES/.test(cli),
			'site 4: the CLI key minter must default to DEFAULT_SCOPES, which does not contain task',
		);

		const users = await Deno.readTextFile(new URL('../../gateway/src/users.ts', import.meta.url));
		const auth = await Deno.readTextFile(new URL('../../gateway/src/auth.ts', import.meta.url));
		assert(/user\.scopes \?\? DEFAULT_SCOPES/.test(users), 'site 5: the account store fallback');
		assert(/scopes \?\? \[\.\.\.DEFAULT_SCOPES\]/.test(users), 'site 5: the account creator');
		assert(
			!/scopes \?\? SCOPES/.test(users) && !/scopes \?\? \[\.\.\.SCOPES\]/.test(users),
			'site 5: never the vocabulary',
		);
		assert(!/adminUser\.scopes \?\? SCOPES/.test(auth), 'site 5: never the whole vocabulary');
		const admin = await Deno.readTextFile(new URL('../../gateway/src/admin_auth.ts', import.meta.url));
		assert(/scopes \? \[\.\.\.scopes\] : \[\.\.\.ADMIN_SCOPES\]/.test(admin), 'site 5: the admin record generator');
		assert(
			/generateAdminUser\(adminUsername, args\.password, adminScopes\)/.test(cli) &&
				/named === null \? \[\.\.\.ADMIN_SCOPES\]/.test(cli),
			'site 5: `doctor --new-admin` takes --scopes and defaults to ADMIN_SCOPES',
		);
		assert(!ADMIN_SCOPES.includes('task'), 'site 5: the administrator grant carries no task either');

		assert(permitted([...DEFAULT_SCOPES, 'task']).has('browser_run_task'), 'an explicit grant must admit it');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('scopes: the anonymous and stdio mounts keep no `task` of their own', () => {
	assertEquals(sorted(DEFAULT_SCOPES), ['files:read', 'mcp:invoke', 'view:control', 'view:watch']);
});
