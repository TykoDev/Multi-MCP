/**
 * The MCP Apps terminal and surface streams (`embed_streams.ts`): the mint's checks, and the sockets end to end over
 * a real loopback server — ticket redemption with its origin binding, the terminal's replay, input and end, the
 * surface's live revisions and removal, the connection ceiling, the re-check and shutdown.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import { SandboxClientError } from '@tykotech/sandbox';
import type { SandboxClient } from '@tykotech/sandbox';
import { ToolError } from '@tykotech/mcp';
import type { AppVariables } from './app.ts';
import { A2uiStore } from './a2ui.ts';
import { type EmbedStreamCaller, EmbedStreams, type EmbedStreamsOptions } from './embed_streams.ts';

const ORIGIN = 'https://host.example';
const SESSION = '00000000-0000-4000-8000-000000000001';
const CREATE = {
	version: 'v0.9',
	createSurface: { surfaceId: 's1', catalogId: 'https://tykotech.eu/a2ui/catalog/v0.9' },
};

const ALICE: EmbedStreamCaller = {
	principal: 'key-a',
	owner: 'api-key:key-a',
	scopes: new Set(['mcp:invoke', 'sandbox:execute', 'a2ui:publish']),
	credential: 'cred-a',
};

/** A sandbox with one shell session owned by ALICE: output queued by the test, input recorded. */
class FakeShell {
	readonly inputs: string[] = [];
	#output = '';
	#ended = false;
	#wake: (() => void) | null = null;

	emit(text: string): void {
		this.#output += text;
		this.#wake?.();
	}

	end(): void {
		this.#ended = true;
		this.#wake?.();
	}

	readonly client = {
		call: async (owner: string, operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
			if (owner !== ALICE.owner || args.session_id !== SESSION) throw new SandboxClientError('no_session', 404);
			if (operation === 'session_input') {
				this.inputs.push(String(args.data));
				return { accepted: true };
			}
			if (operation !== 'session_read') throw new Error(`unexpected ${operation}`);
			const after = Number(args.after ?? 0);
			if (after >= this.#output.length && !this.#ended && Number(args.wait_ms) > 0) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(Number(args.wait_ms), 200));
					this.#wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
			const from = Math.min(after, this.#output.length);
			return {
				output: this.#output.slice(from),
				seq: this.#output.length,
				gap: false,
				ended: this.#ended,
				exit_code: this.#ended ? 0 : null,
				killed: null,
			};
		},
	};
}

interface Fixture {
	readonly streams: EmbedStreams;
	readonly surfaces: A2uiStore;
	readonly shell: FakeShell;
	readonly base: string;
	readonly held: Map<string, number>;
	/** Mutable: what the GW-1 re-check answers. */
	readonly scopesNow: { value: ReadonlySet<string> | null };
	[Symbol.asyncDispose](): Promise<void>;
}

function fixture(overrides: Partial<EmbedStreamsOptions> = {}): Fixture {
	const shell = new FakeShell();
	const surfaces = new A2uiStore();
	const held = new Map<string, number>();
	const scopesNow: { value: ReadonlySet<string> | null } = { value: ALICE.scopes };
	const app = new Hono<{ Variables: AppVariables }>();
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => app.fetch(request));
	const base = `ws://127.0.0.1:${server.addr.port}`;
	const streams = new EmbedStreams({
		socketBase: base,
		admitOrigin: (_principal, origin) => {
			if (origin !== ORIGIN) throw new ToolError('invalid-arguments', `origin ${origin} is not admitted`);
		},
		sandbox: shell.client as unknown as SandboxClient,
		surfaces,
		connections: {
			admitPrincipal: (principal) => {
				const count = held.get(principal) ?? 0;
				if (count >= 2) return false;
				held.set(principal, count + 1);
				return true;
			},
			releasePrincipal: (principal) => held.set(principal, (held.get(principal) ?? 1) - 1),
		},
		authorize: () => scopesNow.value,
		pingMs: 60_000,
		...overrides,
	});
	streams.attach(app);
	return {
		streams,
		surfaces,
		shell,
		base,
		held,
		scopesNow,
		async [Symbol.asyncDispose]() {
			streams.closeAll();
			await surfaces.close();
			await server.shutdown();
		},
	};
}

/** A socket with an `Origin`, collecting its JSON messages; `next(type)` waits for the next one of that type. */
function connect(url: string, origin: string = ORIGIN) {
	const messages: Array<Record<string, unknown>> = [];
	const waiters: Array<() => void> = [];
	const socket = new WebSocket(url, { headers: { origin } } as unknown as string[]);
	let closed = false;
	const closedPromise = new Promise<CloseEvent>((resolve) => {
		socket.addEventListener('close', (event) => {
			closed = true;
			for (const wake of waiters.splice(0)) wake();
			resolve(event);
		});
	});
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		for (const wake of waiters.splice(0)) wake();
	});
	let read = 0;
	return {
		socket,
		messages,
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
		send(message: Record<string, unknown>): void {
			socket.send(JSON.stringify(message));
		},
	};
}

