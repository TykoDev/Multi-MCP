/**
 * A minimal MCP client: stateless JSON-RPC over `POST /mcp`, through `send` with the page's own sign-in. The default
 * mount is stateless per request, so there is no `initialize` handshake. The reply is a JSON body or a
 * `text/event-stream` carrying it as one `message` event; both are accepted.
 */
import { send } from './api.ts';

interface CallToolResult {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** A JSON-RPC level failure (unknown method, malformed request), as opposed to a tool result. */
class McpError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = 'McpError';
		this.code = code;
	}
}

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
		const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5))
			.join('\n');
		if (data.trim() === '') continue;
		const parsed = JSON.parse(data) as RpcReply;
		if ('result' in parsed || 'error' in parsed) replies.push(parsed);
	}
	const reply = replies.find((candidate) => candidate.id === id) ?? replies[0];
	if (reply === undefined) throw new McpError(-32603, 'the server sent no response');
	return reply;
}

/** One JSON-RPC request to `/mcp`. */
async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
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

/** The server's stable error code for a failed tool result, or `null` on success. */
function errorCodeOf(result: CallToolResult): string | null {
	if (result.isError !== true) return null;
	const structured = result.structuredContent?.error as { code?: unknown } | undefined;
	if (typeof structured?.code === 'string') return structured.code;
	const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
	return /^Error: ([a-z-]+):/.exec(text)?.[1] ?? 'tool-error';
}

/** The human-readable message of a failed tool result. */
function errorMessageOf(result: CallToolResult): string {
	const structured = result.structuredContent?.error as { message?: unknown } | undefined;
	if (typeof structured?.message === 'string') return structured.message;
	return result.content?.find((block) => block.type === 'text')?.text ?? 'The tool reported an error.';
}

/** Calls a tool and returns its structured result, throwing `<code>: <message>` on a tool error. */
export async function invoke<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await rpc<CallToolResult>('tools/call', { name, arguments: args });
	if (result.isError === true) throw new Error(`${errorCodeOf(result)}: ${errorMessageOf(result)}`);
	if (result.structuredContent !== undefined) return result.structuredContent as T;
	const text = result.content?.find((block) => block.type === 'text')?.text;
	try {
		return (text === undefined ? {} : JSON.parse(text)) as T;
	} catch {
		return { text } as T;
	}
}
