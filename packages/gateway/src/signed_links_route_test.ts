/**
 * Signed links v2 at the route (containment-otel-links design §2.7, D-140; AC18, AC21, AC22): what ends a link before
 * its expiry, through the gateway's own `app.fetch` — the session's incarnation (404), the owner's keyed credential
 * epoch (a bare 401), and the OAuth cap that holds a link to the access token it was minted under (F1, N3).
 *
 * Links are minted the way the gateway mints them: over MCP, through the mount's own `browser_file_link` and the
 * minter `createGatewayApp` wires, whenever the leg is about minting; with `createLinkMinter` over the same verifier
 * when the leg is only about what the route answers later. The clock is injected (`GatewayDeps.linkClock`), so a
 * two-minute expiry is crossed without waiting; the OAuth principal is injected by a verifier whose `resolve` answers
 * one test token, because the leg is about the credential the mount carries, not about JWT verification.
 *
 * The browser is faked (a session with a real file under `tests/.scratch`), so this stays in the unit tier.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { decodeBase64Url } from '@std/encoding/base64url';
import { join } from '@std/path';
import type { BrowserSession, DownloadRecord } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { generateAdminUser } from './admin_auth.ts';
import { createGatewayApp, type GatewayApp } from './app.ts';
import {
	generateAccountKey,
	generateApiKey,
	type Principal,
	VerifierChain,
	type VerifierChainOptions,
} from './auth.ts';
import type { Cluster } from './cluster.ts';
import { type Config, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { createLinkMinter, createLinkSigner, LINK_PATH } from './signed_links.ts';
import { type NewAccountKey, UserStore } from './users.ts';

const KEY_TEXT = 'k'.repeat(24) + '-link-signing-key-for-tests';
const KEY = new TextEncoder().encode(KEY_TEXT);
const HOST = '127.0.0.1:8787';
const PAYLOAD = new Uint8Array(4_096).map((_, i) => (i * 7) % 256);

async function scratch(prefix: string): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	return await Deno.makeTempDir({ dir: 'tests/.scratch', prefix });
}

function tokenOf(url: string): string {
	return new URL(url).searchParams.get('t') ?? '';
}

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'signed-links-v2' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

function ledgerRecord(dir: string, guid: string): DownloadRecord {
	return {
		guid,
		url: 'http://127.0.0.1:1/export',
		suggestedFilename: 'report.bin',
		fileName: 'report.bin',
		path: join(dir, guid),
		fileSize: PAYLOAD.length,
		receivedBytes: PAYLOAD.length,
		totalBytes: PAYLOAD.length,
		fileType: 'bin',
		mimeType: null,
		autoDownload: false,
		state: 'completed',
		startedAt: 1,
		completedAt: 2,
		error: null,
	};
}

/**
 * A verifier whose `resolve` also answers the tokens a test registered — an OAuth principal carrying the GW-1
 * credential `oauth:<ms>` the real `OAuthVerifier` stamps — and otherwise defers to the real chain.
 */
class InjectedVerifier extends VerifierChain {
	readonly principals = new Map<string, Principal>();
	constructor(options: VerifierChainOptions) {
		super(options);
	}
	override async resolve(token: string): Promise<Principal | null> {
		return this.principals.get(token) ?? await super.resolve(token);
	}
}

interface Fixture extends AsyncDisposable {
	readonly gateway: GatewayApp;
	readonly registry: SessionRegistry;
	readonly verifier: InjectedVerifier;
	readonly config: Config;
	readonly dir: string;
	readonly records: DownloadRecord[];
	readonly keys: { e2e: Awaited<ReturnType<typeof generateApiKey>> };
	/** The injected link clock, in milliseconds; tests move it. */
	readonly clock: { ms: number };
	get(token: string, init?: RequestInit): Promise<Response>;
	/** A link for `owner`, minted exactly as the gateway's minter would (no OAuth cap). */
	link(owner?: string, sessionId?: string): Promise<string>;
	/** An MCP client on this gateway's own `/mcp`, through `app.fetch`, presenting `bearer`. */
	mcp(bearer: string): Promise<Client>;
}

