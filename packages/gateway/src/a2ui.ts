import { expansionOwner, type Principal } from './auth.ts';
import { EVENT_STREAM_LIFETIME_MS, EVENT_STREAM_REVALIDATE_MS } from './eventstream.ts';
/** Principal-bound A2UI state and authenticated REST adapter (D-067); durable with a data directory (B1, D-104). */
import {
	A2UI_CATALOG_ID,
	A2UI_MAX_BYTES,
	A2uiActionSchema,
	A2uiComponentSchema,
	A2uiMessageSchema,
	type A2uiSurface,
	normalizeA2uiMessage,
	readA2uiPointer,
	updateA2uiModel,
	validateA2uiJson,
	validateA2uiTree,
} from '@tykotech/wire';
import { DurableJsonFile } from '@tykotech/agents';
import type { Context, Hono } from 'hono';
import * as z from 'zod';
import type { AppVariables } from './app.ts';
import { HttpProblem, problemResponse } from './problem.ts';

export type A2uiBinding =
	| { kind: 'cancelTask'; taskId: string }
	| { kind: 'permissionDecision'; requestId: string; optionId: string }
	/** E-4: an operator-configured tool action, named by the button's event. */
	| { kind: 'toolAction'; name: string };
export interface A2uiStoreOptions {
	cancelTask?: (principal: string, scopes: ReadonlySet<string>, taskId: string) => Promise<Record<string, unknown>>;
	permissionDecision?: (
		principal: string,
		scopes: ReadonlySet<string>,
		requestId: string,
		optionId: string,
	) => Promise<Record<string, unknown>>;
	/** E-4: runs the configured tool action `name` with the context resolved from server state. */
	toolAction?: (
		principal: string,
		scopes: ReadonlySet<string>,
		name: string,
		context: Readonly<Record<string, unknown>>,
	) => Promise<Record<string, unknown>>;
	/**
	 * B1 / G5: `<TTK_DATA_DIR>/agents/surfaces.json`. Absent keeps surfaces in memory only, as before. Action
	 * registrations are never written: they are one-shot authority bound to live targets, so a restored surface has
	 * none until it is republished, and the SPA shows its buttons disabled.
	 */
	persistPath?: string;
	/** Persistence failures; never surface content. */
	logger?: { warn(message: string): void };
}
interface OwnedSurface {
	owner: string;
	snapshot: A2uiSurface;
	actions: Map<string, A2uiBinding>;
}

/** B1: `surfaces.json`. `revision` is the global counter, so a restart never re-issues an old revision. */
interface SurfacesDocument {
	version: 1;
	revision: number;
	surfaces: { owner: string; snapshot: A2uiSurface }[];
}

/**
 * A stored surface re-validated as if it were being published now, or `null` (skipped, never trusted). Review R2-9:
 * its identity and theme pass the same `createSurface` schema a publish does (the closed D-111 theme included), its
 * components the component schema and the tree check, and the snapshot is rebuilt from the known keys only, so
 * nothing else a hand-edited file carries reaches a client.
 */
function storedSurface(value: unknown): { owner: string; snapshot: A2uiSurface } | null {
	try {
		if (value === null || typeof value !== 'object') return null;
		const { owner, snapshot } = value as { owner?: unknown; snapshot?: unknown };
		if (typeof owner !== 'string' || owner === '' || owner.length > 512) return null;
		if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
		const stored = snapshot as Record<string, unknown>;
		validateA2uiJson(stored);
		const message = A2uiMessageSchema.parse({
			version: 'v0.9',
			createSurface: {
				surfaceId: stored.surfaceId,
				catalogId: stored.catalogId,
				...(stored.theme === undefined ? {} : { theme: stored.theme }),
				...(stored.workspaceId === undefined ? {} : { workspaceId: stored.workspaceId }),
			},
		});
		if (!('createSurface' in message)) return null;
		const revision = stored.revision;
		if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
		if (!Object.hasOwn(stored, 'dataModel')) return null;
		const components = A2uiComponentSchema.array().max(256).parse(stored.components);
		validateA2uiTree(components);
		const { surfaceId, catalogId, theme, workspaceId } = message.createSurface;
		const rebuilt: A2uiSurface = {
			surfaceId,
			catalogId,
			revision,
			components,
			dataModel: stored.dataModel,
			...(theme === undefined ? {} : { theme }),
			...(workspaceId === undefined ? {} : { workspaceId }),
		};
		return { owner, snapshot: rebuilt };
	} catch {
		return null;
	}
}
interface Subscriber {
	owner: string;
	controller: ReadableStreamDefaultController<Uint8Array>;
	dispose: () => void;
}

