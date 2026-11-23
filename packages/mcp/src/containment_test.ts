/**
 * Navigation containment on the MCP side: what an E0 block — a document request the browser refused before sending it
 * — leaves in the registry, and what the tools that issued the navigation answer.
 */
import { blankSession } from '../fixtures/capture_session.ts';
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { BrowserErrorEvent, GoBackEvent, NavigateToUrlEvent, NavigationCompleteEvent } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { isToolError } from './errors.ts';
import {
	blockedSince,
	browserArgsUseProxy,
	DEFAULT_SESSION_ID,
	DOCUMENT_BLOCK_MEMORY,
	PROXY_WEBSOCKET_CAVEAT,
	resolverLayerRules,
	sessionProfile,
	type SessionRecord,
	SessionRegistry,
} from './registry.ts';
import { browserDownload, browserGoBack, browserNavigate } from './tools.ts';
import type { McpAppsDeps, SignedLinkMinter, ToolContext } from './types.ts';
import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { registerCatalog } from './server.ts';

const TOP = 'T-top';
const OFF = 'https://idp.evil.test/callback?code=Zq8-E0-CODE-3vP';

function e0(
	url: string,
	targetId: string = TOP,
	frameId: string = targetId,
	extra: Record<string, unknown> = {},
): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: 'NavigationBlocked',
		message: `Navigation to ${url} is not allowed by the configured domain policy`,
		details: { enforcementPoint: 'E0', url, targetId, frameId, containment: 'request-blocked', ...extra },
	});
}

/**
 * The slice of a CDP client the registry arms (`client.on`), with a way to deliver an event — enough to drive the
 * main-frame commits the registry attributes blocks by.
 */
class FakeClient {
	readonly #listeners = new Map<string, Array<(params: unknown, sessionId?: string) => void>>();
	on(method: string, listener: (params: unknown, sessionId?: string) => void): () => void {
		const list = this.#listeners.get(method) ?? [];
		list.push(listener);
		this.#listeners.set(method, list);
		return () => {};
	}
	emit(method: string, params: unknown): void {
		for (const listener of this.#listeners.get(method) ?? []) listener(params, 'S-top');
	}
	/** A main-frame commit of `url` on the tab, as Chrome reports it. */
	commit(url: string, frameId = TOP): void {
		this.emit('Page.frameNavigated', { frame: { id: frameId, loaderId: 'L', url, securityOrigin: '', mimeType: '' } });
	}
}

interface Fixture extends AsyncDisposable {
	readonly registry: SessionRegistry;
	readonly record: SessionRecord;
	readonly bus: EventBus;
	readonly infos: string[];
	readonly ctx: ToolContext;
	advance(ms: number): void;
}

async function fixture(client: FakeClient | null = null): Promise<Fixture> {
	let now = 50_000;
	const infos: string[] = [];
	const bus = new EventBus({ name: 'containment' });
	const session = blankSession({
		cdpClient: client,
		agentFocusTargetId: TOP,
		eventBus: bus,
		getBrowserStateSummary: () => Promise.resolve({ url: 'https://example.com/home', title: 'home' }),
	});
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		now: () => now,
		allowedDomains: ['example.com'],
		logger: {
			warn: () => {},
			info: (message) => void (message.includes('TTK_ALLOWED_DOMAINS') && infos.push(message)),
		},
		launch: () => Promise.resolve(session),
	});
	const record = await registry.resolve(DEFAULT_SESSION_ID);
	return {
		registry,
		record,
		bus,
		infos,
		ctx: { registry, allowedDomains: ['example.com'], principal: 'test' },
		advance: (ms) => void (now += ms),
		[Symbol.asyncDispose]: async () => {
			await registry.shutdown();
		},
	};
}

function ring(record: SessionRecord) {
	return record.events.read({ kind: 'cursor', epoch: record.events.epoch, seq: 0 });
}

