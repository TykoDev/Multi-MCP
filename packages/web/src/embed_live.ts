/**
 * The live-view embed, `ui://tykotech/live-view` (R9, design §2.20, D-134/D-135).
 *
 * A watch-first view of one browser session, framed by an MCP Apps host in its own sandbox origin. Kit-free: one
 * self-contained document, its script and style inline and pinned by hash in its meta CSP, and the only network it
 * may reach is the gateway's live-view socket (`connect-src`).
 *
 * The session comes from the `browser_live_view` result the host relays (`ui/notifications/tool-result`). Nothing
 * connects until the user presses **Watch**: each press mints a single-use, origin-bound 30-second ticket through the
 * app-only `browser_live_ticket` tool (the host proxies the call over its own MCP connection) and opens
 * `/live/:sessionId/ws` with it. A dropped connection reconnects with the control plane's backoff — 750 ms doubling
 * to 15 s inside a ten-minute window — minting a fresh ticket each time; a connection the server refuses before it
 * ever reaches `meta` is not retried, because retrying a refused origin is a loop, not a recovery.
 *
 * `ui/resource-teardown` and `visibilitychange: hidden` close the socket, which also gives back the viewer slot and
 * any control the user held; coming back into view does not reconnect on its own (design §2.20: the socket opens on
 * the Watch click only). **Take control** exists only when the deployment runs `TTK_MCP_APPS=control` and the
 * credential holds `view:control`: it mints a separate control ticket on its own click. **Open in the control plane**
 * sits in the corner once a ticket has named the control plane's address.
 *
 * Controls follow the control plane's rules: one home per control — Watch and Stop are
 * one button — no control is shown that does nothing in the current state, glyphs are the SPA's Lucide sprite
 * (inlined), and every icon-only button's accessible name is its tooltip.
 */
// First, before anything builds a schema: no `new Function` probe under the embed's CSP (jitless.ts).
import './jitless.ts';
import type { LockInfo } from '@tykotech/wire';
import { createCanvas } from './canvas.ts';
import { el, on } from './dom.ts';
import {
	applyHostContext,
	EmbedBridge,
	embedIcon,
	type EmbedIconName,
	type EmbedToolResult,
	refusalWords,
	toolErrorOf,
} from './embed_bridge.ts';
import { LiveViewSocket } from './ws.ts';

/** The control plane's reconnect policy (FRONTEND §2.3), restated because the viewer module brings the kit. */
const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 15_000;
const RECOVERY_WINDOW_MS = 600_000;
/** Reasons the server ends a view deliberately; retrying would argue with it. */
const FINAL_REASONS = new Set(['session-closed', 'server-shutdown']);

/** `browser_live_view`'s structured result. */
interface LiveViewResult {
	readonly session_id: string;
	readonly origin: string | null;
	readonly title: string;
	readonly control_available: boolean;
}

/** `browser_live_ticket`'s structured result. */
interface TicketResult {
	readonly ticket: string;
	readonly ws_url: string;
	readonly session_id: string;
	readonly mode: 'watch' | 'control';
	readonly control_plane_url: string;
}

/** A refused mint, kept apart from a bridge failure so the two read differently. */
class TicketRefused extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

type Phase = 'waiting' | 'idle' | 'connecting' | 'live' | 'reconnecting' | 'refused' | 'ended';

function liveViewOf(result: EmbedToolResult): LiveViewResult | null {
	const data = result.structuredContent;
	if (data === undefined || typeof data.session_id !== 'string') return null;
	return {
		session_id: data.session_id,
		origin: typeof data.origin === 'string' ? data.origin : null,
		title: typeof data.title === 'string' ? data.title : '',
		control_available: data.control_available === true,
	};
}

function ticketOf(result: EmbedToolResult): TicketResult {
	const refused = toolErrorOf(result);
	if (refused !== null) throw new TicketRefused(refused.code, refused.message);
	const data = result.structuredContent ?? {};
	const { ticket, ws_url: wsUrl, session_id: sessionId, mode, control_plane_url: planeUrl } = data;
	if (
		typeof ticket !== 'string' || typeof wsUrl !== 'string' || typeof sessionId !== 'string' ||
		(mode !== 'watch' && mode !== 'control') || typeof planeUrl !== 'string'
	) {
		throw new TicketRefused('invalid-result', 'the server answered without a usable ticket');
	}
	return { ticket, ws_url: wsUrl, session_id: sessionId, mode, control_plane_url: planeUrl };
}

