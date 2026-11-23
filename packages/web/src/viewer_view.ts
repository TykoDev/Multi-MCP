/**
 * The Live View: the screencast canvas, input forwarding, take/release control, navigation, recording and
 * reconnection. The canvas ring's colour is the control state (green: you drive; amber: someone else does).
 */
import type { LockInfo, TabInfo } from '@tykotech/wire';
import { api, ApiError, downloadFile } from './api.ts';
import { createCanvas } from './canvas.ts';
import { el, mount, on } from './dom.ts';
import type { IconName } from './icons.ts';
import { onLeave } from './lifecycle.ts';
import { invoke } from './mcp.ts';
import { type Navigate, rememberWatched, renderShell, sessionTabs } from './shell.ts';
import { busy, button, copyButton, iconButton, messageOf, relabel, toast } from './ui.ts';
import type { LiveViewSocket } from './ws.ts';

/** Reasons the server ends a view deliberately; retrying would argue with it. */
const FINAL_REASONS = new Set(['session-closed', 'server-shutdown']);
const RECONNECT_BASE_MS = 750;
const RECONNECT_MAX_MS = 15_000;

/**
 * How long a dropped view keeps trying: long enough for a laptop to wake, a VPN to return or a server to restart.
 * The window opens on the first drop after a good connection, so a view that reconnects starts a fresh one.
 */
export const RECOVERY_WINDOW_MS = 600_000;

/**
 * The wait after a 429 on the ticket mint: the per-principal connection cap counts live views and event streams
 * together, and a retry loop that ignores it competes with its own dead sockets for the last free slot.
 */
const RATE_LIMIT_COOLOFF_MS = 30_000;

/** The wait before reconnect attempt `attempt`: backoff, outranked by a cool-off, never past the window's end. */
export function nextRetryDelayMs(attempt: number, remainingMs: number, coolOffMs: number): number {
	const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
	return Math.min(Math.max(backoff, coolOffMs), remainingMs);
}

const UNKNOWN_SESSION = 'https://tykotech.eu/problems/unknown-session';

/**
 * True when the mint refused because the session does not exist for this credential — the one refusal no retry
 * outlasts. In owner mode another principal's session answers exactly as a missing one (no existence leak). A bare
 * 404 without the problem document (a proxy, a rolling deploy) still retries.
 */
export function isMissingSession(cause: unknown): boolean {
	return cause instanceof ApiError && cause.status === 404 && cause.problem?.type === UNKNOWN_SESSION;
}

