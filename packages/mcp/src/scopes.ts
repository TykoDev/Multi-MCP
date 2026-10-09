/**
 * The scope vocabulary, and the partition that makes an explicit grant possible.
 *
 * One owner, in the lower layer, because the catalog's `scope` field already
 * lives here. `packages/gateway` imports through `mod.ts`, an import direction
 * that already exists. Before B1.3 the list was declared independently in three
 * places — `gateway/src/config.ts`, `mcp/src/catalog.ts` and `mcp/src/server.ts`
 * — with nothing keeping them equal.
 *
 * See SPECS/SECURITY-AUTH.md §3.
 */

/** Every scope a principal may hold. This is the *vocabulary*, never a grant. */
export const SCOPES = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	// SEC-01b. The autonomous loop: it acts without a per-action confirmation and
	// spends the caller's model, so from 0.2.0 it is an EXPLICIT_SCOPES member and
	// no principal holds it unless a deployment named it.
	'task',
	'admin',
	// D-A4. Arbitrary in-page JavaScript is a capability no other scope confers,
	// so it is the first member of EXPLICIT_SCOPES and no principal holds it
	// unless a deployment named it.
	'evaluate',
	// D-065: none of the new execution or publication grants arrives by default.
	'sandbox:execute',
	'agent:invoke',
	'a2ui:publish',
	// D-075: the library on the data volume (file share, skills, prompts). Reading it is part of the
	// default grant; writing it is explicit, like every other grant that changes what persists.
	'files:read',
	'files:write',
	// D-098 (C11): reading the Prometheus document at `/metrics`. Explicit, because the counters describe the whole
	// deployment's traffic, which is reconnaissance for a credential that only needed to call tools.
	'metrics:read',
	// R4 (design §2.2, seam S0; read by W1's network tools). Full request URLs, header values and bodies carry
	// query-string tokens and session material, so reading them is explicit; the metadata stays on `mcp:invoke`.
	'network:read',
	// D-144 (model-providers-ui S0): running a text task on an operator-configured model provider spends the
	// operator's provider key, so it is explicit, like `task` (the caller's model) before it.
	'model:invoke',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * What a principal gets when nothing says otherwise: a key record that omits
 * `scopes`, the anonymous loopback principal, and every stdio client.
 *
 * **`task` was here until 0.2.0 and is not any more (SEC-01b, D-024).** It
 * grants an autonomous loop that acts without a per-action confirmation, and
 * every default-grant site handed it out, so D-024's separation described intent
 * rather than behaviour. The finding is precisely that **nobody ever chose to
 * grant autonomous browser control**; the owner decided on 2026-09-10 that
 * existing credentials lose it until an operator grants it deliberately, and
 * that is the intended effect rather than a regrettable side effect. It is a
 * breaking authorization change in a minor release, recorded as one in
 * `CHANGELOG.md`, `SPECS/API-CONTRACT.md` §8 and `SPECS/DECISION-REGISTER.md`
 * D-024 — not softened into an addition.
 *
 * The remedy is one flag: `doctor --new-key <id> --scopes mcp:invoke,task`, or
 * `doctor --new-key-set <prefix>`, which already mints a single-scope `task` key.
 * For the loopback and stdio mounts, `TTK_ANON_SCOPES` names it.
 *
 * **`admin` was here until the capability buildout and is not any more (C7, G4, D-098).** Every key record that
 * omitted `scopes`, every account created without a list and the anonymous loopback principal could manage
 * sessions, accounts and settings, so "a tool key" and "an administrator" were the same credential unless an
 * operator had thought to narrow it. Breaking, deliberately and recorded as such: a key without `scopes` loses
 * `admin`. Stored accounts do not — the user store's one-time v1→v2 migration writes
 * {@linkcode LEGACY_DEFAULT_SCOPES} into every record that named none (G15), and `doctor --new-admin` names
 * `admin` explicitly ({@linkcode ADMIN_SCOPES}).
 */
export const DEFAULT_SCOPES: readonly Scope[] = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	'files:read',
];

/**
 * The default grant as it stood before `admin` left it (G15). Read by exactly one thing: the user store's one-time
 * upgrade, which writes it into every stored account that named no scopes, so an administrator who relied on the old
 * default keeps `admin` across the upgrade. Never a grant site of its own — a record that still has no `scopes`
 * after the upgrade gets {@linkcode DEFAULT_SCOPES} like any other.
 */
export const LEGACY_DEFAULT_SCOPES: readonly Scope[] = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	'admin',
	'files:read',
];

/** What `doctor --new-admin` writes when `--scopes` names nothing: the default grant plus `admin`, explicitly. */
export const ADMIN_SCOPES: readonly Scope[] = [...DEFAULT_SCOPES, 'admin'];

/**
 * Scopes that must be named to be held. Never granted by a default, on any
 * path, for any principal kind.
 *
 * Adding a scope here is the whole mechanism: `SCOPES` is what a token may
 * claim, `DEFAULT_SCOPES` is what an unspecified principal receives, and the
 * two lists are asserted to partition `SCOPES` in both directions — a scope in
 * both would read as explicit and grant as default, which is exactly the
 * failure this exists to prevent.
 *
 * `task` joined `evaluate` here in 0.2.0 (SEC-01b). The two are not the same
 * capability and are here for the same reason: neither is conferred by any other
 * scope, and neither should ever arrive because someone added a scope to
 * `SCOPES`. `evaluate` runs arbitrary code inside every site the browser is
 * logged into; `task` lets the browser drive itself without a per-action
 * confirmation. An operator names the one it wants.
 */
export const EXPLICIT_SCOPES: readonly Scope[] = [
	'evaluate',
	'task',
	'sandbox:execute',
	'agent:invoke',
	'a2ui:publish',
	'files:write',
	// C7 / D-098: managing sessions, accounts and settings is a role an operator assigns, not a default.
	'admin',
	'metrics:read',
	'network:read',
	'model:invoke',
];

/** True when every named scope is a member of the vocabulary. */
export function areScopes(names: readonly string[]): names is Scope[] {
	return names.every((name) => (SCOPES as readonly string[]).includes(name));
}

/** The members of `names` that are not scopes, in the order given. */
export function unknownScopes(names: readonly string[]): string[] {
	return names.filter((name) => !(SCOPES as readonly string[]).includes(name));
}

/**
 * What each scope grants, in the operator's words, for surfaces that let a person choose scopes (the Users
 * screen). Declared beside the vocabulary so the two cannot drift apart, and read from here by the gateway's
 * account routes rather than restated in the SPA, which keeps the vocabulary's one declaration in this file.
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
	'network:read': 'Read request URLs, headers and bodies',
	'model:invoke': 'Run text tasks on a configured model provider',
};
