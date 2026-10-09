/** File-backed service configuration for D-064–D-067. */
import * as z from 'zod';
import { isForbiddenLiteralHost } from '@tykotech/mcp';
import { NOT_TASKABLE } from './taskable.ts';

export interface ServiceEndpoint {
	readonly url: string;
	readonly token: string;
}

export interface AgentPeer {
	readonly id: string;
	readonly url: string;
	readonly token?: string;
}

export interface ExpansionConfig {
	readonly mcpUrl?: string;
	readonly sandbox: ServiceEndpoint | null;
	readonly bridge: (ServiceEndpoint & { readonly agent: string; readonly authMethod?: string }) | null;
	readonly peers: readonly AgentPeer[];
	/** E-4: operator-configured A2UI tool actions (`TTK_A2UI_ACTIONS`); empty when none. */
	readonly a2uiActions?: readonly A2uiToolAction[];
	/** C4 / G10: `TTK_AGENT_TASK_TIMEOUT_S` — the bound on text (ACP) and delegation tasks; 600 s by default. */
	readonly taskTimeoutMs?: number;
	/** B1: `TTK_AGENT_TASK_RETENTION_S` — how long finished tasks are kept, in memory and on disk; 24 h by default. */
	readonly taskRetentionMs?: number;
	/**
	 * A11 / N1: `TTK_A2A_PUSH_ALLOWED_HOSTS` — the exact hosts (`host` or `host:port`, lower case) an A2A push
	 * webhook may target. **Empty means push is not offered at all**; non-empty offers it only where the process also
	 * holds a proven outbound net grant for every listed host (`expansion.ts`).
	 */
	readonly pushAllowedHosts?: readonly string[];
}

/** C4 / G10 / B1: the defaults and ranges of the agent task settings (design §2.1). */
export const AGENT_TASK_TIMEOUT_S = { default: 600, min: 10, max: 86_400 } as const;
export const AGENT_TASK_RETENTION_S = { default: 86_400, min: 60, max: 2_592_000 } as const;

/**
 * A11: one `TTK_A2A_PUSH_ALLOWED_HOSTS` entry as the dispatcher compares it — lower case, IPv6 bracketed, a port
 * only when it is not the https default — or `null` when it is not a bare host. A private, loopback or link-local
 * literal is refused here rather than accepted and then refused on every delivery.
 */
function pushHost(entry: string): string | null {
	if (/[/?#@\s]/.test(entry)) return null;
	const parsed = URL.parse(`https://${entry}/`);
	if (parsed === null || parsed.hostname === '' || parsed.username !== '' || parsed.pathname !== '/') return null;
	if (isForbiddenLiteralHost(parsed.hostname, [])) return null;
	return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
}

/** Whole seconds in `range`, or the default when unset; anything else refuses startup. */
function seconds(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	range: { default: number; min: number; max: number },
	fail: (variable: string, detail: string) => never,
): number {
	const raw = env[name]?.trim();
	if (raw === undefined || raw === '') return range.default;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < range.min || value > range.max) {
		return fail(name, `expected whole seconds from ${range.min} to ${range.max}`);
	}
	return value;
}

/**
 * E-4 (AGENT-EXPANSION §7): a button an agent may put on a surface that calls a tool the **operator** named, with
 * arguments the operator fixed. The surface's server-side state may fill only the argument names listed in
 * `context`, and only with scalars; a client event can never choose the tool or add an argument.
 */
export interface A2uiToolAction {
	readonly name: string;
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly context: readonly string[];
}

const A2uiToolActionsSchema = z.array(
	z.object({
		name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/).refine(
			(name) => name !== 'cancelTask' && name !== 'permissionDecision',
			'cancelTask and permissionDecision are built in',
		),
		tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
		arguments: z.record(z.string(), z.unknown()).default({}),
		context: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)).max(8).default([]),
	}).strict().refine(
		(action) => action.context.every((key) => !(key in action.arguments)),
		'a context key may not override a fixed argument',
	),
).max(32);

export const PeerFileSchema = z.array(
	z.object({
		id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
		url: z.string().max(2048),
		token_file: z.string().min(1).max(4096).optional(),
	}).strict(),
).max(32);

/** Validates an operator-fixed service URL; no request can supply one. */
export function serviceUrl(raw: string): string {
	const url = new URL(raw);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error('expected an HTTP(S) URL without credentials, query, or fragment');
	}
	if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
	return url.href;
}