/** One per-surface watcher (the MCP Apps surface stream, `embed_streams.ts`). */
interface SurfaceWatcher {
	readonly owner: string;
	readonly surfaceId: string;
	readonly onChange: (surface: A2uiSurface | null) => void;
	/** The revision last delivered, so an owner's change to another surface is not re-sent. */
	revision: number;
}

/** Surface watchers in the whole store and per owner; the embed stream is also capped per principal upstream. */
export const A2UI_MAX_WATCHERS = 64;
export const A2UI_MAX_WATCHERS_PER_OWNER = 8;

/** Owns surfaces, one-shot action registrations and bounded snapshot subscriptions. */
export class A2uiStore {
	#surfaces = new Map<string, OwnedSurface>();
	#subscribers = new Set<Subscriber>();
	#watchers = new Set<SurfaceWatcher>();
	#closed = false;
	#revision = 0;
	readonly #file: DurableJsonFile | undefined;
	#final: SurfacesDocument | undefined;
	constructor(private readonly options: A2uiStoreOptions = {}) {
		this.#file = options.persistPath === undefined
			? undefined
			: new DurableJsonFile(options.persistPath, options.logger === undefined ? {} : { logger: options.logger });
		this.#restore();
	}

	/** B1: the document follows a committed change within 250 ms. */
	#changed(): void {
		if (!this.#closed) this.#file?.schedule(() => this.#document());
	}
	/** Once closing, the state frozen at shutdown: a write still queued then must not record the cleared map. */
	#document(): SurfacesDocument {
		if (this.#final !== undefined) return this.#final;
		return {
			version: 1,
			revision: this.#revision,
			surfaces: [...this.#surfaces.values()].map(({ owner, snapshot }) => ({ owner, snapshot })),
		};
	}
	/** B1 / G5: loads `surfaces.json`, re-validating every surface and applying today's caps; actions start empty. */
	#restore(): void {
		const file = this.#file;
		const raw = file?.read();
		if (file === undefined || raw === undefined) return;
		const document = raw as Partial<SurfacesDocument> | null;
		if (
			document === null || typeof document !== 'object' || document.version !== 1 || !Array.isArray(document.surfaces)
		) {
			this.options.logger?.warn(`${file.path} is not a version 1 surface document; starting empty`);
			return;
		}
		let skipped = 0;
		const perOwner = new Map<string, number>();
		for (const entry of document.surfaces) {
			const surface = storedSurface(entry);
			const count = surface === null ? 0 : perOwner.get(surface.owner) ?? 0;
			const key = surface === null ? '' : JSON.stringify([surface.owner, surface.snapshot.surfaceId]);
			if (surface === null || count >= 32 || this.#surfaces.size >= 1024 || this.#surfaces.has(key)) {
				skipped++;
				continue;
			}
			perOwner.set(surface.owner, count + 1);
			this.#surfaces.set(key, { owner: surface.owner, snapshot: surface.snapshot, actions: new Map() });
			this.#revision = Math.max(this.#revision, surface.snapshot.revision);
		}
		const revision = document.revision;
		if (typeof revision === 'number' && Number.isSafeInteger(revision)) {
			this.#revision = Math.max(this.#revision, revision);
		}
		if (skipped > 0) {
			this.options.logger?.warn(`${file.path}: ${skipped} surfaces were malformed or over a cap and were skipped`);
			this.#changed();
		}
	}

