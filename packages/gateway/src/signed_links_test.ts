/**
 * Signed links (R10, design §2.7, D-119; AC9, AC10; v2 by containment-otel-links design §2.7, D-140, AC18–AC20): the
 * token codec, the configuration and key refusals, the owner re-check, and the public route — verify before anything
 * else, before any forward, a bare 401 for every token or owner failure, no query in any log line, and a HEAD that
 * releases its lease. Revocation by session incarnation, credential epoch and the OAuth expiry cap is
 * `signed_links_route_test.ts`'s.
 *
 * The browser is faked (a session with a real file under `tests/.scratch`), so this stays in the unit tier; the
 * browser tier drives the same route with a PDF a real Chromium printed (`tests/e2e/media_e2e_test.ts`).
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url';
import { fromFileUrl, join } from '@std/path';
import type { BrowserSession, DownloadRecord } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp, type GatewayApp } from './app.ts';
import { generateAdminUser } from './admin_auth.ts';
import { generateApiKey, principalFromAuthInfo, VerifierChain } from './auth.ts';
import type { Cluster } from './cluster.ts';
import { type Config, ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { LINK_KEY_FILE_NAME, resolveSecrets, SecretError } from './secrets.ts';
import { Database } from './database.ts';
import { generateDbKey } from './vault.ts';
import { startGateway } from './server.ts';
import {
	clampLinkTtl,
	createLinkMinter,
	createLinkSigner,
	LINK_PATH,
	LINK_TOKEN_PARAM,
	LINK_TTL_MAX_S,
	type LinkClaims,
	LinkMintError,
	type LinkSigner,
} from './signed_links.ts';
import { UserStore } from './users.ts';
import { ToolError } from '@tykotech/mcp';

const SCRATCH_ROOT = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));
const KEY_TEXT = 'k'.repeat(24) + '-link-signing-key-for-tests';
const KEY = new TextEncoder().encode(KEY_TEXT);
/** D-154: `loadConfig` options carrying a vault key, so a data directory can keep a generated link key. */
const VAULT = { secrets: { TTK_DB_KEY: generateDbKey() } };
const PUBLIC = new URL('https://gw.example.test/');

async function scratch(prefix: string): Promise<string> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
	return await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix });
}

/** A stand-in incarnation and credential digest, for the codec tests that need some value of each. */
const INC = 'incarnation1';
const DIGEST = 'stored-digest';
/** The fields a v2 mint needs beyond the session, file and owner. */
const BOUND = { incarnation: INC, digest: DIGEST } as const;

function tokenOf(url: string): string {
	return new URL(url).searchParams.get('t') ?? '';
}

/** The token's claims, read without verifying — what anyone holding the URL can see. */
function bodyOf(token: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(token.split('.')[1]!)));
}

// --- the codec ---------------------------------------------------------------------------------------------------

Deno.test('D-119: a link names the session, file and owner, is built from the public URL and verifies', async () => {
	let now = Date.UTC(2026, 9, 4, 12, 0, 0);
	const signer = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC, now: () => now });
	const link = await signer.mint({ sessionId: 'default', fileId: 'art-1', owner: 'api-key:e2e', ...BOUND });
	const url = new URL(link.url);
	assertEquals(url.origin + url.pathname, `https://gw.example.test${LINK_PATH}`);
	assertEquals([...url.searchParams.keys()], ['t']);
	assertEquals(link.ttlSeconds, 60);
	assertEquals(link.expiresAt, '2026-10-04T12:01:00.000Z');
	const token = tokenOf(link.url);
	assert(token.startsWith('v2.'));
	// Signed, not encrypted — identifiers and one keyed epoch: no field a credential could hide in (D-140).
	assertEquals(Object.keys(bodyOf(token)), ['s', 'i', 'f', 'o', 'e', 'exp', 'n']);
	assert(!token.includes(KEY_TEXT) && !JSON.stringify(bodyOf(token)).includes('ttk_'));
	const claims = await signer.verify(token) as LinkClaims;
	assertEquals([claims.s, claims.i, claims.f, claims.o, claims.exp], [
		'default',
		INC,
		'art-1',
		'api-key:e2e',
		now / 1000 + 60,
	]);
	assertEquals(claims.e.length, 22);
	assert(await signer.epochMatches(claims, DIGEST), 'the epoch is the owner’s under the digest it was minted with');
	assertEquals(await signer.epochMatches(claims, `${DIGEST}x`), false, 'and no other digest’s');
	// Two links for the same file in the same second differ.
	assertNotEquals(
		tokenOf((await signer.mint({ sessionId: 'default', fileId: 'art-1', owner: 'api-key:e2e', ...BOUND })).url),
		token,
	);
	// Expiry: valid one second before, refused at and after.
	now += 59_000;
	assert(await signer.verify(token) !== null);
	now += 1_000;
	assertEquals(await signer.verify(token), null);
});