Deno.test('embed streams: a terminal mint checks scope, origin and ownership', async () => {
	await using f = fixture();
	const ticket = await f.streams.mintTerminal(ALICE, SESSION, ORIGIN);
	assertEquals(ticket.id, SESSION);
	assertEquals(ticket.origin_bound, ORIGIN);
	assertEquals(ticket.expires_in, 30);
	assertEquals(ticket.ws_url, `${f.base}/live/terminal/${SESSION}/ws`);
	assert(ticket.ticket.startsWith('lvt_'));
	await assertRejects(() => f.streams.mintTerminal(ALICE, SESSION, 'https://evil.example'), ToolError, 'not admitted');
	await assertRejects(
		() => f.streams.mintTerminal({ ...ALICE, owner: 'api-key:key-b' }, SESSION, ORIGIN),
		ToolError,
		'no live shell session',
	);
	await assertRejects(
		() => f.streams.mintTerminal({ ...ALICE, scopes: new Set(['mcp:invoke']) }, SESSION, ORIGIN),
		ToolError,
		'cannot open',
	);
});

Deno.test('embed streams: the terminal replays, streams, takes input and ends', async () => {
	await using f = fixture();
	f.shell.emit('$ ');
	const { ticket, ws_url: url } = await f.streams.mintTerminal(ALICE, SESSION, ORIGIN);
	const term = connect(`${url}?ticket=${ticket}`);
	const meta = await term.next('meta');
	assertEquals(meta.kind, 'terminal');
	assertEquals(meta.interactive, true);
	assertEquals((await term.next('output')).data, '$ ');
	f.shell.emit('hello\n');
	assertEquals((await term.next('output')).data, 'hello\n');
	term.send({ type: 'input', data: 'echo hi\n' });
	term.send({ type: 'input', data: '' });
	assertStringIncludes(String((await term.next('error')).message), 'input data must be');
	for (let i = 0; i < 50 && f.shell.inputs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
	assertEquals(f.shell.inputs, ['echo hi\n']);
	assertEquals(f.held.get(ALICE.principal), 1, 'the socket holds one connection slot');
	f.shell.end();
	assertEquals((await term.next('end')).exit_code, 0);
	assertEquals((await term.next('bye')).reason, 'session-ended');
	await term.closed;
	for (let i = 0; i < 50 && f.held.get(ALICE.principal) !== 0; i++) await new Promise((r) => setTimeout(r, 10));
	assertEquals(f.held.get(ALICE.principal), 0, 'the slot is given back');
});

Deno.test('embed streams: a ticket redeems once, from its own origin, for its own kind and target', async () => {
	await using f = fixture();
	const reject = async (url: string, origin = ORIGIN): Promise<void> => {
		const attempt = connect(url, origin);
		await attempt.closed;
		assertEquals(attempt.messages, [], `${url} from ${origin} was refused before it opened`);
	};
	const first = await f.streams.mintTerminal(ALICE, SESSION, ORIGIN);
	await reject(`${first.ws_url}?ticket=${first.ticket}`, 'https://evil.example');
	// Spent by the refused attempt: a ticket is consumed on redemption whatever the outcome.
	await reject(`${first.ws_url}?ticket=${first.ticket}`);
	f.surfaces.publish(ALICE.owner, CREATE);
	const surface = await f.streams.mintSurface(ALICE, 's1', ORIGIN);
	await reject(`${f.base}/live/terminal/${SESSION}/ws?ticket=${surface.ticket}`);
	// A plain GET never burns a ticket.
	const plain = await f.streams.mintSurface(ALICE, 's1', ORIGIN);
	const response = await fetch(`${plain.ws_url.replace(/^ws/, 'http')}?ticket=${plain.ticket}`);
	await response.body?.cancel();
	assertEquals(response.status, 426);
	const term = connect(`${plain.ws_url}?ticket=${plain.ticket}`);
	assertEquals((await term.next('surface')).surface !== undefined, true);
	term.socket.close();
	await term.closed;
});

Deno.test('embed streams: the surface follows every revision and ends when it is removed', async () => {
	await using f = fixture();
	f.surfaces.publish(ALICE.owner, CREATE);
	await assertRejects(() => f.streams.mintSurface(ALICE, 'missing', ORIGIN), ToolError, 'no A2UI surface');
	const { ticket, ws_url: url } = await f.streams.mintSurface(ALICE, 's1', ORIGIN);
	const view = connect(`${url}?ticket=${ticket}`);
	assertEquals((await view.next('meta')).interactive, false);
	assertEquals(((await view.next('surface')).surface as { revision: number }).revision, 1);
	f.surfaces.publish(ALICE.owner, {
		version: 'v0.9',
		updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Text', text: 'hi' }] },
	});
	const updated = (await view.next('surface')).surface as { revision: number; components: unknown[] };
	assertEquals(updated.revision, 2);
	assertEquals(updated.components.length, 1);
	// Another surface of the same owner is not this stream's business.
	f.surfaces.publish(ALICE.owner, { ...CREATE, createSurface: { ...CREATE.createSurface, surfaceId: 's2' } });
	f.surfaces.delete(ALICE.owner, 's1');
	assertEquals((await view.next('removed')).surface_id, 's1');
	assertEquals((await view.next('bye')).reason, 'surface-removed');
	await view.closed;
	assertEquals(view.messages.filter((m) => m.type === 'surface').length, 2);
});

Deno.test('embed streams: the connection ceiling, the re-check and shutdown end streams', async () => {
	await using f = fixture();
	f.surfaces.publish(ALICE.owner, CREATE);
	const open = async () => {
		const { ticket, ws_url: url } = await f.streams.mintSurface(ALICE, 's1', ORIGIN);
		return connect(`${url}?ticket=${ticket}`);
	};
	const one = await open();
	await one.next('surface');
	const two = await open();
	await two.next('surface');
	const three = await open();
	await three.closed;
	assertEquals(three.messages, [], 'the third socket over the ceiling is refused before it opens');
	// The credential loses the scope: the next re-check ends both.
	f.scopesNow.value = new Set(['mcp:invoke']);
	f.streams.revalidateAll();
	assertEquals((await one.next('bye')).reason, 'unauthorized');
	assertEquals((await two.next('bye')).reason, 'unauthorized');
	f.scopesNow.value = ALICE.scopes;
	const four = await open();
	await four.next('surface');
	f.streams.closeAll();
	assertEquals((await four.next('bye')).reason, 'server-shutdown');
	await assertRejects(() => f.streams.mintSurface(ALICE, 's1', ORIGIN), ToolError, 'shutting down');
	assertEquals(f.streams.size, 0);
});