	#owned(principal: string, id: string): OwnedSurface {
		const surface = this.#surfaces.get(JSON.stringify([principal, id]));
		if (!surface || surface.owner !== principal) throw new HttpProblem('not-found');
		return surface;
	}
	/** Validates the complete proposed state before committing a single revision. */
	publish(principal: string, input: unknown): Record<string, unknown> {
		if (this.#closed) throw new HttpProblem('invalid-request', 'A2UI store is closed');
		validateA2uiJson(input);
		// The specification's own spellings (no `version`, the basic catalog's id) mean the local catalog's message.
		const message = A2uiMessageSchema.parse(normalizeA2uiMessage(input));
		if ('deleteSurface' in message) return this.delete(principal, message.deleteSurface.surfaceId);
		let owned: OwnedSurface;
		if ('createSurface' in message) {
			const { surfaceId } = message.createSurface;
			const key = JSON.stringify([principal, surfaceId]);
			if (this.#surfaces.has(key)) {
				this.#owned(principal, surfaceId);
				throw new HttpProblem('invalid-request', 'Surface already exists');
			}
			if (
				this.#surfaces.size >= 1024 ||
				[...this.#surfaces.values()].filter((value) => value.owner === principal).length >= 32
			) {
				throw new HttpProblem('rate-limited', 'A2UI surface limit exceeded');
			}
			owned = {
				owner: principal,
				snapshot: {
					surfaceId,
					catalogId: A2UI_CATALOG_ID,
					revision: ++this.#revision,
					components: [],
					dataModel: {},
					// D-111: the closed theme travels with the surface; the SPA maps it onto kit tokens.
					...(message.createSurface.theme === undefined ? {} : { theme: message.createSurface.theme }),
					...(message.createSurface.workspaceId === undefined
						? {}
						: { workspaceId: message.createSurface.workspaceId }),
				},
				actions: new Map(),
			};
			this.#surfaces.set(key, owned);
		} else {
			const update = 'updateComponents' in message ? message.updateComponents : message.updateDataModel;
			owned = this.#owned(principal, update.surfaceId);
			const snapshot = structuredClone(owned.snapshot);
			if ('updateComponents' in message) {
				validateA2uiTree(message.updateComponents.components);
				const map = new Map(snapshot.components.map((component) => [component.id, component]));
				for (const component of message.updateComponents.components) map.set(component.id, component);
				snapshot.components = [...map.values()];
				validateA2uiTree(snapshot.components);
			} else {snapshot.dataModel = updateA2uiModel(
					snapshot.dataModel,
					message.updateDataModel.path ?? '/',
					message.updateDataModel.value,
				);}
			snapshot.revision = ++this.#revision;
			validateA2uiJson(snapshot);
			owned.snapshot = snapshot;
			owned.actions.clear();
		}
		this.#emit(principal);
		this.#changed();
		return { surface: structuredClone(owned.snapshot) };
	}
	/**
	 * Attaches an owned surface to a coding workspace, or detaches it with `null`, as a new revision; components, data
	 * and theme stay as they are. The id is only a label the control plane groups by — it grants nothing, so it is
	 * checked for shape (a UUID, as `sandbox_create` issues) and not looked up. Registered actions are dropped like on
	 * every other revision: they were authorized against the previous one.
	 */
	attach(principal: string, surfaceId: string, workspaceId: unknown): Record<string, unknown> {
		if (this.#closed) throw new HttpProblem('invalid-request', 'A2UI store is closed');
		if (workspaceId !== null && !z.uuid().safeParse(workspaceId).success) {
			throw new HttpProblem('invalid-request', 'workspaceId must be a workspace id (a UUID) or null');
		}
		const owned = this.#owned(principal, surfaceId);
		const snapshot = structuredClone(owned.snapshot);
		if (workspaceId === null) delete snapshot.workspaceId;
		else snapshot.workspaceId = workspaceId as string;
		snapshot.revision = ++this.#revision;
		owned.snapshot = snapshot;
		owned.actions.clear();
		this.#emit(principal);
		this.#changed();
		return { surface: structuredClone(snapshot) };
	}
	/** Registers an action after the trusted runtime has verified the referenced target. */
	registerAction(principal: string, surfaceId: string, componentId: string, name: string, binding: A2uiBinding): void {
		const owned = this.#owned(principal, surfaceId);
		const component = owned.snapshot.components.find((value) => value.id === componentId);
		if (
			!component || component.component !== 'Button' || component.action.event.name !== name ||
			(binding.kind === 'toolAction' ? binding.name !== name : binding.kind !== name)
		) {
			throw new HttpProblem('invalid-request', 'Unknown A2UI action component');
		}
		owned.actions.set(`${componentId}:${name}`, structuredClone(binding));
		this.#emit(principal);
	}
	/** Deletes surface state and registered actions together. */
	delete(principal: string, surfaceId: string): Record<string, unknown> {
		this.#owned(principal, surfaceId);
		this.#surfaces.delete(JSON.stringify([principal, surfaceId]));
		this.#emit(principal);
		this.#changed();
		return { removed: true, surfaceId };
	}
	/**
	 * D-111: the document of one `Html` component on an owned surface, for the sandboxed route. Any other owner, a
	 * missing surface or component, and a component of another kind all read as not found.
	 */
	html(principal: string, surfaceId: string, componentId: string): string {
		const component = this.#owned(principal, surfaceId).snapshot.components.find((value) => value.id === componentId);
		if (component?.component !== 'Html') throw new HttpProblem('not-found');
		return component.html;
	}
	/** A fresh copy of one owned surface, without its action registrations; not found for any other owner. */
	get(principal: string, surfaceId: string): A2uiSurface {
		return structuredClone(this.#owned(principal, surfaceId).snapshot);
	}
	/**
	 * Watches one owned surface: `onChange` receives a fresh snapshot each time its revision moves, and `null` once it
	 * is deleted (or the store closes), after which the watch is over. Read-only — a watcher gains no action
	 * authority. Throws `not-found` for a surface the owner does not have and `rate-limited` past the watcher caps.
	 */
	watch(principal: string, surfaceId: string, onChange: (surface: A2uiSurface | null) => void): () => void {
		const current = this.#owned(principal, surfaceId);
		if (
			this.#closed || this.#watchers.size >= A2UI_MAX_WATCHERS ||
			[...this.#watchers].filter((watcher) => watcher.owner === principal).length >= A2UI_MAX_WATCHERS_PER_OWNER
		) {
			throw new HttpProblem('rate-limited', 'A2UI surface watch limit reached');
		}
		const watcher: SurfaceWatcher = { owner: principal, surfaceId, onChange, revision: current.snapshot.revision };
		this.#watchers.add(watcher);
		return () => {
			this.#watchers.delete(watcher);
		};
	}
	#notifyWatchers(principal: string): void {
		for (const watcher of [...this.#watchers]) {
			if (watcher.owner !== principal) continue;
			const surface = this.#surfaces.get(JSON.stringify([principal, watcher.surfaceId]));
			try {
				if (surface === undefined) {
					this.#watchers.delete(watcher);
					watcher.onChange(null);
				} else if (surface.snapshot.revision !== watcher.revision) {
					watcher.revision = surface.snapshot.revision;
					watcher.onChange(structuredClone(surface.snapshot));
				}
			} catch {
				// A watcher's failure is its own (a closed socket); it never fails the change that notified it.
			}
		}
	}
	/** Returns fresh owner-only snapshots. */
	list(principal: string): Record<string, unknown> {
		return {
			surfaces: [...this.#surfaces.values()].filter((value) => value.owner === principal).map((value) => ({
				...structuredClone(value.snapshot),
				availableActions: [...value.actions.keys()],
			})),
		};
	}
	/** Subscriptions have bounded buffering; cancel releases state without canceling agent work. */
	stream(principal: string): Response {
		if (
			this.#closed || this.#subscribers.size >= 64 ||
			[...this.#subscribers].filter((sub) => sub.owner === principal).length >= 4
		) {
			throw new HttpProblem('rate-limited', 'A2UI stream limit reached');
		}
		let subscriber: Subscriber | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const dispose = (): void => {
					if (subscriber) this.#subscribers.delete(subscriber);
				};
				subscriber = { owner: principal, controller, dispose };
				this.#subscribers.add(subscriber);
				controller.enqueue(this.#event(principal));
			},
			cancel: () => subscriber?.dispose(),
		}, { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength });
		return new Response(body, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
		});
	}
	#event(principal: string): Uint8Array {
		return new TextEncoder().encode(`event: surfaces\ndata: ${JSON.stringify(this.list(principal))}\n\n`);
	}
	#emit(principal: string): void {
		this.#notifyWatchers(principal);
		for (const subscriber of this.#subscribers) {
			if (subscriber.owner !== principal) continue;
			if ((subscriber.controller.desiredSize ?? 0) <= 0) {
				subscriber.dispose();
				subscriber.controller.close();
			} else subscriber.controller.enqueue(this.#event(principal));
		}
	}
	/** Authorizes the stored revision and consumes an action before asynchronous dispatch. */
	async action(principal: string, scopes: ReadonlySet<string>, input: unknown): Promise<Record<string, unknown>> {
		if (!scopes.has('agent:invoke')) throw new HttpProblem('forbidden-scope');
		validateA2uiJson(input);
		const event = A2uiActionSchema.parse(input);
		const owned = this.#owned(principal, event.action.surfaceId);
		if (owned.snapshot.revision !== event.metadata.revision) {
			throw new HttpProblem('invalid-request', 'Stale A2UI revision');
		}
		const key = `${event.action.sourceComponentId}:${event.action.name}`;
		const binding = owned.actions.get(key);
		if (!binding) throw new HttpProblem('invalid-request', 'Unknown or consumed A2UI action');
		const component = owned.snapshot.components.find((value) => value.id === event.action.sourceComponentId);
		if (!component || component.component !== 'Button') throw new HttpProblem('invalid-request');
		const context: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(component.action.event.context ?? {})) {
			context[name] =
				typeof value === 'object' && value !== null && Object.keys(value).length === 1 && 'path' in value &&
					typeof value.path === 'string'
					? readA2uiPointer(owned.snapshot.dataModel, value.path)
					: value;
		}
		if (JSON.stringify(context) !== JSON.stringify(event.action.context)) {
			throw new HttpProblem('invalid-request', 'A2UI context differs from server state');
		}
		owned.actions.delete(key);
		this.#emit(principal);
		if (binding.kind === 'cancelTask' && this.options.cancelTask) {
			return await this.options.cancelTask(principal, scopes, binding.taskId);
		}
		if (binding.kind === 'permissionDecision' && this.options.permissionDecision) {
			return await this.options.permissionDecision(principal, scopes, binding.requestId, binding.optionId);
		}
		if (binding.kind === 'toolAction' && this.options.toolAction) {
			return await this.options.toolAction(principal, scopes, binding.name, context);
		}
		throw new HttpProblem('invalid-request', 'A2UI action backend unavailable');
	}
	/**
	 * Releases subscriptions and owner state. B1: with a data directory the surfaces are written first, so they
	 * come back after a restart; the returned promise settles once that write has landed.
	 */
	close(): Promise<void> {
		const final = this.#closed || this.#file === undefined ? undefined : structuredClone(this.#document());
		this.#final ??= final;
		this.#closed = true;
		for (const watcher of [...this.#watchers]) {
			this.#watchers.delete(watcher);
			try {
				watcher.onChange(null);
			} catch { /* the watcher's socket is already gone */ }
		}
		for (const subscriber of this.#subscribers) {
			subscriber.controller.close();
			subscriber.dispose();
		}
		this.#surfaces.clear();
		return this.#file?.close(final) ?? Promise.resolve();
	}
}