Deno.test('D-119: a link edited to another file, signed by another key, or malformed is refused', async () => {
	const signer = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC });
	const token = tokenOf(
		(await signer.mint({ sessionId: 's', fileId: 'file-a', owner: 'api-key:e2e', ...BOUND })).url,
	);
	const [, body, mac] = token.split('.');
	for (const edit of [{ f: 'file-b' }, { i: 'incarnation2' }, { e: 'A'.repeat(22) }, { o: 'api-key:other' }]) {
		const edited = { ...bodyOf(token), ...edit };
		const forged = `v2.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(edited)))}.${mac}`;
		assertEquals(await signer.verify(forged), null, `a token edited to ${JSON.stringify(edit)}`);
	}
	const rotated = createLinkSigner({ key: new TextEncoder().encode('r'.repeat(40)), ttlS: 60, publicUrl: PUBLIC });
	assertEquals(await rotated.verify(token), null, 'a rotated link-signing key');
	for (const bad of ['', 'v2', 'v1.' + body + '.' + mac, `v2.${body}.`, `v2.${body}.${mac}x`, `v2.${body}!.${mac}`]) {
		assertEquals(await signer.verify(bad), null, JSON.stringify(bad));
	}
	assertEquals(await signer.verify(`v2.${'A'.repeat(3000)}.${mac}`), null, 'an over-long token');
	// The MAC's last character carries two unused bits: flipping the lowest decodes to the same 32 bytes, and is
	// still refused — a token has exactly one spelling.
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const last = mac!.at(-1)!;
	const sibling = `${mac!.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
	assertEquals(decodeBase64Url(sibling), decodeBase64Url(mac!), 'the two spellings carry one MAC');
	assertEquals(await signer.verify(`v2.${body}.${sibling}`), null);
	assert(await signer.verify(token) !== null);
});

// G5 (D-140): the ceiling moved from 300 s to 3600 s; the test moved with it.
Deno.test('D-119: a token whose expiry is beyond the 3600 s ceiling is refused even under the right key', async () => {
	let now = Date.UTC(2026, 9, 4);
	// A signer whose clock runs ahead mints exp = real now + 7200 s with the deployment's own key.
	const ahead = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC, now: () => now + 3_600_000 });
	const signer = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC, now: () => now });
	const token = tokenOf(
		(await ahead.mint({ sessionId: 's', fileId: 'f', owner: 'api-key:e2e', ttlSeconds: 3600, ...BOUND })).url,
	);
	assertEquals(await signer.verify(token), null);
	now += 3_600_001;
	assert(await signer.verify(token) !== null, 'inside the ceiling once the clocks agree');
});

Deno.test('R1-4: verify allows 30 s of clock skew on the ceiling, and not a second more; minting is unchanged', async () => {
	// The ruling's figure, written out rather than imported, so this test reads the same before and after the fix.
	const LINK_CLOCK_SKEW_S = 30;
	const now = Date.UTC(2026, 9, 4);
	const verifier = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC, now: () => now });
	const mintedBy = (aheadMs: number) =>
		createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC, now: () => now + aheadMs })
			.mint({ sessionId: 's', fileId: 'f', owner: 'api-key:e2e', ttlSeconds: 3600, ...BOUND });
	// The minting node runs ahead of the verifying one (the entry node and the owner peer both verify): a full-life
	// link from it is still honoured within the skew allowance…
	for (const ahead of [1_000, 2_000, LINK_CLOCK_SKEW_S * 1000]) {
		const minted = await mintedBy(ahead);
		assertEquals(minted.ttlSeconds, LINK_TTL_MAX_S, 'a link is still minted for at most 3600 s (G5)');
		assert(await verifier.verify(tokenOf(minted.url)) !== null, `refused a link minted ${ahead} ms ahead`);
	}
	// …and refused beyond it: the ceiling is 3600 s (G5) plus the allowance, never more.
	assertEquals(await verifier.verify(tokenOf((await mintedBy((LINK_CLOCK_SKEW_S + 1) * 1000)).url)), null);
});

Deno.test('AC19: verify accepts exp = now + 3630 and refuses now + 3631, and a v1 token under the right key', async () => {
	const now = Date.UTC(2026, 9, 5);
	const verifier = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC, now: () => now });
	const at = async (expOffsetS: number) => {
		// A minting clock running `expOffsetS - 3600` seconds ahead puts a full-life link's exp at now + expOffsetS.
		const minted = await createLinkSigner({
			key: KEY,
			ttlS: 3600,
			publicUrl: PUBLIC,
			now: () => now + (expOffsetS - 3600) * 1000,
		}).mint({ sessionId: 's', fileId: 'f', owner: 'api-key:e2e', ...BOUND });
		const token = tokenOf(minted.url);
		assertEquals(bodyOf(token).exp, now / 1000 + expOffsetS);
		return await verifier.verify(token);
	};
	assert(await at(3630) !== null, 'exp = now + 3600 + 30 is honoured');
	assertEquals(await at(3631), null, 'exp = now + 3631 is refused');

	// A v1 token whose MAC is genuine under this key (built by hand, as the v1 signer built it) is refused: the shape
	// is v2-only and the MAC context changed, so it cannot be relabelled as v2 either.
	const v1Claims = { s: 's', f: 'f', o: 'api-key:e2e', exp: now / 1000 + 60, n: 'AAAAAAAAAAA' };
	const v1Body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(v1Claims)));
	const hmac = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const v1Mac = encodeBase64Url(
		new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`ttk-link-v1\0${v1Body}`))),
	);
	assertEquals(await verifier.verify(`v1.${v1Body}.${v1Mac}`), null, 'v1 no longer verifies');
	assertEquals(await verifier.verify(`v2.${v1Body}.${v1Mac}`), null, 'nor relabelled as v2');
});

Deno.test('AC21 (F1): LinkSigner.mint caps at notAfter by itself, and refuses under 10 s left', async () => {
	const now = Date.UTC(2026, 9, 5, 12, 0, 0);
	const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC, now: () => now });
	const seconds = now / 1000;
	const request = { sessionId: 's', fileId: 'f', owner: 'oauth:sub', ...BOUND };
	const capped = await signer.mint({ ...request, notAfter: seconds + 120 });
	assertEquals([capped.ttlSeconds, capped.expiresAt], [120, new Date((seconds + 120) * 1000).toISOString()]);
	assertEquals(bodyOf(tokenOf(capped.url)).exp, seconds + 120);
	// A requested life shorter than the cap is kept; the cap never lengthens a link.
	assertEquals((await signer.mint({ ...request, ttlSeconds: 30, notAfter: seconds + 120 })).ttlSeconds, 30);
	// Exactly the floor is still a link; one second under it, an expired credential or a non-number is not.
	assertEquals((await signer.mint({ ...request, notAfter: seconds + 10 })).ttlSeconds, 10);
	for (const notAfter of [seconds + 9, seconds + 5, seconds - 1, Number.NaN]) {
		const refused = await assertRejects(() => signer.mint({ ...request, notAfter }), LinkMintError);
		assertEquals(refused.reason, 'credential-expiring');
	}
	// No notAfter (an API key, an account): the requested or default life, as before.
	assertEquals((await signer.mint({ ...request, owner: 'api-key:e2e' })).ttlSeconds, 3600);
});

Deno.test('AC20: the body carries no stored hash, salt or password hash — only a keyed 22-character epoch', async () => {
	const key = await generateApiKey('e2e', ['mcp:invoke']);
	const { record: admin } = await generateAdminUser('root');
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record]) }),
		allowAnonymous: false,
		users: new UserStore({ dataDir: null, seed: admin }),
	});
	const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC });
	const mint = createLinkMinter({ signer, bindingOf: (owner, credential) => verifier.linkBinding(owner, credential) });
	const stored = [key.record.sha256, admin.salt, admin.hash, `${admin.salt}.${admin.hash}.${admin.iterations}`];
	const epochs = new Set<string>();
	for (const owner of ['api-key:e2e', 'api-key:admin:root']) {
		const digest = verifier.ownerCredentialDigest(owner);
		assert(digest !== null, owner);
		const token = tokenOf((await mint({ sessionId: 's', fileId: 'f', owner, incarnation: INC })).url);
		const body = bodyOf(token);
		assertEquals(Object.keys(body), ['s', 'i', 'f', 'o', 'e', 'exp', 'n']);
		assert(/^[A-Za-z0-9_-]{22}$/.test(String(body.e)), String(body.e));
		epochs.add(String(body.e));
		const decoded = JSON.stringify(body);
		for (const value of stored) {
			assert(!token.includes(value) && !decoded.includes(value), 'no stored credential material in the token');
			for (const field of Object.values(body)) assertNotEquals(String(field), value);
		}
		// The epoch is keyed: it is not the SHA-256 of the digest, which anyone could compute to test a guess.
		const unkeyed = encodeBase64Url(
			new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digest))).slice(0, 16),
		);
		assertNotEquals(body.e, unkeyed);
	}
	assertEquals(epochs.size, 2, 'each owner has its own epoch');
});

Deno.test('D-148: a key-bound link carries the key’s public id as k, the MAC covers it, and a malformed k is refused', async () => {
	const signer = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC });
	const request = { sessionId: 's', fileId: 'f', owner: 'api-key:admin:alice', ...BOUND };
	const keyed = tokenOf((await signer.mint({ ...request, key: 'k_abcdefghij' })).url);
	assertEquals(Object.keys(bodyOf(keyed)), ['s', 'i', 'f', 'o', 'k', 'e', 'exp', 'n']);
	assertEquals((await signer.verify(keyed))?.k, 'k_abcdefghij');
	// No key: exactly D-140's claims, and no `k` on the verified claims either — a pre-D-148 link reads as it did.
	const plain = tokenOf((await signer.mint(request)).url);
	assertEquals(Object.keys(bodyOf(plain)), ['s', 'i', 'f', 'o', 'e', 'exp', 'n']);
	assertEquals('k' in (await signer.verify(plain) as LinkClaims), false);

	// The MAC covers `k`: adding one, changing it or dropping it is a forgery.
	const macOf = (token: string): string => token.split('.')[2]!;
	const reforge = (token: string, claims: Record<string, unknown>): string =>
		`v2.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.${macOf(token)}`;
	const { k: _k, ...dropped } = bodyOf(keyed);
	for (
		const [what, forged] of [
			['k added', reforge(plain, { ...bodyOf(plain), k: 'k_abcdefghij' })],
			['k changed', reforge(keyed, { ...bodyOf(keyed), k: 'k_otherkey00' })],
			['k dropped', reforge(keyed, dropped)],
		] as const
	) {
		assertEquals(await signer.verify(forged), null, what);
	}

	// Strict: a genuine MAC over a malformed `k` (what only a minting bug or a stolen link key could sign) is refused.
	const hmac = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signed = async (claims: Record<string, unknown>): Promise<string> => {
		const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
		const mac = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`ttk-link-v2\0${body}`));
		return `v2.${body}.${encodeBase64Url(new Uint8Array(mac))}`;
	};
	assertEquals((await signer.verify(await signed(bodyOf(keyed))))?.k, 'k_abcdefghij', 'the hand-signed copy verifies');
	for (const k of ['', 'has/slash', 'k'.repeat(65), 7, null, ['k_abcdefghij']]) {
		assertEquals(await signer.verify(await signed({ ...bodyOf(keyed), k })), null, JSON.stringify(k));
	}

	// Budget: the longest identifiers verify accepts, with the longest key id, still fit TOKEN_SHAPE and 2048.
	const longest = tokenOf(
		(await signer.mint({
			sessionId: 's'.repeat(256),
			fileId: 'f'.repeat(128),
			owner: 'api-key:admin:' + 'a'.repeat(498),
			incarnation: 'i'.repeat(32),
			digest: DIGEST,
			key: 'k'.repeat(64),
		})).url,
	);
	assert(longest.length <= 2048 && longest.split('.')[1]!.length <= 1800, String(longest.length));
	assertEquals((await signer.verify(longest))?.k, 'k'.repeat(64));
});

Deno.test('BUG-2 / D-140: mint refuses a token verify would refuse — the owner bound at 512, and the body bound', async () => {
	// verify() rejects o > 512 characters and a body > 1800; mint() used to check neither, so an OAuth subject of 507+
	// characters got a successful browser_file_link whose link answered 401 on every follow (review BUG-2).
	const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC });
	const request = (owner: string) => ({ sessionId: 's', fileId: 'f', owner, incarnation: INC, digest: 'digest' });
	const at512 = 'oauth:' + 'a'.repeat(506);
	assertEquals(at512.length, 512);
	const minted = await signer.mint(request(at512));
	const token = new URL(minted.url).searchParams.get(LINK_TOKEN_PARAM) ?? '';
	assertEquals((await signer.verify(token))?.o, at512, 'an owner of 512 characters mints a link that verifies');
	const at513 = at512 + 'a';
	const refused = await assertRejects(() => signer.mint(request(at513)), LinkMintError);
	assertEquals(refused.reason, 'too-long');
	// Within 512 characters but past the 1800-character body: a multi-byte owner (506 × U+20AC is 1518 UTF-8 bytes, so
	// the base64url body runs past 1800 characters).
	const wide = 'oauth:' + '€'.repeat(506);
	assertEquals(wide.length, 512);
	assertEquals((await assertRejects(() => signer.mint(request(wide)), LinkMintError)).reason, 'too-long');
	// Through the minter the refusal is a result-level ToolError naming the cause, never a link that cannot work.
	const mint = createLinkMinter({ signer, bindingOf: () => ({ digest: 'digest' }) });
	const viaTool = await assertRejects(
		() =>
			mint({
				sessionId: 's',
				fileId: 'f',
				owner: at513,
				incarnation: INC,
				notAfter: Math.floor(Date.now() / 1000) + 600,
			}),
		ToolError,
	);
	assertEquals(viaTool.code, 'invalid-arguments');
	assertStringIncludes(viaTool.message, 'too long for a signed link');
});

Deno.test('SEC-2 / D-140: a delegated MCP bearer reaches the tools with its own expiry and the delegated mark', async () => {
	// The producer half of the cap `credentialNotAfterOf` applies (packages/mcp): the bearer gate must hand a `ttkd_`
	// bearer's tools both `delegatedMcp: true` and an `expiresAt` no later than the delegation, or the cap reads nothing.
	const parent = await generateApiKey('parent', ['mcp:invoke', 'agent:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([parent.record]) }),
		allowAnonymous: false,
	});
	// The task's own credential, as GW-1 binds it: verifying the parent key registers the owner's authority.
	const principal = principalFromAuthInfo(await verifier.verifyAccessToken(parent.key));
	const before = Math.floor(Date.now() / 1000);
	const delegated = await verifier.delegateMcp('api-key:parent', new Set(['mcp:invoke']), principal.credential);
	assert(delegated !== null);
	try {
		const authInfo = await verifier.verifyAccessToken(delegated.token);
		assertEquals(authInfo.extra?.delegatedMcp, true);
		assertEquals(
			authInfo.extra?.credential,
			principal.credential,
			'the delegator credential, which has no expiry of its own',
		);
		assert(typeof authInfo.expiresAt === 'number' && Number.isFinite(authInfo.expiresAt));
		assert(
			authInfo.expiresAt > before && authInfo.expiresAt <= before + 121,
			`expiresAt ${authInfo.expiresAt - before} s out`,
		);
		// A link minted under that notAfter lives no longer than the delegation.
		const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC });
		const minted = await signer.mint({
			sessionId: 's',
			fileId: 'f',
			owner: 'api-key:parent',
			digest: 'digest',
			incarnation: INC,
			notAfter: authInfo.expiresAt,
		});
		assert(minted.ttlSeconds <= 121, `link ttl ${minted.ttlSeconds}`);
	} finally {
		delegated.close();
	}
});

Deno.test('N3 / D-140: the minter refuses an unbound link as scope-required, never minting one', async () => {
	const key = await generateApiKey('e2e', ['mcp:invoke']);
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record]), TTK_OAUTH_ISSUER: 'https://issuer.example.test' }),
		allowAnonymous: false,
	});
	let minted = 0;
	const signer = createLinkSigner({ key: KEY, ttlS: 3600, publicUrl: PUBLIC });
	const counting: LinkSigner = {
		...signer,
		mint: (input) => {
			minted += 1;
			return signer.mint(input);
		},
	};
	const mint = createLinkMinter({
		signer: counting,
		bindingOf: (owner, credential) => verifier.linkBinding(owner, credential),
	});
	const seconds = Math.floor(Date.now() / 1000);
	const base = { sessionId: 's', fileId: 'f', incarnation: INC };
	const refusals: Array<[string, Parameters<typeof mint>[0], string]> = [
		['no incarnation', { sessionId: 's', fileId: 'f', owner: 'api-key:e2e' }, 'no longer in force'],
		['N3: an OAuth owner with no notAfter', { ...base, owner: 'oauth:sub' }, 'no known expiry'],
		['a removed key', { ...base, owner: 'api-key:ghost' }, 'no longer in force'],
		['an unknown realm', { ...base, owner: 'user:x' }, 'no longer in force'],
	];
	for (const [what, input, text] of refusals) {
		const refused = await assertRejects(() => mint(input), ToolError, undefined, what);
		assertEquals(refused.code, 'scope-required', what);
		assertStringIncludes(refused.message, text, what);
	}
	assertEquals(minted, 0, 'nothing reached the signer');
	// Under 10 s left: the signer's own refusal, turned into the same result-level code.
	const expiring = await assertRejects(() => mint({ ...base, owner: 'oauth:sub', notAfter: seconds + 5 }), ToolError);
	assertEquals(expiring.code, 'scope-required');
	assertStringIncludes(expiring.message, 'expires within 10 s; refresh it and mint again');
	// With an expiry, an OAuth owner mints, capped by it.
	const ok = await mint({ ...base, owner: 'oauth:sub', notAfter: seconds + 600 });
	assert(ok.ttlSeconds <= 600 && ok.ttlSeconds >= 599, String(ok.ttlSeconds));
});

Deno.test('D-119: a requested life is clamped to 10..3600 s, and a short key is refused', () => {
	// G5 (D-140): the ceiling is 3600 s, so the over-long request is 5000 rather than 1000.
	assertEquals([clampLinkTtl(undefined, 60), clampLinkTtl(5, 60), clampLinkTtl(5000, 60), clampLinkTtl(42.9, 60)], [
		60,
		10,
		LINK_TTL_MAX_S,
		42,
	]);
	assertThrows(() => createLinkSigner({ key: new Uint8Array(31), ttlS: 60, publicUrl: PUBLIC }), Error, '32 bytes');
});

// --- configuration and key (AC10) --------------------------------------------------------------------------------

Deno.test('AC10: TTK_SIGNED_LINK* parse, and refuse every explicit combination with no lasting key', () => {
	for (const name of ['TTK_SIGNED_LINKS', 'TTK_SIGNED_LINK_TTL_S', 'TTK_SIGNED_LINK_KEY_FILE']) {
		assert((ENV_NAMES as readonly string[]).includes(name), `${name} is read from the process`);
	}
	// G5 (D-140): the deployment default is the signer's, 3600 s. D-154: a generated key needs the vault's key too.
	assertEquals(loadConfig({ TTK_SIGNED_LINKS: 'true', TTK_DATA_DIR: '/data' }, VAULT).signedLinks, {
		ttlS: 3600,
		key: null,
		defaulted: false,
	});
	assertEquals(
		loadConfig({ TTK_SIGNED_LINKS: 'on', TTK_SIGNED_LINK_TTL_S: '120' }, { secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } })
			.signedLinks,
		{ ttlS: 120, key: KEY_TEXT, defaulted: false },
	);
	// An explicit off is off whatever key could be had.
	assertEquals(loadConfig({ TTK_SIGNED_LINKS: 'false', TTK_DATA_DIR: '/data' }).signedLinks, null);
	assertEquals(
		loadConfig({ TTK_SIGNED_LINKS: 'off' }, { secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } }).signedLinks,
		null,
	);
	assertThrows(() => loadConfig({ TTK_SIGNED_LINKS: 'true' }), ConfigError, 'TTK_SIGNED_LINKS: signed links need');
	assertThrows(
		() => loadConfig({ TTK_SIGNED_LINKS: 'true', TTK_DATA_DIR: '/data' }),
		ConfigError,
		'TTK_DATA_DIR with TTK_DB_KEY_FILE',
	);
	assertThrows(
		() => loadConfig({ TTK_SIGNED_LINKS: 'true', TTK_DATA_DIR: '/data', TTK_CLUSTER_KV: '/kv/db' }),
		ConfigError,
		'TTK_SIGNED_LINK_KEY_FILE to one key all nodes share',
	);
	// A key file makes a cluster acceptable.
	loadConfig({ TTK_SIGNED_LINKS: 'true', TTK_CLUSTER_KV: '/kv/db' }, { secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } });
	assertThrows(
		() => loadConfig({ TTK_DATA_DIR: '/data' }, { secrets: { TTK_SIGNED_LINK_KEY: 'short' } }),
		ConfigError,
		'TTK_SIGNED_LINK_KEY_FILE: the key is shorter than 32 characters',
	);
	for (const ttl of ['9', '3601', 'soon']) {
		assertThrows(() => loadConfig({ TTK_SIGNED_LINK_TTL_S: ttl }), ConfigError, 'TTK_SIGNED_LINK_TTL_S');
	}
	assertThrows(() => loadConfig({ TTK_SIGNED_LINKS: 'maybe' }), ConfigError, 'TTK_SIGNED_LINKS');
});

Deno.test('D-150: TTK_SIGNED_LINKS unset is on wherever a signing key can be had, and off with a note elsewhere', () => {
	// A data directory with a vault key on a single node: the generated key, sealed (D-154).
	const generated = loadConfig({ TTK_DATA_DIR: '/data' }, VAULT);
	assertEquals(generated.signedLinks, { ttlS: 3600, key: null, defaulted: true });
	assertEquals(generated.featureNotes.filter((note) => note.includes('TTK_SIGNED_LINKS')), []);
	// A key file: on, with or without a data directory, clustered or not.
	assertEquals(loadConfig({}, { secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } }).signedLinks, {
		ttlS: 3600,
		key: KEY_TEXT,
		defaulted: true,
	});
	assertEquals(
		loadConfig({ TTK_CLUSTER_KV: '/kv/db', TTK_DATA_DIR: '/data' }, { secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } })
			.signedLinks?.key,
		KEY_TEXT,
	);
	// Neither: off, silently but for one note naming the variable and both ways to give it a key.
	const keyless = loadConfig({});
	assertEquals(keyless.signedLinks, null);
	const [note] = keyless.featureNotes.filter((line) => line.includes('TTK_SIGNED_LINKS'));
	assertStringIncludes(note ?? '', 'TTK_SIGNED_LINKS is unset and stays off');
	assertStringIncludes(note ?? '', 'TTK_SIGNED_LINK_KEY_FILE, or TTK_DATA_DIR with TTK_DB_KEY_FILE');
	// A data directory without a vault key: nowhere encrypted to keep a generated key, so off with the same note.
	assertEquals(loadConfig({ TTK_DATA_DIR: '/data' }).signedLinks, null);
	// A cluster with only a data directory: a generated key would be one node's, so off, and the note says why.
	const clustered = loadConfig({ TTK_CLUSTER_KV: '/kv/db', TTK_DATA_DIR: '/data' });
	assertEquals(clustered.signedLinks, null);
	assert(
		clustered.featureNotes.some((line) => line.includes('TTK_SIGNED_LINKS') && line.includes('all nodes share')),
		clustered.featureNotes.join(' | '),
	);
	// An empty value is unset, as for every boolean here.
	assertEquals(loadConfig({ TTK_SIGNED_LINKS: ' ', TTK_DATA_DIR: '/data' }, VAULT).signedLinks?.defaulted, true);
});

Deno.test('AC10: the key file is file-only, read by resolveSecrets, and an unreadable one names the path only', async () => {
	const read = (path: string) =>
		path === '/run/secrets/link'
			? Promise.resolve(`${KEY_TEXT}\n`)
			: Promise.reject(path === '/nope' ? new Error('denied') : new Deno.errors.NotFound(path));
	const resolved = await resolveSecrets({ env: { TTK_SIGNED_LINK_KEY_FILE: '/run/secrets/link' }, readFile: read });
	assertEquals(resolved.TTK_SIGNED_LINK_KEY, KEY_TEXT);
	const refused = await assertRejects(
		() => resolveSecrets({ env: { TTK_SIGNED_LINK_KEY_FILE: '/nope' }, readFile: read }),
		SecretError,
	);
	assertStringIncludes(refused.message, 'TTK_SIGNED_LINK_KEY_FILE (/nope)');
	// There is no inline form for an environment to carry.
	assertEquals(
		(await resolveSecrets({ env: { TTK_SIGNED_LINK_KEY: KEY_TEXT }, readFile: read })).TTK_SIGNED_LINK_KEY,
		undefined,
	);
});

// D-154: the generated key's life (sealed in the vault, reused, a plaintext file from an earlier release moved in and
// deleted, refused without a vault) is proven in database_test.ts.

// --- the owner re-check --------------------------------------------------------------------------------------------

Deno.test('D-119: ownerScopes answers from the live key set, the account store, OAuth and anonymous rules', async () => {
	const key = await generateApiKey('e2e', ['mcp:invoke', 'view:watch']);
	const other = await generateApiKey('other');
	const verifier = new VerifierChain({
		config: loadConfig({ TTK_API_KEYS: JSON.stringify([key.record, other.record]) }),
		allowAnonymous: false,
	});
	assertEquals([...verifier.ownerScopes('api-key:e2e')!].sort(), ['mcp:invoke', 'view:watch']);
	assert(verifier.ownerScopes('api-key:other')!.has('mcp:invoke'), 'a record naming no scopes holds the default grant');
	assertEquals(verifier.ownerScopes('api-key:nobody'), null);
	assertEquals(verifier.ownerScopes('oauth:subject'), null, 'no OAuth configured, no OAuth owner');
	assertEquals(verifier.ownerScopes('anonymous-loopback:local'), null, 'credentialed: no anonymous owner');
	assertEquals(verifier.ownerScopes('something-else'), null);
	verifier.replaceApiKeys([other.record]);
	assertEquals(verifier.ownerScopes('api-key:e2e'), null, 'a removed key ends its links');

	const oauth = new VerifierChain({
		config: loadConfig({ TTK_OAUTH_ISSUER: 'https://issuer.example.test' }),
		allowAnonymous: false,
	});
	assertEquals([...oauth.ownerScopes('oauth:subject')!], ['mcp:invoke'], 'OAuth: mcp:invoke and nothing more');
	assertEquals(oauth.ownerScopes('oauth:'), null);

	const anonymous = new VerifierChain({ config: loadConfig({}), allowAnonymous: true });
	assert(anonymous.ownerScopes('anonymous-loopback:local')!.has('mcp:invoke'));
});

// --- the route ----------------------------------------------------------------------------------------------------

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'signed-links' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

function ledgerRecord(dir: string, guid: string, name: string, size: number): DownloadRecord {
	return {
		guid,
		url: 'http://127.0.0.1:1/export?token=secret',
		suggestedFilename: name,
		fileName: name,
		path: join(dir, guid),
		fileSize: size,
		receivedBytes: size,
		totalBytes: size,
		fileType: 'txt',
		mimeType: null,
		autoDownload: false,
		state: 'completed',
		startedAt: 1,
		completedAt: 2,
		error: null,
	};
}

const PAYLOAD = new Uint8Array(70_000).map((_, i) => (i * 13) % 256);

interface RouteFixture extends AsyncDisposable {
	readonly gateway: GatewayApp;
	readonly registry: SessionRegistry;
	readonly verifier: VerifierChain;
	readonly signer: LinkSigner;
	readonly logs: string[];
	readonly keys: {
		e2e: Awaited<ReturnType<typeof generateApiKey>>;
		viewer: Awaited<ReturnType<typeof generateApiKey>>;
	};
	readonly owners: string[];
	get(token: string, init?: RequestInit): Promise<Response>;
	link(owner?: string, fileId?: string, sessionId?: string): Promise<string>;
}

async function routeFixture(
	env: Record<string, string> = {},
	options: { cluster?: Cluster; allowAnonymous?: boolean } = {},
): Promise<RouteFixture> {
	const dir = await scratch('link-route-');
	await Deno.writeFile(join(dir, 'G1'), PAYLOAD);
	const records = [ledgerRecord(dir, 'G1', 'report.txt', PAYLOAD.length)];
	const ledger = {
		downloads: records,
		isRemoteBrowser: false,
		lookup: (g: string) => records.find((r) => r.guid === g),
	};
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session: fakeSession(), downloads: ledger as never, downloadsDir: dir }),
	});
	await registry.resolve(undefined);
	const e2e = await generateApiKey('e2e', ['mcp:invoke']);
	const viewer = await generateApiKey('viewer', ['view:watch']);
	const config: Config = loadConfig(
		{
			TTK_HOST: '127.0.0.1',
			TTK_API_KEYS: JSON.stringify([e2e.record, viewer.record]),
			TTK_SIGNED_LINKS: 'true',
			TTK_PUBLIC_URL: 'http://127.0.0.1:8787/',
			TTK_RATE_RPM: '100000',
			...env,
		},
		{ secrets: { TTK_SIGNED_LINK_KEY: KEY_TEXT } },
	);
	const logs: string[] = [];
	const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
	const verifier = new VerifierChain({ config, allowAnonymous: options.allowAnonymous ?? false, logger });
	const gateway = createGatewayApp({
		config,
		registry,
		verifier,
		logger,
		version: 'test',
		...(options.cluster === undefined ? {} : { cluster: options.cluster }),
	});
	const signer = createLinkSigner({ key: KEY, ttlS: 60, publicUrl: config.publicUrl });
	const owners: string[] = [];
	return {
		gateway,
		registry,
		verifier,
		signer,
		logs,
		keys: { e2e, viewer },
		owners,
		get: async (token, init = {}) => {
			// What a browser following the link sends: a Host the allowlist knows, no Origin, no credential.
			const headers = new Headers(init.headers);
			headers.set('host', '127.0.0.1:8787');
			const url = `http://127.0.0.1:8787${LINK_PATH}?t=${encodeURIComponent(token)}`;
			return await gateway.app.fetch(new Request(url, { ...init, headers }));
		},
		// D-140: bound like the gateway's own minter binds — the session's incarnation and the owner's credential digest.
		// An owner or session that no longer has one gets a stand-in, so the route's refusal is what is under test.
		link: async (owner = 'api-key:e2e', fileId = 'G1', sessionId = 'default') =>
			tokenOf(
				(await signer.mint({
					sessionId,
					fileId,
					owner,
					incarnation: registry.peek(sessionId)?.incarnation ?? INC,
					digest: verifier.ownerCredentialDigest(owner) ?? DIGEST,
				})).url,
			),
		async [Symbol.asyncDispose]() {
			await gateway.close();
			await registry.shutdown();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

function assertLinkHeaders(response: Response): void {
	assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
	assertEquals(response.headers.get('cache-control'), 'no-store');
	assertEquals(response.headers.get('access-control-allow-origin'), null, 'no CORS on a public route either');
}

Deno.test('AC9: a valid link downloads with no bearer — GET, HEAD and Range — under no-referrer and no-store', async () => {
	await using f = await routeFixture();
	const token = await f.link();
	const response = await f.get(token);
	assertEquals(response.status, 200);
	assertLinkHeaders(response);
	assertStringIncludes(response.headers.get('content-disposition') ?? '', 'attachment; filename="report.txt"');
	assertEquals(new Uint8Array(await response.arrayBuffer()), PAYLOAD);

	const record = f.registry.peek('default')!;
	const head = await f.get(token, { method: 'HEAD' });
	assertEquals(head.status, 200);
	assertEquals(head.headers.get('content-length'), String(PAYLOAD.length));
	assertLinkHeaders(head);
	assertEquals(head.body, null);
	assertEquals(record.files.openReads, 0, 'a HEAD releases the lease it took');

	const ranged = await f.get(token, { headers: { range: 'bytes=10-19' } });
	assertEquals(ranged.status, 206);
	assertEquals(ranged.headers.get('content-range'), `bytes 10-19/${PAYLOAD.length}`);
	assertEquals(new Uint8Array(await ranged.arrayBuffer()), PAYLOAD.slice(10, 20));
	assertLinkHeaders(ranged);
});

Deno.test('K-2: a HEAD on the bearer file route releases the lease it took, like the link route', async () => {
	await using f = await routeFixture();
	const record = f.registry.peek('default')!;
	const request = (method: string) =>
		f.gateway.app.fetch(
			new Request('http://127.0.0.1:8787/api/v1/sessions/default/files/G1', {
				method,
				headers: { host: '127.0.0.1:8787', authorization: `Bearer ${f.keys.e2e.key}` },
			}),
		);
	const head = await request('HEAD');
	assertEquals(head.status, 200);
	assertEquals(head.headers.get('content-length'), String(PAYLOAD.length));
	assertEquals(head.body, null);
	// Nobody reads a HEAD body, so a lease left open here was held until the session closed.
	assertEquals(record.files.openReads, 0, 'a HEAD releases the lease it took');
	const get = await request('GET');
	assertEquals(new Uint8Array(await get.arrayBuffer()), PAYLOAD, 'GET is unchanged');
	assertEquals(record.files.openReads, 0);
});

Deno.test('R1-6: a link the owner node serves does not name that node on the public route', async () => {
	// A stand-in owner node on an ephemeral loopback port: what it answers is passed back, minus who it is.
	await using owner = Deno.serve(
		{ hostname: '127.0.0.1', port: 0, onListen: () => {} },
		() => new Response('bytes from node-b', { headers: { 'content-type': 'text/plain' } }),
	);
	const cluster = {
		self: { id: 'node-a', url: 'http://127.0.0.1:1', role: 'all' },
		ownerOf: () => Promise.resolve({ id: 'node-b', url: `http://127.0.0.1:${owner.addr.port}`, role: 'all' }),
		adopt: () => Promise.resolve(),
		release: () => Promise.resolve(),
	} as unknown as Cluster;
	await using f = await routeFixture({ TTK_CLUSTER_KV: '/kv/never-opened' }, { cluster });
	const response = await f.get(await f.link());
	assertEquals(response.status, 200);
	assertEquals(await response.text(), 'bytes from node-b', 'the forward happened');
	assertEquals(response.headers.get('x-ttk-served-by'), null, 'a public route names no node');
});

Deno.test('AC9: every token or owner failure is the same bare 401, and a missing file a 404', async () => {
	await using f = await routeFixture();
	const valid = await f.link();
	const [, , mac] = valid.split('.');
	const bound = {
		incarnation: f.registry.peek('default')!.incarnation,
		digest: f.verifier.ownerCredentialDigest('api-key:e2e')!,
	};
	const editedToFileB = `v2.${
		encodeBase64Url(new TextEncoder().encode(JSON.stringify({ ...bodyOf(valid), f: 'G2' })))
	}.${mac}`;
	const expired = tokenOf(
		(await createLinkSigner({ key: KEY, ttlS: 60, publicUrl: PUBLIC, now: () => Date.now() - 400_000 })
			.mint({ sessionId: 'default', fileId: 'G1', owner: 'api-key:e2e', ...bound })).url,
	);
	const rotated = tokenOf(
		(await createLinkSigner({ key: new TextEncoder().encode('z'.repeat(48)), ttlS: 60, publicUrl: PUBLIC })
			.mint({ sessionId: 'default', fileId: 'G1', owner: 'api-key:e2e', ...bound })).url,
	);
	// D-140: a link the right key signed for the right owner, under a credential the owner no longer holds.
	const staleEpoch = tokenOf(
		(await f.signer.mint({
			sessionId: 'default',
			fileId: 'G1',
			owner: 'api-key:e2e',
			incarnation: bound.incarnation,
			digest: 'a-previous-key-hash',
		})).url,
	);
	const cases: Array<[string, string]> = [
		['no token', ''],
		['garbage', 'v2.abc.def'],
		['a v1 token', `v1.${valid.split('.')[1]}.${mac}`],
		['edited to file B', editedToFileB],
		['expired', expired],
		['rotated link-signing key', rotated],
		['an owner that never existed', await f.link('api-key:ghost')],
		['an owner without mcp:invoke', await f.link('api-key:viewer')],
		['an OAuth owner with no OAuth configured', await f.link('oauth:subject')],
		['a stale credential epoch (D-140)', staleEpoch],
	];
	const bodies = new Set<string>();
	for (const [what, token] of cases) {
		const response = await f.get(token);
		assertEquals(response.status, 401, what);
		assertLinkHeaders(response);
		const body = await response.json();
		assertEquals(body.detail, undefined, `${what}: no reason is given`);
		bodies.add(`${body.type}|${body.title}`);
	}
	assertEquals(bodies.size, 1, 'every refusal looks the same');
	// A removed owner (its key record deleted from the live set) ends a link minted while it held.
	const before = await f.get(valid);
	assertEquals(before.status, 200);
	await before.body?.cancel();
	f.verifier.replaceApiKeys([f.keys.viewer.record]);
	assertEquals((await f.get(valid)).status, 401);

	await using g = await routeFixture();
	const missingFile = await g.get(await g.link('api-key:e2e', 'G9'));
	assertEquals(missingFile.status, 404);
	assertLinkHeaders(missingFile);
	assertStringIncludes((await missingFile.json()).type, 'not-found');
	const missingSession = await g.get(await g.link('api-key:e2e', 'G1', 'nobody'));
	assertEquals(missingSession.status, 404);
	await missingSession.body?.cancel();
});

Deno.test('AC9: an OAuth-minted link carries mcp:invoke only; an anonymous one holds only while anonymous is allowed', async () => {
	await using oauth = await routeFixture({ TTK_OAUTH_ISSUER: 'https://issuer.example.test' });
	const served = await oauth.get(await oauth.link('oauth:subject'));
	assertEquals(served.status, 200);
	await served.body?.cancel();
	assertEquals([...oauth.verifier.ownerScopes('oauth:subject')!], ['mcp:invoke']);

	await using anonymous = await routeFixture({ TTK_API_KEYS: '[]' }, { allowAnonymous: true });
	const anon = await anonymous.get(await anonymous.link('anonymous-loopback:local'));
	assertEquals(anon.status, 200);
	await anon.body?.cancel();
});

Deno.test('AC9: tokens are verified before any forward, and an unreachable owner node is a causeless 503', async () => {
	const asked: string[] = [];
	const cluster = {
		self: { id: 'node-a', url: 'http://127.0.0.1:1', role: 'all' },
		ownerOf: (sessionId: string) => {
			asked.push(sessionId);
			// Port 9 on loopback: nothing listens, so the forward fails at connect.
			return Promise.resolve({ id: 'node-b', url: 'http://127.0.0.1:9', role: 'all' });
		},
		adopt: () => Promise.resolve(),
		release: () => Promise.resolve(),
	} as unknown as Cluster;
	await using f = await routeFixture({ TTK_CLUSTER_KV: '/kv/never-opened' }, { cluster });
	// One character of the MAC changed, away from its last (which carries unused bits).
	const valid = await f.link();
	const at = valid.length - 5;
	const forged = `${valid.slice(0, at)}${valid[at] === 'A' ? 'B' : 'A'}${valid.slice(at + 1)}`;
	assertEquals((await f.get(forged)).status, 401);
	assertEquals((await f.get(await f.link('api-key:ghost'))).status, 401);
	assertEquals(asked, [], 'an unverified token or a revoked owner never costs a hop');

	const response = await f.get(await f.link());
	assertEquals(response.status, 503);
	assertLinkHeaders(response);
	const text = await response.text();
	assertEquals(JSON.parse(text).detail, undefined);
	for (const leak of ['127.0.0.1:9', 'node-b', 'refused', 'connect', 'os error']) {
		assert(!text.toLowerCase().includes(leak.toLowerCase()), `the 503 says nothing about ${leak}: ${text}`);
	}
	assertEquals(asked, ['default']);
});

Deno.test('AC9: the link is charged to its owner’s own budget', async () => {
	await using f = await routeFixture({ TTK_RATE_RPM: '3' });
	const token = await f.link();
	const first = await f.get(token);
	assertEquals(first.status, 200);
	await first.body?.cancel();
	const second = await f.get(token);
	assertEquals(second.status, 429);
	assertLinkHeaders(second);
	assert(second.headers.get('retry-after') !== null);
	await second.body?.cancel();
});

Deno.test('AC9: no log line carries the link, its token or its query — whatever the outcome', async () => {
	await using f = await routeFixture();
	const tokens = [await f.link(), await f.link('api-key:ghost'), 'v2.not.valid', await f.link('api-key:e2e', 'G9')];
	for (const token of tokens) {
		const response = await f.get(token);
		await response.body?.cancel();
	}
	const all = f.logs.join('\n');
	for (const token of tokens) {
		assert(!all.includes(token), 'the token is a credential for its life');
		assert(!all.includes(encodeURIComponent(token)));
	}
	assert(!all.includes('?t='), all);
});

Deno.test('AC9: with links off the route is not public and browser_file_link is absent, naming the switch', async () => {
	const dir = await scratch('link-off-');
	const scoped = await generateApiKey('off', ['mcp:invoke']);
	const gateway = await startGateway({
		config: loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '0', TTK_API_KEYS: JSON.stringify([scoped.record]) }),
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve({ session: fakeSession(), downloads: null, downloadsDir: dir }),
	});
	const client = new Client({ name: 'links-off', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
				fetch: (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('Authorization', `Bearer ${scoped.key}`);
					return fetch(input, { ...init, headers });
				},
			}),
		);
		const { tools } = await client.listTools();
		assert(!tools.some((tool) => tool.name === 'browser_file_link'));
		const refused = await client.callTool({ name: 'browser_file_link', arguments: { file_id: 'x' } }) as {
			isError?: boolean;
			content: Array<{ text?: string }>;
			structuredContent?: { error?: { code?: string; feature?: string } };
		};
		assertEquals(refused.isError, true);
		assertStringIncludes(refused.content[0]?.text ?? '', 'Error: feature-unavailable:');
		assertStringIncludes(refused.content[0]?.text ?? '', 'TTK_SIGNED_LINKS');
		assertEquals(refused.structuredContent?.error?.feature, undefined, 'a switch, not a missing capability');
		const anonymous = await fetch(`${gateway.url}${LINK_PATH}?t=v2.a.b`);
		assertEquals(anonymous.status, 401, 'off, the path is behind the bearer gate like any other');
		await anonymous.body?.cancel();
	} finally {
		await client.close();
		await gateway.shutdown();
		await gateway.finished;
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('AC9: with links on, a link minted over MCP downloads the file with no bearer', async () => {
	const dir = await scratch('link-on-');
	const data = await scratch('link-on-data-');
	const scoped = await generateApiKey('on', ['mcp:invoke']);
	const gateway = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: JSON.stringify([scoped.record]),
			TTK_SIGNED_LINKS: 'true',
			TTK_DATA_DIR: data,
			// D-150: `owner` is the default; the session is created below with no caller, so it is shared here.
			TTK_SESSION_OWNERSHIP: 'shared',
			// D-154: a generated key is sealed in the database's vault, which needs its own key.
		}, { secrets: { TTK_DB_KEY: generateDbKey() } }),
		version: 'test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve({ session: fakeSession(), downloads: null, downloadsDir: dir }),
	});
	const client = new Client({ name: 'links-on', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	try {
		// The key was generated at startup (no key file was named) and sealed in the vault — no plaintext file.
		assertEquals(Database.inspect(data)?.secrets, 1);
		await assertRejects(() => Deno.stat(join(data, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
		const record = await gateway.registry.resolve(undefined);
		const art = await record.files.addArtifact({
			name: 'page.pdf',
			mimeType: 'application/pdf',
			bytes: new TextEncoder().encode('%PDF-1.7 via link'),
		});
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
				fetch: (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('Authorization', `Bearer ${scoped.key}`);
					return fetch(input, { ...init, headers });
				},
			}),
		);
		const { tools } = await client.listTools();
		const tool = tools.find((entry) => entry.name === 'browser_file_link');
		assert(tool !== undefined, 'on, the tool is listed');
		assertEquals(tool.annotations, { readOnlyHint: true, openWorldHint: false });
		const minted = await client.callTool({
			name: 'browser_file_link',
			arguments: { file_id: art.file_id, ttl_seconds: 30 },
		}) as { isError?: boolean; structuredContent?: { url: string; ttl_seconds: number; expires_at: string } };
		assertEquals(minted.isError, undefined);
		assertEquals(minted.structuredContent?.ttl_seconds, 30);
		const url = new URL(minted.structuredContent!.url);
		assertEquals(url.pathname, LINK_PATH);
		assertEquals(bodyOf(url.searchParams.get('t')!).o, 'api-key:on', 'bound to the realm-qualified owner');
		const response = await fetch(`${gateway.url}${url.pathname}${url.search}`);
		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'application/pdf');
		assertEquals(await response.text(), '%PDF-1.7 via link');
	} finally {
		await client.close();
		await gateway.shutdown();
		await gateway.finished;
		await Deno.remove(dir, { recursive: true }).catch(() => {});
		await Deno.remove(data, { recursive: true }).catch(() => {});
	}
});