interface FixtureOptions {
	readonly env?: Record<string, string>;
	readonly users?: UserStore;
	readonly cluster?: Cluster;
	/** A registry to share with another fixture (a second gateway over the same sessions). */
	readonly registry?: SessionRegistry;
	readonly withSession?: boolean;
	readonly e2e?: Awaited<ReturnType<typeof generateApiKey>>;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const dir = await scratch('link-v2-');
	await Deno.writeFile(join(dir, 'G1'), PAYLOAD);
	const records = [ledgerRecord(dir, 'G1')];
	const ledger = {
		downloads: records,
		isRemoteBrowser: false,
		lookup: (g: string) => records.find((r) => r.guid === g),
	};
	const ownsRegistry = options.registry === undefined;
	const registry = options.registry ?? new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session: fakeSession(), downloads: ledger as never, downloadsDir: dir }),
	});
	if (ownsRegistry && options.withSession !== false) await registry.resolve(undefined);
	const e2e = options.e2e ?? await generateApiKey('e2e', ['mcp:invoke']);
	const config = loadConfig(
		{
			TTK_HOST: '127.0.0.1',
			TTK_API_KEYS: JSON.stringify([e2e.record]),
			TTK_SIGNED_LINKS: 'true',
			TTK_PUBLIC_URL: `http://${HOST}/`,
			TTK_RATE_RPM: '100000',
			...options.env,
		},
		{ secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } },
	);
	const logger = createLogger({ level: 'error', write: () => {} });
	const verifier = new InjectedVerifier({
		config,
		allowAnonymous: false,
		logger,
		...(options.users === undefined ? {} : { users: options.users }),
	});
	const clock = { ms: Date.now() };
	const gateway = createGatewayApp({
		config,
		registry,
		verifier,
		logger,
		version: 'test',
		linkClock: () => clock.ms,
		...(options.cluster === undefined ? {} : { cluster: options.cluster }),
	});
	// The gateway's own minter, over the same key, verifier and clock — for the legs that are about the route.
	const minter = createLinkMinter({
		signer: createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: config.publicUrl, now: () => clock.ms }),
		// No credential: bound by owner, as every link minted before D-148 was (an account owner: account-level).
		bindingOf: (owner) => verifier.linkBinding(owner, undefined),
	});
	const clients: Client[] = [];
	return {
		gateway,
		registry,
		verifier,
		config,
		dir,
		records,
		keys: { e2e },
		clock,
		get: async (token, init = {}) => {
			const headers = new Headers(init.headers);
			headers.set('host', HOST);
			const url = `http://${HOST}${LINK_PATH}?t=${encodeURIComponent(token)}`;
			return await gateway.app.fetch(new Request(url, { ...init, headers }));
		},
		link: async (owner = 'api-key:e2e', sessionId = 'default') =>
			tokenOf(
				(await minter({
					sessionId,
					fileId: 'G1',
					owner,
					incarnation: registry.peek(sessionId)?.incarnation ?? 'no-session12',
				})).url,
			),
		mcp: async (bearer) => {
			const client = new Client({ name: 'links-v2', version: '0' }, { versionNegotiation: { mode: 'auto' } });
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
					fetch: async (input, init) => {
						const headers = new Headers(init?.headers);
						headers.set('authorization', `Bearer ${bearer}`);
						headers.set('host', HOST);
						return await gateway.app.fetch(new Request(input, { ...init, headers }));
					},
				}),
			);
			clients.push(client);
			return client;
		},
		async [Symbol.asyncDispose]() {
			for (const client of clients) await client.close().catch(() => {});
			await gateway.close();
			if (ownsRegistry) await registry.shutdown();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

/** The status of following `token`, with the body drained. */
async function statusOf(f: Fixture, token: string, init?: RequestInit): Promise<number> {
	const response = await f.get(token, init);
	await response.body?.cancel();
	return response.status;
}

interface LinkCall {
	isError?: boolean;
	content: Array<{ text?: string }>;
	structuredContent?: {
		url?: string;
		ttl_seconds?: number;
		expires_at?: string;
		error?: { code?: string };
	};
}

async function callLink(client: Client, args: Record<string, unknown> = {}): Promise<LinkCall> {
	return await client.callTool({ name: 'browser_file_link', arguments: { file_id: 'G1', ...args } }) as LinkCall;
}

// --- the session (incarnation) and the file: 404 ----------------------------------------------------------------

Deno.test('AC21: a closed session, the same id created again, and a deleted file each answer 404', async () => {
	await using f = await fixture();
	const token = await f.link();
	assertEquals(await statusOf(f, token), 200);

	await f.registry.close('default');
	const closed = await f.get(token);
	assertEquals(closed.status, 404);
	assertStringIncludes((await closed.json()).type, 'not-found');

	// The same id, created again, holding a servable G1: the launch hands every incarnation the same ledger, and the
	// bytes are put back where the close removed them — so only the incarnation keeps this link from serving them.
	const again = await f.registry.resolve(undefined);
	assertEquals(again.id, 'default');
	await Deno.mkdir(f.dir, { recursive: true });
	await Deno.writeFile(join(f.dir, 'G1'), PAYLOAD);
	assertEquals(again.files.lookup('G1')?.guid, 'G1', 'the recreated session does hold a G1');
	assertEquals(await statusOf(f, token), 404, 'recreated under the same id: another session');
	assertEquals(await statusOf(f, await f.link()), 200, 'a link minted in the new incarnation serves');

	// The file deleted from disk, then forgotten by the ledger.
	const fresh = await f.link();
	await Deno.remove(join(f.dir, 'G1'));
	assertEquals(await statusOf(f, fresh), 404);
	f.records.length = 0;
	assertEquals(await statusOf(f, fresh), 404);
});

// --- the owner's credential (epoch): 401 ------------------------------------------------------------------------

Deno.test('AC21: an API key removed or rotated under its id ends its links; an identical reload does not', async () => {
	await using f = await fixture();
	const other = await generateApiKey('other', ['mcp:invoke']);
	f.verifier.replaceApiKeys([f.keys.e2e.record, other.record]);
	const token = await f.link();
	assertEquals(await statusOf(f, token), 200);

	// Reloading the key file with the same record changes nothing.
	f.verifier.replaceApiKeys([{ ...f.keys.e2e.record }, other.record]);
	assertEquals(await statusOf(f, token), 200, 'identical-record reload');

	// Rotated under the same id: `ownerScopes` still finds an `e2e` holding mcp:invoke — the epoch is what refuses.
	const rotated = await generateApiKey('e2e', ['mcp:invoke']);
	f.verifier.replaceApiKeys([rotated.record, other.record]);
	assert(f.verifier.ownerScopes('api-key:e2e')?.has('mcp:invoke'), 'the id is still a key with mcp:invoke');
	const refused = await f.get(token);
	assertEquals(refused.status, 401, 'rotated under the same id');
	assertEquals((await refused.json()).detail, undefined, 'a bare 401');
	// Restoring the old record would restore the old epoch: the link is bound to the credential, not to a counter.
	const underRotated = await f.link();
	assertEquals(await statusOf(f, underRotated), 200, 'the replacement key mints links of its own');

	// Removed.
	f.verifier.replaceApiKeys([other.record]);
	assertEquals(await statusOf(f, underRotated), 401, 'removed');
});

Deno.test('AC21: a password change, a disabled account and a removed account each end the account’s links', async () => {
	const data = await scratch('link-v2-users-');
	try {
		const { record: root } = await generateAdminUser('root');
		const users = new UserStore({ dataDir: data, seed: root });
		await users.create({ username: 'alice', password: 'alice-password-1', scopes: ['mcp:invoke'] });
		await using f = await fixture({ users });
		const owner = 'api-key:admin:alice';

		const beforeChange = await f.link(owner);
		assertEquals(await statusOf(f, beforeChange), 200);
		await users.setPassword('alice', 'alice-password-2');
		assert(f.verifier.ownerScopes(owner)?.has('mcp:invoke'), 'the account still holds mcp:invoke');
		assertEquals(await statusOf(f, beforeChange), 401, 'password changed');

		const beforeDisable = await f.link(owner);
		assertEquals(await statusOf(f, beforeDisable), 200);
		await users.update('alice', { disabled: true });
		assertEquals(await statusOf(f, beforeDisable), 401, 'disabled');
		await users.update('alice', { disabled: false });

		const beforeRemove = await f.link(owner);
		assertEquals(await statusOf(f, beforeRemove), 200);
		await users.remove('alice');
		assertEquals(await statusOf(f, beforeRemove), 401, 'removed');
	} finally {
		await Deno.remove(data, { recursive: true }).catch(() => {});
	}
});

// --- an account API key's own links (D-148) ---------------------------------------------------------------------

/** A REST call on the fixture's gateway, through `app.fetch`, presenting `token` when there is one. */
async function rest(
	f: Fixture,
	method: string,
	path: string,
	token: string | null,
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const headers = new Headers({ host: HOST });
	// Only with a body: the front's JSON parser refuses an empty body that claims to be JSON.
	if (body !== undefined) headers.set('content-type', 'application/json');
	if (token !== null) headers.set('authorization', `Bearer ${token}`);
	const response = await f.gateway.app.fetch(
		new Request(`http://${HOST}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
	const text = await response.text();
	return { status: response.status, json: text === '' ? null : JSON.parse(text) };
}

/** A link minted over the fixture's own `/mcp` under `bearer`, as a client gets one. */
async function mintOver(f: Fixture, bearer: string): Promise<string> {
	const minted = await callLink(await f.mcp(bearer));
	assertEquals(minted.isError, undefined, JSON.stringify(minted.content));
	return tokenOf(minted.structuredContent!.url!);
}

/** The token's claims, read without verifying — what anyone holding the URL can see. */
function claimsOf(token: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(token.split('.')[1]!)));
}

/** A key minted for the account store, as the Users screen's route mints it. */
async function accountKey(): Promise<Awaited<ReturnType<typeof generateAccountKey>> & { input: NewAccountKey }> {
	const key = await generateAccountKey();
	return { ...key, input: { id: key.id, prefix: key.prefix, sha256: key.sha256 } };
}

Deno.test('D-148: deleting an account key ends the links minted under it at the next follow, and only those', async () => {
	const data = await scratch('link-v2-account-keys-');
	try {
		const { record: root, password: rootPassword } = await generateAdminUser('root');
		const users = new UserStore({ dataDir: data, seed: root });
		await users.create({ username: 'alice', password: 'alice-password-1', scopes: ['mcp:invoke'] });
		const [one, two] = [await accountKey(), await accountKey()];
		await users.addKey('alice', one.input);
		await users.addKey('alice', two.input);
		await using f = await fixture({ users });
		const signIn = async (body: unknown): Promise<string> =>
			(await rest(f, 'POST', '/api/v1/auth/login', null, body)).json?.token as string;

		const links = {
			one: await mintOver(f, one.secret),
			oneSignIn: await mintOver(f, await signIn({ apiKey: one.secret })),
			two: await mintOver(f, two.secret),
			password: await mintOver(f, await signIn({ username: 'alice', password: 'alice-password-1' })),
			// No credential bound: what a link minted before D-148 under any of the above was — account-level.
			legacy: await f.link('api-key:admin:alice'),
		};
		// The key's public id rides as `k`; never its hash, the key or its prefix. The others carry no `k`.
		assertEquals([claimsOf(links.one).k, claimsOf(links.oneSignIn).k, claimsOf(links.two).k], [one.id, one.id, two.id]);
		assertEquals([claimsOf(links.password).k, claimsOf(links.legacy).k], [undefined, undefined]);
		for (const key of [one, two]) {
			for (const value of [key.sha256, key.secret, key.prefix]) {
				assert(
					!Object.values(links).some((token) =>
						token.includes(value) || JSON.stringify(claimsOf(token)).includes(value)
					),
				);
			}
		}
		for (const [name, token] of Object.entries(links)) assertEquals(await statusOf(f, token), 200, name);

		// Revoked over the route, as the Users screen does it: the very next follow is D-140's bare 401.
		const admin = await signIn({ username: 'root', password: rootPassword });
		assertEquals((await rest(f, 'DELETE', `/api/v1/users/alice/keys/${one.id}`, admin)).status, 204);
		const refused = await f.get(links.one);
		assertEquals(refused.status, 401);
		assertEquals((await refused.json()).detail, undefined, 'a bare 401');
		assertEquals(await statusOf(f, links.oneSignIn), 401, 'minted under a sign-in opened with the key');
		// The account's other key, its password sign-in and a link with no key binding are untouched.
		for (const name of ['two', 'password', 'legacy'] as const) assertEquals(await statusOf(f, links[name]), 200, name);

		// Disabling the account ends the rest; enabling it restores those still inside their life (D-140's residual).
		assertEquals((await rest(f, 'PATCH', '/api/v1/users/alice', admin, { disabled: true })).status, 200);
		for (const name of ['two', 'password', 'legacy'] as const) assertEquals(await statusOf(f, links[name]), 401, name);
		assertEquals((await rest(f, 'PATCH', '/api/v1/users/alice', admin, { disabled: false })).status, 200);
		for (const name of ['two', 'password', 'legacy'] as const) assertEquals(await statusOf(f, links[name]), 200, name);
		assertEquals(await statusOf(f, links.one), 401, 'a revoked key stays revoked');

		// A password change ends every link of the account, a key's included; the key itself lives on and mints anew.
		assertEquals((await rest(f, 'POST', '/api/v1/users/alice/password', admin, {})).status, 200);
		for (const name of ['two', 'password', 'legacy'] as const) assertEquals(await statusOf(f, links[name]), 401, name);
		const after = await mintOver(f, two.secret);
		assertEquals(await statusOf(f, after), 200);

		// Narrowing the account past `mcp:invoke` narrows the key, and its link with it.
		await users.update('alice', { scopes: ['view:watch'] });
		assertEquals(await statusOf(f, after), 401, 'the key no longer holds mcp:invoke');
		await users.update('alice', { scopes: ['mcp:invoke'] });
		assertEquals(await statusOf(f, after), 200);

		// Deleting the account removes its keys, and their links end with them.
		assertEquals((await rest(f, 'DELETE', '/api/v1/users/alice', admin)).status, 204);
		assertEquals(await statusOf(f, after), 401);
	} finally {
		await Deno.remove(data, { recursive: true }).catch(() => {});
	}
});

Deno.test({
	name: 'D-148: an account key revoked on one cluster node ends its links on every node',
	// The KV replicas poll on timers the store owns; the account-key cluster test runs the same way.
	sanitizeResources: false,
	sanitizeOps: false,
	fn: async () => {
		const data = await scratch('link-v2-cluster-keys-');
		const { record: root } = await generateAdminUser('root');
		const kvA = await Deno.openKv(join(data, 'cluster.kv'));
		const kvB = await Deno.openKv(join(data, 'cluster.kv'));
		const usersA = new UserStore({ dataDir: join(data, 'a'), seed: root });
		const usersB = new UserStore({ dataDir: join(data, 'b'), seed: null });
		try {
			await usersA.attachCluster(kvA, { pollMs: 50 });
			await usersB.attachCluster(kvB, { pollMs: 50 });
			await usersA.create({ username: 'alice', password: 'alice-password-1', scopes: ['mcp:invoke'] });
			const [revoked, kept] = [await accountKey(), await accountKey()];
			await usersA.addKey('alice', revoked.input);
			await usersA.addKey('alice', kept.input);
			await until(() => usersB.findKey(revoked.sha256) !== null && usersB.findKey(kept.sha256) !== null, 'B');
			// Two nodes over the same sessions and link key, each answering from its own replica of the accounts.
			await using a = await fixture({ users: usersA });
			await using b = await fixture({ users: usersB, registry: a.registry, e2e: a.keys.e2e });
			b.clock.ms = a.clock.ms;
			const token = await mintOver(a, revoked.secret);
			const other = await mintOver(a, kept.secret);
			assertEquals([await statusOf(a, token), await statusOf(b, token)], [200, 200], 'B computes the same epoch');

			// Revoked on B: B refuses at once; A refuses as soon as its replica has read the write.
			await usersB.removeKey('alice', revoked.id);
			assertEquals(await statusOf(b, token), 401);
			await until(() => usersA.findKey(revoked.sha256) === null, 'A reading the revocation');
			assertEquals(await statusOf(a, token), 401);
			assertEquals([await statusOf(a, other), await statusOf(b, other)], [200, 200], 'the other key’s link');
		} finally {
			usersA.detachCluster();
			usersB.detachCluster();
			kvA.close();
			kvB.close();
			await Deno.remove(data, { recursive: true }).catch(() => {});
		}
	},
});

async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

Deno.test('AC21: an OAuth link stops when OAuth is no longer configured', async () => {
	await using oauth = await fixture({ env: { TTK_OAUTH_ISSUER: 'https://issuer.example.test' } });
	oauth.verifier.principals.set('oauth-token', {
		kind: 'oauth',
		id: 'subject',
		scopes: new Set(['mcp:invoke']),
		credential: `oauth:${Math.floor(oauth.clock.ms / 1000) * 1000 + 600_000}`,
	});
	const minted = await callLink(await oauth.mcp('oauth-token'));
	assertEquals(minted.isError, undefined, JSON.stringify(minted.content));
	const token = tokenOf(minted.structuredContent!.url!);
	assertEquals(await statusOf(oauth, token), 200);
	// The same deployment, the same key and the same sessions, restarted without TTK_OAUTH_ISSUER.
	await using plain = await fixture({ registry: oauth.registry, e2e: oauth.keys.e2e });
	plain.clock.ms = oauth.clock.ms;
	assertEquals(await statusOf(plain, token), 401);
});

// --- the OAuth cap (F1) and its fail-closed edge (N3) ----------------------------------------------------------

Deno.test('AC21 (F1): an OAuth link is capped at its token’s expiry; under 10 s left is scope-required; an API key is not capped', async () => {
	await using f = await fixture({ env: { TTK_OAUTH_ISSUER: 'https://issuer.example.test' } });
	const nowS = Math.floor(f.clock.ms / 1000);
	const oauth = (token: string, expiresInS: number | null): void => {
		f.verifier.principals.set(token, {
			kind: 'oauth',
			id: 'subject',
			scopes: new Set(['mcp:invoke']),
			// GW-1: what `OAuthVerifier.verify` stamps — the token's `exp` in milliseconds. `null`: no credential at all.
			...(expiresInS === null ? {} : { credential: `oauth:${(nowS + expiresInS) * 1000}` }),
		});
	};

	// A token expiring in 120 s, minting with no ttl_seconds: the link is capped at 120 s.
	oauth('token-120', 120);
	const minted = await callLink(await f.mcp('token-120'));
	assertEquals(minted.isError, undefined, JSON.stringify(minted.content));
	assertEquals(minted.structuredContent?.ttl_seconds, 120);
	assertEquals(minted.structuredContent?.expires_at, new Date((nowS + 120) * 1000).toISOString());
	const token = tokenOf(minted.structuredContent!.url!);
	assertEquals(await statusOf(f, token), 200, 'at +0 s');
	f.clock.ms = nowS * 1000 + 119_000;
	assertEquals(await statusOf(f, token), 200, 'at +119 s');
	f.clock.ms = nowS * 1000 + 121_000;
	assertEquals(await statusOf(f, token), 401, 'at +121 s: expired with its token');

	// A token expiring in 5 s: nothing to mint.
	f.clock.ms = nowS * 1000;
	oauth('token-5', 5);
	const short = await callLink(await f.mcp('token-5'));
	assertEquals(short.isError, true);
	assertEquals(short.structuredContent?.error?.code, 'scope-required');
	assertStringIncludes(short.content[0]?.text ?? '', 'expires within 10 s; refresh it and mint again');

	// N3: an OAuth owner whose call carries no expiry (here: no credential at all) fails closed.
	oauth('token-none', null);
	const unbounded = await callLink(await f.mcp('token-none'));
	assertEquals(unbounded.isError, true);
	assertEquals(unbounded.structuredContent?.error?.code, 'scope-required');
	assertStringIncludes(unbounded.content[0]?.text ?? '', 'no known expiry');

	// An API key under the same clock: the deployment default, uncapped.
	const keyed = await callLink(await f.mcp(f.keys.e2e.key));
	assertEquals(keyed.isError, undefined, JSON.stringify(keyed.content));
	assertEquals(keyed.structuredContent?.ttl_seconds, 3600);
	assertEquals(keyed.structuredContent?.expires_at, new Date((nowS + 3600) * 1000).toISOString());
	f.clock.ms = nowS * 1000 + 3_599_000;
	assertEquals(await statusOf(f, tokenOf(keyed.structuredContent!.url!)), 200, 'an API-key link lives its hour');
});

// --- the tool's bound (AC18) ------------------------------------------------------------------------------------

Deno.test('AC18: browser_file_link accepts ttl_seconds 3600 and refuses 3601 as invalid-arguments', async () => {
	await using f = await fixture();
	const client = await f.mcp(f.keys.e2e.key);
	const accepted = await callLink(client, { ttl_seconds: 3600 });
	assertEquals(accepted.isError, undefined, JSON.stringify(accepted.content));
	assertEquals(accepted.structuredContent?.ttl_seconds, 3600);
	for (const ttl of [3601, 9]) {
		const refused = await callLink(client, { ttl_seconds: ttl });
		assertEquals(refused.isError, true, String(ttl));
		assertEquals(refused.structuredContent?.error?.code, 'invalid-arguments', String(ttl));
	}
	const { tools } = await client.listTools();
	const schema = tools.find((tool) => tool.name === 'browser_file_link')?.inputSchema as {
		properties?: { ttl_seconds?: { maximum?: number; minimum?: number; description?: string } };
	};
	assertEquals([schema.properties?.ttl_seconds?.minimum, schema.properties?.ttl_seconds?.maximum], [10, 3600]);
	assertStringIncludes(schema.properties?.ttl_seconds?.description ?? '', 'never outlives the OAuth access token');
});

// --- two nodes (AC22) -------------------------------------------------------------------------------------------

Deno.test('AC22: the entry node refuses a stale epoch before any hop; the owner node repeats it and 404s an incarnation mismatch', async () => {
	const e2e = await generateApiKey('e2e', ['mcp:invoke']);
	// Node B holds the session and serves the bytes; it is a real gateway behind a loopback listener.
	await using b = await fixture({ e2e });
	const reached: string[] = [];
	await using listener = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
		reached.push(new URL(request.url).pathname);
		const headers = new Headers(request.headers);
		headers.set('host', HOST);
		return b.gateway.app.fetch(new Request(request.url, { method: request.method, headers }));
	});
	const asked: string[] = [];
	const cluster = {
		self: { id: 'node-a', url: 'http://127.0.0.1:1', role: 'all' },
		ownerOf: (sessionId: string) => {
			asked.push(sessionId);
			return Promise.resolve({ id: 'node-b', url: `http://127.0.0.1:${listener.addr.port}`, role: 'all' });
		},
		adopt: () => Promise.resolve(),
		release: () => Promise.resolve(),
	} as unknown as Cluster;
	// Node A, the entry: the same key and key records, no session of its own.
	await using a = await fixture({ e2e, cluster, withSession: false, env: { TTK_CLUSTER_KV: '/kv/never-opened' } });
	a.clock.ms = b.clock.ms;
	const incarnation = b.registry.peek('default')!.incarnation;
	const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: a.config.publicUrl, now: () => a.clock.ms });
	const raw = async (digest: string, inc: string): Promise<string> =>
		tokenOf(
			(await signer.mint({ sessionId: 'default', fileId: 'G1', owner: 'api-key:e2e', incarnation: inc, digest })).url,
		);

	// A stale epoch (a key hash the owner no longer has): 401 at A, and neither the index nor B is consulted.
	assertEquals(await statusOf(a, await raw('a-previous-key-hash', incarnation)), 401);
	assertEquals([asked, reached], [[], []], 'a stale epoch never costs a hop');

	// The right epoch and incarnation: forwarded, served by B.
	const good = await a.get(await raw(e2e.record.sha256, incarnation));
	assertEquals(good.status, 200);
	assertEquals(new Uint8Array(await good.arrayBuffer()), PAYLOAD);
	assertEquals(reached, [LINK_PATH]);

	// The right epoch, another incarnation: A cannot tell (it holds no session), B answers 404.
	const mismatch = await a.get(await raw(e2e.record.sha256, 'AAAAAAAAAAAA'));
	assertEquals(mismatch.status, 404);
	assertStringIncludes((await mismatch.json()).type, 'not-found');
	assertEquals(reached.length, 2, 'decided on the owner node');

	// The owner node repeats the epoch check on its own records: rotated on B only, A forwards and B refuses.
	const rotated = await generateApiKey('e2e', ['mcp:invoke']);
	b.verifier.replaceApiKeys([rotated.record]);
	assertEquals(await statusOf(a, await raw(e2e.record.sha256, incarnation)), 401);
	assertEquals(reached.length, 3);
});
