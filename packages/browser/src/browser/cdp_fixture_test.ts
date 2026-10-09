/**
 * A real, local, CDP-speaking browser **fixture** for the session/watchdog tests — plus its own
 * self-test, which is why it lives in a `_test.ts` file colocated with the code it serves.
 *
 * This is a fixture, not a mock (D-TEST1, OBSERVABILITY-TESTING-CICD.md §4.1.2): a real `Deno.serve`
 * listener on `127.0.0.1:0`, a real WebSocket, real CDP JSON frames, and a small but honest browser
 * model (targets, flat sessions, attach/detach, lifecycle events). Nothing in `@tykotech/browser` or
 * `@tykotech/cdp` is stubbed. `@tykotech/cdp` ships an equivalent under `src/testing/`, but its `mod.ts` is the
 * only sanctioned import surface (AGENTS.md §3 forbids deep imports across packages), so the browser
 * model this package needs lives here.
 *
 * The hostname is pinned to `127.0.0.1`: `Deno.serve` defaults to `0.0.0.0`, which the test
 * permission matrix refuses (build-run erratum E-5).
 */

import { assert, assertEquals } from '@std/assert';
import { CdpClient } from '@tykotech/cdp';

/** One CDP command the fixture received. */
export interface FixtureRequest {
	readonly id: number;
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly sessionId: string | undefined;
}

/** One target in the fixture's browser model. */
export interface FixtureTarget {
	targetId: string;
	type: string;
	url: string;
	title: string;
	attached: boolean;
}

/** What `Page.navigate` answers with, and what lifecycle events follow it. */
export interface NavigatePlan {
	readonly loaderId?: string | null | undefined;
	readonly errorText?: string | undefined;
	/** Lifecycle names emitted right after the reply, all carrying `loaderId`. */
	readonly lifecycle?: readonly string[] | undefined;
	/** Lifecycle names emitted with no `loaderId` at all (the §7.5 staleness edge). */
	readonly lifecycleWithoutLoader?: readonly string[] | undefined;
}

export interface ChromeFixtureOptions {
	/** Page targets present before anything connects. Default: one `about:blank`. */
	readonly pages?: readonly string[] | undefined;
	/** Default plan for `Page.navigate`. */
	readonly navigate?: NavigatePlan | undefined;
}

const DEFAULT_NAVIGATE_PLAN: NavigatePlan = { lifecycle: ['init', 'DOMContentLoaded', 'load', 'networkIdle'] };

/** A local CDP endpoint with a browser model behind it. Always `await using`. */
export class ChromeFixture implements AsyncDisposable {
	readonly #server: Deno.HttpServer<Deno.NetAddr>;
	readonly #abort: AbortController;
	readonly #targets = new Map<string, FixtureTarget>();
	readonly #sessions = new Map<string, string>();
	readonly #requests: FixtureRequest[] = [];
	readonly #handlers = new Map<string, (request: FixtureRequest, fixture: ChromeFixture) => void>();
	readonly port: number;
	#socket: WebSocket | null = null;
	#navigatePlan: NavigatePlan;
	#autoAttach = false;
	#nextTarget = 0;
	#nextSession = 0;
	#nextLoader = 0;
	#closed = false;

	private constructor(
		server: Deno.HttpServer<Deno.NetAddr>,
		abort: AbortController,
		options: ChromeFixtureOptions,
	) {
		this.#server = server;
		this.#abort = abort;
		this.port = server.addr.port;
		this.#navigatePlan = options.navigate ?? DEFAULT_NAVIGATE_PLAN;
		for (const url of options.pages ?? ['about:blank']) this.addPage(url);
	}

	static start(options: ChromeFixtureOptions = {}): ChromeFixture {
		const ref: { fixture?: ChromeFixture } = {};
		const abort = new AbortController();
		const server = Deno.serve({
			hostname: '127.0.0.1',
			port: 0,
			signal: abort.signal,
			onListen: () => {},
			onError: () => new Response('fixture error', { status: 500 }),
		}, (request) => ref.fixture?.handle(request) ?? new Response('not ready', { status: 503 }));
		const fixture = new ChromeFixture(server, abort, options);
		ref.fixture = fixture;
		return fixture;
	}

	// -- endpoints ---------------------------------------------------------------------------------

	get wsUrl(): string {
		return `ws://127.0.0.1:${this.port}/devtools/browser/fixture`;
	}

	get httpUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	get requests(): readonly FixtureRequest[] {
		return this.#requests;
	}