Deno.test('an E0 block is one navigation record — blocked, request-blocked, not committed, redacted', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0(OFF));
	await f.bus.dispatch(
		new NavigationCompleteEvent({ targetId: TOP as never, url: OFF, errorMessage: 'net::ERR_ABORTED' }),
	);
	const records = ring(f.record);
	assertEquals(records.length, 1, JSON.stringify(records));
	const [navigation] = records;
	assertEquals(navigation?.kind, 'navigation');
	assertEquals(navigation?.payload.blocked, true);
	assertEquals(navigation?.payload.containment, 'request-blocked');
	assertEquals(navigation?.payload.committed, false);
	assertEquals(navigation?.payload.origin, 'https://idp.evil.test');
	assertEquals(navigation?.payload.path, '/callback');
	assertEquals(navigation?.payload.has_query, true);
	assertEquals(navigation?.payload.frame_id, TOP);
	assertEquals(navigation?.tab_id, TOP);
	assert(!JSON.stringify(records).includes('Zq8-E0-CODE'), 'a token reached the ring');
	assertEquals(f.infos.length, 1);
	assertStringIncludes(f.infos[0] ?? '', 'document request refused before it was sent');
	assertStringIncludes(f.infos[0] ?? '', 'https://idp.evil.test');
	assert(!(f.infos[0] ?? '').includes('/callback'), f.infos[0]);
	assertEquals(f.record.documentBlocks, [
		{ targetId: TOP, frameId: TOP, origin: 'https://idp.evil.test', at: 50_000, chainHost: null },
	]);
});

Deno.test('a frame’s block keeps its frame id, and only a main-frame block answers blockedSince', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0('https://frame.evil.test/x', TOP, 'F-child'));
	await f.bus.dispatch(e0('https://popup.evil.test/x', 'T-popup'));
	assertEquals(ring(f.record).map((record) => record.payload.frame_id), ['F-child', 'T-popup']);
	assertEquals(blockedSince(f.record, TOP, 0), null, 'a child frame is not the tab’s own navigation');
	assertEquals(blockedSince(f.record, 'T-popup', 0), 'https://popup.evil.test');
	assertEquals(blockedSince(f.record, null, 0), null);
	f.advance(10);
	await f.bus.dispatch(e0('https://top.evil.test/x'));
	assertEquals(blockedSince(f.record, TOP, 50_005), 'https://top.evil.test');
	assertEquals(blockedSince(f.record, TOP, 50_011), null, 'a block before `since` is not this navigation’s');
});

Deno.test('the session remembers at most DOCUMENT_BLOCK_MEMORY blocks, newest last', async () => {
	await using f = await fixture();
	for (let index = 0; index < DOCUMENT_BLOCK_MEMORY + 4; index++) {
		await f.bus.dispatch(e0(`https://n${index}.evil.test/`));
	}
	assertEquals(f.record.documentBlocks.length, DOCUMENT_BLOCK_MEMORY);
	assertEquals(f.record.documentBlocks.at(-1)?.origin, `https://n${DOCUMENT_BLOCK_MEMORY + 3}.evil.test`);
	assertEquals(DOCUMENT_BLOCK_MEMORY, 16);
});

async function toolError(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
	const error = await assertRejects(run);
	assert(isToolError(error), String(error));
	return { code: error.code, message: error.message };
}

Deno.test('browser_navigate through a refused redirect answers navigation-blocked, origin only', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async (event) => {
		await f.bus.dispatch(e0(OFF));
		throw new Error(`navigation to ${event.url} failed: net::ERR_ABORTED`);
	});
	const refused = await toolError(() => browserNavigate({ url: 'https://example.com/redirect?to=x' }, f.ctx));
	assertEquals(refused, {
		code: 'navigation-blocked',
		message: "navigation-blocked: https://idp.evil.test is not in the server's allowed-domain list",
	});
});

Deno.test('the success path is checked too — a block during the tool’s navigation is its answer', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0(OFF));
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'navigation-blocked',
	);
});

Deno.test('a frame’s block does not turn the tool’s own failure into navigation-blocked', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0(OFF, TOP, 'F-child'));
		throw new Error('navigation failed: net::ERR_CONNECTION_REFUSED');
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'browser-unavailable',
	);
});

