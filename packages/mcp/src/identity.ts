/** The server's public identity and the instructions a client hands its model. */
import type { Implementation } from '@modelcontextprotocol/server';
import type { TykotechCapabilities } from './capabilities.ts';

/** The implementation name. Wire-visible and stable; the registry name is `eu.tykotech/tykotech-mcp` (server.json). */
export const SERVER_NAME = 'tykotech-mcp';
/** The human-readable title a client shows. */
export const SERVER_TITLE = 'Multi-MCP';
/** One line, for a client's server list and the registry entry. */
export const SERVER_DESCRIPTION = 'Browser control with a live view, a coding sandbox and agents over MCP';
/** The bound on {@linkcode serverInstructions}, in UTF-8 bytes: a client prepends this to its model's context. */
export const MAX_INSTRUCTIONS_BYTES = 2048;

/** The deployment-specific half of the identity; absent on stdio. */
interface ServerIdentity {
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

/** The `instructions` for one caller, built from that caller's capability block alone. */
export function serverInstructions(capabilities: TykotechCapabilities): string {
	const lines: string[] = [
		'Multi-MCP runs a server-side Chromium for you. Read the ttk://capabilities resource for what this ' +
		'credential can do here.',
	];
	// `tool_groups` is present only on a connection that lists its tools grouped. The sentences below name tools such a
	// list does not hold yet, so the way to them comes first.
	if (capabilities.tool_groups !== undefined) {
		lines.push(
			`Tools come in groups: call ${capabilities.tool_groups.map((group) => `use_${group}`).join(', ')} to add ` +
				"that group's tools to your tool list before you use them.",
		);
	}
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
