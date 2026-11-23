/** Sessions as MCP resources. */
import { McpServer, type ReadResourceResult, ResourceTemplate } from '@modelcontextprotocol/server';
import { encodeBase64 } from '@std/encoding/base64';
import type { TykotechCapabilities } from './capabilities.ts';
import { observationPayload, observe } from './observe.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';
import { redactDeep, type SecretStore } from './secrets.ts';
import { type LibraryStore, walkShare } from './library.ts';

/** URI scheme for everything this server exposes as a resource. */
export const RESOURCE_SCHEME = 'ttk';

/** The discovery resource: `ttk://capabilities`. */
export const CAPABILITIES_URI = `${RESOURCE_SCHEME}://capabilities`;

/** The three per-session resource kinds. */
const RESOURCE_KINDS = ['state', 'screenshot', 'page'] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The URI for one session resource. */
export function resourceUri(sessionId: string, kind: ResourceKind): string {
	return `${RESOURCE_SCHEME}://session/${encodeURIComponent(sessionId)}/${kind}`;
}

/** The URI of one downloaded file: `ttk://session/{sessionId}/files/{fileId}`. */
export function fileResourceUri(sessionId: string, fileId: string): string {
	return `${RESOURCE_SCHEME}://session/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`;
}

/** Every resource URI a session has, in the order they are listed. */
export function resourceUris(sessionId: string): string[] {
	return RESOURCE_KINDS.map((kind) => resourceUri(sessionId, kind));
}

const TITLES: Record<ResourceKind, { title: string; description: string; mimeType: string }> = {
	state: {
		title: 'Page state',
		description: 'URL, title, tabs, scroll position and the interactive-element tree, as JSON.',
		mimeType: 'application/json',
	},
	screenshot: {
		title: 'Screenshot',
		description: 'A PNG of the focused tab, captured when read.',
		mimeType: 'image/png',
	},
	page: {
		title: 'Page text',
		description: 'The serialized visible text of the focused tab.',
		mimeType: 'text/plain',
	},
};

/** Registers the session resource template on a server instance. */
export function registerResources(
	server: McpServer,
	registry: SessionRegistry,
	scopes: ReadonlySet<Scope>,
	capabilities?: TykotechCapabilities,
	access?: SessionAccess,
	secrets?: SecretStore,
): void {
	// Registered before the `mcp:invoke` gate, deliberately.
	if (capabilities !== undefined) {
		server.registerResource(
			'tykotech-capabilities',
			CAPABILITIES_URI,
			{
				title: 'Server capabilities',
				description: 'What this deployment offers this credential: version, live view, events and fields.',
				mimeType: 'application/json',
			},
			(uri): ReadResourceResult => ({
				contents: [{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(capabilities, null, 2),
				}],
			}),
		);
	}
	if (!scopes.has('mcp:invoke')) return;
	const complete = sessionCompleters(registry, access, RESOURCE_KINDS);
	server.registerResource(
		'browser-session',
		new ResourceTemplate(`${RESOURCE_SCHEME}://session/{sessionId}/{kind}`, {
			complete: { sessionId: complete.sessionId, kind: complete.kind },
			list: () => ({
				resources: registry.listFor(access).flatMap((summary) =>
					RESOURCE_KINDS.map((kind) => ({
						uri: resourceUri(summary.session_id, kind),
						name: `${summary.session_id} ${kind}`,
						title: `${TITLES[kind].title} — session ${summary.session_id}`,
						description: TITLES[kind].description,
						mimeType: TITLES[kind].mimeType,
					}))
				),
			}),
		}),
		{
			title: 'Browser session',
			description: 'The live state, screenshot and text of a browser session.',
		},
		async (uri, variables): Promise<ReadResourceResult> => {
			const sessionId = decodeURIComponent(String(variables.sessionId ?? ''));
			const kind = String(variables.kind ?? '') as ResourceKind;
			if (!RESOURCE_KINDS.includes(kind)) {
				throw new Error(`unknown resource kind ${kind}; expected one of ${RESOURCE_KINDS.join(', ')}`);
			}

			// `peek`, not `resolve`: reading a resource must never *create* a browser. A client listing resources it
			// holds should not be able to launch Chromium by refreshing a stale URI.
			const record = registry.peekFor(sessionId, access);
			if (record === undefined) throw new Error(`no session with id ${sessionId}`);

			const observation = await observe(record, { includeScreenshot: kind === 'screenshot' });
			registry.touch(record.id);

			if (kind === 'screenshot') {
				if (observation.screenshot === undefined) throw new Error('the browser returned no screenshot');
				return {
					contents: [{ uri: uri.href, mimeType: 'image/png', blob: observation.screenshot }],
				};
			}
			// The same page content the tools return, so the same exit redaction (secret rule 2, `redactDeep`).
			if (kind === 'page') {
				return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: redactDeep(observation.page, secrets) }] };
			}
			return {
				contents: [{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(redactDeep(observationPayload(observation), secrets), null, 2),
				}],
			};
		},
	);

	// Downloaded files.
	server.registerResource(
		'browser-session-file',
		new ResourceTemplate(`${RESOURCE_SCHEME}://session/{sessionId}/files/{fileId}`, {
			complete: { sessionId: complete.sessionId, fileId: complete.fileId },
			list: () => ({
				resources: registry.visibleTo(access).flatMap((record) => {
					return record.files.list().filter((file) => file.available).map((file) => ({
						uri: fileResourceUri(record.id, file.file_id),
						name: file.name,
						title: `${file.name} — session ${record.id}`,
						description: `A file the browser downloaded (${file.size} bytes).`,
						mimeType: file.mime_type,
						size: file.size,
					}));
				}),
			}),
		}),
		{
			title: 'Downloaded file',
			description: 'A file downloaded by a browser session, as a blob. Files above 1 MiB are fetched over HTTP.',
		},
		async (uri, variables): Promise<ReadResourceResult> => {
			const sessionId = decodeURIComponent(String(variables.sessionId ?? ''));
			const fileId = decodeURIComponent(String(variables.fileId ?? ''));
			// `peek`, for the same reason as above: a stale file URI must never launch a browser.
			const record = registry.peekFor(sessionId, access);
			if (record === undefined) throw new Error(`no session with id ${sessionId}`);
			const { info, bytes } = await record.files.readInline(fileId);
			registry.touch(record.id);
			return { contents: [{ uri: uri.href, mimeType: info.mime_type, blob: encodeBase64(bytes) }] };
		},
	);
}

