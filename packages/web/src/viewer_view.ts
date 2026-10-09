/**
 * The live viewer: the screencast canvas, input forwarding, the inspector and reconnection (B6).
 *
 * Presentation: a full-bleed stage with a floating glass toolbar, the canvas
 * framed by a ring whose colour is the control state (green: you drive; amber:
 * someone else does; neutral: nobody), and the inspector as a side panel. The
 * words live in tooltips and accessible names.
 */
import type { LockInfo, TabInfo } from '@tykotech/wire';
import { api, ApiError } from './api.ts';
import { createCanvas } from './canvas.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { createInspector } from './inspector.ts';
import { onLeave } from './lifecycle.ts';
import { invoke } from './mcp.ts';
import { busy, button, copyButton, iconButton, illustration, messageOf, relabel, tip, toast } from './ui.ts';
import type { LiveViewSocket } from './ws.ts';
import { rememberWatched, sessionTabs } from './session_tabs.ts';
import { type Navigate, renderShell } from './shell.ts';

/** Reasons the server ends a view deliberately; retrying would argue with it. */
const FINAL_REASONS = new Set(['session-closed', 'server-shutdown']);
/** Auto-reconnect backoff (R6). */
const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 15_000;

/**
 * How long a dropped view keeps trying before it gives up for good (B6.2).
 *
 * This replaces the old eight-attempt budget, which with exponential backoff
 * expired after about a minute — long enough for a page reload, nowhere near
 * long enough for a laptop to come off standby, a VPN to re-establish, or a
 * server to finish restarting. Ten minutes is the window in which a recording
 * session is still plausibly the *same* session, and the credential is still in
 * memory. Past it, the honest answer is that this view is gone.
 *
 * The window opens on the first drop after a good connection and is measured
 * from there, so a view that reconnects cleanly starts a fresh ten minutes and
 * one that flaps for ten minutes still stops.
 */
export const RECOVERY_WINDOW_MS = 600_000;

/**
 * How long to wait after the server says this principal is over its connection
 * budget (F3).
 *
 * The per-principal long-lived-connection cap is counted across live-view
 * sockets and SSE streams together, and a retry loop that ignores it competes
 * with its own dead sockets for the last free slot. A browser cannot read the
 * status of a failed WebSocket *upgrade*, so the 429 is only visible when it
 * lands on the ticket mint — but when it does, the right response is to stop
 * asking for a while rather than to back off by another 750 ms.
 */
const RATE_LIMIT_COOLOFF_MS = 30_000;

/**
 * How long to wait before reconnect attempt `attempt`, given what is left of the
 * recovery window and any cool-off a 429 imposed (B6.2, F3).
 *
 * Exported because it is the whole of the retry policy and the only part of it
 * that can be asserted without a browser: the backoff grows, a cool-off outranks
 * it, and neither may push the next attempt past the end of the window — waiting
 * beyond the deadline would mean the last attempt never happens.
 */
export function nextRetryDelayMs(attempt: number, remainingMs: number, coolOffMs: number): number {
	const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
	return Math.min(Math.max(backoff, coolOffMs), remainingMs);
}

/** The problem the ticket mint answers for a session this credential cannot see. */
const UNKNOWN_SESSION = 'https://tykotech.eu/problems/unknown-session';

/**
 * True when the ticket mint refused because the session does not exist for this credential (RV-2) — the one
 * refusal no retry can outlast. In owner mode another principal's session answers exactly as one that never existed
 * (no existence leak, D-128), and neither appears by asking again, so the view ends at once instead of backing off
 * for ten minutes. A bare 404 without the server's problem document (a proxy, a rolling deploy) still retries.
 */
export function isMissingSession(cause: unknown): boolean {
	return cause instanceof ApiError && cause.status === 404 && cause.problem?.type === UNKNOWN_SESSION;
}

// --- viewer -------------------------------------------------------------------