Deno.test('browser_go_back whose history entry is refused answers navigation-blocked', async () => {
	await using f = await fixture();
	f.bus.on(GoBackEvent, async () => {
		await f.bus.dispatch(e0(OFF));
		throw new Error('net::ERR_ABORTED');
	});
	const refused = await toolError(() => browserGoBack({}, f.ctx));
	assertEquals(refused.code, 'navigation-blocked');
	assert(!refused.message.includes('/callback'), refused.message);
});

Deno.test('browser_download {url} checks right after dispatch, on the ERR_ABORTED swallow path too', async () => {
	await using f = await fixture();
	f.bus.on(NavigateToUrlEvent, async () => {
		await f.bus.dispatch(e0('https://files.evil.test/export.csv?sig=Zq8'));
		throw new Error('navigation failed: net::ERR_ABORTED');
	});
	const started = Date.now();
	const refused = await toolError(() => browserDownload({ url: 'https://example.com/redirect' }, f.ctx));
	assertEquals(refused, {
		code: 'navigation-blocked',
		message:
			"navigation-blocked: the download resolved to https://files.evil.test, which is not in the server's allowed-domain list",
	});
	assert(Date.now() - started < 2_000, 'answered at once, not after the detection window');
	assertEquals(f.record.files.list(), [], 'no ledger row: nothing reached the network');
});

// --------------------------------------------------------------------------- A tool answers navigation-blocked only
// for its own request chain ---------------------------------------------------------------------------

Deno.test('browser_navigate to an on-list page whose script leaves at once succeeds — the block is the page’s', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.bus.on(NavigateToUrlEvent, async (event) => {
		f.advance(5);
		client.commit(event.url);
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Document' }));
	});
	const result = await browserNavigate({ url: 'https://example.com/auto' }, f.ctx);
	assert(result.isError !== true, JSON.stringify(result));
	const blocked = ring(f.record).filter((record) => record.payload.blocked === true);
	assertEquals(blocked.length, 1);
	assertEquals(blocked[0]?.payload.containment, 'request-blocked');
});

Deno.test('the tool’s own refused redirect hop still answers navigation-blocked (no commit, its chain)', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.bus.on(NavigateToUrlEvent, async (event) => {
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: event.url, resourceType: 'Document' }));
		throw new Error(`navigation to ${event.url} failed: net::ERR_ABORTED`);
	});
	const refused = await toolError(() => browserNavigate({ url: 'https://example.com/redirect?to=x' }, f.ctx));
	assertEquals(refused.message, "navigation-blocked: https://idp.evil.test is not in the server's allowed-domain list");
});

Deno.test('a page spinning blocked navigations does not fail a tool navigation that is in flight', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.bus.on(NavigateToUrlEvent, async () => {
		f.advance(5);
		await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Document' }));
		throw new Error('navigation failed: net::ERR_CONNECTION_REFUSED');
	});
	assertEquals(
		(await toolError(() => browserNavigate({ url: 'https://example.com/' }, f.ctx))).code,
		'browser-unavailable',
	);
});

Deno.test('blockedSince — a commit after `since` ends the tool’s chain; a chain begun elsewhere is not the tool’s', async () => {
	const client = new FakeClient();
	await using f = await fixture(client);
	f.advance(10);
	await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: 'https://example.com/start' }));
	assertEquals(blockedSince(f.record, TOP, 50_000, 'https://example.com/start'), 'https://idp.evil.test');
	assertEquals(blockedSince(f.record, TOP, 50_000, 'http://EXAMPLE.com:8080/other'), 'https://idp.evil.test', 'host');
	assertEquals(blockedSince(f.record, TOP, 50_000, 'https://other.example.org/'), null, 'another chain');
	assertEquals(blockedSince(f.record, TOP, 50_000), 'https://idp.evil.test', 'no URL: the commit rule alone');
	f.advance(10);
	client.commit('https://example.com/start');
	assertEquals(blockedSince(f.record, TOP, 50_000), null, 'the tab committed after since');
	assertEquals(f.record.commits.get(TOP), 50_020);
	client.emit('Page.frameNavigated', {
		frame: {
			id: 'F-child',
			parentId: TOP,
			loaderId: 'L',
			url: 'https://example.com/f',
			securityOrigin: '',
			mimeType: '',
		},
	});
	assertEquals(f.record.commits.has('F-child'), false);
});