	get targets(): readonly FixtureTarget[] {
		return [...this.#targets.values()];
	}

	/** Commands seen for one method, for wire-shape assertions. */
	requestsFor(method: string): FixtureRequest[] {
		return this.#requests.filter((request) => request.method === method);
	}

	/** Replace the handler for one CDP method. The handler must reply itself. */
	script(method: string, handler: (request: FixtureRequest, fixture: ChromeFixture) => void): this {
		this.#handlers.set(method, handler);
		return this;
	}

	setNavigatePlan(plan: NavigatePlan): void {
		this.#navigatePlan = plan;
	}

	// -- browser model -----------------------------------------------------------------------------

	addPage(url = 'about:blank', type = 'page'): string {
		const targetId = `TARGET${String(++this.#nextTarget).padStart(4, '0')}`;
		const target: FixtureTarget = { targetId, type, url, title: url, attached: false };
		this.#targets.set(targetId, target);
		if (this.#socket !== null) {
			this.emit('Target.targetCreated', { targetInfo: this.#info(target) });
			if (this.#autoAttach) this.attachTarget(targetId);
		}
		return targetId;
	}

	/** Attaches a flat session and emits `Target.attachedToTarget`, exactly as Chrome does. */
	attachTarget(targetId: string, waitingForDebugger = false): string {
		const target = this.#targets.get(targetId);
		if (target === undefined) throw new Error(`fixture: unknown target ${targetId}`);
		const existing = this.sessionFor(targetId);
		if (existing !== null) return existing;
		const sessionId = `SESSION${String(++this.#nextSession).padStart(4, '0')}`;
		this.#sessions.set(sessionId, targetId);
		target.attached = true;
		this.emit('Target.attachedToTarget', { sessionId, targetInfo: this.#info(target), waitingForDebugger });
		return sessionId;
	}

	sessionFor(targetId: string): string | null {
		for (const [sessionId, owner] of this.#sessions) {
			if (owner === targetId) return sessionId;
		}
		return null;
	}

	/** Detaches every session of a target and destroys it — the "fully removed" path of §7.3. */
	removeTarget(targetId: string): void {
		for (const [sessionId, owner] of [...this.#sessions]) {
			if (owner !== targetId) continue;
			this.#sessions.delete(sessionId);
			this.emit('Target.detachedFromTarget', { sessionId, targetId });
		}
		if (this.#targets.delete(targetId)) this.emit('Target.targetDestroyed', { targetId });
	}

	/** Detaches one session without destroying the target. */
	detachSession(sessionId: string): void {
		const targetId = this.#sessions.get(sessionId);
		if (targetId === undefined) return;
		this.#sessions.delete(sessionId);
		this.emit('Target.detachedFromTarget', { sessionId, targetId });
	}

	setTargetUrl(targetId: string, url: string): void {
		const target = this.#targets.get(targetId);
		if (target === undefined) return;
		target.url = url;
		target.title = url;
		this.emit('Target.targetInfoChanged', { targetInfo: this.#info(target) });
	}

	/** Pushes one `Page.lifecycleEvent` for a target, routed by its session id. */
	emitLifecycle(targetId: string, name: string, loaderId: string | null = 'LOADER0001'): void {
		const sessionId = this.sessionFor(targetId);
		if (sessionId === null) throw new Error(`fixture: target ${targetId} has no session`);
		const params: Record<string, unknown> = { frameId: `FRAME-${targetId}`, name, timestamp: 1234.5 };
		if (loaderId !== null) params.loaderId = loaderId;
		this.emit('Page.lifecycleEvent', params, sessionId);
	}

	// -- wire --------------------------------------------------------------------------------------

	emit(method: string, params: unknown = {}, sessionId?: string): void {
		this.#write(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
	}

	reply(id: number, result: unknown = {}, sessionId?: string): void {
		this.#write(JSON.stringify({ id, result, ...(sessionId === undefined ? {} : { sessionId }) }));
	}

	replyError(id: number, error: { code: number; message: string }): void {
		this.#write(JSON.stringify({ id, error }));
	}

	/** Kills the connection without a clean client-side close — a browser dying mid-run. */
	drop(): void {
		this.#socket?.close(1001, 'fixture dropped the connection');
		this.#socket = null;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#socket !== null && this.#socket.readyState === WebSocket.OPEN) {
			this.#socket.close(1001, 'fixture shutting down');
		}
		this.#socket = null;
		this.#abort.abort();
		await this.#server.finished;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	// -- internals ---------------------------------------------------------------------------------

	/** @internal wired from the `Deno.serve` handler. */
	private handle(request: Request): Response {
		const url = new URL(request.url);
		if (request.headers.get('upgrade') === 'websocket') {
			const { socket, response } = Deno.upgradeWebSocket(request);
			socket.onmessage = (event: MessageEvent) => {
				if (typeof event.data === 'string') this.#onCommand(event.data);
			};
			socket.onclose = () => {
				if (this.#socket === socket) this.#socket = null;
			};
			socket.onerror = () => {};
			this.#socket = socket;
			return response;
		}
		if (url.pathname === '/json/version') {
			return Response.json({
				Browser: 'Chrome/fixture',
				'Protocol-Version': '1.3',
				webSocketDebuggerUrl: this.wsUrl,
			});
		}
		return new Response('not found', { status: 404 });
	}

	#write(text: string): void {
		const socket = this.#socket;
		if (socket === null || socket.readyState !== WebSocket.OPEN) return;
		socket.send(text);
	}

	#info(target: FixtureTarget): Record<string, unknown> {
		return {
			targetId: target.targetId,
			type: target.type,
			title: target.title,
			url: target.url,
			attached: target.attached,
		};
	}

	#onCommand(raw: string): void {
		let parsed: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof parsed.id !== 'number' || typeof parsed.method !== 'string') return;
		const request: FixtureRequest = {
			id: parsed.id,
			method: parsed.method,
			params: parsed.params ?? {},
			sessionId: parsed.sessionId,
		};
		this.#requests.push(request);

		const scripted = this.#handlers.get(request.method);
		if (scripted !== undefined) {
			scripted(request, this);
			return;
		}
		this.#dispatch(request);
	}

	#dispatch(request: FixtureRequest): void {
		switch (request.method) {
			case 'Target.getTargets': {
				this.reply(request.id, { targetInfos: this.targets.map((target) => this.#info(target)) });
				return;
			}
			case 'Target.setDiscoverTargets': {
				this.reply(request.id);
				for (const target of this.targets) this.emit('Target.targetCreated', { targetInfo: this.#info(target) });
				return;
			}
			case 'Target.setAutoAttach': {
				this.reply(request.id);
				if (request.sessionId !== undefined) return;
				this.#autoAttach = true;
				for (const target of this.targets) {
					if (target.type === 'page') this.attachTarget(target.targetId);
				}
				return;
			}
			case 'Target.attachToTarget': {
				const targetId = String(request.params.targetId);
				if (!this.#targets.has(targetId)) {
					this.replyError(request.id, { code: -32602, message: `No target with given id found: ${targetId}` });
					return;
				}
				const sessionId = this.attachTarget(targetId);
				this.reply(request.id, { sessionId });
				return;
			}
			case 'Target.createTarget': {
				const targetId = this.addPage(String(request.params.url ?? 'about:blank'));
				this.reply(request.id, { targetId });
				return;
			}
			case 'Target.closeTarget': {
				this.removeTarget(String(request.params.targetId));
				this.reply(request.id, { success: true });
				return;
			}
			case 'Target.detachFromTarget': {
				const sessionId = request.params.sessionId;
				if (typeof sessionId === 'string') this.detachSession(sessionId);
				this.reply(request.id);
				return;
			}
			case 'Page.navigate': {
				this.#navigate(request);
				return;
			}
			default: {
				this.reply(request.id);
			}
		}
	}

	#navigate(request: FixtureRequest): void {
		const targetId = request.sessionId === undefined ? null : this.#sessions.get(request.sessionId) ?? null;
		const plan = this.#navigatePlan;
		const url = String(request.params.url ?? '');
		const frameId = `FRAME-${targetId ?? 'ROOT'}`;

		if (plan.errorText !== undefined) {
			this.reply(request.id, { frameId, errorText: plan.errorText });
			return;
		}

		const loaderId = plan.loaderId === undefined
			? `LOADER${String(++this.#nextLoader).padStart(4, '0')}`
			: plan.loaderId;
		if (targetId !== null) this.setTargetUrl(targetId, url);
		this.reply(request.id, { frameId, ...(loaderId === null ? {} : { loaderId }) });

		if (targetId === null) return;
		for (const name of plan.lifecycle ?? []) this.emitLifecycle(targetId, name, loaderId);
		for (const name of plan.lifecycleWithoutLoader ?? []) this.emitLifecycle(targetId, name, null);
	}
}

// ---------------------------------------------------------------------------
// the fixture's own contract
// ---------------------------------------------------------------------------

Deno.test('ChromeFixture serves /json/version and a real CDP socket', async () => {
	await using fixture = ChromeFixture.start({ pages: ['about:blank', 'chrome://newtab'] });

	const response = await fetch(`${fixture.httpUrl}/json/version`);
	const document = await response.json();
	assertEquals(document.webSocketDebuggerUrl, fixture.wsUrl);

	const client = await CdpClient.connect(fixture.wsUrl);
	try {
		const targets = await client.send.Target.getTargets({ filter: [{ type: 'page' }] });
		assertEquals(targets.targetInfos.length, 2);
		const attached = await client.send.Target.attachToTarget({
			targetId: targets.targetInfos[0]?.targetId ?? '',
			flatten: true,
		});
		assert(attached.sessionId.startsWith('SESSION'));
		const navigated = await client.send.Page.navigate({ url: 'about:blank' }, attached.sessionId);
		assert(navigated.loaderId !== undefined);
	} finally {
		await client.close();
	}
});

Deno.test('ChromeFixture reports an unknown target as a CDP protocol error', async () => {
	await using fixture = ChromeFixture.start();
	const client = await CdpClient.connect(fixture.wsUrl);
	try {
		let threw = false;
		try {
			await client.send.Target.attachToTarget({ targetId: 'NOPE', flatten: true });
		} catch {
			threw = true;
		}
		assert(threw, 'attaching to a non-existent target must surface the CDP error');
	} finally {
		await client.close();
	}
});
