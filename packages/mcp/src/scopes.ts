/** The scope vocabulary, and the partition that makes an explicit grant possible. */

/** Every scope a principal may hold. This is the *vocabulary*, never a grant. */
export const SCOPES = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	// The autonomous loop: it acts without a per-action confirmation and spends the caller's model, so it is an
	// EXPLICIT_SCOPES member and no principal holds it unless a deployment named it.
	'task',
	'admin',
	// Arbitrary in-page JavaScript is a capability no other scope confers, so it is an EXPLICIT_SCOPES member and no
	// principal holds it unless a deployment named it.
	'evaluate',
	// None of the execution or publication grants arrives by default.
	'sandbox:execute',
	'agent:invoke',
	'a2ui:publish',
	// The library on the data volume (file share, skills, prompts). Reading it is part of the
	// default grant; writing it is explicit, like every other grant that changes what persists.
	'files:read',
	'files:write',
	// Reading the Prometheus document at `/metrics`. Explicit, because the counters describe the whole
	// deployment's traffic, which is reconnaissance for a credential that only needed to call tools.
	'metrics:read',
	// The network tools' full view. Full request URLs (and the URLs inside header values) and response bodies carry
	// query-string tokens and session material, so reading them is explicit; the rest of the log, credential headers
	// redacted, stays on `mcp:invoke`.
	'network:read',
	// Running a text task on an operator-configured model provider spends the operator's provider key, so it is
	// explicit, like `task` (which spends the caller's model).
	'model:invoke',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * What a principal gets when nothing says otherwise: a key record that omits `scopes`, the anonymous loopback
 * principal, and every stdio client.
 */
export const DEFAULT_SCOPES: readonly Scope[] = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	'files:read',
];

/** The grant a v1 user store implied for an account that named no scopes: {@linkcode DEFAULT_SCOPES} plus `admin`. */
export const SCOPELESS_ACCOUNT_SCOPES: readonly Scope[] = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	'admin',
	'files:read',
];

/** What `doctor --new-admin` writes when `--scopes` names nothing: the default grant plus `admin`, explicitly. */
export const ADMIN_SCOPES: readonly Scope[] = [...DEFAULT_SCOPES, 'admin'];

/**
 * What `deno task setup`'s API key holds unless `--scopes` says otherwise (docs/security.md, Secrets):
 * the default grant plus every capability the default compose stack runs — the file share and memory writes, the
 * coding sandbox, agents, the built-in model agent and A2UI — so the key the quick start prints reaches all of it.
 */
export const STACK_SCOPES: readonly Scope[] = [
	...DEFAULT_SCOPES,
	'files:write',
	'sandbox:execute',
	'agent:invoke',
	'model:invoke',
	'a2ui:publish',
];

/** Scopes that must be named to be held. Never granted by a default, on any path, for any principal kind. */
export const EXPLICIT_SCOPES: readonly Scope[] = [
	'evaluate',
	'task',
	'sandbox:execute',
	'agent:invoke',
	'a2ui:publish',
	'files:write',
	// Managing sessions, accounts and settings is a role an operator assigns, not a default.
	'admin',
	'metrics:read',
	'network:read',
	'model:invoke',
];

/** The members of `names` that are not scopes, in the order given. */
export function unknownScopes(names: readonly string[]): string[] {
	return names.filter((name) => !(SCOPES as readonly string[]).includes(name));
}

/**
 * What each scope grants, in the operator's words, for surfaces that let a person choose scopes (the Users screen).
 */
export const SCOPE_GRANTS: Readonly<Record<Scope, string>> = {
	'mcp:invoke': 'Call MCP tools and read resources',
	'view:watch': 'Watch live browser sessions',
	'view:control': 'Take over live browser sessions',
	'task': 'Run autonomous browser tasks with a model',
	'admin': 'Manage sessions, accounts and settings',
	'evaluate': 'Run JavaScript inside pages',
	'sandbox:execute': 'Run commands in coding workspaces',
	'agent:invoke': 'Prompt and delegate to agents',
	'a2ui:publish': 'Publish A2UI surfaces',
	'files:read': 'Read the file share, skills and prompts',
	'files:write': 'Change the file share, skills and prompts',
	'metrics:read': 'Read server metrics',
	'network:read': 'Read full request URLs and response bodies',
	'model:invoke': 'Run text tasks on a configured model provider',
};