const BYE = new TextEncoder().encode('event: bye\ndata: {"reason":"stream-expired"}\n\n');

/**
 * Why a guarded stream was ended by the guard rather than by its source: the principal's re-check failed, the
 * lifetime ran out, or the server is shutting down.
 */
export type StreamEndReason = 'unauthorized' | 'expired' | 'shutdown';

/**
 * A6 (D-106): the terminal event of a guarded A2A stream — a JSON-RPC error carrying the request's id (or, on the
 * HTTP+JSON binding, the bare error object), so an A2A client sees the stream fail and resubscribes, where an
 * `event: bye` would have been an unnamed SSE event it ignores. `-32000` is in JSON-RPC's implementation-defined
 * server range and is not one of A2A's own codes; `data.reason` names the cause.
 */
export const A2A_STREAM_ENDED = -32000;
export function a2aStreamFarewell(rpcId: string | number | null | undefined): (reason: StreamEndReason) => Uint8Array {
	return (reason) => {
		const error = {
			code: A2A_STREAM_ENDED,
			message: reason === 'unauthorized'
				? 'Stream ended: the credential is no longer authorized'
				: reason === 'expired'
				? 'Stream ended: lifetime reached; resubscribe with SubscribeToTask'
				: 'Stream ended: the server is shutting down',
			data: { reason: reason === 'expired' ? 'stream-expired' : reason === 'shutdown' ? 'server-shutdown' : reason },
		};
		const event = rpcId === undefined ? { error } : { jsonrpc: '2.0', id: rpcId, error };
		return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
	};
}

