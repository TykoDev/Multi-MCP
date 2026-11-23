/** File-backed service configuration: the coding sandbox, A2A peers, A2UI actions and task bounds. */
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
	readonly sandbox: ServiceEndpoint | null;
	readonly peers: readonly AgentPeer[];
	/** Operator-configured A2UI tool actions (`TTK_A2UI_ACTIONS`); empty when none. */
	readonly a2uiActions?: readonly A2uiToolAction[];
	/** `TTK_AGENT_TASK_TIMEOUT_S` — the bound on text and delegation tasks; 600 s by default. */
	readonly taskTimeoutMs?: number;
	/** `TTK_AGENT_TASK_RETENTION_S` — how long finished tasks are kept, in memory and on disk; 24 h by default. */
	readonly taskRetentionMs?: number;
	/**
	 * `TTK_A2A_PUSH_ALLOWED_HOSTS` — the exact hosts (`host` or `host:port`, lower case) an A2A push webhook may
	 * target.
	 */
	readonly pushAllowedHosts?: readonly string[];
}

/** The defaults and ranges of the agent task settings. */
const AGENT_TASK_TIMEOUT_S = { default: 600, min: 10, max: 86_400 } as const;
const AGENT_TASK_RETENTION_S = { default: 86_400, min: 60, max: 2_592_000 } as const;

/**
 * One `TTK_A2A_PUSH_ALLOWED_HOSTS` entry as the dispatcher compares it — lower case, IPv6 bracketed, a port only when
 * it is not the https default — or `null` when it is not a bare host.
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
 * A button an agent may put on a surface that calls a tool the **operator** named, with arguments the operator fixed.
 */
export interface A2uiToolAction {
	readonly name: string;
	readonly tool: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly context: readonly string[];
}

const A2uiToolActionsSchema = z.array(
	z.object({
		// `permissionDecision` answered the retired ACP agent's permission requests; the name stays reserved so a
		// surface published before its removal can never reach an operator tool under it.
		name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/).refine(
			(name) => name !== 'cancelTask' && name !== 'permissionDecision',
			'cancelTask is built in and permissionDecision is reserved',
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
	if (raw.includes('?') || raw.includes('#')) throw new Error('expected an HTTP(S) URL without query or fragment');
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
	const sandbox = ((): ServiceEndpoint | null => {
		const raw = env.TTK_SANDBOX_URL?.trim();
		const token = secrets.TTK_SANDBOX_TOKEN;
		if (!raw && !token && !env.TTK_SANDBOX_TOKEN_FILE) return null;
		if (!raw || !token || token.length < 32 || /\s/.test(token)) {
			return fail(
				'TTK_SANDBOX_URL',
				`URL and a file-backed token of at least 32 non-whitespace characters are required`,
			);
		}
		try {
			const url = serviceUrl(raw);
			if (new URL(url).pathname !== '/') throw new Error('sandbox origin required');
			return { url, token };
		} catch {
			return fail('TTK_SANDBOX_URL', 'expected HTTP(S) URL without credentials, query, or fragment');
		}
	})();
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
		// A button runs its tool indirectly, as a task does — no MCP context to ask a human through, no caller to hand
		// a link or ticket to — so a tool that cannot run as a task cannot sit behind a button either.
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
		peers,
		a2uiActions,
		taskTimeoutMs: seconds(env, 'TTK_AGENT_TASK_TIMEOUT_S', AGENT_TASK_TIMEOUT_S, fail) * 1000,
		taskRetentionMs: seconds(env, 'TTK_AGENT_TASK_RETENTION_S', AGENT_TASK_RETENTION_S, fail) * 1000,
		pushAllowedHosts,
	};
}
