/**
 * containment-otel-links S0 (design §2.0 items 3–5): the seams WS-B and WS-C code against, held before either lands.
 *
 * - `SessionRecord.incarnation`: 12 base64url characters from 9 random bytes, drawn at the one creation site, and a
 *   different one when a closed session's id is created again (what a v2 signed link binds to, §2.7).
 * - `ToolContext.credentialNotAfter`: set by `registerCatalog` from the GW-1 credential `oauth:<ms>` only, as Unix
 *   seconds (F1); absent for every other credential.
 * - `SessionRegistryOptions.allowedDomainsScope` / `SessionProfileInput.allowedDomainsScope`: accepted; `documents`
 *   leaves the launch profile byte-identical (WS-B composes `all`, D-138).
 * - `SignedLinkMinter.credential` (D-148): bound by `registerCatalog` from the GW-1 credential, never by a tool.
 */
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { DEFAULT_SESSION_ID, sessionProfile, SessionRegistry } from './registry.ts';
import { credentialNotAfterOf, registerCatalog } from './server.ts';
import type { SignedLinkMinter } from './types.ts';

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'containment-seam-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

function registry(scope?: 'documents' | 'all'): SessionRegistry {
	return new SessionRegistry({
		reapIntervalMs: 0,
		...(scope === undefined ? {} : { allowedDomainsScope: scope }),
		launch: () => Promise.resolve(fakeSession()),
	});
}

const INCARNATION = /^[A-Za-z0-9_-]{12}$/;