/** Resolves configuration from validated file contents; it never reads or writes process environment. */
export function expansionConfig(
	env: Readonly<Record<string, string | undefined>>,
	secrets: Readonly<Record<string, string>>,
	fail: (variable: string, detail: string) => never,
): ExpansionConfig {
	const endpoint = (name: string): ServiceEndpoint | null => {
		const raw = env[`${name}_URL`]?.trim();
		const token = secrets[`${name}_TOKEN`];
		if (!raw && !token && !env[`${name}_TOKEN_FILE`]) return null;
		if (!raw || !token || token.length < 32 || /\s/.test(token)) {
			return fail(`${name}_URL`, `URL and a file-backed token of at least 32 non-whitespace characters are required`);
		}
		try {
			const url = serviceUrl(raw);
			if (name === 'TTK_SANDBOX' && new URL(url).pathname !== '/') throw new Error('sandbox origin required');
			return { url, token };
		} catch {
			return fail(`${name}_URL`, 'expected HTTP(S) URL without credentials, query, or fragment');
		}
	};
	const sandbox = endpoint('TTK_SANDBOX');
	const bridgeEndpoint = endpoint('TTK_AGENT_BRIDGE');
	const agent = env.TTK_AGENT_DEFAULT?.trim() || 'default';
	// E-2: the ACP auth method to use when the agent advertises it; the credentials stay with the agent in the runner.
	const authMethod = env.TTK_AGENT_AUTH_METHOD?.trim() || undefined;
	if (authMethod !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(authMethod)) {
		return fail('TTK_AGENT_AUTH_METHOD', 'expected an ACP auth method identifier');
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agent)) {
		return fail('TTK_AGENT_DEFAULT', 'expected a configured agent identifier');
	}
	let peers: AgentPeer[] = [];
	const rawPeers = secrets.TTK_AGENT_PEERS;
	if (env.TTK_AGENT_PEERS_FILE && rawPeers === undefined) {
		return fail('TTK_AGENT_PEERS_FILE', 'peer configuration must be resolved before startup');
	}
	if (rawPeers !== undefined) {
		try {
			const schema = z.array(z.object({ id: z.string(), url: z.string(), token: z.string().optional() }).strict()).max(
				32,
			);
			peers = schema.parse(JSON.parse(rawPeers)).map((peer) => ({ ...peer, url: serviceUrl(peer.url) }));
			if (new Set(peers.map((peer) => peer.id)).size !== peers.length) throw new Error('duplicate peer');
		} catch {
			return fail('TTK_AGENT_PEERS_FILE', 'invalid peer list or URL');
		}
	}
	let mcpUrl: string | undefined;
	if (env.TTK_AGENT_MCP_URL) {
		try {
			mcpUrl = serviceUrl(env.TTK_AGENT_MCP_URL);
			if (new URL(mcpUrl).pathname !== '/mcp') throw new Error('MCP path required');
		} catch {
			return fail('TTK_AGENT_MCP_URL', 'expected a fixed HTTP(S) /mcp endpoint without credentials');
		}
	}
	let a2uiActions: A2uiToolAction[] = [];
	const rawActions = env.TTK_A2UI_ACTIONS?.trim();
	if (rawActions) {
		try {
			if (rawActions.length > 64 * 1024) throw new Error('too large');
			a2uiActions = A2uiToolActionsSchema.parse(JSON.parse(rawActions));
			if (new Set(a2uiActions.map((action) => action.name)).size !== a2uiActions.length) throw new Error('duplicate');
		} catch {
			return fail('TTK_A2UI_ACTIONS', 'expected a JSON array of {name, tool, arguments?, context?} with unique names');
		}
		// X-1 (D-141; amends D-086, D-125, D-121): a button runs its tool indirectly, as a task does — no MCP context to
		// ask a human through, no caller to hand a link or ticket to — so a tool that cannot run as a task cannot sit
		// behind a button either. Refused at startup rather than on the first click. Outside the `try` above so this
		// detail is not replaced by the generic one; both names are operator configuration and carry no secret.
		const indirect = a2uiActions.find((action) => NOT_TASKABLE.has(action.tool));
		if (indirect !== undefined) {
			return fail('TTK_A2UI_ACTIONS', `action "${indirect.name}" names ${indirect.tool}, which cannot run indirectly`);
		}
	}
	const pushAllowedHosts: string[] = [];
	for (const entry of (env.TTK_A2A_PUSH_ALLOWED_HOSTS ?? '').split(',').map((item) => item.trim())) {
		if (entry === '') continue;
		const host = pushHost(entry);
		if (host === null) {
			return fail(
				'TTK_A2A_PUSH_ALLOWED_HOSTS',
				'expected comma-separated public host names (host or host:port); private, loopback and link-local ' +
					'addresses are never allowed',
			);
		}
		if (!pushAllowedHosts.includes(host)) pushAllowedHosts.push(host);
	}
	return {
		sandbox,
		bridge: bridgeEndpoint === null
			? null
			: { ...bridgeEndpoint, agent, ...(authMethod === undefined ? {} : { authMethod }) },
		peers,
		a2uiActions,
		...(mcpUrl === undefined ? {} : { mcpUrl }),
		taskTimeoutMs: seconds(env, 'TTK_AGENT_TASK_TIMEOUT_S', AGENT_TASK_TIMEOUT_S, fail) * 1000,
		taskRetentionMs: seconds(env, 'TTK_AGENT_TASK_RETENTION_S', AGENT_TASK_RETENTION_S, fail) * 1000,
		pushAllowedHosts,
	};
}