/** `tools/list` over the gateway's own `/mcp`, as the names a key sees. */
async function listedNames(url: string, key: string): Promise<string[]> {
	const response = await fetch(`${url}/mcp`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${key}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	const text = await response.text();
	const line = text.split('\n').find((entry) => entry.startsWith('data: '));
	const body = JSON.parse(line === undefined ? text : line.slice('data: '.length)) as {
		result?: { tools?: Array<{ name: string }> };
	};
	return (body.result?.tools ?? []).map((tool) => tool.name);
}

Deno.test('D-150/D-154: startGateway seals the key for the default, logs a keyless default once, moves a legacy key', async () => {
	const scoped = await generateApiKey('d150', ['mcp:invoke']);
	const dbKey = generateDbKey();
	const start = async (env: Record<string, string>, lines: string[], withDbKey = true) =>
		await startGateway({
			config: loadConfig({
				TTK_HOST: '127.0.0.1',
				TTK_PORT: '0',
				TTK_API_KEYS: JSON.stringify([scoped.record]),
				// Pinned off: the embeds exist only after `build:web`, and this test is about links.
				TTK_MCP_APPS: 'off',
				...env,
			}, withDbKey ? { secrets: { TTK_DB_KEY: dbKey } } : {}),
			version: 'test',
			logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
			launch: () => Promise.resolve({ session: fakeSession(), downloads: null, downloadsDir: SCRATCH_ROOT }),
		});
	const stop = async (gateway: Awaited<ReturnType<typeof start>>) => {
		await gateway.shutdown();
		await gateway.finished;
	};
	const data = await scratch('link-default-');
	const bad = await scratch('link-default-bad-');
	try {
		// Unset with a data directory and a vault key: on, and the key generated and sealed exactly as for an explicit true.
		{
			const lines: string[] = [];
			const gateway = await start({ TTK_DATA_DIR: data }, lines);
			try {
				assertEquals(Database.inspect(data)?.secrets, 1);
				await assertRejects(() => Deno.stat(join(data, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
				assert((await listedNames(gateway.url, scoped.key)).includes('browser_file_link'));
				assert(!lines.some((line) => line.includes('TTK_SIGNED_LINKS')), lines.join('\n'));
			} finally {
				await stop(gateway);
			}
		}
		// Unset with nowhere to keep a key — no data directory, or one without a vault key: off, and one info line
		// naming the variable and why.
		for (const [env, withDbKey] of [[{}, true], [{ TTK_DATA_DIR: bad }, false]] as const) {
			const lines: string[] = [];
			const gateway = await start(env, lines, withDbKey);
			try {
				assert(!(await listedNames(gateway.url, scoped.key)).includes('browser_file_link'));
				const notes = lines.filter((line) => line.includes('TTK_SIGNED_LINKS is unset and stays off'));
				assertEquals(notes.length, 1, lines.join('\n'));
				assertEquals(JSON.parse(notes[0]!).level, 'info');
				if (withDbKey === false) assertStringIncludes(notes[0]!, 'TTK_DB_KEY_FILE');
			} finally {
				await stop(gateway);
			}
		}
		// A plaintext key an earlier release generated: moved into the vault and deleted; too short to keep, replaced.
		await Deno.writeTextFile(join(bad, LINK_KEY_FILE_NAME), 'too-short\n');
		{
			const lines: string[] = [];
			const gateway = await start({ TTK_DATA_DIR: bad }, lines);
			try {
				assert((await listedNames(gateway.url, scoped.key)).includes('browser_file_link'));
				await assertRejects(() => Deno.stat(join(bad, LINK_KEY_FILE_NAME)), Deno.errors.NotFound);
				assert(!lines.join('\n').includes('too-short'), 'no line quotes the key');
			} finally {
				await stop(gateway);
			}
		}
	} finally {
		await Deno.remove(data, { recursive: true }).catch(() => {});
		await Deno.remove(bad, { recursive: true }).catch(() => {});
	}
});
