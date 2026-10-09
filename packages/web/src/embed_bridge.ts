/**
 * The MCP Apps bridge for the two embeds (R9, design §2.20, D-134): JSON-RPC 2.0 over `postMessage` with the host
 * that frames us, hand-written because the Apps SDK is not a dependency this repository takes.
 *
 * What it speaks, and nothing more:
 *
 * - **to the host:** `ui/initialize` (then `ui/notifications/initialized`), `tools/call`, `ui/open-link`, and the
 *   `ui/notifications/size-changed` notification;
 * - **from the host:** the `ui/notifications/tool-input`, `tool-result`, `tool-cancelled` and
 *   `host-context-changed` notifications, and the `ui/resource-teardown` request, which is answered once the embed
 *   has released what it holds; a `ping` is answered too.
 *
 * `ui/update-model-context` and `ui/message` are never sent (design §2.20): an embed that could talk to the model
 * would be a second, unreviewed prompt channel.
 *
 * **Who it listens to.** Only messages whose `source` is the window that framed us: a sibling frame, a pop-up or a
 * page this document opened can post to us, and none of them is the host. Messages to the host go to `'*'` because a
 * sandboxed frame cannot know its host's origin; nothing the embed sends is secret — the ticket travels the other
 * way, inside the host's answer.
 */

import type { EmbedIconName } from './embed_icons.ts';

export type { EmbedIconName } from './embed_icons.ts';

/** The protocol revision this bridge was written against (SEP-1865, Stable). */
export const APPS_PROTOCOL_VERSION = '2026-01-26';

/** A tool result as the host relays it. */
export interface EmbedToolResult {
	readonly content?: ReadonlyArray<{ type?: string; text?: string }>;
	readonly structuredContent?: Record<string, unknown>;
	readonly isError?: boolean;
}

/** The parts of the host context the embeds use (the host may send more). */
export interface HostContext {
	readonly theme?: string;
	readonly styles?: { readonly variables?: Readonly<Record<string, unknown>> };
}

/** What the embed is told by the host. */
export interface EmbedBridgeHandlers {
	onToolInput?(args: Readonly<Record<string, unknown>>): void;
	onToolResult?(result: EmbedToolResult): void;
	onToolCancelled?(): void;
	onHostContext?(context: HostContext): void;
	/** Releases the socket and anything else held; the host waits for the answer before it removes the frame. */
	onTeardown?(): void | Promise<void>;
}

/** A JSON-RPC failure answered by the host. */
export class BridgeError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = 'BridgeError';
		this.code = code;
	}
}

/** How long a request to the host may stay unanswered: a ticket mint is one tool call. */
const REQUEST_TIMEOUT_MS = 30_000;

