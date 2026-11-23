/**
 * Signed links v2 at the route: what ends a link before its expiry, through the gateway's own `app.fetch` — the
 * session's incarnation (404) and the owner's keyed credential epoch (a bare 401).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { decodeBase64Url } from '@std/encoding/base64url';
import { join } from '@std/path';
import type { DownloadRecord } from '@tykotech/browser';
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
import { type Config, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { createLinkMinter, createLinkSigner, LINK_PATH } from './signed_links.ts';
import { type NewAccountKey, UserStore } from './users.ts';
import { fakeSession, scratch } from './support_test.ts';

const KEY_TEXT = 'k'.repeat(24) + '-link-signing-key-for-tests';
const KEY = new TextEncoder().encode(KEY_TEXT);
const HOST = '127.0.0.1:8787';
const PAYLOAD = new Uint8Array(4_096).map((_, i) => (i * 7) % 256);

function tokenOf(url: string): string {
	return new URL(url).searchParams.get('t') ?? '';
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

/** A verifier whose `resolve` also answers the tokens a test registered, and otherwise defers to the real chain. */
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
	/** A link for `owner`, minted exactly as the gateway's minter would. */
	link(owner?: string, sessionId?: string): Promise<string>;
	/** An MCP client on this gateway's own `/mcp`, through `app.fetch`, presenting `bearer`. */
	mcp(bearer: string): Promise<Client>;
}

interface FixtureOptions {
	readonly env?: Record<string, string>;
	readonly users?: UserStore;
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
	});
	// The gateway's own minter, over the same key, verifier and clock — for the legs that are about the route.
	const minter = createLinkMinter({
		signer: createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: config.publicUrl, now: () => clock.ms }),
		// No credential: bound by owner alone (an account owner: account-level).
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

Deno.test('signed link route: a closed session, the same id created again, and a deleted file each answer 404', async () => {
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

Deno.test('signed link route: an API key removed or rotated under its id ends its links; an identical reload does not', async () => {
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

Deno.test('signed link route: a password change, a disabled account and a removed account each end the account’s links', async () => {
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

// --- an account API key's own links -----------------------------------------------------------------------------

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

Deno.test('signed link route: deleting an account key ends the links minted under it at the next follow, and only those', async () => {
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
			// No credential bound: a link bound to the owner alone — account-level.
			unbound: await f.link('api-key:admin:alice'),
		};
		// The key's public id rides as `k`; never its hash, the key or its prefix. The others carry no `k`.
		assertEquals([claimsOf(links.one).k, claimsOf(links.oneSignIn).k, claimsOf(links.two).k], [one.id, one.id, two.id]);
		assertEquals([claimsOf(links.password).k, claimsOf(links.unbound).k], [undefined, undefined]);
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

		// Revoked over the route, as the Users screen does it: the very next follow is a bare 401.
		const admin = await signIn({ username: 'root', password: rootPassword });
		assertEquals((await rest(f, 'DELETE', `/api/v1/users/alice/keys/${one.id}`, admin)).status, 204);
		const refused = await f.get(links.one);
		assertEquals(refused.status, 401);
		assertEquals((await refused.json()).detail, undefined, 'a bare 401');
		assertEquals(await statusOf(f, links.oneSignIn), 401, 'minted under a sign-in opened with the key');
		// The account's other key, its password sign-in and a link with no key binding are untouched.
		for (const name of ['two', 'password', 'unbound'] as const) assertEquals(await statusOf(f, links[name]), 200, name);

		// Disabling the account ends the rest; enabling it restores those still inside their life.
		assertEquals((await rest(f, 'PATCH', '/api/v1/users/alice', admin, { disabled: true })).status, 200);
		for (const name of ['two', 'password', 'unbound'] as const) assertEquals(await statusOf(f, links[name]), 401, name);
		assertEquals((await rest(f, 'PATCH', '/api/v1/users/alice', admin, { disabled: false })).status, 200);
		for (const name of ['two', 'password', 'unbound'] as const) assertEquals(await statusOf(f, links[name]), 200, name);
		assertEquals(await statusOf(f, links.one), 401, 'a revoked key stays revoked');

		// A password change ends every link of the account, a key's included; the key itself lives on and mints anew.
		assertEquals((await rest(f, 'POST', '/api/v1/users/alice/password', admin, {})).status, 200);
		for (const name of ['two', 'password', 'unbound'] as const) assertEquals(await statusOf(f, links[name]), 401, name);
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

// --- the tool's bound -------------------------------------------------------------------------------------------

Deno.test('signed link route: browser_file_link accepts ttl_seconds 3600 and refuses 3601 as invalid-arguments', async () => {
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
	assertStringIncludes(schema.properties?.ttl_seconds?.description ?? '', 'never outlives the credential');
});