export function viewerView(sessionId: string, navigate: Navigate): void {
	// The connection, as a dot in the address pill: `dot live` once a socket reaches `meta`.
	const status = el('span', { class: 'dot', role: 'img', 'aria-label': 'Connecting', 'data-tip': 'Connecting' });
	// SR1-A5. The socket now sends origin plus path and never the query or the
	// fragment, so this field shows a page's address rather than its full URL. The
	// label says so: a field that reads as a complete URL while omitting the part
	// that distinguishes two pages would mislead the human reading it, and typing
	// Enter here re-navigates to exactly what is shown.
	const urlField = el('input', {
		id: 'lv-url',
		type: 'text',
		class: 'lv-url',
		readonly: true,
		spellcheck: 'false',
		autocomplete: 'off',
		'aria-label': 'Page address — origin and path',
		title: 'Origin and path only; the query string and fragment are not sent to the live view.',
	});
	const tabSelect = el('select', { 'aria-label': 'Open tabs' });
	const tabPicker = el('div', { class: 'lv-tabs', hidden: true }, [icon('tabs'), tabSelect]);
	const controlButton = button({ label: 'Take control', icon: 'control', iconOnly: true });
	controlButton.classList.add('lv-control');
	controlButton.disabled = true;
	const modePill = el('span', { class: 'lv-mode idle', role: 'img' });
	const sessionChip = el('span', { class: 'lv-session mono', 'data-tip': 'Session id', text: sessionId });
	const pageTitle = el('span', { class: 'lv-title' });
	const historyBack = iconButton('back', 'Go back');
	const inspectorToggle = iconButton('panel', 'Toggle inspector');
	const bannerGlyph = el('span', { class: 'lv-banner-glyph', 'aria-hidden': 'true' });
	const bannerText = el('span', { class: 'lv-banner-text' });
	const banner = el('div', { class: 'lv-banner', role: 'status', hidden: true }, [bannerGlyph, bannerText]);
	const stage = el('div', { class: 'lv-stage', 'data-control': 'none' });

	let socket: LiveViewSocket | null = null;
	let viewerId: string | null = null;
	let mode: 'watch' | 'control' = 'watch';
	let lock: LockInfo | null = null;
	let destroyed = false;
	/**
	 * Whether the session is known to exist for this credential: set by the first `meta`, cleared when the view ends
	 * for good (RV-2). The inspector and the toolbar's tool buttons wait for it; until then they could only fail.
	 */
	let ready = false;
	/** The id the ticket resolved `sessionId` to — `default` names a real session once one exists. */
	let resolved = sessionId;
	/**
	 * Auto-reconnect state (R6).
	 *
	 * A live-view ticket is single-use and lives 30 seconds, so a dropped socket
	 * cannot simply be reopened — every attempt has to mint a new one. That is
	 * why reconnection is a loop with a budget rather than one retry: a laptop
	 * closing its lid, a proxy idling out a WebSocket, and a server restart all
	 * look the same from here, and all of them should end with the view back on
	 * screen without the user clicking anything.
	 *
	 * `bye` is the exception. It means the server ended this view deliberately —
	 * the session was closed, or the server is shutting down — and retrying
	 * would be arguing with it.
	 */
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * When the current run of failures stops being worth retrying (B6.2).
	 *
	 * `null` means "not currently failing". It is set on the first drop after a
	 * good connection and cleared by the next `meta`, so the window always
	 * measures one unbroken run of failures rather than the age of the view.
	 */
	let recoveryDeadline: number | null = null;
	/** Epoch ms before which no ticket should be minted, after a 429 (F3). */
	let coolOffUntil = 0;
	/**
	 * The stage's single overlay, or `null` (F2).
	 *
	 * Tracked rather than appended blindly: every overlay is
	 * `position:absolute; inset:0`, so two of them stack perfectly and the upper
	 * one silently eats every click meant for the button underneath.
	 */
	let overlay: HTMLElement | null = null;

	const canvas = createCanvas((message) => socket?.send(message));
	stage.append(canvas.element);

	const body = el('div', { class: 'lv-body' });
	const setInspector = (open: boolean): void => {
		body.classList.toggle('inspector-open', open);
		inspectorToggle.classList.toggle('on', open);
		inspectorToggle.setAttribute('aria-pressed', String(open));
	};
	const inspector = createInspector((message) => socket?.send(message), () => setInspector(false));
	on(inspectorToggle, 'click', () => setInspector(!body.classList.contains('inspector-open')));

	/** The connection dot: a tone and what it means (its tooltip and accessible name). */
	function setConnection(tone: 'live' | 'dead', meaning: string): void {
		status.className = `dot ${tone}`;
		status.setAttribute('aria-label', meaning);
		status.setAttribute('data-tip', meaning);
	}

	/** The mode chip: a glyph always, and a word only where it must be read at a glance (DRIVING). */
	function setMode(
		kind: 'connecting' | 'offline' | 'idle' | 'driving' | 'locked',
		glyph: IconName,
		word: string,
		explain: string,
	): void {
		modePill.className = `lv-mode ${kind}`;
		modePill.replaceChildren(icon(glyph), ...(kind === 'driving' ? [el('span', { text: word })] : []));
		modePill.setAttribute('aria-label', word);
		modePill.setAttribute('data-tip', explain);
	}

	function setBanner(text: string, kind: 'locked' | 'error' | null): void {
		banner.hidden = text === '';
		bannerText.textContent = text;
		banner.className = `lv-banner${kind === null ? '' : ` ${kind}`}`;
		bannerGlyph.replaceChildren(icon(kind === 'error' ? 'alert' : 'lock'));
	}

	function setTitle(title: string): void {
		pageTitle.textContent = title;
		if (title === '') pageTitle.removeAttribute('data-tip');
		else pageTitle.setAttribute('data-tip', title);
	}

	function holdsControl(): boolean {
		return lock !== null && viewerId !== null && lock.holder === viewerId;
	}

	/** The tool buttons (toolbar back, inspector): offered once the session is known to exist and nobody holds it. */
	function syncTools(): void {
		historyBack.disabled = !ready || lock !== null;
		historyBack.title = !ready
			? 'Waiting for the live view to connect to this session'
			: lock !== null
			? 'Browser tools are refused while a human holds the session'
			: '';
		inspector.setReady(ready);
	}

	/** RV-2: the view ended for good, so nothing that calls the session is offered any more. */
	function endTools(): void {
		ready = false;
		syncTools();
	}

	function renderControlState(): void {
		const driving = holdsControl();
		canvas.setInteractive(driving);
		canvas.element.classList.toggle('locked', lock !== null && !driving);
		// The ring around the canvas: green while you drive, amber while someone else does.
		stage.setAttribute('data-control', driving ? 'you' : lock !== null ? 'other' : 'none');
		// Editable while driving (the socket navigates) or while nobody holds the
		// session (a `browser_navigate` tool call does); read-only while someone
		// else drives, because both of those would be refused.
		urlField.readOnly = lock !== null && !driving;
		inspector.setLock(lock !== null, driving);
		syncTools();

		if (driving) {
			setMode('driving', 'control', 'DRIVING', 'You are in control — pointer and keys go to the page');
			relabel(controlButton, 'Release control', 'release');
			controlButton.classList.add('driving');
			controlButton.disabled = false;
			setBanner('', null);
			return;
		}
		controlButton.classList.remove('driving');
		if (lock !== null) {
			const who = lock.holderName ?? lock.principal;
			setMode('locked', 'lock', 'In use', `${who} is in control`);
			relabel(controlButton, 'Take control', 'control');
			controlButton.disabled = true;
			setBanner(
				`${lock.principal} has control since ${new Date(lock.takenAt).toLocaleTimeString()}.`,
				'locked',
			);
			return;
		}
		if (mode === 'control') setMode('idle', 'eye', 'Watching', 'Watching — take control to drive');
		else setMode('idle', 'eye-off', 'Watch only', 'Watch only — this credential cannot take control');
		relabel(controlButton, 'Take control', 'control');
		controlButton.disabled = mode !== 'control';
		setBanner('', null);
	}

	function renderTabs(tabs: TabInfo[]): void {
		clear(tabSelect);
		for (const tab of tabs) {
			const option = el('option', { value: tab.tabId, text: tab.title || tab.url || tab.tabId });
			if (tab.focused) {
				option.selected = true;
				// Same guard as `onState`: a `tabs` message must not overwrite an
				// address the user is in the middle of typing.
				if (!urlField.matches(':focus')) urlField.value = tab.url;
				setTitle(tab.title);
			}
			tabSelect.append(option);
		}
		tabSelect.disabled = tabs.length < 2 || !holdsControl();
		// One tab needs no picker; the inspector still lists it.
		tabPicker.hidden = tabs.length < 2;
		tip(tabPicker, `${tabs.length} tabs`);
		inspector.setTabs(tabs);
	}

	on(controlButton, 'click', () => {
		socket?.send({ type: holdsControl() ? 'control.release' : 'control.take' });
	});

	on(tabSelect, 'change', () => {
		if (holdsControl()) socket?.send({ type: 'tab.switch', tabId: tabSelect.value });
	});

	on(urlField, 'keydown', (event) => {
		if (event.key !== 'Enter') return;
		const url = urlField.value.trim();
		if (holdsControl()) {
			socket?.send({ type: 'navigate', url });
			return;
		}
		if (lock !== null || urlField.readOnly) return;
		urlField.blur();
		invoke('browser_navigate', { session_id: resolved, url }).catch((cause) => toast(messageOf(cause), 'error'));
	});

	on(historyBack, 'click', () => {
		void busy(historyBack, () => invoke('browser_go_back', { session_id: resolved })).catch((cause) =>
			toast(messageOf(cause), 'error')
		);
	});

	/** An action offered on the overlay. The first is the primary one. */
	interface OverlayAction {
		readonly label: string;
		readonly icon: IconName;
		readonly run: () => void;
	}

	/** How an overlay looks: its illustration, its tone, and (while retrying) the time until the next attempt. */
	interface OverlayLook {
		readonly glyph: IconName;
		readonly tone: 'warn' | 'danger' | 'info';
		readonly countdownMs?: number;
	}

	/**
	 * Takes down every overlay on the stage (F2).
	 *
	 * Deliberately a sweep rather than `overlay.remove()`: the invariant this
	 * function exists to hold is "at most one overlay", and a sweep repairs a
	 * violation instead of trusting that one never happened. Whatever is on the
	 * stage, after this the canvas is clickable.
	 */
	function hideOverlay(): void {
		for (const node of Array.from(stage.querySelectorAll('.overlay'))) node.remove();
		overlay = null;
	}

	/**
	 * Shows the stage's one overlay, replacing whatever was there (F2).
	 *
	 * The previous implementation appended and never removed, so each disconnect
	 * left another full-stage sibling behind. After eight idle timeouts the stack
	 * was nine deep and the topmost overlay intercepted every click aimed at the
	 * Reconnect button below it: the recovery affordance was dead precisely when
	 * it was needed, and only a full document reload got the view back.
	 */
	function showOverlay(
		message: string,
		detail: string | null,
		actions: readonly OverlayAction[],
		look: OverlayLook = { glyph: 'radio', tone: 'warn' },
	): void {
		hideOverlay();
		const buttons = actions.map(({ label, icon: glyph, run }, index) =>
			button({ label, icon: glyph, variant: index === 0 ? 'primary' : undefined, onClick: run })
		);
		const countdown: Node[] = [];
		if (look.countdownMs !== undefined) {
			const fill = el('span', { class: 'overlay-countdown-fill' });
			// A CSSOM write (the CSP allows it): the bar drains over exactly the wait.
			fill.style.setProperty('--lv-wait', `${Math.max(0, Math.round(look.countdownMs))}ms`);
			countdown.push(el('div', { class: 'overlay-countdown', 'aria-hidden': 'true' }, [fill]));
		}
		overlay = el('div', { class: 'overlay', role: 'alertdialog', 'aria-label': message }, [
			el('div', { class: `overlay-card ${look.tone}` }, [
				illustration(look.glyph, look.tone),
				el('div', { class: 'overlay-title', text: message }),
				...(detail === null ? [] : [el('div', { class: 'overlay-detail', text: detail })]),
				...countdown,
				el('div', { class: 'overlay-actions' }, buttons),
			]),
		]);
		stage.append(overlay);
	}

	/** Puts the canvas back in front of the user and clears any overlay. */
	function restoreStage(): void {
		hideOverlay();
		if (!stage.contains(canvas.element)) stage.append(canvas.element);
		canvas.element.classList.remove('dead');
	}

	async function connect(): Promise<void> {
		try {
			// Loaded on first use: the socket validates every server message with the
			// shared wire schemas, and that validator is most of the JavaScript the
			// app ships. Screens that never open a live view never download it.
			const { LiveViewSocket } = await import('./ws.ts');
			// Each await is a window in which the operator may have left this view; its
			// teardown has already run with no socket to close, so a socket opened
			// after it would never be closed (G3-1).
			if (destroyed) return;
			const ticket = await api.mintTicket(sessionId === 'default' ? undefined : sessionId);
			if (destroyed) return;
			mode = ticket.mode;
			resolved = ticket.session_id;
			// D-147: the Live View tab comes back to this session, by the id `default` resolved to.
			rememberWatched(ticket.session_id);
			sessionChip.textContent = ticket.session_id;
			inspector.setSession(ticket.session_id);
			const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
			socket = new LiveViewSocket(
				`${scheme}://${location.host}/live/${encodeURIComponent(ticket.session_id)}/ws` +
					`?ticket=${encodeURIComponent(ticket.ticket)}`,
				{
					onMeta: (meta) => {
						// A connection that reached `meta` is a good one: the next drop
						// starts its backoff from zero rather than from where this one
						// left off, and opens a fresh recovery window rather than
						// inheriting the remains of the last one.
						attempt = 0;
						recoveryDeadline = null;
						coolOffUntil = 0;
						restoreStage();
						// The server names this connection, so `lock.holder === viewerId`
						// distinguishes our own lock from another viewer's.
						viewerId = meta.viewerId;
						mode = meta.mode;
						lock = meta.lock;
						ready = true;
						setConnection('live', 'Connected');
						renderTabs(meta.tabs);
						renderControlState();
						// FXD-N3: a subscription belongs to one socket, so a reconnected one is asked again while the
						// Inspector's toggle says "Streaming"; `onClosed` leaves the toggle as the operator set it.
						inspector.socketReady();
					},
					onTabs: renderTabs,
					onLock: (next) => {
						lock = next;
						renderControlState();
					},
					onState: (url, title) => {
						if (!urlField.matches(':focus')) urlField.value = url;
						setTitle(title);
					},
					onError: (code, message) => setBanner(`${code}: ${message}`, 'error'),
					onFrame: (meta, jpeg) => canvas.draw(meta, jpeg),
					onEvent: (record) => inspector.event(record),
					onClosed: (reason) => {
						if (destroyed) return;
						setConnection('dead', 'Disconnected');
						canvas.element.classList.add('dead');
						canvas.setInteractive(false);
						// The lock died with the socket, and the server has already
						// released it; showing it as still held would be a lie.
						lock = null;
						viewerId = null;
						stage.setAttribute('data-control', 'none');
						setMode('offline', 'unplug', 'Disconnected', 'Disconnected');
						if (FINAL_REASONS.has(reason)) {
							manualRetry(`Disconnected: ${reason}`);
							return;
						}
						scheduleReconnect(reason);
					},
				},
			);
		} catch (cause) {
			setConnection('dead', 'Disconnected');
			if (destroyed) return;
			setMode('offline', 'unplug', 'Disconnected', 'Disconnected');
			if (isMissingSession(cause)) {
				missing();
				return;
			}
			// A 429 on the mint is the server saying this principal already holds
			// every long-lived connection it is allowed (F3). Retrying on the
			// ordinary backoff would just keep asking; the slots free themselves
			// only once the dead sockets behind them are reaped.
			if (cause instanceof ApiError && cause.status === 429) {
				coolOffUntil = Date.now() + (cause.retryAfterMs ?? RATE_LIMIT_COOLOFF_MS);
			}
			scheduleReconnect(messageOf(cause));
		}
	}

	/** Cancels any pending automatic retry. */
	function cancelRetry(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	}

	/** Starts a fresh attempt now, from a button. */
	function retryNow(): void {
		cancelRetry();
		restoreStage();
		void connect();
	}

	/** Leaves this view for the session picker, where a new session can be started. */
	function startNewSession(): void {
		cancelRetry();
		navigate('#/sessions');
	}

	/**
	 * The server ended this view on purpose; retrying is arguing with it.
	 *
	 * Still offers a retry, because `server-shutdown` becomes retryable the moment
	 * the server is back, but leads with the exit that actually applies.
	 */
	function manualRetry(reason: string): void {
		endTools();
		showOverlay(
			`Disconnected: ${reason}`,
			'The server ended this view. Reconnecting will only work once that reason no longer applies.',
			[{ label: 'Reconnect', icon: 'refresh', run: retryNow }, {
				label: 'Back to sessions',
				icon: 'sessions',
				run: startNewSession,
			}],
			{ glyph: 'unplug', tone: 'danger' },
		);
	}

	/**
	 * The mint answered `unknown-session` (RV-2): this session does not exist for this credential, and asking again
	 * cannot change that. The view ends here — no countdown, no Reconnect, one way back — and the tool buttons stay
	 * disabled. The words are the same whether the id never existed or belongs to another principal (D-128).
	 */
	function missing(): void {
		cancelRetry();
		attempt = 0;
		recoveryDeadline = null;
		endTools();
		setConnection('dead', 'Session not found');
		showOverlay(
			'This session does not exist for this credential',
			`No session ${sessionId} is open for this sign-in. It may have been closed.`,
			[{ label: 'Back to sessions', icon: 'sessions', run: startNewSession }],
			{ glyph: 'ban', tone: 'danger' },
		);
	}

	/**
	 * The recovery window ran out (B6.2).
	 *
	 * The end of the road, and it says so rather than offering a Reconnect button
	 * that will fail the same way it has for the last ten minutes. The ticket this
	 * view was minted against is long expired and the session behind it may have
	 * been reaped for idleness, so the honest next step is a new session — but
	 * "Try again" stays available, because the operator may know something the
	 * page does not (the server was being restarted, the VPN is back).
	 */
	function expire(reason: string): void {
		cancelRetry();
		attempt = 0;
		recoveryDeadline = null;
		socket = null;
		endTools();
		showOverlay(
			'Session and recovery window expired',
			`No connection could be re-established in ${Math.round(RECOVERY_WINDOW_MS / 60_000)} minutes. ` +
				`Last reason: ${reason}.`,
			[{ label: 'Start a new session', icon: 'plus', run: startNewSession }, {
				label: 'Try again',
				icon: 'refresh',
				run: retryNow,
			}],
			{ glyph: 'timer', tone: 'danger' },
		);
	}

	/**
	 * Backs off and tries again, minting a fresh ticket each time.
	 *
	 * The delay grows so a server that is down does not get hammered by every
	 * open tab, and it is capped so a view left open overnight still comes back
	 * within seconds of the server returning. What bounds the loop is the
	 * recovery window, not an attempt count: with exponential backoff an
	 * eight-attempt budget expired after about a minute, which is shorter than
	 * most of the outages a live view is expected to survive.
	 */
	function scheduleReconnect(reason: string): void {
		if (destroyed) return;
		// Opens on the first failure of a run and is cleared by the next `meta`.
		if (recoveryDeadline === null) recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;

		const remaining = recoveryDeadline - Date.now();
		if (remaining <= 0) {
			expire(reason);
			return;
		}

		attempt += 1;
		const delay = nextRetryDelayMs(attempt, remaining, coolOffUntil - Date.now());

		showOverlay(
			`Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s — ${reason}`,
			`Giving up in ${Math.max(1, Math.round(remaining / 60_000))} min if this does not come back.`,
			[{ label: 'Reconnect now', icon: 'refresh', run: retryNow }, {
				label: 'Start a new session',
				icon: 'plus',
				run: startNewSession,
			}],
			{ glyph: 'radio', tone: 'warn', countdownMs: delay },
		);

		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (destroyed) return;
			restoreStage();
			void connect();
		}, delay);
	}

	// The floating toolbar. The address field is the first — and, until an
	// inspector section with inputs is opened, the only — input on this screen.
	const toolbar = el('div', { class: 'lv-toolbar' }, [
		el('div', { class: 'lv-group' }, [historyBack]),
		el('div', { class: 'lv-address' }, [
			status,
			el('label', { class: 'sr-only', for: 'lv-url', text: 'Page address' }),
			urlField,
		]),
		tabPicker,
		el('div', { class: 'lv-group lv-end' }, [modePill, controlButton, inspector.capture, inspectorToggle]),
	]);
	body.append(el('div', { class: 'lv-main' }, [toolbar, banner, stage]), inspector.node);
	setInspector(globalThis.innerWidth >= 1100);

	const identity = el('div', { class: 'lv-ident' }, [
		sessionChip,
		copyButton(() => resolved, 'Copy session id'),
	]);

	// A class, not a `style` attribute (F4). The page's own CSP declares
	// `style-src 'self'`, which blocks style *attributes* — so the attribute form
	// reached the DOM, was refused by the browser, logged a console error on
	// every load, and left the viewer without its flex column and with ~105 px of
	// dead space below the canvas. `canvas.ts` is the contrasting case and is
	// correct: `node.style.cssText` is a CSSOM write, which CSP does not gate.
	rememberWatched(sessionId);
	mount(
		renderShell(navigate, {
			active: 'sessions',
			title: 'Live View',
			tabs: sessionTabs('view'),
			flush: true,
			actions: [identity, pageTitle],
		}, [body]),
	);

	renderControlState();
	setMode('connecting', 'loader', 'Connecting', 'Connecting');
	void connect();

	// Not `hashchange`: clicking the Live View rail item re-renders this route with
	// no hash change, and a leaked view keeps its socket, canvas and reconnect loop —
	// and can hold the takeover lock from a viewer nobody can see (G-1).
	onLeave(() => {
		destroyed = true;
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		socket?.close();
		canvas.destroy();
	});
}
