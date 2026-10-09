/**
 * Sessions as MCP resources (SPECS/ROADMAP.md R4).
 *
 * A tool call is a *request*: the model has to decide to look. A resource is
 * something a client can attach to a conversation, re-read, and subscribe to —
 * which is the right shape for "what is on the screen right now". Declaring the
 * live pages as resources means a host can put the current screenshot in front
 * of its user without the model spending a turn asking for it.
 *
 * Three per session, addressed by a template so a new session needs no
 * registration:
 *
 * - `ttk://session/{id}/state`      — the JSON `browser_get_state` returns
 * - `ttk://session/{id}/screenshot` — a PNG of the focused tab
 * - `ttk://session/{id}/page`       — the serialized page text alone
 *
 * Reads are live: the resource is not a cache of the last tool call, it builds
 * a fresh observation. A stale screenshot is worse than none, because a human
 * looking at it has no way to tell.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { ReadResourceResult } from '@modelcontextprotocol/server';
import { encodeBase64 } from '@std/encoding/base64';
import type { TykotechCapabilities } from './capabilities.ts';
import { sessionCompleters } from './completions.ts';
import { observationPayload, observe } from './observe.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';

/** URI scheme for everything this server exposes as a resource. */
export const RESOURCE_SCHEME = 'ttk';

/**
 * The discovery resource (B3.1, §8 location 2): `ttk://capabilities`.
 *
 * A fixed URI rather than a template, because there is exactly one of it per connection and its
 * content is already narrowed to the connecting principal. It carries the same object the
 * `initialize` result's `capabilities.tykotech` carries — one builder, two read points — so a client
 * that reconnects rarely can re-read it instead, and a client on a transport that hides the
 * `initialize` result can read it at all.
 */
export const CAPABILITIES_URI = `${RESOURCE_SCHEME}://capabilities`;

/** The three per-session resource kinds. */
export const RESOURCE_KINDS = ['state', 'screenshot', 'page'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The URI for one session resource. */
export function resourceUri(sessionId: string, kind: ResourceKind): string {
	return `${RESOURCE_SCHEME}://session/${encodeURIComponent(sessionId)}/${kind}`;
}

/**
 * The URI of one downloaded file (E-33): `ttk://session/{sessionId}/files/{fileId}`.
 *
 * A distinct template rather than a fourth `kind`, so a file id can never be mistaken for a
 * resource kind and the two templates cannot match each other's URIs (`{kind}` stops at `/`).
 */
export function fileResourceUri(sessionId: string, fileId: string): string {
	return `${RESOURCE_SCHEME}://session/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`;
}

const FILE_URI = new RegExp(`^${RESOURCE_SCHEME}://session/([^/]+)/files/([^/]+)$`);

/** Parses a file resource URI, or returns `null` for anything else. The gateway routes on this. */
export function parseFileResourceUri(uri: string): { sessionId: string; fileId: string } | null {
	const match = FILE_URI.exec(uri);
	if (match === null) return null;
	try {
		return { sessionId: decodeURIComponent(match[1] ?? ''), fileId: decodeURIComponent(match[2] ?? '') };
	} catch {
		return null;
	}
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

/**
 * Registers the session resource template on a server instance.
 *
 * The `list` callback enumerates the sessions that exist *now*, so
 * `resources/list` is an honest picture of the browser rather than a static
 * declaration.
 *
 * **Scoped, and the scope set is a required argument rather than an option.**
 * These resources carry the same page content the tools do — the element tree,
 * the serialized text, a PNG of the screen, and any downloaded file — so they
 * take `mcp:invoke`, exactly as the tool catalog and `SPECS/API-CONTRACT.md`
 * route 14 do: watching a browser is not permission to carry off its documents.
 * Until B1.5 this function took no scopes at all and was called outside the
 * catalog's scope loop, so a `view:watch`-only credential — or an OAuth token
 * whose scope claim matched nothing, which yields an empty set — could read
 * the whole observation through `resources/read`. A principal without the scope
 * gets no registration, so the resources are absent from `resources/list` and a
 * read is unknown rather than refused, which is the same answer the tool
 * catalog gives.
 *
 * **`access` narrows both templates to the caller's sessions** (R8, D-128): in `owner` mode a list carries only the
 * sessions the caller may reach and a read of another owner's URI is unknown, exactly as the tools answer. The same
 * access is closed over by the templates' completers (R13, D-129), because a completer is handed no caller.
 */
export function registerResources(
	server: McpServer,
	registry: SessionRegistry,
	scopes: ReadonlySet<Scope>,
	capabilities?: TykotechCapabilities,
	access?: SessionAccess,
): void {
	// B3.1: registered before the `mcp:invoke` gate, deliberately. The block is
	// already scope-filtered by its builder, and a `view:watch` credential that
	// cannot read a page is still entitled to learn which live-view features the
	// deployment offers it — which is the entire point of a discovery surface.
	// It carries no page content, so the reason the session resources are gated
	// does not apply to it.
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

			// `peek`, not `resolve`: reading a resource must never *create* a
			// browser. A client listing resources it holds should not be able to
			// launch Chromium by refreshing a stale URI. `peekFor` (D-128): another
			// owner's session reads as absent in `owner` mode.
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
			if (kind === 'page') {
				return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: observation.page }] };
			}
			return {
				contents: [{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(observationPayload(observation), null, 2),
				}],
			};
		},
	);

	// E-33: downloaded files. The list enumerates only files that can actually be
	// read — pending and failed downloads are the listing tool's business — and
	// the read shares the tool's bounded, re-validated read, so a host following
	// a resource link and a model calling browser_get_file get identical bytes.
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
