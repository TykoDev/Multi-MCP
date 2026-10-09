/**
 * R14 (D-122): the server's public identity and the instructions a client hands its model.
 *
 * Both reach a client at connect time — the 2025-era `initialize` result carries `serverInfo` and `instructions`, and
 * the 2026-07-28 `server/discover` result carries `instructions` while the SDK stamps the full `serverInfo` into every
 * result's `_meta` — so both are built to be safe to repeat to any caller:
 *
 * - The identity is constant text plus two URLs the gateway derives from `TTK_PUBLIC_URL`, the address the caller
 *   already used. The icon is a URL, never a `data:` URI: on 2026 a data icon would ride every single response.
 *   stdio passes no identity, so it advertises neither a website nor an icon (there is no public URL to point at).
 * - The instructions are built **only from the already scope-filtered `capabilities.tykotech` block** of this caller,
 *   the same block `initialize` carries. So a viewer credential is never told about tools it cannot hold, nothing is
 *   said about the live view to a caller without a view scope, and no configuration value (a host, a path, a limit an
 *   operator chose) can appear: the block holds none that the caller could not already read.
 */
import type { Implementation } from '@modelcontextprotocol/server';
import type { TykotechCapabilities } from './capabilities.ts';

/** The implementation name. Wire-visible and stable; the registry name is `eu.tykotech/tykotech-mcp` (server.json). */
export const SERVER_NAME = 'tykotech-mcp';
/** The human-readable title a client shows. ERRATUM(E-117): renamed from "TykoTech MCP". */
export const SERVER_TITLE = 'Multi-MCP';
/** One line, for a client's server list and the registry entry. */
export const SERVER_DESCRIPTION = 'Browser control with a live view, a coding sandbox and agents over MCP';
/** The bound on {@linkcode serverInstructions}, in UTF-8 bytes: a client prepends this to its model's context. */
export const MAX_INSTRUCTIONS_BYTES = 2048;

/** The deployment-specific half of the identity; absent on stdio. */
export interface ServerIdentity {
	/** The deployment's origin (`TTK_PUBLIC_URL`). */
	readonly websiteUrl?: string;
	/** An absolute URL of the 192px PNG mark the gateway serves publicly (`/assets/brand/icon-192.png`). */
	readonly iconUrl?: string;
}

/** The `serverInfo` this server reports. */
export function serverImplementation(version: string, identity?: ServerIdentity): Implementation {
	return {
		name: SERVER_NAME,
		title: SERVER_TITLE,
		version,
		description: SERVER_DESCRIPTION,
		...(identity?.websiteUrl === undefined ? {} : { websiteUrl: identity.websiteUrl }),
		...(identity?.iconUrl === undefined
			? {}
			: { icons: [{ src: identity.iconUrl, mimeType: 'image/png', sizes: ['192x192'] }] }),
	};
}

/**
 * The `instructions` for one caller, from that caller's capability block alone (see the module comment). Each
 * sentence is present only when the block shows the caller can act on it; the result is at most
 * {@linkcode MAX_INSTRUCTIONS_BYTES}.
 */
export function serverInstructions(capabilities: TykotechCapabilities): string {
	const lines: string[] = [
		'Multi-MCP runs a server-side Chromium for you. Read the ttk://capabilities resource for what this ' +
		'credential can do here.',
	];
	// `events` is present exactly when the caller holds `mcp:invoke`, i.e. can drive the browser at all.
	if (capabilities.events !== undefined) {
		lines.push(
			'Browser tools act on a session: omit session_id to use your default session, or call browser_navigate ' +
				'with new_session: true for a separate one, then pass the session_id it returns.',
			'Call browser_get_state to see the page: it numbers the interactive elements and returns a state_token. ' +
				'Pass that token with an index-based action, so a page that changed underneath you is refused rather ' +
				'than clicked blindly; read the state again after a refusal.',
			"A failed tool returns a result whose text starts 'Error: <code>:'. tools_withheld in ttk://capabilities " +
				'names the tools this credential cannot see, and why.',
		);
	}
	// `live_view` is present only for a caller holding a view scope, on a mount that serves the live view.
	if (capabilities.live_view !== undefined) {
		lines.push(
			'A person can watch a session in the live view and take control of it. While they hold control, mutating ' +
				'tools answer human-has-control: wait and retry, and do not work around them.',
		);
	}
	// `sandbox` is present only for a caller holding `sandbox:execute` on a deployment whose sandbox has answered.
	if (capabilities.sandbox !== undefined) {
		lines.push(
			'The sandbox_* tools run commands in isolated coding workspaces that belong to this credential.',
		);
	}
	const text = lines.join('\n');
	// A guard rather than a truncation: the sentences are fixed, so this can only fail when someone adds one.
	if (new TextEncoder().encode(text).byteLength > MAX_INSTRUCTIONS_BYTES) {
		throw new Error(`server instructions exceed ${MAX_INSTRUCTIONS_BYTES} bytes`);
	}
	return text;
}
