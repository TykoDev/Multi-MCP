/**
 * MCP Apps (R9, design §2.20, D-134): the three `ui://` documents this server offers an Apps host, and the tool
 * metadata that links a tool to one of them.
 *
 * Everything here is registered **only when the feature is on** (`McpDeps.mcpApps`, from `TTK_MCP_APPS`, whose
 * gateway default is `control` since D-150). Off — named off, clustered, without the embed build, or on stdio — there
 * is no `ui://` resource and no tool carries `_meta.ui`, so a client cannot tell an Apps-capable build from one without
 * the feature.
 *
 * The documents themselves are built by `scripts/build_embed.ts` and loaded by the gateway (`mcp_apps.ts`); this
 * module only publishes them. Their `_meta.ui` is the host's instruction for the sandbox it frames them in: the
 * one socket origin they may reach (`connectDomains`), nothing else (`resourceDomains`, `frameDomains` and
 * `baseUriDomains` empty), a border, and the dedicated sandbox domain when the operator named one.
 */
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import type { Scope } from './scopes.ts';
import type { McpAppsDeps } from './types.ts';

/** The MIME type an MCP Apps host recognises an embeddable document by (SEP-1865). */
export const UI_RESOURCE_MIME = 'text/html;profile=mcp-app';

/** The live-view embed: a watch-first view of one browser session, socket opened on a click. */
export const LIVE_VIEW_UI_URI = 'ui://tykotech/live-view';

/** The A2UI embed: a read-only render of the surface an `a2ui_publish` call returned, followed live on a click. */
export const A2UI_SURFACE_UI_URI = 'ui://tykotech/a2ui-surface';

/** The terminal embed: one live sandbox shell session, streamed and typed into once the user presses Attach. */
export const TERMINAL_UI_URI = 'ui://tykotech/terminal';

/** Who may see a tool, as the Apps extension spells it: the model, the embedded app, or both. */
export type UiVisibility = 'model' | 'app';

/** A tool's link to its embed. */
export interface ToolUi {
	readonly resourceUri: string;
	readonly visibility: readonly UiVisibility[];
}

/**
 * The tools that open an embed (design §2.20). The ticket tools (`browser_live_ticket`, `a2ui_surface_ticket`,
 * `sandbox_session_ticket`) are app-only: the host must hide them from the model, because each result is a socket
 * credential the embed spends and the model has no use for.
 */
export const TOOL_UI: ReadonlyMap<string, ToolUi> = new Map<string, ToolUi>([
	['browser_live_view', { resourceUri: LIVE_VIEW_UI_URI, visibility: ['model', 'app'] }],
	['browser_live_ticket', { resourceUri: LIVE_VIEW_UI_URI, visibility: ['app'] }],
	['a2ui_publish', { resourceUri: A2UI_SURFACE_UI_URI, visibility: ['model', 'app'] }],
	// The surface embed follows its surface over the same kind of ticket-gated socket as the live view.
	['a2ui_surface_ticket', { resourceUri: A2UI_SURFACE_UI_URI, visibility: ['app'] }],
	// A live shell session is something a person watches: opening one shows the terminal embed.
	['sandbox_session_open', { resourceUri: TERMINAL_UI_URI, visibility: ['model', 'app'] }],
	['sandbox_session_ticket', { resourceUri: TERMINAL_UI_URI, visibility: ['app'] }],
]);

/**
 * The `_meta` a linked tool carries in `tools/list`, or `undefined` for a tool with no embed.
 *
 * Both spellings: `ui.resourceUri` is the stable one, and the deprecated flat `ui/resourceUri` key is what hosts
 * built against the draft still read (design §2.22: emit both until the extension's GA drops the second).
 */
export function toolUiMeta(name: string): Record<string, unknown> | undefined {
	const ui = TOOL_UI.get(name);
	if (ui === undefined) return undefined;
	return { ui: { resourceUri: ui.resourceUri, visibility: [...ui.visibility] }, 'ui/resourceUri': ui.resourceUri };
}

/**
 * A resource's `_meta.ui`: the sandbox the host should frame the document in.
 *
 * The same object on the `resources/list` entry and on the `resources/read` content, because the extension states
 * no precedence between the two and a host may read either.
 */
export function resourceUiMeta(apps: Pick<McpAppsDeps, 'connectDomains' | 'domain'>): Record<string, unknown> {
	return {
		ui: {
			csp: {
				connectDomains: [...apps.connectDomains],
				resourceDomains: [],
				frameDomains: [],
				baseUriDomains: [],
			},
			prefersBorder: true,
			...(apps.domain === undefined ? {} : { domain: apps.domain }),
		},
	};
}

/** One embed, as it is published. */
interface UiDocument {
	readonly name: string;
	readonly uri: string;
	readonly title: string;
	readonly description: string;
	readonly html: (apps: McpAppsDeps) => string;
}

const DOCUMENTS: readonly UiDocument[] = [
	{
		name: 'tykotech-live-view',
		uri: LIVE_VIEW_UI_URI,
		title: 'Live browser view',
		description: 'Watch a browser session in place; the socket opens only when you press Watch.',
		html: (apps) => apps.liveViewHtml,
	},
	{
		name: 'tykotech-a2ui-surface',
		uri: A2UI_SURFACE_UI_URI,
		title: 'Agent surface',
		description: 'A read-only render of the A2UI surface an agent published.',
		html: (apps) => apps.a2uiHtml,
	},
	{
		name: 'tykotech-terminal',
		uri: TERMINAL_UI_URI,
		title: 'Live terminal',
		description: 'Watch and type into a sandbox shell session; the socket opens only when you press Attach.',
		html: (apps) => apps.terminalHtml,
	},
];

/**
 * Registers every `ui://` document for a principal holding `mcp:invoke`, like the session resources: an embed is
 * a way to reach the tools, and a credential that cannot call them has no use for one.
 */
export function registerUiResources(server: McpServer, apps: McpAppsDeps, scopes: ReadonlySet<Scope>): void {
	if (!scopes.has('mcp:invoke')) return;
	const meta = resourceUiMeta(apps);
	for (const document of DOCUMENTS) {
		const text = document.html(apps);
		server.registerResource(
			document.name,
			document.uri,
			{ title: document.title, description: document.description, mimeType: UI_RESOURCE_MIME, _meta: meta },
			(uri): ReadResourceResult => ({
				contents: [{ uri: uri.href, mimeType: UI_RESOURCE_MIME, text, _meta: meta }],
			}),
		);
	}
}
