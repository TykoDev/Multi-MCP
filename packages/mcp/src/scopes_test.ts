/**
 * SEC-01: the scope partition, and the deny paths that make it real.
 *
 * Three code paths handed out every declared scope by default — a key record
 * omitting `scopes`, the anonymous loopback principal, and every stdio client —
 * and a fourth *materialised* the whole vocabulary into a printed key record
 * (`packages/cli/mod.ts`). Adding a scope to `SCOPES` therefore granted it
 * retroactively to all four, which is why D-A4 is not implementable by adding a
 * scope and needed the partition below instead.
 */
import { assert, assertEquals } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { dispatchToolCall } from './dispatch.ts';
import { type McpDeps, registerCatalog } from './server.ts';
import {
	ADMIN_SCOPES,
	DEFAULT_SCOPES,
	EXPLICIT_SCOPES,
	LEGACY_DEFAULT_SCOPES,
	type Scope,
	SCOPE_GRANTS,
	SCOPES,
	unknownScopes,
} from './scopes.ts';
import { SessionRegistry } from './registry.ts';
import { CATALOG } from './catalog.ts';

const sorted = (names: readonly string[]) => [...names].sort();

Deno.test('scopes: DEFAULT_SCOPES and EXPLICIT_SCOPES partition SCOPES (I-12)', () => {
	// Union.
	assertEquals(sorted([...DEFAULT_SCOPES, ...EXPLICIT_SCOPES]), sorted(SCOPES));
	// Disjointness, both directions. Union alone passes a scope present in both
	// lists, which would read as explicit and grant as default — precisely the
	// failure this mechanism exists to prevent.
	assertEquals(DEFAULT_SCOPES.filter((s) => EXPLICIT_SCOPES.includes(s)), []);
	assertEquals(EXPLICIT_SCOPES.filter((s) => DEFAULT_SCOPES.includes(s)), []);
});

