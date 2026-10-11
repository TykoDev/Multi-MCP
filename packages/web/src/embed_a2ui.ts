/**
 * The A2UI embed, `ui://tykotech/a2ui-surface` (R9, design §2.20, D-134/D-136).
 *
 * A read-only render of the surface an `a2ui_publish` call returned, framed by an MCP Apps host. The snapshot comes
 * from the result the host relays (`ui/notifications/tool-result`, `structuredContent.result.surface`). It is the
 * control plane's own renderer in its `{ interactive: false, kit: false }` mode (`a2ui.ts`), so the two cannot
 * disagree about what a surface means: the schema checks, the theme mapping and the "text is only ever text" rule are
 * the same code.
 *
 * **Follow live** keeps the render current while the agent goes on publishing: the press mints a single-use,
 * origin-bound ticket through the app-only `a2ui_surface_ticket` tool and opens the surface socket — the same
 * transport the live view uses for a browser (`embed_stream.ts`) — which sends every new revision and says when the
 * surface is removed. The stream is read-only: no action is sent and the model is never written (design §1 item 3,
 * G9).
 */
// First, before anything builds a schema: no `new Function` probe under the embed's CSP (jitless.ts).
import './jitless.ts';
import type { A2uiSurface } from '@tykotech/wire';
import { releaseA2uiSurface, renderA2uiSurface } from './a2ui.ts';
import { el, on } from './dom.ts';
import { applyHostContext, EmbedBridge, embedIcon, type EmbedToolResult, toolErrorOf } from './embed_bridge.ts';
import { EmbedStream, type StreamMessage } from './embed_stream.ts';

/** What one `a2ui_publish` result holds inside its `{ result }` envelope. */
type Published = { kind: 'surface'; surface: A2uiSurface } | { kind: 'removed'; surfaceId: string } | null;

/** `bye` reasons after which following again would only fail. */
const FINAL_REASONS = new Set(['surface-removed', 'server-shutdown', 'unauthorized']);

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

	const dot = el('span', { class: 'e-dot idle', role: 'img', hidden: true });
	const caption = el('span', { class: 'e-caption' });
	const followButton = el('button', { class: 'e-btn primary', type: 'button', hidden: true });
	const body = el('div', { class: 'e-surface' });
	const message = el('p', { class: 'e-message-text', role: 'status', 'aria-live': 'polite' });
	const shell = el('main', { class: 'embed a2ui' }, [
		el('header', { class: 'e-bar' }, [
			el('span', { class: 'e-glyph', 'aria-hidden': 'true' }, [embedIcon('surface')]),
			el('span', { class: 'e-ident' }, [caption]),
			dot,
			el('span', { class: 'e-actions' }, [followButton]),
		]),
		body,
		message,
	]);
	let rendered: HTMLElement | null = null;
	/** The surface on screen, which the stream follows; `null` before one is shown and after it is removed. */
	let surfaceId: string | null = null;
	let revision = 0;
	let following = false;

	function clearSurface(): void {
		if (rendered !== null) releaseA2uiSurface(rendered);
		rendered = null;
		body.replaceChildren();
	}

	function renderControls(): void {
		followButton.hidden = surfaceId === null;
		followButton.className = following ? 'e-btn quiet' : 'e-btn primary';
		followButton.replaceChildren(
			embedIcon(following ? 'stop' : 'radio'),
			el('span', { text: following ? 'Stop following' : 'Follow live' }),
		);
		dot.hidden = !following;
	}

	function showSurface(surface: A2uiSurface): void {
		// A stream can deliver a revision the host's own result already showed; an older one is never drawn over a newer.
		if (surface.surfaceId === surfaceId && surface.revision < revision) return;
		clearSurface();
		try {
			// `send` is never called in read-only mode; it refuses if it ever were.
			rendered = renderA2uiSurface(
				surface,
				() => Promise.reject(new Error('this embed is read-only')),
				{ interactive: false, kit: false },
			);
			body.append(rendered);
			surfaceId = surface.surfaceId;
			revision = surface.revision;
			caption.textContent = `${surface.surfaceId} · revision ${surface.revision} · read-only`;
			message.textContent = '';
		} catch (cause) {
			caption.textContent = 'Agent surface';
			message.textContent = `This surface cannot be shown: ${cause instanceof Error ? cause.message : 'invalid'}`;
		}
		renderControls();
	}

	function showRemoved(id: string): void {
		if (following) stream.stop();
		clearSurface();
		surfaceId = null;
		revision = 0;
		caption.textContent = id;
		message.textContent = `Surface ${id} was removed.`;
		renderControls();
	}

	function show(result: EmbedToolResult): void {
		const refused = toolErrorOf(result);
		if (refused !== null) {
			if (surfaceId === null) {
				clearSurface();
				caption.textContent = 'Agent surface';
			}
			message.textContent = `The surface could not be published — ${refused.code}: ${refused.message}`;
			return;
		}
		const published = publishedOf(result);
		if (published === null) return;
		if (published.kind === 'removed') {
			showRemoved(published.surfaceId);
			return;
		}
		if (following && published.surface.surfaceId !== surfaceId) stream.stop();
		showSurface(published.surface);
	}

	const bridge = new EmbedBridge({
		onToolResult: show,
		onHostContext: applyHostContext,
		onTeardown: () => {
			stream.stop();
			clearSurface();
		},
	});

	const stream = new EmbedStream({
		bridge,
		ticketTool: 'a2ui_surface_ticket',
		ticketArgs: () => ({ surface_id: surfaceId }),
		finalReasons: FINAL_REASONS,
		handlers: {
			onPhase: (phase, why) => {
				following = phase !== 'idle';
				dot.className = `e-dot ${phase === 'live' ? 'live' : phase === 'idle' ? 'idle' : 'busy'}`;
				const meaning = phase === 'live' ? 'Following live' : phase === 'idle' ? 'Not following' : 'Connecting';
				dot.setAttribute('aria-label', meaning);
				dot.title = meaning;
				if (phase === 'reconnecting' && why !== undefined) message.textContent = `Reconnecting — ${why}`;
				else if (phase === 'live') message.textContent = '';
				renderControls();
			},
			onMessage: (incoming: StreamMessage) => {
				if (incoming.type === 'surface' && typeof incoming.surface === 'object' && incoming.surface !== null) {
					showSurface(incoming.surface as A2uiSurface);
				} else if (incoming.type === 'removed' && typeof incoming.surface_id === 'string') {
					showRemoved(incoming.surface_id);
				} else if (incoming.type === 'error') {
					message.textContent = `${String(incoming.code)}: ${String(incoming.message)}`;
				}
			},
			onEnded: (code, text) => {
				following = false;
				if (surfaceId !== null) message.textContent = `Not following — ${code}: ${text}`;
				renderControls();
			},
		},
	});

	on(followButton, 'click', () => {
		if (following) {
			stream.stop();
			return;
		}
		if (surfaceId !== null) stream.start();
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden' && following) stream.stop();
	});

	app.append(shell);
	caption.textContent = 'Agent surface';
	message.textContent = 'Waiting for the host to pass the published surface.';
	renderControls();
	bridge.watchSize(shell);
	void bridge.connect({ name: 'tykotech-a2ui-surface', version: '1' }).catch(() => {
		message.textContent = 'This view must be opened by an MCP Apps host.';
	});
}

main();
