/**
 * The A2UI embed, `ui://tykotech/a2ui-surface` (R9, design §2.20, D-134/D-136).
 *
 * A read-only render of the surface an `a2ui_publish` call returned, framed by an MCP Apps host. The snapshot comes
 * from the result the host relays (`ui/notifications/tool-result`, `structuredContent.result.surface`); nothing is
 * fetched, no action is sent and the model is never written. It is the control plane's own renderer in its
 * `{ interactive: false, kit: false }` mode (`a2ui.ts`), so the two cannot disagree about what a surface means: the
 * schema checks, the theme mapping and the "text is only ever text" rule are the same code.
 *
 * Interactive embeds (actions, live updates) are deliberately not built (design §1 item 3, G9): reopen with an
 * app-only `a2ui_action` design.
 */
// First, before anything builds a schema: no `new Function` probe under the embed's CSP (jitless.ts).
import './jitless.ts';
import type { A2uiSurface } from '@tykotech/wire';
import { releaseA2uiSurface, renderA2uiSurface } from './a2ui.ts';
import { el } from './dom.ts';
import { applyHostContext, EmbedBridge, embedIcon, type EmbedToolResult, toolErrorOf } from './embed_bridge.ts';

/** What one `a2ui_publish` result holds inside its `{ result }` envelope. */
type Published = { kind: 'surface'; surface: A2uiSurface } | { kind: 'removed'; surfaceId: string } | null;

function publishedOf(result: EmbedToolResult): Published {
	const inner = result.structuredContent?.result as Record<string, unknown> | undefined;
	if (inner === undefined || inner === null || typeof inner !== 'object') return null;
	if (inner.removed === true && typeof inner.surfaceId === 'string') {
		return { kind: 'removed', surfaceId: inner.surfaceId };
	}
	const surface = inner.surface;
	return surface !== null && typeof surface === 'object' ? { kind: 'surface', surface: surface as A2uiSurface } : null;
}

function main(): void {
	const app = document.getElementById('app');
	if (app === null) return;

	const caption = el('span', { class: 'e-caption' });
	const body = el('div', { class: 'e-surface' });
	const message = el('p', { class: 'e-message-text', role: 'status', 'aria-live': 'polite' });
	const shell = el('main', { class: 'embed a2ui' }, [
		el('header', { class: 'e-bar' }, [
			el('span', { class: 'e-glyph', 'aria-hidden': 'true' }, [embedIcon('surface')]),
			el('span', { class: 'e-ident' }, [caption]),
		]),
		body,
		message,
	]);
	let rendered: HTMLElement | null = null;

	function clearSurface(): void {
		if (rendered !== null) releaseA2uiSurface(rendered);
		rendered = null;
		body.replaceChildren();
	}

	function show(result: EmbedToolResult): void {
		const refused = toolErrorOf(result);
		if (refused !== null) {
			clearSurface();
			caption.textContent = 'Agent surface';
			message.textContent = `The surface could not be published — ${refused.code}: ${refused.message}`;
			return;
		}
		const published = publishedOf(result);
		if (published === null) return;
		clearSurface();
		if (published.kind === 'removed') {
			caption.textContent = published.surfaceId;
			message.textContent = `Surface ${published.surfaceId} was removed.`;
			return;
		}
		try {
			// `send` is never called in read-only mode; it refuses if it ever were.
			rendered = renderA2uiSurface(
				published.surface,
				() => Promise.reject(new Error('this embed is read-only')),
				{ interactive: false, kit: false },
			);
			body.append(rendered);
			caption.textContent = `${published.surface.surfaceId} · revision ${published.surface.revision} · read-only`;
			message.textContent = '';
		} catch (cause) {
			caption.textContent = 'Agent surface';
			message.textContent = `This surface cannot be shown: ${cause instanceof Error ? cause.message : 'invalid'}`;
		}
	}

	const bridge = new EmbedBridge({
		onToolResult: show,
		onHostContext: applyHostContext,
		onTeardown: clearSurface,
	});
	app.append(shell);
	caption.textContent = 'Agent surface';
	message.textContent = 'Waiting for the host to pass the published surface.';
	bridge.watchSize(shell);
	void bridge.connect({ name: 'tykotech-a2ui-surface', version: '1' }).catch(() => {
		message.textContent = 'This view must be opened by an MCP Apps host.';
	});
}

main();