Deno.test('scopes: the explicit execution and publication grants are pinned (D-064, D-098)', () => {
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
	// C7 / D-098: `metrics:read`, with its grant in the operator's words.
	assertEquals(SCOPE_GRANTS['metrics:read'], 'Read server metrics');
	// S0 (design §2.2): `network:read` — explicit, never a default.
	assertEquals(SCOPE_GRANTS['network:read'], 'Read request URLs, headers and bodies');
	assert(!DEFAULT_SCOPES.includes('network:read'), '`network:read` must not be in the default grant');
	// D-144 (model-providers-ui S0): fourteen scopes, `model:invoke` the newest — explicit, never a default (C10).
	assertEquals(SCOPES.length, 14);
	assertEquals(SCOPE_GRANTS['model:invoke'], 'Run text tasks on a configured model provider');
	assert(!DEFAULT_SCOPES.includes('model:invoke'), '`model:invoke` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('model:invoke'), '`model:invoke` must be an explicit grant');
});

/**
 * C7 / G4 / G15 (D-098): `admin` left the default grant. Breaking for a key record without `scopes`; not for
 * a stored account, which the user store's one-time upgrade gives the old grant (`LEGACY_DEFAULT_SCOPES`) in writing.
 */
Deno.test('scopes: `admin` must be named to be held; the legacy grant is the old default exactly (C7, G15)', () => {
	assert(!DEFAULT_SCOPES.includes('admin'), '`admin` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('admin'), '`admin` must be an explicit grant');
	assertEquals([...LEGACY_DEFAULT_SCOPES], ['mcp:invoke', 'view:watch', 'view:control', 'admin', 'files:read']);
	assertEquals(sorted(ADMIN_SCOPES), sorted([...DEFAULT_SCOPES, 'admin']));
});

/**
 * SEC-01b, closed by the owner decision of 2026-09-10 — and this is where a
 * reader meets it rather than deducing it from `auth.ts`.
 *
 * `task` grants an autonomous loop that acts without a per-action confirmation.
 * Until 0.2.0 every default-grant site handed it out, so D-024's separation
 * described intent rather than behaviour: **nobody ever chose to grant
 * autonomous browser control**. It is now an `EXPLICIT_SCOPES` member. Existing
 * credentials lose it until an operator grants it deliberately, which is the
 * intended effect and is recorded as a breaking change in `CHANGELOG.md` and
 * `SPECS/API-CONTRACT.md` §8.
 *
 * The deferral's three conditions are **retired**, not left standing: the
 * SECURITY-AUTH §3 row no longer says "granted by default", the `DEFAULT_SCOPES`
 * comment records the decision rather than the deferral, and the operator
 * remedy in the documentation is now how to *obtain* `task` rather than how to
 * avoid it.
 */
Deno.test('scopes: `task` must be named to be held — SEC-01b, decided 2026-09-10', () => {
	assert(!DEFAULT_SCOPES.includes('task'), '`task` must not be in the default grant');
	assert(EXPLICIT_SCOPES.includes('task' as Scope), '`task` must be an explicit grant');
});

Deno.test('scopes: the vocabulary has exactly one declaration in the tree', async () => {
	// Detecting drift between three copies is weaker than making a second copy
	// unrepresentable, and this is the check that keeps it that way.
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

Deno.test('scopes: the identifier ALL_SCOPES no longer exists anywhere', async () => {
	// The cheapest control available: a live name meaning "everything" is how
	// the default-grant defect comes back, and with the name gone a stale import
	// fails `deno check` instead of silently granting the whole vocabulary.
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

/**
 * SEC-01, deny path 4 of 4 — the site the plan's slice list did not name.
 *
 * `ttk doctor --new-key <id>` with no `--scopes` *materialises* the granted
 * array into the printed key record, so it does not reach the
 * `matched.scopes ?? DEFAULT_SCOPES` fallback in the verifier at all: a key
 * minted with the whole vocabulary would hold it explicitly, forever.
 *
 * Written when `packages/cli` was outside `deno task test:unit`'s file list
 * (it joined in D-137, review N1); it stays a static check here, and says so.
 */
Deno.test('scopes: the CLI key minter defaults to DEFAULT_SCOPES, not the vocabulary', async () => {
	const source = await Deno.readTextFile(new URL('../../cli/mod.ts', import.meta.url));
	assert(
		/args\.scopes === undefined\s*\n?\s*\?\s*DEFAULT_SCOPES/.test(source),
		'ttk doctor --new-key must default to DEFAULT_SCOPES',
	);
	// And an operator naming a scope explicitly is still accepted: this is the
	// supported way to obtain an EXPLICIT_SCOPES member, so refusing it here
	// would leave the mechanism with no path at all.
	assert(source.includes("args.scopes.split(',')"), 'an explicit --scopes list must still be honoured');
});

/**
 * The rewrite this test exists to stop: pointing the OAuth claim filter at
 * `DEFAULT_SCOPES` would silently strip an explicitly-granted scope from every
 * token an operator deliberately put it in. It fails closed, which is why
 * nothing else would notice — the explicit-grant mechanism simply stops working
 * on that mount, with no error anywhere.
 */
Deno.test('scopes: the OAuth claim filter reads the vocabulary, not the defaults', async () => {
	const source = await Deno.readTextFile(new URL('../../gateway/src/auth.ts', import.meta.url));
	assert(
		source.includes('(SCOPES as readonly string[]).includes(entry)'),
		'the OAuth scope-claim filter must be checked against SCOPES',
	);
	assert(
		!/DEFAULT_SCOPES as readonly string\[\]/.test(source),
		'narrowing the claim filter to DEFAULT_SCOPES disables the explicit-grant mechanism',
	);
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

		// The whole set, not merely the absence of `evaluate`: an absence-only
		// assertion passes an implementation that grants some other wrong superset.
		const expected = sorted(
			CATALOG
				.filter((tool) => tool.scope === undefined || (DEFAULT_SCOPES as readonly string[]).includes(tool.scope))
				.map((tool) => tool.name),
		);
		assertEquals(admitted(), expected);

		// The same set with an explicit grant: the mechanism has to *work*, not only fail closed.
		// B2.7 gave `evaluate` its first and only tool, so the widening is asserted to be **exactly**
		// `browser_evaluate` — the set difference, not merely its presence. An implementation that
		// admitted a second tool on the same grant would pass a presence check and fail this one.
		assertEquals(
			admitted([...DEFAULT_SCOPES, 'evaluate']).filter((name) => !expected.includes(name)),
			['browser_evaluate'],
		);
		assert(!expected.includes('browser_evaluate'), 'browser_evaluate must not be reachable on the default grant');

		// And a deliberately empty grant admits only the unscoped tools.
		assertEquals(
			admitted([]),
			sorted(CATALOG.filter((tool) => tool.scope === undefined).map((tool) => tool.name)),
		);
	} finally {
		await registry.shutdown();
	}
});

// --- B2.7: the tool the partition exists for --------------------------------

/**
 * D-A4's promise, on all four principal paths at once.
 *
 * The four are the shapes `scopesOf` can be handed: a credential naming its scopes, a credential
 * naming none (the verifier substitutes `DEFAULT_SCOPES` before this layer sees it), the anonymous
 * loopback principal, and the stdio mount — the last two reaching `registerCatalog` as
 * `authInfo === undefined` with the mount's `anonScopes`. Absence from `tools/list` is asserted
 * through `permitted`, which is what the registration loop writes and what `tools/list` reads.
 */
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

		// And the grant works, so the assertion above is about the gate rather than about a tool that
		// nothing can reach at all.
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
		// SEC-17: the refusal never names the grant a caller would have to obtain.
		assert(!(payload?.error?.message ?? '').includes('evaluate scope'));
		const text = ((result.content as Array<{ text?: string }>)[0]?.text) ?? '';
		assertEquals(text.startsWith('Error: scope-required: '), true, text);
	} finally {
		await registry.shutdown();
	}
});

/**
 * The word that must not appear.
 *
 * D-A4 chose honesty — "the sandbox is the scope grant, not the expression subset" — and the failure
 * mode is a later editor adding a reassuring adjective to a description a model reads before
 * deciding what to run. A prose rule nobody can check is a rule that lasts one refactor, so it is
 * checked (B2-SR5-4).
 */
Deno.test('scopes: browser_evaluate never describes itself as sandboxed, isolated or restricted', () => {
	const tool = CATALOG.find((entry) => entry.name === 'browser_evaluate');
	assert(tool !== undefined);
	const prose = `${tool.title} ${tool.description}`.toLowerCase();
	for (const forbidden of ['sandbox', 'sandboxed', 'isolated world', 'safely', 'read-only subset']) {
		assert(!prose.includes(forbidden), `browser_evaluate's description claims "${forbidden}"`);
	}
	// And it says the two things that are true, because an absence check alone passes a description
	// that says nothing at all.
	assert(prose.includes('main world'));
	assert(prose.includes('ttk_allowed_domains'));
});

// --- SEC-01b: every grant site, enumerated from the tree and pinned by name ---

/**
 * The six sites that can hand a principal a scope, and the rule each obeys.
 *
 * BF-2's lesson is why this is a list rather than one assertion: `packages/cli`
 * *materialises* the vocabulary into a printed key record and never reaches the
 * verifier's `matched.scopes ?? DEFAULT_SCOPES` fallback, so a fix to the
 * fallback alone sails past it. B2.7's pre-implementation engagement then found
 * a fifth the specification had not named — the OAuth claim path. The agent-expansion review (GW-2) found the
 * sixth: the administrator record, defaulted and materialised to the whole vocabulary. Enumerated here so a
 * seventh added later fails this test instead of inheriting silently.
 */
Deno.test('scopes: no default-grant site can hand out `task` (SEC-01b, all six)', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		// 1. A key record that omits `scopes`. The verifier substitutes
		//    DEFAULT_SCOPES, so the substitution itself is what must not carry it.
		assert(!DEFAULT_SCOPES.includes('task'), 'site 1: the verifier fallback');

		// 2. The anonymous loopback principal, and 3. the stdio mount. Both reach
		//    `registerCatalog` with `authInfo === undefined` and the mount's
		//    `anonScopes`, which defaults to DEFAULT_SCOPES. Asserted through
		//    `permitted`, which is what `tools/list` reads — not through the list.
		const permitted = (anonScopes?: readonly Scope[]) =>
			registerCatalog(
				new McpServer({ name: 't', version: '0' }),
				{ registry, version: '0', ...(anonScopes === undefined ? {} : { anonScopes }) },
				undefined,
			).permitted;
		assert(!permitted().has('browser_run_task'), 'site 2: the anonymous loopback principal');
		assert(!permitted(DEFAULT_SCOPES).has('browser_run_task'), 'site 3: the stdio mount');

		// 4. `ttk doctor --new-key` with no `--scopes`, which materialises the
		//    array into the printed record. Static (written before `packages/cli`
		//    joined the unit tier, D-137 N1), and says so.
		const cli = await Deno.readTextFile(new URL('../../cli/mod.ts', import.meta.url));
		assert(
			/args\.scopes === undefined\s*\??\s*\?\s*DEFAULT_SCOPES/.test(cli),
			'site 4: the CLI key minter must default to DEFAULT_SCOPES, which no longer contains task',
		);

		// 5. The OAuth claim path. It filters a token's claim against SCOPES, not
		//    DEFAULT_SCOPES — which is correct and must stay so: a token that
		//    *names* `task` is an operator's explicit grant, and narrowing the
		//    filter to the defaults would disable the explicit-grant mechanism on
		//    that mount with no error anywhere. What it must never do is add a
		//    scope the token did not claim.
		const auth = await Deno.readTextFile(new URL('../../gateway/src/auth.ts', import.meta.url));
		assert(auth.includes('(SCOPES as readonly string[]).includes(entry)'), 'site 5: the OAuth claim filter');
		assert(!/scopes\.add\('task'\)/.test(auth), 'site 5: no path may add task to a claim that did not name it');

		// 6. The account record (GW-2, D-065, D-074): the user store falls back for a record that omits `scopes`
		//    (on verify, on the public view and on create), and `doctor --new-admin` / `generateAdminUser`
		//    materialise the array into the record they write. All of them must reach for DEFAULT_SCOPES; the
		//    behavioural deny path is in `gateway/src/units_test.ts`.
		const users = await Deno.readTextFile(new URL('../../gateway/src/users.ts', import.meta.url));
		assert(/user\.scopes \?\? DEFAULT_SCOPES/.test(users), 'site 6: the account store fallback');
		assert(/scopes \?\? \[\.\.\.DEFAULT_SCOPES\]/.test(users), 'site 6: the account creator');
		assert(
			!/scopes \?\? SCOPES/.test(users) && !/scopes \?\? \[\.\.\.SCOPES\]/.test(users),
			'site 6: never the vocabulary',
		);
		assert(!/adminUser\.scopes \?\? SCOPES/.test(auth), 'site 6: never the whole vocabulary');
		// C7 / D-098: an administrator record names `admin` — the default grant plus `admin`, never the vocabulary.
		const admin = await Deno.readTextFile(new URL('../../gateway/src/admin_auth.ts', import.meta.url));
		assert(/scopes \? \[\.\.\.scopes\] : \[\.\.\.ADMIN_SCOPES\]/.test(admin), 'site 6: the admin record generator');
		assert(
			/generateAdminUser\(adminUsername, args\.password, adminScopes\)/.test(cli) &&
				/named === null \? \[\.\.\.ADMIN_SCOPES\]/.test(cli),
			'site 6: `doctor --new-admin` takes --scopes and defaults to ADMIN_SCOPES',
		);
		assert(!ADMIN_SCOPES.includes('task'), 'site 6: the administrator grant carries no task either');

		// The grant still *works*, so every assertion above is about the gate
		// rather than about a tool nothing can reach.
		assert(permitted([...DEFAULT_SCOPES, 'task']).has('browser_run_task'), 'an explicit grant must admit it');
	} finally {
		await registry.shutdown();
	}
});

Deno.test('scopes: the anonymous and stdio mounts keep no `task` of their own (SEC-01b)', () => {
	// The decision, stated where it can be checked: the credential-less paths do
	// **not** keep `task`. A principal carrying no credential chose least of all,
	// `evaluate` is already withheld from them for the same reason, and
	// TTK_ANON_SCOPES is the documented way to put it back for a development
	// mount. Two rules for one question would be the drift this partition exists
	// to prevent.
	// C7 / D-098: nor `admin` — a credential-less principal manages nothing unless TTK_ANON_SCOPES names it.
	assertEquals(sorted(DEFAULT_SCOPES), ['files:read', 'mcp:invoke', 'view:control', 'view:watch']);
});