Deno.test('a refused speculative request is recorded but never answers a tool', async () => {
	await using f = await fixture();
	await f.bus.dispatch(e0(OFF, TOP, TOP, { chainStart: OFF, resourceType: 'Prefetch' }));
	assertEquals(ring(f.record).filter((record) => record.payload.blocked === true).length, 1);
	assertEquals(f.record.documentBlocks, []);
	assertEquals(blockedSince(f.record, TOP, 0), null);
});

Deno.test('the commit check’s E2 is one blocked, committed record parked on about:blank', async () => {
	await using f = await fixture();
	await f.bus.dispatch(
		new BrowserErrorEvent({
			errorType: 'NavigationBlocked',
			message: `Navigation to ${OFF} is not allowed by the configured domain policy`,
			details: { enforcementPoint: 'E2', url: OFF, targetId: TOP, containment: 'about:blank', trigger: 'commit' },
		}),
	);
	const records = ring(f.record);
	assertEquals(records.length, 1);
	assertEquals(records[0]?.payload.containment, 'about:blank');
	assertEquals(records[0]?.payload.committed, true);
	assert(!JSON.stringify(records).includes('Zq8-E0-CODE'));
	assertEquals(blockedSince(f.record, TOP, 0), null, 'E2 is not a refused request');
});

// --------------------------------------------------------------------------- The request scope on the MCP side:
// where subresource and hint refusals surface, the resolver layer composed into the launch profile, and the startup
// notices ---------------------------------------------------------------------------

/** What the vendored `SessionManager` dispatches for a refused subresource or hint. */
function requestBlock(url: string, requestKind: 'subresource' | 'hint', targetId: string = TOP): BrowserErrorEvent {
	return new BrowserErrorEvent({
		errorType: 'NavigationBlocked',
		message: `Request to ${url} is not allowed by the configured domain policy`,
		details: {
			enforcementPoint: 'E0',
			containment: 'request-blocked',
			requestKind,
			url,
			targetId,
			targetType: 'page',
			frameId: targetId,
			resourceType: requestKind === 'hint' ? 'Fetch' : 'Image',
		},
	});
}

for (const requestKind of ['subresource', 'hint'] as const) {
	Deno.test(`a refused ${requestKind} is a log line only — no ring record, no documentBlocks`, async () => {
		await using f = await fixture();
		const changes: unknown[] = [];
		const unwatch = f.registry.watch((change) => void changes.push(change));
		try {
			await f.bus.dispatch(requestBlock(OFF, requestKind));
			assertEquals(ring(f.record), [], 'nothing on the ring');
			assertEquals(f.record.documentBlocks, [], 'nothing blockedSince reads');
			assertEquals(blockedSince(f.record, TOP, 0), null);
			assertEquals(changes, [], 'no page-changed announce');
			assertEquals(f.infos.length, 1);
			assertStringIncludes(f.infos[0] ?? '', `request refused before it was sent (${requestKind})`);
			assertStringIncludes(f.infos[0] ?? '', 'https://idp.evil.test');
			assert(!(f.infos[0] ?? '').includes('/callback') && !(f.infos[0] ?? '').includes('Zq8'), f.infos[0]);
		} finally {
			unwatch();
		}
	});
}

Deno.test('request refusals share the block line’s rate limit, and never enter containedNavigations', async () => {
	await using f = await fixture();
	for (let index = 0; index < 10; index++) {
		await f.bus.dispatch(requestBlock(`https://n${index}.evil.test/p.png`, 'subresource'));
	}
	assertEquals(f.infos.length, 1, 'one line per BLOCK_LOG_INTERVAL_MS');
	f.advance(1_000);
	await f.bus.dispatch(requestBlock('https://late.evil.test/p.png', 'subresource'));
	assertEquals(f.infos.length, 2);
	assertStringIncludes(f.infos[1] ?? '', '(10 blocks since the last report)');
	await f.bus.dispatch(
		new NavigationCompleteEvent({ targetId: TOP as never, url: 'https://late.evil.test/p.png' }),
	);
	assertEquals(ring(f.record).filter((record) => record.payload.blocked === true), []);
});

