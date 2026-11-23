/**
 * The live-view socket's authority and admission, over a real loopback server with a stub session: the ticket carries
 * the minting credential and the socket re-earns it — at upgrade, on its horizon and on every credential change —
 * narrowing a controller to a watcher or closing it; the per-session seat cap holds under concurrent upgrades; and an
 * oversized frame closes the socket before anything parses it.
 */
import { assert, assertEquals } from '@std/assert';
import { Hono } from 'hono';
import type { LiveViewerHandle, Scope, SessionAccess, SessionRegistry } from '@tykotech/mcp';
import type { AppVariables } from './app.ts';
import { ANONYMOUS_OWNER } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import {
	attachLiveView,
	type CastRegistry,
	liveModeAllowed,
	liveTicketScopesNow,
	type LiveViewDeps,
	MAX_VIEWER_FRAME_CHARS,
} from './liveview.ts';
import { TicketStore } from './tickets.ts';

const ACCESS: SessionAccess = { owner: 'api-key:ops', admin: false };
/** What the minting credential holds; the socket's re-check narrows this set to what it still holds. */
const CONTROL: ReadonlySet<Scope> = new Set<Scope>(['mcp:invoke', 'view:control', 'view:watch']);

Deno.test('liveModeAllowed narrows and never widens', () => {
	assertEquals(liveModeAllowed('control', new Set(['view:control'])), 'control');
	assertEquals(liveModeAllowed('control', new Set(['view:watch'])), 'watch');
	assertEquals(liveModeAllowed('watch', new Set(['view:control'])), 'watch');
	assertEquals(liveModeAllowed('watch', new Set(['view:watch'])), 'watch');
	assertEquals(liveModeAllowed('control', new Set(['mcp:invoke'])), null);
	assertEquals(liveModeAllowed('watch', new Set()), null);
});

Deno.test('liveTicketScopesNow re-checks the stamped credential, and says when it cannot', () => {
	const tickets = new TicketStore();
	const seen: Array<[string, string[], string | undefined]> = [];
	const authorize = (owner: string, scopes: ReadonlySet<string>, credential: string | undefined) => {
		seen.push([owner, [...scopes], credential]);
		return credential === 'api-key:live' || owner === ANONYMOUS_OWNER ? new Set(['view:watch']) : null;
	};
	const stamped = tickets.mint('ops', 's1', 'control', { access: ACCESS, scopes: CONTROL, credential: 'api-key:live' });
	assertEquals(stamped.credential, 'api-key:live');
	assertEquals([...(stamped.scopes ?? [])], [...CONTROL]);
	assertEquals([...(liveTicketScopesNow(stamped, authorize) as ReadonlySet<string>)], ['view:watch']);
	assertEquals(seen[0], ['api-key:ops', [...CONTROL], 'api-key:live']);

	const revoked = tickets.mint('ops', 's1', 'control', { access: ACCESS, scopes: CONTROL, credential: 'api-key:gone' });
	assertEquals(liveTicketScopesNow(revoked, authorize), null);

	// No fingerprint (as from an MCP Apps mint over stdio), and no verifier: nothing to re-check.
	const bare = tickets.mint('ops', 's1', 'control', { access: ACCESS, scopes: CONTROL });
	assertEquals(liveTicketScopesNow(bare, authorize), 'unchecked');
	assertEquals(liveTicketScopesNow(stamped, undefined), 'unchecked');
	// The anonymous loopback principal has no credential and is re-checked by owner alone.
	const anonymous = tickets.mint('anonymous:127.0.0.1', 's1', 'watch', {
		access: { owner: ANONYMOUS_OWNER, admin: false },
		scopes: new Set<Scope>(['view:watch']),
	});
	assertEquals([...(liveTicketScopesNow(anonymous, authorize) as ReadonlySet<string>)], ['view:watch']);
	// A verifier that throws is not an answer that the credential stands.
	assertEquals(
		liveTicketScopesNow(stamped, () => {
			throw new Error('boom');
		}),
		null,
	);
});