type Pending = { resolve(value: unknown): void; reject(cause: Error): void; timer: ReturnType<typeof setTimeout> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bridge, one per embed document. */
export class EmbedBridge {
	readonly #host: Window;
	readonly #handlers: EmbedBridgeHandlers;
	readonly #pending = new Map<number, Pending>();
	#nextId = 0;
	#lastSize = '';
	#listener: ((event: MessageEvent) => void) | null = null;

	constructor(handlers: EmbedBridgeHandlers, host: Window = globalThis.parent) {
		this.#handlers = handlers;
		this.#host = host;
	}

	/** Starts listening, then performs the `ui/initialize` handshake; resolves with the host context, if any. */
	async connect(appInfo: { name: string; version: string }): Promise<HostContext> {
		this.#listener = (event: MessageEvent) => this.#onMessage(event);
		globalThis.addEventListener('message', this.#listener);
		const result = await this.request('ui/initialize', {
			protocolVersion: APPS_PROTOCOL_VERSION,
			appInfo,
			appCapabilities: {},
		});
		this.notify('ui/notifications/initialized', {});
		const context = isRecord(result) && isRecord(result.hostContext) ? result.hostContext as HostContext : {};
		this.#handlers.onHostContext?.(context);
		return context;
	}

	/** One request to the host; rejects with {@linkcode BridgeError} on a JSON-RPC error or a timeout. */
	request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id = ++this.#nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new BridgeError(-32001, `the host did not answer ${method}`));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#post({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.#post({ jsonrpc: '2.0', method, params });
	}

	/** `tools/call` through the host, on this server's connection. */
	async callTool(name: string, args: Record<string, unknown>): Promise<EmbedToolResult> {
		const result = await this.request('tools/call', { name, arguments: args });
		return isRecord(result) ? result as EmbedToolResult : {};
	}

	/** Asks the host to open a link outside the frame (the embed may not navigate itself). */
	async openLink(url: string): Promise<void> {
		await this.request('ui/open-link', { url });
	}

	/**
	 * Reports the document's content size to the host whenever it changes, so the frame fits its content. Measured on
	 * the root element, whose box is the content's and not the frame's (unlike its `scrollHeight`, which never falls
	 * below the frame), so the frame can shrink as well as grow; `element` is observed as well because it is what
	 * changes.
	 */
	watchSize(element: Element): void {
		const root = document.documentElement;
		const report = (): void => {
			const rect = root.getBoundingClientRect();
			const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
			const key = `${size.width}x${size.height}`;
			if (key === this.#lastSize) return;
			this.#lastSize = key;
			this.notify('ui/notifications/size-changed', size);
		};
		const observer = new ResizeObserver(report);
		observer.observe(root);
		observer.observe(element);
		report();
	}

	#post(message: Record<string, unknown>): void {
		try {
			this.#host.postMessage(message, '*');
		} catch {
			// A host that is gone cannot be told; the teardown path has already run or never will.
		}
	}

	#answer(id: unknown, result: Record<string, unknown> | null, error?: { code: number; message: string }): void {
		if (typeof id !== 'number' && typeof id !== 'string') return;
		this.#post(error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error });
	}

	#onMessage(event: MessageEvent): void {
		if (event.source !== this.#host) return;
		const message: unknown = event.data;
		if (!isRecord(message) || message.jsonrpc !== '2.0') return;
		const method = typeof message.method === 'string' ? message.method : null;
		const params = isRecord(message.params) ? message.params : {};
		if (method === null) {
			// A response to one of ours.
			if (typeof message.id !== 'number') return;
			const pending = this.#pending.get(message.id);
			if (pending === undefined) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (isRecord(message.error)) {
				const code = typeof message.error.code === 'number' ? message.error.code : -32603;
				const text = typeof message.error.message === 'string' ? message.error.message : 'the host refused';
				pending.reject(new BridgeError(code, text));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (message.id !== undefined) {
			void this.#onRequest(message.id, method);
			return;
		}
		switch (method) {
			case 'ui/notifications/tool-input':
				this.#handlers.onToolInput?.(isRecord(params.arguments) ? params.arguments : {});
				return;
			case 'ui/notifications/tool-result':
				this.#handlers.onToolResult?.(params as EmbedToolResult);
				return;
			case 'ui/notifications/tool-cancelled':
				this.#handlers.onToolCancelled?.();
				return;
			case 'ui/notifications/host-context-changed':
				this.#handlers.onHostContext?.(params as HostContext);
				return;
		}
	}

	async #onRequest(id: unknown, method: string): Promise<void> {
		if (method === 'ping') {
			this.#answer(id, {});
			return;
		}
		if (method === 'ui/resource-teardown') {
			try {
				await this.#handlers.onTeardown?.();
			} finally {
				this.#answer(id, {});
			}
			return;
		}
		this.#answer(id, null, { code: -32601, message: `method not found: ${method}` });
	}
}

/** A failed tool result's `<code>: <message>`, read the way the SPA reads one (`mcp.ts`). */
export function toolErrorOf(result: EmbedToolResult): { code: string; message: string } | null {
	if (result.isError !== true) return null;
	const structured = result.structuredContent?.error;
	if (isRecord(structured) && typeof structured.code === 'string') {
		return {
			code: structured.code,
			message: typeof structured.message === 'string' ? structured.message : structured.code,
		};
	}
	const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
	const match = /^Error: ([a-z-]+): ([\s\S]*)$/.exec(text);
	return match === null ? { code: 'tool-error', message: text || 'the tool failed' } : {
		code: match[1] ?? 'tool-error',
		message: match[2] ?? '',
	};
}

/** What the live embed says when a ticket or its socket is refused (RV-10). */
export interface RefusalWords {
	/** One sentence for the person in the chat: no code, no origin, no variable name. */
	readonly user: string;
	/** The server's own words, for whoever runs the deployment: shown folded under the sentence. */
	readonly detail: string;
	/** Whether another Watch press could pass; an origin the server does not admit cannot. */
	readonly retryable: boolean;
}

/**
 * The words for a refused live view (RV-10). The person reading the embed is in a chat and cannot change what the
 * server admits; the operator who can needs the origin and the variable to set. So the sentence is theirs and the
 * detail is folded away — present, so it can be copied to whoever runs the server, but never the message itself.
 */
export function refusalWords(code: string, text: string): RefusalWords {
	const detail = `${code}: ${text}`;
	// An origin the server does not admit stays refused however often it is asked (D-135): no Watch is offered again.
	if (code === 'invalid-arguments' && /origin/i.test(text)) {
		return {
			user: 'Live views are not available in this app. The server’s administrator can allow it.',
			detail,
			retryable: false,
		};
	}
	if (code === 'connection-refused') return { user: 'The live view could not connect.', detail, retryable: true };
	return { user: 'The server did not open this live view.', detail, retryable: true };
}

/**
 * The host style variables an embed adopts, mapped onto the embed's own tokens (`styles/embed.css`), which carry
 * the control plane's palette until a host says otherwise.
 */
const HOST_VARIABLES: Readonly<Record<string, string>> = {
	'--color-background-primary': '--ttk-canvas',
	'--color-background-secondary': '--ttk-card',
	'--color-text-primary': '--text',
	'--color-text-secondary': '--text-dim',
	'--color-border-primary': '--ttk-hairline',
	'--font-sans': '--font',
	'--font-mono': '--mono',
	'--border-radius-md': '--ttk-radius-s',
};

/**
 * True for a host style value that can only paint: no `url(` (a fetch the embed's CSP would refuse and report), no
 * declaration or block punctuation, nothing markup-shaped, and short.
 */
export function safeStyleValue(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
		!/url\s*\(|image-set|[;{}<>\\@]/i.test(value);
}

/**
 * Applies the host's theme and style variables to the document. A CSSOM write (`style.setProperty`), which the
 * embed's hash-pinned `style-src` does not gate; a `style` attribute would be refused.
 */
export function applyHostContext(context: HostContext): void {
	const root = document.documentElement;
	if (context.theme === 'light' || context.theme === 'dark') root.setAttribute('data-theme', context.theme);
	const variables = context.styles?.variables;
	if (!isRecord(variables)) return;
	for (const [hostName, ownName] of Object.entries(HOST_VARIABLES)) {
		const value = variables[hostName];
		if (safeStyleValue(value)) root.style.setProperty(ownName, value);
	}
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * One glyph from the sprite `scripts/build_embed.ts` inlines into the embed document (`<symbol id="i-<name>">`),
 * referenced by a same-document fragment: the embed can reach no sprite file, and a markup string never reaches
 * the DOM. The names are the SPA's own icon vocabulary (`icon_names.ts`), so the glyphs are the same Lucide ones.
 */
export function embedIcon(name: EmbedIconName): SVGSVGElement {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', 'icon');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const use = document.createElementNS(SVG, 'use');
	use.setAttribute('href', `#i-${name}`);
	svg.append(use);
	return svg;
}