Deno.test('a document E0 next to request refusals is still one record that answers blockedSince', async () => {
	await using f = await fixture();
	await f.bus.dispatch(requestBlock('https://img.evil.test/p.png', 'subresource'));
	await f.bus.dispatch(e0(OFF));
	await f.bus.dispatch(requestBlock('https://pf.evil.test/x', 'hint'));
	assertEquals(ring(f.record).length, 1);
	assertEquals(blockedSince(f.record, TOP, 0), 'https://idp.evil.test');
});

const PROFILE_BASE = {
	headless: true,
	downloadsDir: '/data/downloads/x',
	browserPath: null,
	userDataDir: null,
	storageState: null,
	chromiumSandbox: true,
} as const;

Deno.test('all composes exactly one --host-resolver-rules, in the designed order', () => {
	const skipped: string[] = [];
	const allowedDomains = ['Example.com.', '10.0.0.5', '[::1]', '%%bad'];
	const browserArgs = ['--host-resolver-rules=MAP x 127.0.0.1', '--proxy-server=http://p:3128'];
	const expected = 'MAP x 127.0.0.1, EXCLUDE example.com, EXCLUDE *.example.com, EXCLUDE 10.0.0.5, EXCLUDE ::1, ' +
		'EXCLUDE p, MAP * ~NOTFOUND';
	assertEquals(resolverLayerRules(allowedDomains, browserArgs, (message) => void skipped.push(message)), expected);
	assertEquals(skipped.length, 1, 'the unreadable entry is skipped with a warning');
	assertStringIncludes(skipped[0] ?? '', '"%%bad"');

	const profile = sessionProfile({ ...PROFILE_BASE, allowedDomains, browserArgs, allowedDomainsScope: 'all' });
	assertEquals(profile.args, ['--proxy-server=http://p:3128', `--host-resolver-rules=${expected}`]);
	assertEquals(profile.requestScope, 'all');
	assertEquals(profile.args?.filter((arg) => arg.startsWith('--host-resolver-rules')).length, 1);
});

Deno.test('documents — and an unrestricted deployment — leave the profile byte-identical', () => {
	const browserArgs = ['--host-resolver-rules=MAP x 127.0.0.1', '--proxy-server=http://p:3128'];
	const documents = sessionProfile({ ...PROFILE_BASE, allowedDomains: ['example.com'], browserArgs });
	assertEquals(
		sessionProfile({ ...PROFILE_BASE, allowedDomains: ['example.com'], browserArgs, allowedDomainsScope: 'documents' }),
		documents,
	);
	assertEquals(documents.args, browserArgs);
	assertEquals(documents.requestScope, undefined);
	const open = sessionProfile({ ...PROFILE_BASE, allowedDomains: [], browserArgs, allowedDomainsScope: 'all' });
	assertEquals(open, sessionProfile({ ...PROFILE_BASE, allowedDomains: [], browserArgs }));
	const bare = sessionProfile({
		...PROFILE_BASE,
		allowedDomains: ['example.com'],
		browserArgs: [],
		allowedDomainsScope: 'all',
	});
	assertEquals(bare.args, ['--host-resolver-rules=EXCLUDE example.com, EXCLUDE *.example.com, MAP * ~NOTFOUND']);
});

Deno.test('an underscore host is left out of the layer with a warning — it does not resolve (fail closed)', () => {
	const skipped: string[] = [];
	const rules = resolverLayerRules(['my_host.example', 'ok.example'], [], (message) => void skipped.push(message));
	assertEquals(rules, 'EXCLUDE ok.example, EXCLUDE *.ok.example, MAP * ~NOTFOUND');
	assertEquals(skipped.length, 1);
	assertStringIncludes(skipped[0] ?? '', 'my_host.example');
});