export function viewerView(sessionId: string, navigate: Navigate): void {
	const status = el('span', { class: 'dot', role: 'img', 'aria-label': 'Connecting', title: 'Connecting' });
	// The socket reports origin and path only, never the query or fragment; the label says so.
	const urlField = el('input', {
		id: 'lv-url',
		type: 'text',
		class: 'lv-url',
		readonly: true,
		spellcheck: 'false',
		autocomplete: 'off',
		'aria-label': 'Page address — origin and path',
	});
	const tabSelect = el('select', { class: 'lv-tabs', 'aria-label': 'Open tabs', hidden: true });
	const controlButton = button({ label: 'Take control', icon: 'control' });
	controlButton.disabled = true;
	const modePill = el('span', { class: 'lv-mode' });
	const sessionChip = el('code', { class: 'lv-session mono', text: sessionId });
	const historyBack = iconButton('back', 'Go back');
	const record = iconButton('record', 'Record');
	const banner = el('div', { class: 'lv-banner', role: 'status', hidden: true });
	const stage = el('div', { class: 'lv-stage', 'data-control': 'none' });

	let socket: LiveViewSocket | null = null;
	let viewerId: string | null = null;
	let mode: 'watch' | 'control' = 'watch';
	let lock: LockInfo | null = null;
	let destroyed = false;
	/** Set by the first `meta`: until the session is known to exist, the tool buttons could only fail. */
	let ready = false;
	/** The id the ticket resolved `sessionId` to — `default` names a real session once one exists. */
	let resolved = sessionId;
	let recording = false;
	// A ticket is single-use and short-lived, so every reconnect mints a new one: a loop bounded by the window.
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** When the current run of failures stops being retried; `null` while not failing. */
	let recoveryDeadline: number | null = null;
	/** Epoch ms before which no ticket is minted, after a 429. */
	let coolOffUntil = 0;

	const canvas = createCanvas((message) => socket?.send(message));
	stage.append(canvas.element);

	function setConnection(tone: 'live' | 'dead', meaning: string): void {
		status.className = `dot ${tone}`;
		status.setAttribute('aria-label', meaning);
		status.title = meaning;
	}

	function setMode(kind: string, word: string): void {
		modePill.className = `lv-mode ${kind}`;
		modePill.textContent = word;
	}

	function setBanner(text: string, kind: 'locked' | 'error' | '' = ''): void {
		banner.hidden = text === '';
		banner.textContent = text;
		banner.className = `lv-banner ${kind}`;
	}

	function holdsControl(): boolean {
		return lock !== null && viewerId !== null && lock.holder === viewerId;
	}

	/** The tool buttons: offered once the session is known to exist and nobody holds it. */
	function syncTools(): void {
		historyBack.disabled = !ready || lock !== null;
		record.disabled = !ready;
	}

	function renderControlState(): void {
		const driving = holdsControl();
		canvas.setInteractive(driving);
		stage.setAttribute('data-control', driving ? 'you' : lock !== null ? 'other' : 'none');
		// Editable while driving (the socket navigates) or while nobody holds it (a tool call does).
		urlField.readOnly = lock !== null && !driving;
		syncTools();
		if (driving) {
			setMode('driving', 'DRIVING');
			relabel(controlButton, 'Release control', 'release');
			controlButton.disabled = false;
			setBanner('');
			return;
		}
		relabel(controlButton, 'Take control', 'control');
		if (lock !== null) {
			setMode('locked', 'In use');
			controlButton.disabled = true;
			setBanner(
				`${lock.holderName ?? lock.principal} has control since ${new Date(lock.takenAt).toLocaleTimeString()}.`,
				'locked',
			);
			return;
		}
		setMode('idle', mode === 'control' ? 'Watching' : 'Watch only');
		controlButton.disabled = mode !== 'control';
		setBanner('');
	}

	function renderTabs(tabs: TabInfo[]): void {
		tabSelect.replaceChildren(...tabs.map((tab) => {
			const option = el('option', { value: tab.tabId, text: tab.title || tab.url || tab.tabId });
			if (tab.focused) {
				option.selected = true;
				// A `tabs` message must not overwrite an address the user is typing.
				if (!urlField.matches(':focus')) urlField.value = tab.url;
			}
			return option;
		}));
		tabSelect.disabled = !holdsControl();
		tabSelect.hidden = tabs.length < 2;
	}

	on(controlButton, 'click', () => socket?.send({ type: holdsControl() ? 'control.release' : 'control.take' }));
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
	on(record, 'click', () => {
		void busy(record, async () => {
			const result = await invoke<{ recording: boolean; url?: string }>('browser_record', {
				session_id: resolved,
				action: recording ? 'stop' : 'start',
			});
			recording = result.recording;
			if (!recording && result.url !== undefined) {
				toast('Recording saved — downloading', 'ok');
				await downloadFile(new URL(result.url, location.href).pathname, `${resolved}.webm`);
			} else toast(recording ? 'Recording started' : 'Recording stopped', 'ok');
		}).then(() => {
			relabel(record, recording ? 'Stop recording' : 'Record', recording ? 'stop' : 'record');
			record.classList.toggle('recording', recording);
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});

	interface OverlayAction {
		readonly label: string;
		readonly icon: IconName;
		readonly run: () => void;
	}

	/**
	 * Takes down every overlay on the stage. A sweep, not `overlay.remove()`: every overlay covers the stage, so two
	 * stacked ones would let the upper swallow the clicks meant for the button below.
	 */
	function hideOverlay(): void {
		for (const node of Array.from(stage.querySelectorAll('.overlay'))) node.remove();
	}

	/** Shows the stage's one overlay, replacing whatever was there. The first action is the primary one. */
	function showOverlay(message: string, detail: string, actions: readonly OverlayAction[]): void {
		hideOverlay();
		const overlay = el('div', { class: 'overlay', role: 'alertdialog', 'aria-label': message }, [
			el('div', { class: 'overlay-card' }, [
				el('div', { class: 'overlay-title', text: message }),
				el('div', { class: 'overlay-detail', text: detail }),
				el(
					'div',
					{ class: 'actions' },
					actions.map(({ label, icon, run }, index) =>
						button({ label, icon, variant: index === 0 ? 'primary' : undefined, onClick: run })
					),
				),
			]),
		]);
		stage.append(overlay);
	}

	function restoreStage(): void {
		hideOverlay();
		canvas.element.classList.remove('dead');
	}

	function ended(): void {
		ready = false;
		syncTools();
	}

	async function connect(): Promise<void> {
		try {
			// The socket validates every server message with the wire schemas, most of the app's JavaScript:
			// loaded on first use.
			const { LiveViewSocket } = await import('./ws.ts');
			// The operator may have left during each await; a socket opened after the teardown would never close.
			if (destroyed) return;
			const ticket = await api.mintTicket(sessionId === 'default' ? undefined : sessionId);
			if (destroyed) return;
			mode = ticket.mode;
			resolved = ticket.session_id;
			rememberWatched(ticket.session_id);
			sessionChip.textContent = ticket.session_id;
			const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
			socket = new LiveViewSocket(
				`${scheme}://${location.host}/live/${encodeURIComponent(ticket.session_id)}/ws` +
					`?ticket=${encodeURIComponent(ticket.ticket)}`,
				{
					onMeta: (meta) => {
						// A good connection: the next drop backs off from zero, in a fresh window.
						attempt = 0;
						recoveryDeadline = null;
						coolOffUntil = 0;
						restoreStage();
						viewerId = meta.viewerId;
						mode = meta.mode;
						lock = meta.lock;
						ready = true;
						setConnection('live', 'Connected');
						renderTabs(meta.tabs);
						renderControlState();
					},
					onTabs: renderTabs,
					onLock: (next) => {
						lock = next;
						renderControlState();
					},
					onState: (url) => {
						if (!urlField.matches(':focus')) urlField.value = url;
					},
					onError: (code, message) => setBanner(`${code}: ${message}`, 'error'),
					onFrame: (meta, jpeg) => canvas.draw(meta, jpeg),
					onClosed: (reason) => {
						if (destroyed) return;
						setConnection('dead', 'Disconnected');
						canvas.element.classList.add('dead');
						canvas.setInteractive(false);
						// The lock died with the socket, and the server has already released it.
						lock = null;
						viewerId = null;
						stage.setAttribute('data-control', 'none');
						setMode('offline', 'Disconnected');
						if (FINAL_REASONS.has(reason)) {
							ended();
							showOverlay(
								`Disconnected: ${reason}`,
								'The server ended this view. Reconnecting works only once that reason no longer applies.',
								[
									{ label: 'Reconnect', icon: 'refresh', run: retryNow },
									{ label: 'Back to sessions', icon: 'sessions', run: backToSessions },
								],
							);
							return;
						}
						scheduleReconnect(reason);
					},
				},
			);
		} catch (cause) {
			setConnection('dead', 'Disconnected');
			if (destroyed) return;
			setMode('offline', 'Disconnected');
			if (isMissingSession(cause)) {
				cancelRetry();
				ended();
				setConnection('dead', 'Session not found');
				showOverlay(
					'This session does not exist for this credential',
					`No session ${sessionId} is open for this sign-in. It may have been closed.`,
					[{ label: 'Back to sessions', icon: 'sessions', run: backToSessions }],
				);
				return;
			}
			if (cause instanceof ApiError && cause.status === 429) {
				coolOffUntil = Date.now() + (cause.retryAfterMs ?? RATE_LIMIT_COOLOFF_MS);
			}
			scheduleReconnect(messageOf(cause));
		}
	}

	function cancelRetry(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	}

	function retryNow(): void {
		cancelRetry();
		restoreStage();
		void connect();
	}

	function backToSessions(): void {
		cancelRetry();
		navigate('#/sessions');
	}

	/** Backs off and tries again with a fresh ticket, until the recovery window runs out. */
	function scheduleReconnect(reason: string): void {
		if (destroyed) return;
		if (recoveryDeadline === null) recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;
		const remaining = recoveryDeadline - Date.now();
		if (remaining <= 0) {
			cancelRetry();
			attempt = 0;
			recoveryDeadline = null;
			socket = null;
			ended();
			showOverlay(
				'Session and recovery window expired',
				`No connection could be re-established in ${Math.round(RECOVERY_WINDOW_MS / 60_000)} minutes. ` +
					`Last reason: ${reason}.`,
				[
					{ label: 'Start a new session', icon: 'plus', run: backToSessions },
					{ label: 'Try again', icon: 'refresh', run: retryNow },
				],
			);
			return;
		}
		attempt += 1;
		const delay = nextRetryDelayMs(attempt, remaining, coolOffUntil - Date.now());
		showOverlay(
			`Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s — ${reason}`,
			`Giving up in ${Math.max(1, Math.round(remaining / 60_000))} min if this does not come back.`,
			[
				{ label: 'Reconnect now', icon: 'refresh', run: retryNow },
				{ label: 'Start a new session', icon: 'plus', run: backToSessions },
			],
		);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (destroyed) return;
			restoreStage();
			void connect();
		}, delay);
	}

	const toolbar = el('div', { class: 'lv-toolbar' }, [
		historyBack,
		el('div', { class: 'lv-address' }, [status, urlField]),
		tabSelect,
		modePill,
		controlButton,
		record,
	]);
	rememberWatched(sessionId);
	mount(renderShell(navigate, {
		active: 'sessions',
		title: 'Live View',
		tabs: sessionTabs('view'),
		flush: true,
		actions: [sessionChip, copyButton(() => resolved, 'Copy session id')],
	}, [el('div', { class: 'lv-main' }, [toolbar, banner, stage])]));

	renderControlState();
	setMode('connecting', 'Connecting');
	void connect();

	// Not `hashchange`: a click on the current route re-renders with no hash change, and a leaked view keeps its
	// socket and reconnect loop — and can hold the takeover lock from a viewer nobody can see.
	onLeave(() => {
		destroyed = true;
		cancelRetry();
		socket?.close();
		canvas.destroy();
	});
}
