/**
 * D-080: resource change notifications for a long-lived server instance — a stateful 2025 transport session
 * or a stdio connection.
 *
 * The stateless HTTP mount pushes through its handler's own event bus (gateway `app.ts`). An instance that owns a
 * connection has to push itself, and before D-080 nothing did, so the clients that took the stateful mount for
 * its standalone stream got nothing on it, and stdio clients never heard of a new session or a finished download.
 *
 * Per era:
 * - **2025 (legacy):** `resources/list_changed` goes to everyone; `resources/updated` only for URIs the client
 *   asked for with `resources/subscribe`, which this module serves (and advertises as `resources.subscribe`).
 * - **2026 (modern):** the SDK's own `subscriptions/listen` router owns delivery and filtering, so every change is
 *   handed to it and it drops what no subscription asked for.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import { resourceUris } from './resources.ts';

/** Subscriptions one connection may hold; past it a subscribe is refused rather than growing without bound. */
export const MAX_RESOURCE_SUBSCRIPTIONS = 256;
const MAX_URI_CHARS = 1024;

export interface ResourceWatch {
	/** URIs this connection subscribed to (legacy era), for tests and diagnostics. */
	readonly subscriptions: ReadonlySet<string>;
	/** Stops listening to the registry. */
	close(): void;
}

/**
 * Wires `registry` changes to `server`'s notifications. Call before the server connects: the `resources.subscribe`
 * capability must be declared before `initialize` is answered.
 *
 * `access` is the connection's caller (R8, D-128). In `owner` mode a change is announced only for a session that
 * caller may reach — one it was told about, for a session that has since closed — so a connection never learns that
 * another owner's session started, navigated, downloaded or ended. `shared` mode (and a registry stand-in that reports
 * no ownership) announces everything, as before.
 */
export function watchResourceChanges(
	server: McpServer,
	registry:
		& Pick<SessionRegistry, 'watch'>
		& Partial<Pick<SessionRegistry, 'ownership' | 'peek' | 'canAccess' | 'visibleTo'>>,
	era: 'legacy' | 'modern',
	access?: SessionAccess,
): ResourceWatch {
	const subscriptions = new Set<string>();
	const owned = registry.ownership === 'owner';
	/** `owner` mode: the sessions this connection may know exist, so their removal is announced and no other's is. */
	const known = new Set<string>(owned ? (registry.visibleTo?.(access) ?? []).map((record) => record.id) : []);
	const reaches = (sessionId: string): boolean => {
		if (!owned) return true;
		const record = registry.peek?.(sessionId);
		const ok = record !== undefined && registry.canAccess?.(record, access) === true;
		if (ok) known.add(sessionId);
		return ok;
	};
	if (era === 'legacy') {
		server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
		server.server.setRequestHandler('resources/subscribe', (request) => {
			const uri = request.params.uri;
			if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_CHARS) {
				throw new Error('a resource URI of at most 1024 characters is required');
			}
			if (!subscriptions.has(uri) && subscriptions.size >= MAX_RESOURCE_SUBSCRIPTIONS) {
				throw new Error(`at most ${MAX_RESOURCE_SUBSCRIPTIONS} resource subscriptions per connection`);
			}
			subscriptions.add(uri);
			return {};
		});
		server.server.setRequestHandler('resources/unsubscribe', (request) => {
			subscriptions.delete(request.params.uri);
			return {};
		});
	} else {
		server.server.registerCapabilities({ resources: { listChanged: true } });
	}

	const listChanged = (): void => void server.sendResourceListChanged();
	const updated = (uri: string): void => {
		if (era === 'legacy' && !subscriptions.has(uri)) return;
		void server.server.sendResourceUpdated({ uri }).catch(() => {});
	};
	const unwatch = registry.watch((change) => {
		// A connection that is not open yet, or has gone, drops the notification; nothing is queued.
		if (!server.isConnected()) return;
		switch (change.kind) {
			case 'session-added':
			case 'files-changed':
				if (reaches(change.sessionId)) listChanged();
				break;
			case 'session-removed':
				if (!owned || known.delete(change.sessionId)) listChanged();
				break;
			case 'page-changed':
				if (!reaches(change.sessionId)) break;
				for (const uri of resourceUris(change.sessionId)) updated(uri);
				break;
		}
	});
	return { subscriptions, close: unwatch };
}