Deno.test('an allowlist entry holding `*` is left out with a warning — it never writes `EXCLUDE *…`', () => {
	for (const wildcard of ['*', '*.org', 'a*b.example']) {
		const skipped: string[] = [];
		const rules = resolverLayerRules(['example.com', wildcard], [], (message) => void skipped.push(message));
		assertEquals(rules, 'EXCLUDE example.com, EXCLUDE *.example.com, MAP * ~NOTFOUND', wildcard);
		assertEquals(skipped.length, 1, wildcard);
		assertStringIncludes(skipped[0] ?? '', JSON.stringify(wildcard));
	}
});

Deno.test('the last operator --host-resolver-rules wins, and every proxy host of a rule list is excluded', () => {
	const rules = resolverLayerRules(['a.example'], [
		'--host-resolver-rules=MAP old 127.0.0.1',
		'--host-resolver-rules=MAP new 127.0.0.1',
		'--proxy-server=http=p1:3128;https=https://P2:443,direct://',
	]);
	assertEquals(
		rules,
		'MAP new 127.0.0.1, EXCLUDE a.example, EXCLUDE *.a.example, EXCLUDE p1, EXCLUDE p2, MAP * ~NOTFOUND',
	);
	assertEquals(browserArgsUseProxy(['--proxy-pac-url=http://pac/x.pac']), true);
	assertEquals(browserArgsUseProxy(['--proxy-auto-detect']), true);
	assertEquals(browserArgsUseProxy(['--no-proxy-server']), false);
});

Deno.test('an allowlisted host the operator maps is not excluded — an EXCLUDE would void the operator MAP', () => {
	assertEquals(
		resolverLayerRules(['127.0.0.1', 'ttk-site-b.test'], ['--host-resolver-rules=MAP ttk-site-b.test 127.0.0.1']),
		'MAP ttk-site-b.test 127.0.0.1, EXCLUDE 127.0.0.1, EXCLUDE *.ttk-site-b.test, MAP * ~NOTFOUND',
	);
	assertEquals(
		resolverLayerRules(['a.example', 'b.example'], ['--host-resolver-rules=MAP *.a.example:443 10.0.0.1']),
		'MAP *.a.example:443 10.0.0.1, EXCLUDE a.example, EXCLUDE b.example, EXCLUDE *.b.example, MAP * ~NOTFOUND',
	);
	assertEquals(
		resolverLayerRules(['a.example'], ['--host-resolver-rules=MAP * 10.0.0.1']),
		'MAP * 10.0.0.1, MAP * ~NOTFOUND',
		'an operator catch-all admits everything (the documented residual)',
	);
});

function startupWarnings(options: ConstructorParameters<typeof SessionRegistry>[0]): Promise<string[]> {
	const warnings: string[] = [];
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		...options,
		logger: { warn: (message) => void warnings.push(message), info: () => {} },
	});
	return registry.shutdown().then(() => warnings);
}

Deno.test('all with a proxy flag logs the WebSocket caveat once at startup; documents does not', async () => {
	for (const flag of ['--proxy-server=http://p:3128', '--proxy-pac-url=http://pac/p.pac', '--proxy-auto-detect']) {
		const warnings = await startupWarnings({
			allowedDomains: ['example.com'],
			allowedDomainsScope: 'all',
			browserArgs: [flag],
		});
		assertEquals(warnings.filter((message) => message === PROXY_WEBSOCKET_CAVEAT).length, 1, flag);
		assertStringIncludes(PROXY_WEBSOCKET_CAVEAT, 'WebSockets to off-list hosts are not refused');
	}
	assertEquals(
		await startupWarnings({ allowedDomains: ['example.com'], browserArgs: ['--proxy-server=http://p:3128'] }),
		[],
	);
	assertEquals(
		await startupWarnings({ allowedDomains: ['example.com'], allowedDomainsScope: 'all', browserArgs: [] }),
		[],
		'no proxy, no caveat',
	);
});

Deno.test('the registry names an unreadable allowlist entry once at startup, under all only', async () => {
	const all = await startupWarnings({ allowedDomains: ['example.com', '%%bad'], allowedDomainsScope: 'all' });
	assertEquals(all.length, 1);
	assertStringIncludes(all[0] ?? '', '"%%bad"');
	assertEquals(await startupWarnings({ allowedDomains: ['example.com', '%%bad'] }), []);
	assertEquals(
		await startupWarnings({
			allowedDomains: ['%%bad'],
			allowedDomainsScope: 'all',
			browserArgs: ['--proxy-server=http://p:3128'],
			launch: () => Promise.reject(new Error('unused')),
		}),
		[],
	);
});

