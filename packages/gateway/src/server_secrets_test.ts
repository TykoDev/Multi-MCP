/**
 * NF-3 (design §2.8, AC26, HTTP half): `startGateway` builds **one** `SecretStore` and hands it to both consumers —
 * the registry's `redact` (the request log and console ring cap their text through it) and the mount's
 * `GatewayDeps.secrets`, which the tools read as `ctx.secrets`.
 *
 * Proven by identity, not by counting alone: the injected factory returns a store that records which instance each
 * `redact` call ran on. The registry path is driven by a request reaching a session's network log; the tool path by
 * `browser_network_log`, whose projection redacts every field it returns. The browser is faked (an injected
 * launcher and a stand-in CDP client), so this stays in the unit tier.
 */
import { assert, assertEquals } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import type { CdpClient } from '@tykotech/cdp';
import { type SecretEntry, SecretStore } from '@tykotech/mcp';
import { generateApiKey } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startGateway } from './server.ts';

/** Synthetic; never a real credential. */
const SECRET = 'Zq8-nf3-synthetic-secret-0123456789';

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'nf3-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

type Listener = (params: unknown, sessionId?: string) => void;

/** The `on` half of a CDP client, with an `emit` to deliver one event. */
function fakeCdp(): CdpClient & { emit(event: string, params: unknown): void } {
	const listeners = new Map<string, Set<Listener>>();
	return {
		on(event: string, listener: Listener) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event: string, params: unknown) {
			for (const listener of listeners.get(event) ?? []) listener(params);
		},
	} as unknown as CdpClient & { emit(event: string, params: unknown): void };
}

/** A store that remembers the instance every `redact` ran on. */
class RecordingStore extends SecretStore {
	readonly #seen: SecretStore[];
	constructor(entries: readonly SecretEntry[], seen: SecretStore[]) {
		super(entries);
		this.#seen = seen;
	}
	override redact(text: string): string {
		this.#seen.push(this);
		return super.redact(text);
	}
}

Deno.test('NF-3 (AC26): one SecretStore per mount — registry redact and ctx.secrets are the same instance', async () => {
	const key = await generateApiKey('nf3', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([key.record]),
		TTK_SECRETS: JSON.stringify({ shop_token: SECRET }),
		TTK_LOG_LEVEL: 'error',
		// D-150: `owner` is the default; this test creates its session with no caller (`createNew()`), so shared.
		TTK_SESSION_OWNERSHIP: 'shared',
	});
	const built: SecretStore[] = [];
	const seen: SecretStore[] = [];
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve(fakeSession()),
		secretStore: (entries) => {
			const store = new RecordingStore(entries, seen);
			built.push(store);
			return store;
		},
	});
	try {
		assertEquals(built.length, 1, 'the factory is called once per gateway');
		const store = built[0]!;

		// The registry path: a request reaching the session's network log is redacted at mint.
		const record = await gateway.registry.createNew();
		const cdp = fakeCdp();
		record.network.attach(cdp);
		cdp.emit('Network.requestWillBeSent', {
			requestId: 'R1',
			loaderId: 'L',
			documentURL: `https://shop.test/cart/${SECRET}?token=${SECRET}`,
			request: { url: `https://shop.test/cart/${SECRET}?token=${SECRET}`, method: 'GET', headers: {} },
			timestamp: 100,
			wallTime: 1_767_225_600,
			initiator: {},
			type: 'Document',
			frameId: 'FRAME',
		});
		const byRegistry = seen.length;
		assert(byRegistry > 0, 'the registry redacted through the injected store');
		assertEquals(record.network.snapshot()[0]?.path.includes(SECRET), false, 'redacted at mint');

		// The tool path: `browser_network_log` redacts every field through `ctx.secrets`.
		const response = await fetch(`${gateway.url}/mcp`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${key.key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'browser_network_log', arguments: { session_id: record.id } },
			}),
		});
		const text = await response.text();
		assertEquals(response.status, 200, text);
		assert(!text.includes(SECRET), 'no secret value in the tool result');
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		const result = JSON.parse(line === undefined ? text : line.slice('data: '.length)).result;
		assertEquals(result.isError, undefined, JSON.stringify(result));
		assertEquals(result.structuredContent.entries.length, 1);
		assert(seen.length > byRegistry, 'the tool redacted through ctx.secrets');

		// Every redaction — registry and tool alike — ran on the one instance the factory built.
		assertEquals(new Set(seen).size, 1);
		assert(seen.every((instance) => instance === store));
	} finally {
		await gateway.shutdown();
		await gateway.finished;
	}
});
