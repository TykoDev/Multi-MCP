/**
 * What the remainder of `#/resources/…` means. One route serves two kinds of
 * parameter: an MCP resource URI (`ttk://capabilities`, `https://…`, `file:`),
 * read live, or one of the tree's groups — the Library's `files[/<path>]`,
 * `skills[/<name>]`, `prompts[/<name>]`, `templates`, and since D-152 the
 * absorbed Tools console's `tools[/<name> | /@<group>]` beside `server`,
 * `browser`, `sessions[/<id>]`, `sandbox[/<id>]`, `agents[/<part>]` and
 * `surfaces[/<id>]`.
 *
 * The rule needs no list of schemes: every MCP URI carries one (RFC 3986 §3.1,
 * a letter then letters, digits, `+`, `.` or `-`, up to the colon), and no group
 * name is followed by a colon. A group the tree does not know is treated as a
 * URI, which is what today's view does with any parameter, so an unknown word
 * reads as "not a resource" rather than as a blank screen.
 *
 * Pure, so the router and the Resources screen agree on one reading and the
 * unit tests beside this file pin it.
 */

export type ResourceGroup =
	| 'files'
	| 'skills'
	| 'prompts'
	| 'templates'
	| 'tools'
	| 'server'
	| 'browser'
	| 'sessions'
	| 'sandbox'
	| 'agents'
	| 'surfaces';

export type ResourceRoute =
	| { readonly kind: 'none' }
	| { readonly kind: 'uri'; readonly uri: string }
	| { readonly kind: 'group'; readonly group: ResourceGroup; readonly rest?: string };

const GROUPS: ReadonlySet<string> = new Set<ResourceGroup>([
	'files',
	'skills',
	'prompts',
	'templates',
	'tools',
	'server',
	'browser',
	'sessions',
	'sandbox',
	'agents',
	'surfaces',
]);

/** A scheme, as RFC 3986 defines it, followed by its colon. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Reads the decoded remainder of a `#/resources/…` route; `undefined` or empty is the tree with nothing selected. */
export function routeOf(param: string | undefined): ResourceRoute {
	if (param === undefined || param === '') return { kind: 'none' };
	if (SCHEME.test(param)) return { kind: 'uri', uri: param };
	const slash = param.indexOf('/');
	const group = slash === -1 ? param : param.slice(0, slash);
	if (!GROUPS.has(group)) return { kind: 'uri', uri: param };
	const rest = slash === -1 ? '' : param.slice(slash + 1);
	return rest === ''
		? { kind: 'group', group: group as ResourceGroup }
		: { kind: 'group', group: group as ResourceGroup, rest };
}