// --- Resource change notifications for a long-lived server instance — a stateful 2025 transport session or a stdio connection.

/** Subscriptions one connection may hold; past it a subscribe is refused rather than growing without bound. */
const MAX_RESOURCE_SUBSCRIPTIONS = 256;
const MAX_URI_CHARS = 1024;

export interface ResourceWatch {
	/** URIs this connection subscribed to (2025 era), for tests and diagnostics. */
	readonly subscriptions: ReadonlySet<string>;
	/** Stops listening to the registry. */
	close(): void;
}

/** Wires `registry` changes to `server`'s notifications. */
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

// --- `completion/complete` for the resource templates. -----------------------------------------------------------

/** The most values one completion returns; the SDK truncates at the same number. */
export const MAX_COMPLETIONS = 100;

/** The SDK's `CompleteResourceTemplateCallback`, the shape every completer here implements. */
type Completer = (
	value: string,
	context?: { arguments?: Record<string, string> },
) => string[] | Promise<string[]>;

/** Up to {@linkcode MAX_COMPLETIONS} of `values` that start with `prefix`, in their own order, without duplicates. */
export function completeByPrefix(values: Iterable<string>, prefix: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value.startsWith(prefix) || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
		if (out.length >= MAX_COMPLETIONS) break;
	}
	return out;
}

/** A template variable as the client typed it: percent-decoded when it decodes, verbatim otherwise. */
function decoded(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** The completers of the two session templates (`{sessionId}/{kind}`, `{sessionId}/files/{fileId}`). */
interface SessionCompleters {
	readonly sessionId: Completer;
	readonly kind: Completer;
	readonly fileId: Completer;
}

/** Completers over the sessions `access` may reach (`shared` mode: all of them). */
function sessionCompleters(
	registry: Pick<SessionRegistry, 'visibleTo' | 'peekFor'>,
	access: SessionAccess | undefined,
	kinds: readonly string[],
): SessionCompleters {
	return {
		sessionId: (value) => completeByPrefix(registry.visibleTo(access).map((record) => record.id), value),
		kind: (value) => completeByPrefix(kinds, value),
		fileId: (value, context) => {
			// `peekFor`, never `resolve`: completing a file id must not launch a browser. An omitted session is the
			// caller's default, as everywhere else.
			const record = registry.peekFor(decoded(context?.arguments?.sessionId), access);
			if (record === undefined) return [];
			return completeByPrefix(
				record.files.list().filter((file) => file.available).map((file) => file.file_id),
				value,
			);
		},
	};
}

/** The completers of the two library templates (`ttk://share/{+path}`, `ttk://skill/{name}`). */
interface LibraryCompleters {
	readonly path: Completer;
	readonly name: Completer;
}

/**
 * Completers over the library — shared storage, so the only gate is the `files:read` registration already applies.
 */
export function libraryCompleters(store: LibraryStore): LibraryCompleters {
	return {
		path: async (value) => {
			try {
				const entries = await walkShare(store);
				return completeByPrefix(entries.map((entry) => entry.path), value);
			} catch {
				// A share that cannot be read completes to nothing; `resources/list` reports the fault.
				return [];
			}
		},
		name: (value) => completeByPrefix(store.cached().skills.map((skill) => skill.name), value),
	};
}