function registry(scope?: 'documents' | 'all'): SessionRegistry {
	return new SessionRegistry({
		reapIntervalMs: 0,
		...(scope === undefined ? {} : { allowedDomainsScope: scope }),
		launch: () => Promise.resolve(blankSession()),
	});
}

const INCARNATION = /^[A-Za-z0-9_-]{12}$/;

Deno.test('every record has a 12-character base64url incarnation, new for each creation', async () => {
	const sessions = registry('all');
	try {
		const first = await sessions.resolve(undefined);
		assertEquals(first.id, DEFAULT_SESSION_ID);
		assert(INCARNATION.test(first.incarnation), first.incarnation);
		assertEquals((await sessions.resolve(undefined)).incarnation, first.incarnation);

		const other = await sessions.createNew();
		assert(INCARNATION.test(other.incarnation), other.incarnation);
		assertNotEquals(other.incarnation, first.incarnation);

		await sessions.close(DEFAULT_SESSION_ID);
		const again = await sessions.resolve(undefined);
		assertEquals(again.id, DEFAULT_SESSION_ID);
		assert(INCARNATION.test(again.incarnation), again.incarnation);
		assertNotEquals(again.incarnation, first.incarnation);
	} finally {
		await sessions.shutdown();
	}
});

Deno.test('allowedDomainsScope is accepted; documents leaves sessionProfile unchanged', () => {
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
	assertNotEquals(sessionProfile({ ...base, allowedDomainsScope: 'all' }), unset);
});

Deno.test('an MCP Apps ticket carries the mount’s credential, never one a tool passes', async () => {
	const sessions = registry();
	const seen: (string | undefined)[] = [];
	const mcpApps = {
		mode: 'watch',
		liveViewHtml: '',
		a2uiHtml: '',
		terminalHtml: '',
		connectDomains: [],
		origins: [],
		mintTicket: (input: { credential?: string }) => {
			seen.push(input.credential);
			return Promise.reject(new Error('not minted in this test'));
		},
	} as unknown as McpAppsDeps;
	const server = new McpServer({ name: 'containment-seam-test', version: '0' });
	try {
		const ctx = registerCatalog(server, { registry: sessions, version: '0', mcpApps }, {
			token: 't',
			clientId: 'c',
			scopes: ['mcp:invoke', 'view:watch'],
			extra: { owner: 'api-key:c', credential: 'api-key:c' },
		}).ctx;
		await ctx.mcpApps!.mintTicket({
			principal: 'c',
			access: { owner: 'api-key:c', admin: false },
			scopes: new Set(['view:watch']),
			mode: 'watch',
			origin: 'https://host.example',
			holderName: null,
			credential: 'forged',
		}).catch(() => {});
		assertEquals(seen, ['api-key:c']);
	} finally {
		await server.close();
		await sessions.shutdown();
	}
});

/** An `AuthInfo` as the bearer gate stamps it, with `credential` on its `extra` when given. */
function auth(credential?: unknown): AuthInfo {
	return {
		token: 't',
		clientId: 'subject',
		scopes: ['mcp:invoke'],
		extra: { owner: 'api-key:subject', ...(credential === undefined ? {} : { credential }) },
	};
}

Deno.test('registerCatalog binds the call’s own credential into the link minter; a tool cannot supply one', async () => {
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
		await (await minterFor(auth('user-key:abc')))({ ...request, credential: 'user-key:forged' });
		assertEquals(asked.at(-1), { ...request, credential: 'user-key:abc' });
		for (const authInfo of [auth(), auth(''), auth(42), undefined]) {
			await (await minterFor(authInfo))({ ...request, credential: 'user-key:forged' });
			assertEquals(asked.at(-1), request, JSON.stringify(authInfo?.extra));
		}
	} finally {
		await sessions.shutdown();
	}
});