/** An icon-only button whose accessible name is its tooltip. */
function iconButton(glyph: EmbedIconName, label: string, extraClass = ''): HTMLButtonElement {
	const button = el('button', {
		class: `e-btn icon ${extraClass}`.trim(),
		type: 'button',
		'aria-label': label,
		title: label,
	});
	button.append(embedIcon(glyph));
	return button;
}

function relabel(button: HTMLButtonElement, glyph: EmbedIconName, label: string, showLabel: boolean): void {
	button.replaceChildren(embedIcon(glyph), ...(showLabel ? [el('span', { text: label })] : []));
	button.setAttribute('aria-label', label);
	button.title = label;
}

function main(): void {
	const app = document.getElementById('app');
	if (app === null) return;

	const dot = el('span', { class: 'e-dot', role: 'img' });
	const titleNode = el('span', { class: 'e-title' });
	const originNode = el('span', { class: 'e-origin mono' });
	const holder = el('span', { class: 'e-holder', hidden: true });
	const controlButton = iconButton('control', 'Take control');
	const watchButton = el('button', { class: 'e-btn primary', type: 'button' });
	const openButton = iconButton('external', 'Open in the control plane', 'corner');
	const messageGlyph = el('span', { class: 'e-message-glyph', 'aria-hidden': 'true' });
	const messageText = el('p', { class: 'e-message-text' });
	// RV-10: what only the operator can act on (the origin, the variable to set) is folded under the sentence.
	const messageDetailText = el('p', { class: 'e-detail-text' });
	const messageDetail = el('details', { class: 'e-detail', hidden: true }, [
		el('summary', { text: 'Details' }),
		messageDetailText,
	]);
	const message = el('div', { class: 'e-message', role: 'status', 'aria-live': 'polite' }, [
		messageGlyph,
		messageText,
		messageDetail,
	]);
	const notice = el('p', { class: 'e-notice', role: 'status', 'aria-live': 'polite' });
	const stage = el('div', { class: 'e-stage' });
	const shell = el('main', { class: 'embed live', 'data-phase': 'waiting' }, [
		el('header', { class: 'e-bar' }, [
			dot,
			el('span', { class: 'e-ident' }, [titleNode, originNode]),
			holder,
			el('span', { class: 'e-actions' }, [controlButton, watchButton, openButton]),
		]),
		stage,
		notice,
	]);

	let phase: Phase = 'waiting';
	let view: LiveViewResult | null = null;
	let socket: LiveViewSocket | null = null;
	let socketMode: 'watch' | 'control' = 'watch';
	let viewerId: string | null = null;
	let lock: LockInfo | null = null;
	let controlPlaneUrl: string | null = null;
	/** The user asked to watch; cleared by Stop, teardown and hiding. */
	let wanted = false;
	/** A Take control press waiting for its control socket's `meta`. */
	let pendingTake = false;
	/** Whether the last refusal could pass on another press; an unadmitted origin cannot. */
	let retryable = true;
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let recoveryDeadline: number | null = null;
	/** Bumped by every open and every stop, so a mint or a socket that outlived its press is ignored. */
	let generation = 0;

	const canvas = createCanvas((outbound) => socket?.send(outbound));
	stage.append(canvas.element, message);

	const driving = (): boolean => lock !== null && viewerId !== null && lock.holder === viewerId;

	/** The stage's message: a glyph, one sentence, and optionally the operator's detail, folded. */
	function say(glyph: EmbedIconName | null, text: string, detail?: string): void {
		messageGlyph.replaceChildren(...(glyph === null ? [] : [embedIcon(glyph)]));
		messageText.textContent = text;
		messageDetail.hidden = detail === undefined;
		messageDetail.open = false;
		messageDetailText.textContent = detail ?? '';
	}

	function render(): void {
		shell.setAttribute('data-phase', phase);
		const tone = phase === 'live'
			? driving() ? 'driving' : 'live'
			: phase === 'connecting' || phase === 'reconnecting'
			? 'busy'
			: phase === 'refused' || phase === 'ended'
			? 'dead'
			: 'idle';
		const meaning = tone === 'driving'
			? 'You are in control'
			: tone === 'live'
			? 'Watching'
			: tone === 'busy'
			? 'Connecting'
			: 'Not connected';
		dot.className = `e-dot ${tone}`;
		dot.setAttribute('aria-label', meaning);
		dot.title = meaning;

		const streaming = phase === 'connecting' || phase === 'live' || phase === 'reconnecting';
		watchButton.hidden = phase === 'waiting' || view === null || (phase === 'refused' && !retryable);
		watchButton.className = streaming ? 'e-btn quiet' : 'e-btn primary';
		if (streaming) relabel(watchButton, 'stop', 'Stop', true);
		else relabel(watchButton, 'eye', 'Watch', true);

		// Offered only where it can work: this deployment and credential allow control, the socket is up, and nobody
		// else holds the browser (the holder chip says who does).
		const someoneElse = lock !== null && !driving();
		controlButton.hidden = !(view?.control_available === true && phase === 'live' && !someoneElse);
		if (driving()) relabel(controlButton, 'release', 'Release control', false);
		else relabel(controlButton, 'control', 'Take control', false);
		controlButton.classList.toggle('on', driving());
		canvas.setInteractive(driving());

		holder.hidden = !(phase === 'live' && someoneElse);
		if (someoneElse && lock !== null) {
			const who = lock.holderName ?? lock.principal;
			holder.replaceChildren(embedIcon('lock'), el('span', { text: `In use by ${who}` }));
			holder.title = `${who} is in control`;
		}
		openButton.hidden = controlPlaneUrl === null;
		message.hidden = phase === 'live';
	}

	function showView(next: LiveViewResult): void {
		view = next;
		titleNode.textContent = next.title === '' ? 'Untitled page' : next.title;
		titleNode.title = `Session ${next.session_id}`;
		originNode.textContent = next.origin ?? '';
		if (phase === 'waiting' || phase === 'refused') {
			phase = 'idle';
			say('eye', `Press Watch to stream session ${next.session_id} here.`);
		}
		render();
	}

	function cancelRetry(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	}

	function closeSocket(): void {
		const current = socket;
		socket = null;
		viewerId = null;
		lock = null;
		current?.close();
	}

	/** Stops everything the user started; `text` says why, for the stage. */
	function stop(text: string): void {
		wanted = false;
		pendingTake = false;
		generation += 1;
		cancelRetry();
		closeSocket();
		recoveryDeadline = null;
		attempt = 0;
		if (view !== null) {
			phase = 'idle';
			say('eye', text);
		}
		render();
	}

	function refuse(code: string, text: string): void {
		wanted = false;
		pendingTake = false;
		cancelRetry();
		closeSocket();
		phase = 'refused';
		// An origin the server does not admit stays refused however often it is asked, so Watch is not offered again:
		// a button that can only fail is an idle control. Any other refusal may pass on the next press. The person in
		// the chat reads a sentence; the code, the origin and the variable to set are the operator's (RV-10).
		const words = refusalWords(code, text);
		retryable = words.retryable;
		say('alert', words.user, words.detail);
		render();
	}

	async function open(mode: 'watch' | 'control'): Promise<void> {
		if (view === null) return;
		const mine = ++generation;
		cancelRetry();
		// Taking control from a running watch keeps the watch until the control ticket is in hand, so a refused
		// control press costs the user nothing they had.
		const keepWatching = mode === 'control' && socket !== null;
		if (!keepWatching) {
			closeSocket();
			phase = phase === 'reconnecting' ? 'reconnecting' : 'connecting';
			say(null, 'Connecting…');
			render();
		}
		let ticket: TicketResult;
		try {
			ticket = ticketOf(
				await bridge.callTool('browser_live_ticket', { session_id: view.session_id, mode, origin: location.origin }),
			);
		} catch (cause) {
			if (mine !== generation) return;
			const code = cause instanceof TicketRefused ? cause.code : 'host-error';
			const text = cause instanceof Error ? cause.message : 'the host did not relay the call';
			if (keepWatching) {
				pendingTake = false;
				notice.textContent = `Control is not available — ${code}: ${text}`;
				return;
			}
			refuse(code, text);
			return;
		}
		if (mine !== generation) return;
		if (keepWatching) {
			// The watch socket gives way to the control one; its close is ignored (it is no longer `socket`).
			closeSocket();
			phase = 'connecting';
			say(null, 'Taking control…');
			render();
		}
		controlPlaneUrl = ticket.control_plane_url;
		socketMode = ticket.mode;
		let reached = false;
		const url = `${ticket.ws_url}?ticket=${encodeURIComponent(ticket.ticket)}`;
		const opened: LiveViewSocket = new LiveViewSocket(url, {
			onMeta: (meta) => {
				if (opened !== socket) return;
				reached = true;
				attempt = 0;
				recoveryDeadline = null;
				viewerId = meta.viewerId;
				lock = meta.lock;
				phase = 'live';
				notice.textContent = '';
				if (pendingTake && meta.mode === 'control') opened.send({ type: 'control.take' });
				pendingTake = false;
				render();
			},
			onTabs: () => {},
			onLock: (next) => {
				if (opened !== socket) return;
				lock = next;
				render();
			},
			onState: (pageUrl, title) => {
				if (opened !== socket) return;
				titleNode.textContent = title === '' ? 'Untitled page' : title;
				originNode.textContent = URL.parse(pageUrl)?.origin ?? '';
			},
			onError: (code, text) => {
				// `internal` is the transport failing, which the close that follows explains.
				if (opened === socket && code !== 'internal') notice.textContent = `${code}: ${text}`;
			},
			onFrame: (frame, jpeg) => {
				if (opened === socket) canvas.draw(frame, jpeg);
			},
			onClosed: (reason) => {
				if (opened !== socket) return;
				closeSocket();
				if (!wanted) return;
				if (!reached) {
					refuse(
						'connection-refused',
						'the live-view socket was refused before it opened; the host’s origin may not be admitted ' +
							'(TTK_ALLOWED_ORIGINS), or the session has no free viewer slot',
					);
					return;
				}
				if (FINAL_REASONS.has(reason)) {
					wanted = false;
					phase = 'ended';
					say('alert', `The server ended this view: ${reason}.`);
					render();
					return;
				}
				reconnect(reason);
			},
		});
		socket = opened;
	}

	function reconnect(reason: string): void {
		if (recoveryDeadline === null) recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;
		const remaining = recoveryDeadline - Date.now();
		if (remaining <= 0) {
			wanted = false;
			phase = 'ended';
			say('alert', `No connection could be re-established in ten minutes. Last reason: ${reason}.`);
			render();
			return;
		}
		attempt += 1;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS, remaining);
		phase = 'reconnecting';
		say(null, `Reconnecting in ${Math.max(1, Math.round(delay / 1000))} s — ${reason}`);
		render();
		// A reconnect is always a watch: control is taken again only by a press.
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (wanted) void open('watch');
		}, delay);
	}

	on(watchButton, 'click', () => {
		if (phase === 'connecting' || phase === 'live' || phase === 'reconnecting') {
			stop('Stopped. Press Watch to stream again.');
			return;
		}
		wanted = true;
		attempt = 0;
		recoveryDeadline = null;
		void open('watch');
	});

	on(controlButton, 'click', () => {
		if (driving()) {
			socket?.send({ type: 'control.release' });
			return;
		}
		if (socketMode === 'control' && socket?.open === true) {
			socket.send({ type: 'control.take' });
			return;
		}
		// A watch ticket can never take control (B2.3): the press mints a control ticket of its own.
		pendingTake = true;
		wanted = true;
		void open('control');
	});

	on(openButton, 'click', () => {
		if (controlPlaneUrl === null) return;
		void bridge.openLink(controlPlaneUrl).catch(() => {
			notice.textContent = 'The host would not open the control plane.';
		});
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden' && (wanted || socket !== null)) {
			stop('Paused while the view was hidden. Press Watch to stream again.');
		}
	});

	const bridge = new EmbedBridge({
		onToolResult: (result) => {
			const refused = toolErrorOf(result);
			if (refused !== null) {
				phase = 'refused';
				say('alert', `The live view could not open — ${refused.code}: ${refused.message}`);
				render();
				return;
			}
			const next = liveViewOf(result);
			if (next !== null) showView(next);
		},
		onHostContext: applyHostContext,
		onTeardown: () => {
			stop('Closed.');
			canvas.destroy();
		},
	});

	app.append(shell);
	say(null, 'Waiting for the host to name the session to show.');
	render();
	bridge.watchSize(shell);
	void bridge.connect({ name: 'tykotech-live-view', version: '1' }).catch(() => {
		say('alert', 'This view must be opened by an MCP Apps host.');
	});
}

main();
