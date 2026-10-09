/**
 * A minimal MCP client for the SPA: stateless JSON-RPC over `POST /mcp`.
 *
 * The gateway's default mount is stateless per request (the 2026-07-28 shape),
 * so there is no `initialize` handshake and no transport session to hold — an
 * `initialize` declaring a 2025 protocol would be routed to the stateful mount
 * and leave a transport session behind for nothing. Every call is one POST with
 * the same bearer credential as the rest of the API, through `send`.
 *
 * The reply is either a JSON body or a `text/event-stream` carrying the
 * response as one `message` event; both are accepted.
 */
import { send } from './api.ts';
import { onSignOut } from './lifecycle.ts';

/** The subset of JSON Schema `tools/list` produces from the server's Zod schemas. */
export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	const?: unknown;
	format?: string;
	description?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	maxLength?: number;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	allOf?: JsonSchema[];
}

export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: JsonSchema;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	resource?: ResourceContents;
}

export interface CallToolResult {
	content?: ContentBlock[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export interface McpResource {
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpResourceTemplate {
	uriTemplate: string;
	name?: string;
	title?: string;
	description?: string;
}

export interface ResourceContents {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** A JSON-RPC level failure (unknown method, malformed request), as opposed to a tool result. */
export class McpError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = 'McpError';
		this.code = code;
	}
}

/** JSON-RPC "method not found": the server does not offer that capability at all. */
export const METHOD_NOT_FOUND = -32601;

let nextId = 0;

interface RpcReply {
	id?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

/** Picks the reply to `id` out of an SSE body, or the first reply when the server omits ids. */
function fromEventStream(body: string, id: number): RpcReply {
	const replies: RpcReply[] = [];
	for (const block of body.split(/\r?\n\r?\n/)) {
		const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join(
			'\n',
		);
		if (data.trim() === '') continue;
		const parsed = JSON.parse(data) as RpcReply;
		if ('result' in parsed || 'error' in parsed) replies.push(parsed);
	}
	const reply = replies.find((candidate) => candidate.id === id) ?? replies[0];
	if (reply === undefined) throw new McpError(-32603, 'the server sent no response');
	return reply;
}

/** One JSON-RPC request to `/mcp`. */
export async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
	const id = ++nextId;
	const response = await send('/mcp', {
		method: 'POST',
		headers: { accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
	});
	const body = await response.text();
	const reply = (response.headers.get('content-type') ?? '').includes('event-stream')
		? fromEventStream(body, id)
		: JSON.parse(body) as RpcReply;
	if (reply.error !== undefined) throw new McpError(reply.error.code, reply.error.message);
	return reply.result as T;
}

/** Follows `nextCursor` until a list is complete. */
async function paged<T>(method: string, key: string): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const result = await rpc<Record<string, unknown>>(method, cursor === undefined ? undefined : { cursor });
		items.push(...((result[key] as T[] | undefined) ?? []));
		cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
		if (cursor === undefined) break;
	}
	return items;
}

let toolCache: Promise<McpTool[]> | null = null;

export const mcp = {
	/**
	 * The tools this credential is served. Cached for the page's lifetime because
	 * the list only changes with deployment configuration; `refresh` re-asks.
	 */
	tools(refresh = false): Promise<McpTool[]> {
		if (refresh || toolCache === null) {
			toolCache = paged<McpTool>('tools/list', 'tools');
			toolCache.catch(() => {
				toolCache = null;
			});
		}
		return toolCache;
	},
	call: (name: string, args: Record<string, unknown>) => rpc<CallToolResult>('tools/call', { name, arguments: args }),
	resources: () => paged<McpResource>('resources/list', 'resources'),
	templates: () => paged<McpResourceTemplate>('resources/templates/list', 'resourceTemplates'),
	read: async (uri: string) => (await rpc<{ contents: ResourceContents[] }>('resources/read', { uri })).contents,
	prompts: () => paged<{ name: string; title?: string; description?: string }>('prompts/list', 'prompts'),
	/** Forgets cached lists, for a new credential. */
	reset(): void {
		toolCache = null;
	},
};

// The tool list is what one credential is served; the next credential must ask again.
onSignOut(() => mcp.reset());

/** The server's stable error code for a failed tool result, or `null` on success. */
export function errorCodeOf(result: CallToolResult): string | null {
	if (result.isError !== true) return null;
	const structured = result.structuredContent?.error as { code?: unknown } | undefined;
	if (typeof structured?.code === 'string') return structured.code;
	const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
	return /^Error: ([a-z-]+):/.exec(text)?.[1] ?? 'tool-error';
}

/** The human-readable message of a failed tool result. */
export function errorMessageOf(result: CallToolResult): string {
	const structured = result.structuredContent?.error as { message?: unknown } | undefined;
	if (typeof structured?.message === 'string') return structured.message;
	return result.content?.find((block) => block.type === 'text')?.text ?? 'The tool reported an error.';
}

/**
 * Calls a tool and returns its structured result, throwing on a tool error.
 *
 * For the UI's own shortcuts, which want data and an exception — the console
 * calls `mcp.call` directly because there a failure *is* the result to show.
 */
export async function invoke<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await mcp.call(name, args);
	if (result.isError === true) throw new Error(`${errorCodeOf(result)}: ${errorMessageOf(result)}`);
	if (result.structuredContent !== undefined) return result.structuredContent as T;
	const text = result.content?.find((block) => block.type === 'text')?.text;
	try {
		return (text === undefined ? {} : JSON.parse(text)) as T;
	} catch {
		return { text } as T;
	}
}