Deno.test('S0 item 3: every record has a 12-character base64url incarnation, new for each creation', async () => {
	const sessions = registry('all');
	try {
		const first = await sessions.resolve(undefined);
		assertEquals(first.id, DEFAULT_SESSION_ID);
		assert(INCARNATION.test(first.incarnation), first.incarnation);
		// A lookup returns the record it created; the incarnation does not move while the session lives.
		assertEquals((await sessions.resolve(undefined)).incarnation, first.incarnation);

		const other = await sessions.createNew();
		assert(INCARNATION.test(other.incarnation), other.incarnation);
		assertNotEquals(other.incarnation, first.incarnation);

		// The same id, recreated after a close, is a new incarnation: a link bound to the old one cannot reach it.
		await sessions.close(DEFAULT_SESSION_ID);
		const again = await sessions.resolve(undefined);
		assertEquals(again.id, DEFAULT_SESSION_ID);
		assert(INCARNATION.test(again.incarnation), again.incarnation);
		assertNotEquals(again.incarnation, first.incarnation);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('S0 item 3: allowedDomainsScope is accepted; documents leaves sessionProfile unchanged', () => {
	const base = {
		headless: true,
		downloadsDir: '/data/downloads/x',
		browserPath: null,
		browserArgs: ['--proxy-server=http://p:3128'],
		userDataDir: null,
		storageState: null,
		chromiumSandbox: true,
		allowedDomains: ['example.com'],
	} as const;
	const unset = sessionProfile(base);
	assertEquals(sessionProfile({ ...base, allowedDomainsScope: 'documents' }), unset);
	// WS-B (D-138): `all` now composes the request scope and the resolver layer — pinned in containment_test.ts AC13.
	assertNotEquals(sessionProfile({ ...base, allowedDomainsScope: 'all' }), unset);
});

function auth(credential?: unknown): AuthInfo {
	return {
		token: 't',
		clientId: 'subject',
		scopes: ['mcp:invoke'],
		extra: { owner: 'oauth:subject', ...(credential === undefined ? {} : { credential }) },
	};
}

Deno.test('S0 item 5: credentialNotAfterOf reads the oauth:<ms> credential as Unix seconds, and nothing else', () => {
	assertEquals(credentialNotAfterOf(auth('oauth:1791201600000')), 1_791_201_600);
	// Milliseconds that are not a whole second round down: a link may never outlive the token.
	assertEquals(credentialNotAfterOf(auth('oauth:1791201600999')), 1_791_201_600);
	for (
		const other of [
			undefined,
			'api-key:alice',
			'user:admin:1',
			'oauth:',
			'oauth:12.5',
			'oauth:-5',
			'oauth:1e12',
			' oauth:1000',
			'oauth:1000 ',
			'OAUTH:1000',
			1_791_201_600_000,
		]
	) {
		assertEquals(credentialNotAfterOf(auth(other)), undefined, String(other));
	}
	assertEquals(credentialNotAfterOf(undefined), undefined, 'the credential-less mounts');
	assertEquals(credentialNotAfterOf({ token: 't', clientId: 'c', scopes: [] }), undefined, 'no extra');
});

Deno.test('SEC-2 / D-140: a delegated MCP bearer caps notAfter at its own expiry, whatever its delegator', () => {
	// A `ttkd_` bearer (an agent task's, life <= 120 s) carries its delegator's GW-1 credential. With an API-key or
	// account delegator that credential has no expiry, so a link minted under the delegation lived the full hour and
	// outlived the task (review SEC-2, measured 3480 s past it). The bearer's own `expiresAt` now bounds it.
	const delegated = (credential: string, expiresAt?: number): AuthInfo => ({
		token: 't',
		clientId: 'parent',
		scopes: ['mcp:invoke'],
		...(expiresAt === undefined ? {} : { expiresAt }),
		extra: { owner: 'api-key:parent', credential, delegatedMcp: true },
	});
	assertEquals(credentialNotAfterOf(delegated('api-key:parent', 1_791_201_720)), 1_791_201_720, 'API-key delegator');
	assertEquals(credentialNotAfterOf(delegated('user:admin:1', 1_791_201_720)), 1_791_201_720, 'account delegator');
	// An OAuth delegator: the earlier of the two wins, either way round.
	assertEquals(credentialNotAfterOf(delegated('oauth:1791201600000', 1_791_201_720)), 1_791_201_600);
	assertEquals(credentialNotAfterOf(delegated('oauth:1791209999000', 1_791_201_720)), 1_791_201_720);
	// A fractional expiresAt rounds down: a link may never outlive the bearer.
	assertEquals(credentialNotAfterOf(delegated('api-key:parent', 1_791_201_720.9)), 1_791_201_720);
	// Only a delegated bearer is capped by expiresAt; an ordinary bearer keeps the credential-only reading.
	const plain: AuthInfo = {
		...delegated('api-key:parent', 1_791_201_720),
		extra: { owner: 'api-key:parent', credential: 'api-key:parent' },
	};
	assertEquals(credentialNotAfterOf(plain), undefined);
	// A delegated bearer without a usable expiresAt keeps the delegator's reading (the gateway always sets one).
	assertEquals(credentialNotAfterOf(delegated('api-key:parent')), undefined);
	assertEquals(credentialNotAfterOf(delegated('api-key:parent', Number.NaN)), undefined);
});

Deno.test('S0 item 5: registerCatalog puts credentialNotAfter on the context for an OAuth credential only', async () => {
	const sessions = registry();
	const contextFor = async (authInfo: AuthInfo | undefined) => {
		const server = new McpServer({ name: 'containment-seam-test', version: '0' });
		try {
			return registerCatalog(server, { registry: sessions, version: '0' }, authInfo).ctx;
		} finally {
			await server.close();
		}
	};
	try {
		assertEquals((await contextFor(auth('oauth:1791201600000'))).credentialNotAfter, 1_791_201_600);
		for (const authInfo of [auth('api-key:alice'), auth(), undefined]) {
			const ctx = await contextFor(authInfo);
			assertEquals('credentialNotAfter' in ctx, false, JSON.stringify(authInfo?.extra));
		}
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('D-148: registerCatalog binds the call’s GW-1 credential into the link minter; a tool cannot supply one', async () => {
	const sessions = registry();
	const asked: Parameters<SignedLinkMinter>[0][] = [];
	const signedLink: SignedLinkMinter = (input) => {
		asked.push(input);
		return Promise.resolve({ url: 'https://gw.test/l', expiresAt: '2026-10-07T00:00:00.000Z', ttlSeconds: 60 });
	};
	const minterFor = async (authInfo: AuthInfo | undefined) => {
		const server = new McpServer({ name: 'containment-seam-test', version: '0' });
		try {
			return registerCatalog(server, { registry: sessions, version: '0', signedLink }, authInfo).ctx.signedLink!;
		} finally {
			await server.close();
		}
	};
	const request = { sessionId: 's', fileId: 'f', owner: 'api-key:admin:alice', incarnation: 'incarnation1' };
	try {
		// The mount's credential reaches the minter, whatever the tool passed.
		await (await minterFor(auth('user-key:abc')))({ ...request, credential: 'user-key:forged' });
		assertEquals(asked.at(-1), { ...request, credential: 'user-key:abc' });
		// No credential on the call (or no authInfo at all): none reaches the minter, and a tool's is dropped.
		for (const authInfo of [auth(), auth(''), auth(42), undefined]) {
			await (await minterFor(authInfo))({ ...request, credential: 'user-key:forged' });
			assertEquals(asked.at(-1), request, JSON.stringify(authInfo?.extra));
		}
	} finally {
		await sessions.shutdown();
	}
});