/** Timings for {@linkcode StreamGuard}; the defaults are the session event stream's own. */
export interface StreamGuardOptions {
	readonly revalidateMs?: number;
	readonly lifetimeMs?: number;
}

/**
 * GW-3: bounds the A2UI and agent-task event streams the way `eventstream.ts` bounds a session stream.
 *
 * Both were opened once and then stood on that one authorization decision for as long as the client held them:
 * after a key rotation the old key's open A2UI stream kept receiving the owner's surfaces, and an expired OAuth
 * token streamed indefinitely. A long-lived stream **is** a cached decision, and §2.1 allows none, so each one
 * re-earns it every {@linkcode EVENT_STREAM_REVALIDATE_MS} (the gateway's 300 s horizon) and ends outright at
 * {@linkcode EVENT_STREAM_LIFETIME_MS}; the client reconnects and presents its credential again. The timers are
 * unref'd and live outside `pull`, so a consumer that stops reading is bounded as well. `revalidateAll` lets the
 * gateway apply a key reload or a logout immediately instead of at the next tick.
 */
export class StreamGuard {
	readonly #open = new Set<{ check(): void; end(): void }>();
	readonly revalidateMs: number;
	readonly lifetimeMs: number;
	constructor(options: StreamGuardOptions = {}) {
		this.revalidateMs = options.revalidateMs ?? EVENT_STREAM_REVALIDATE_MS;
		this.lifetimeMs = options.lifetimeMs ?? EVENT_STREAM_LIFETIME_MS;
	}
	/** Streams open right now. */
	get size(): number {
		return this.#open.size;
	}
	/**
	 * Wraps an SSE body. `authorized` re-checks the principal behind it — credential still in force **and** the
	 * route's scope still held; `false` (or a throw) ends the stream with a `bye` and releases `source`.
	 *
	 * `farewell` (A6) replaces the `bye` with the stream's own terminal event — an A2A stream's JSON-RPC error. A
	 * stream whose source ends on its own (its task finished) ends without one, as before.
	 */
	wrap(
		source: ReadableStream<Uint8Array>,
		authorized: () => boolean,
		farewell: (reason: StreamEndReason) => Uint8Array = () => BYE,
	): ReadableStream<Uint8Array> {
		const reader = source.getReader();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let ended = false;
		const end = (reason: StreamEndReason | null): void => {
			if (ended) return;
			ended = true;
			clearTimeout(lifetime);
			clearInterval(timer);
			this.#open.delete(entry);
			try {
				if (reason !== null) controller?.enqueue(farewell(reason));
				controller?.close();
			} catch {
				// The consumer has already gone away.
			}
			void reader.cancel().catch(() => {});
		};
		const entry = {
			check: (): void => {
				let ok = false;
				try {
					ok = authorized();
				} catch {
					// A fault in the check fails closed.
				}
				if (!ok) end('unauthorized');
			},
			end: (): void => end('shutdown'),
		};
		const lifetime = setTimeout(() => end('expired'), this.lifetimeMs);
		const timer = setInterval(entry.check, this.revalidateMs);
		Deno.unrefTimer(lifetime);
		Deno.unrefTimer(timer);
		this.#open.add(entry);
		return new ReadableStream<Uint8Array>({
			start: (value): void => {
				controller = value;
			},
			pull: async (value): Promise<void> => {
				const next = await reader.read().catch((): ReadableStreamReadDoneResult<Uint8Array> => ({ done: true }));
				if (ended) return;
				if (next.done) end(null);
				else value.enqueue(next.value);
			},
			cancel: (): void => end(null),
		});
	}
	/** Re-checks every open stream now: a key reload or a logout must not wait for the next tick. */
	revalidateAll(): void {
		for (const entry of [...this.#open]) entry.check();
	}
	/** Ends every open stream; called at shutdown. */
	closeAll(): void {
		for (const entry of [...this.#open]) entry.end();
	}
}

/**
 * D-111: the policy an agent's `Html` document is served under. `sandbox` with no tokens gives the document an
 * opaque origin with no scripts, forms, pop-ups or top navigation even when it is opened directly rather than
 * framed; `default-src 'none'` leaves it no network at all (inline styles and `data:` images and fonts only); and
 * `frame-ancestors 'self'` lets only the control plane frame it.
 */
export const A2UI_HTML_CSP =
	"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

/** Every header the `Html` route sets, so the route and its test read one definition. */
export const A2UI_HTML_HEADERS: Readonly<Record<string, string>> = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': A2UI_HTML_CSP,
	'x-content-type-options': 'nosniff',
	'cache-control': 'no-store',
	'cross-origin-resource-policy': 'same-origin',
};

/** Optional wiring for {@linkcode attachA2uiRoutes}; the gateway passes both. */
export interface A2uiRouteOptions {
	/** GW-3: the guard that bounds `GET /api/v1/a2ui/events`; a private one on the default horizons otherwise. */
	readonly streams?: StreamGuard;
	/**
	 * GW-3: true while the principal's credential is in force and still holds `agent:invoke`. Without one only
	 * the lifetime applies and the scope is re-read from the principal as it was at open.
	 */
	readonly authorized?: (principal: Principal) => boolean;
	/**
	 * D-143 (addendum B): what `GET /api/v1/a2ui/actions` lists — the gateway passes `ExpansionServices.actionNames`
	 * (built-ins plus the configured names, sorted). The built-ins alone when nothing is passed.
	 */
	readonly actionNames?: readonly string[];
}

/** Attach behind the gateway's host/auth/rate middleware, never as a public mount. */
export function attachA2uiRoutes(
	app: Hono<{ Variables: AppVariables }>,
	store: A2uiStore,
	publish: (principal: string, message: unknown) => Record<string, unknown> = (principal, message) =>
		store.publish(principal, message),
	options: A2uiRouteOptions = {},
): void {
	const streams = options.streams ?? new StreamGuard();
	const authorized = options.authorized ?? ((principal: Principal): boolean => principal.scopes.has('agent:invoke'));
	// GW-6: each route names its own scope. The former wildcard gate chose `agent:invoke` for any path *ending*
	// in `/actions`, so `DELETE /api/v1/a2ui/surfaces/actions` deleted a surface without `a2ui:publish`.
	const requires =
		(scope: 'agent:invoke' | 'a2ui:publish') =>
		async (ctx: Context<{ Variables: AppVariables }>, next: () => Promise<void>): Promise<Response | void> => {
			if (!ctx.get('principal').scopes.has(scope)) return problemResponse('forbidden-scope', ctx.get('requestId'));
			await next();
		};
	async function respond(
		ctx: Context<{ Variables: AppVariables }>,
		run: () => Response | Promise<Response>,
	): Promise<Response> {
		try {
			return await run();
		} catch (cause) {
			return cause instanceof HttpProblem
				? problemResponse(cause.slug, ctx.get('requestId'), cause.detail)
				: problemResponse('invalid-request', ctx.get('requestId'), 'Invalid A2UI request');
		}
	}
	async function read(request: Request): Promise<unknown> {
		const reader = request.body?.getReader();
		if (!reader) throw new HttpProblem('invalid-request');
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > A2UI_MAX_BYTES) {
					await reader.cancel();
					throw new HttpProblem('payload-too-large');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes));
	}
	app.get(
		'/api/v1/a2ui/surfaces',
		requires('agent:invoke'),
		(ctx) => respond(ctx, () => ctx.json(store.list(expansionOwner(ctx.get('principal'))))),
	);
	app.post(
		'/api/v1/a2ui/surfaces',
		requires('a2ui:publish'),
		(ctx) => respond(ctx, async () => ctx.json(publish(expansionOwner(ctx.get('principal')), await read(ctx.req.raw)))),
	);
	// D-111: an `Html` component is served only here, owner-bound, under A2UI_HTML_CSP, for an `<iframe sandbox>`.
	app.get(
		'/api/v1/a2ui/surfaces/:surfaceId/html/:componentId',
		requires('agent:invoke'),
		(ctx) =>
			respond(ctx, () =>
				new Response(
					store.html(
						expansionOwner(ctx.get('principal')),
						ctx.req.param('surfaceId') ?? '',
						ctx.req.param('componentId') ?? '',
					),
					{ headers: A2UI_HTML_HEADERS },
				)),
	);
	// A surface's workspace: `{ workspaceId: <uuid> | null }`, nothing else. Publishing is the scope that changes a surface.
	app.patch(
		'/api/v1/a2ui/surfaces/:id',
		requires('a2ui:publish'),
		(ctx) =>
			respond(ctx, async () => {
				const body = await read(ctx.req.raw);
				if (
					body === null || typeof body !== 'object' || Array.isArray(body) ||
					Object.keys(body).join() !== 'workspaceId'
				) throw new HttpProblem('invalid-request', 'Expected { "workspaceId": <workspace id> | null }');
				return ctx.json(
					store.attach(
						expansionOwner(ctx.get('principal')),
						ctx.req.param('id') ?? '',
						(body as { workspaceId: unknown }).workspaceId,
					),
				);
			}),
	);
	app.delete(
		'/api/v1/a2ui/surfaces/:id',
		requires('a2ui:publish'),
		(ctx) =>
			respond(ctx, () => ctx.json(store.delete(expansionOwner(ctx.get('principal')), ctx.req.param('id') ?? ''))),
	);
	app.get('/api/v1/a2ui/events', requires('agent:invoke'), (ctx) =>
		respond(ctx, () => {
			const principal = ctx.get('principal');
			const response = store.stream(expansionOwner(principal));
			// GW-3: re-checked on the gateway's horizon and bounded by a lifetime, like the session event stream.
			return new Response(streams.wrap(response.body!, () => authorized(principal)), { headers: response.headers });
		}));
	// D-143 (addendum B): the action names a surface may bind, under the read scope every other A2UI read uses. Names
	// only — a reader holding `agent:invoke` but not `mcp:invoke` must not learn which tool sits behind a button.
	const actionNames = options.actionNames ?? ['cancelTask', 'permissionDecision'];
	app.get(
		'/api/v1/a2ui/actions',
		requires('agent:invoke'),
		(ctx) => respond(ctx, () => ctx.json({ names: actionNames })),
	);
	app.post(
		'/api/v1/a2ui/actions',
		requires('agent:invoke'),
		(ctx) =>
			respond(
				ctx,
				async () =>
					ctx.json(
						await store.action(
							expansionOwner(ctx.get('principal')),
							ctx.get('principal').scopes,
							await read(ctx.req.raw),
						),
					),
			),
	);
}