/** A session record with the members the socket path reads, and a registry that keeps the lock as the real one does. */
function stubSession() {
	const record = {
		id: 's1',
		viewers: new Map<string, LiveViewerHandle>(),
		lock: null as { holder: string; principal: string; takenAt: number; holderName: string | null } | null,
		session: { tabs: [], agentFocusTargetId: undefined, cachedBrowserState: undefined },
		lastUsedAt: 0,
	};
	const broadcast = () => {
		for (const viewer of record.viewers.values()) viewer.send({ type: 'lock', lock: record.lock });
	};
	const registry = {
		resolve: () => Promise.resolve(record),
		peekFor: () => record,
		addViewer: (_r: unknown, viewer: LiveViewerHandle) => record.viewers.set(viewer.id, viewer),
		removeViewer: (_r: unknown, id: string) => {
			record.viewers.delete(id);
			registry.releaseControl(record, id);
		},
		takeControl: (_r: unknown, viewer: LiveViewerHandle) => {
			if (record.lock !== null) return record.lock.holder === viewer.id;
			record.lock = { holder: viewer.id, principal: viewer.principal, takenAt: 0, holderName: null };
			broadcast();
			return true;
		},
		releaseControl: (_r: unknown, id: string) => {
			if (record.lock?.holder !== id) return;
			record.lock = null;
			broadcast();
		},
	};
	const cast = {
		lastSize: null,
		frameScaleFor: () => 1,
		attach: () => () => {},
		keyframe: () => true,
	};
	return {
		record,
		registry: registry as unknown as SessionRegistry,
		casts: { castFor: () => cast, attachFrames: () => () => {} } as unknown as CastRegistry,
	};
}

/** The live view on its own loopback server; `scopes.value` is what the credential holds now (`null`: gone). */
function fixture(overrides: Partial<LiveViewDeps> = {}, env: Record<string, string> = {}) {
	const app = new Hono<{ Variables: AppVariables }>();
	const tickets = new TicketStore();
	const stub = stubSession();
	const scopes: { value: ReadonlySet<string> | null } = { value: CONTROL };
	const config = loadConfig({ TTK_HOST: '127.0.0.1', TTK_PORT: '8787', ...env });
	const handle = attachLiveView({
		app,
		config,
		registry: stub.registry,
		tickets,
		logger: createLogger({ level: 'error', write: () => {} }),
		casts: stub.casts,
		authorize: (_owner, minted, _credential) =>
			scopes.value === null ? null : new Set([...minted].filter((scope) => scopes.value!.has(scope))),
		...overrides,
	});
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => app.fetch(request));
	const base = `ws://127.0.0.1:${server.addr.port}`;
	const sockets: WebSocket[] = [];
	return {
		...stub,
		handle,
		scopes,
		/** A socket on a fresh ticket minted with `mode` and the stamped credential (`null`: none stamped). */
		open(mode: 'watch' | 'control' = 'control', credential: string | null = 'api-key:ops') {
			const ticket = tickets.mint('ops', 's1', mode, {
				access: ACCESS,
				scopes: CONTROL,
				...(credential === null ? {} : { credential }),
			});
			const client = connect(`${base}/live/s1/ws?ticket=${ticket.ticket}`);
			sockets.push(client.socket);
			return client;
		},
		async [Symbol.asyncDispose]() {
			for (const socket of sockets) {
				try {
					socket.close();
				} catch { /* already closed */ }
			}
			await server.shutdown();
		},
	};
}

/** A socket collecting its JSON messages; `next(type)` waits for the next one of that type. */
function connect(url: string) {
	const messages: Array<Record<string, unknown>> = [];
	const waiters: Array<() => void> = [];
	const socket = new WebSocket(url);
	let closed = false;
	let opened = false;
	const settled = new Promise<'open' | 'refused'>((resolve) => {
		socket.addEventListener('open', () => {
			opened = true;
			resolve('open');
		});
		socket.addEventListener('close', () => resolve(opened ? 'open' : 'refused'));
	});
	const closedPromise = new Promise<CloseEvent>((resolve) => {
		socket.addEventListener('close', (event) => {
			closed = true;
			for (const wake of waiters.splice(0)) wake();
			resolve(event);
		});
	});
	socket.addEventListener('message', (event) => {
		if (typeof event.data === 'string') messages.push(JSON.parse(event.data) as Record<string, unknown>);
		for (const wake of waiters.splice(0)) wake();
	});
	socket.addEventListener('error', () => {});
	let read = 0;
	return {
		socket,
		settled,
		closed: closedPromise,
		async next(type: string): Promise<Record<string, unknown>> {
			for (;;) {
				while (read < messages.length) {
					const message = messages[read++]!;
					if (message.type === type) return message;
				}
				if (closed) throw new Error(`the socket closed before a ${type} message`);
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
		send(message: Record<string, unknown> | string): void {
			socket.send(typeof message === 'string' ? message : JSON.stringify(message));
		},
	};
}

Deno.test('a narrowed credential drops control at once; a revoked one closes the socket', async () => {
	await using f = fixture();
	const viewer = f.open('control');
	assertEquals((await viewer.next('meta')).mode, 'control');
	viewer.send({ type: 'control.take' });
	assertEquals(((await viewer.next('lock')).lock as { holder: string }).holder !== undefined, true);
	assert(f.record.lock !== null, 'the viewer holds the lock');

	// A re-check that finds the same authority changes nothing.
	f.handle.revalidateAll();
	assert(f.record.lock !== null, 'nothing changed while view:control is held');
	// Both view scopes gone (the credential still exists): the credentials-changed hook closes the socket.
	f.scopes.value = new Set(['mcp:invoke']);
	f.handle.revalidateAll();
	const close = await viewer.closed;
	assertEquals(close.code, 4001);
	assertEquals(close.reason, 'unauthorized');
	assertEquals(f.record.lock, null, 'control ended with the credential');
});

Deno.test('a controller whose credential keeps only view:watch is narrowed, not closed', async () => {
	await using f = fixture();
	const scopes = f.scopes;
	const viewer = f.open('control');
	assertEquals((await viewer.next('meta')).mode, 'control');
	viewer.send({ type: 'control.take' });
	await viewer.next('lock');
	assert(f.record.lock !== null);

	scopes.value = new Set(['mcp:invoke', 'view:watch']);
	f.handle.revalidateAll();
	assertEquals(f.record.lock, null, 'the lock is released the moment control is lost');
	assertEquals((await viewer.next('lock')).lock, null, 'every viewer hears it');
	viewer.send({ type: 'control.take' });
	const refused = await viewer.next('error');
	assertEquals(refused.code, 'not-holder');
	assertEquals(f.record.lock, null);
	assertEquals(viewer.socket.readyState, WebSocket.OPEN, 'a watcher may still watch');
});

Deno.test('the upgrade re-earns the ticket, and the horizon timer re-checks without a nudge', async () => {
	await using f = fixture({ revalidateMs: 50 });
	// Revoked between mint and upgrade: the socket never opens.
	f.scopes.value = null;
	const early = f.open('control');
	assertEquals(await early.settled, 'refused');

	// Revoked while open, with nobody calling revalidateAll: the 50 ms horizon closes it.
	f.scopes.value = CONTROL;
	const viewer = f.open('control');
	await viewer.next('meta');
	f.scopes.value = null;
	const close = await viewer.closed;
	assertEquals(close.code, 4001);
});

Deno.test('a ticket with no credential to re-check is bounded at the stream lifetime', async () => {
	await using f = fixture({ lifetimeMs: 100, revalidateMs: 60_000 });
	f.scopes.value = null; // would close a checked socket; this one cannot be checked
	const viewer = f.open('control', null);
	assertEquals((await viewer.next('meta')).mode, 'control');
	const close = await viewer.closed;
	assertEquals(close.code, 1000);
	assertEquals(close.reason, 'stream-expired');
});

Deno.test('concurrent upgrades cannot exceed the per-session viewer cap', async () => {
	await using f = fixture({}, { TTK_MAX_VIEWERS: '1' });
	// Both upgrades are in flight before either socket opens, so a cap counting only opened viewers would admit both.
	const first = f.open('watch');
	const second = f.open('watch');
	const outcomes = (await Promise.all([first.settled, second.settled])).sort();
	assertEquals(outcomes, ['open', 'refused']);
	assertEquals(f.record.viewers.size, 1);

	// A seat comes back when its viewer leaves.
	const opened = outcomes[0] === 'open' && (await first.settled) === 'open' ? first : second;
	opened.socket.close();
	await opened.closed;
	for (let wait = 0; wait < 50 && f.record.viewers.size > 0; wait += 1) await new Promise((r) => setTimeout(r, 10));
	const again = f.open('watch');
	assertEquals(await again.settled, 'open');
});

Deno.test('an oversized frame closes the socket with 1009 before it is parsed', async () => {
	await using f = fixture();
	const viewer = f.open('watch');
	await viewer.next('meta');
	// Just under the cap is parsed as usual (and refused as malformed).
	viewer.send(' '.repeat(MAX_VIEWER_FRAME_CHARS - 1) + '{');
	assertEquals((await viewer.next('error')).code, 'bad-message');
	viewer.send('x'.repeat(MAX_VIEWER_FRAME_CHARS + 1));
	const close = await viewer.closed;
	assertEquals(close.code, 1009);
	assertEquals(close.reason, 'frame-too-large');
});
