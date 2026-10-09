/**
 * The sessions screen: every live browser session as a card — who is watching,
 * how many tabs, whether a human holds the operator lock — with the actions on
 * hover. Above them, always, the stored-data dashboard (D-155): one compact tile
 * per resource this credential can read, each linking to the screen that manages
 * it; the words live in tooltips.
 *
 * One action, one home (D-092): the header holds "new session" (and, for an
 * admin with sessions open, "close all"); the list polls, so there is no
 * refresh; the default session is the Live View tab (D-147).
 */
import { api, ApiError, type Overview, type SessionSummary } from './api.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { onLeave } from './lifecycle.ts';
import { invoke, mcp } from './mcp.ts';
import { clearCommands, registerCommands } from './palette.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	dot,
	empty,
	iconButton,
	imageOf,
	messageOf,
	openModal,
	poll,
	tip,
	toast,
} from './ui.ts';
import { overviewStrip, withLiveSessions } from './overview_tiles.ts';
import { sessionTabs } from './session_tabs.ts';
import { type Navigate, renderShell, setDockBadge } from './shell.ts';

/** The palette source this screen registers its sessions under. */
const PALETTE_SOURCE = 'sessions';

/** A long id shortened for display (`01JD3K…7QXZ`); the full id stays in the card's text and tooltip. */
function shortId(id: string): string {
	return id.length > 16 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;
}

/** A stable tint for a session's card, derived from its id. */
function hueOf(id: string): number {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return hash % 6;
}

/**
 * Whose session a card shows (RV-7): the name after the owner's kind (`api-key:alice` → `alice`) for the chip, the
 * whole owner for its tooltip. `null` when the server sent no owner — shared mode, or a caller that is not admin —
 * and then the card shows nothing in its place.
 */
export function ownerOf(session: Pick<SessionSummary, 'owner'>): { name: string; tip: string } | null {
	const owner = session.owner;
	if (owner === undefined || owner === '') return null;
	const colon = owner.indexOf(':');
	return { name: colon > 0 && colon < owner.length - 1 ? owner.slice(colon + 1) : owner, tip: `Owner · ${owner}` };
}

/** A number with a glyph; what it counts is its tooltip and accessible name. */
function fact(glyph: IconName, value: number, meaning: string): HTMLElement {
	const text = `${value} ${meaning}`;
	return el('span', { class: 'sc-fact', role: 'img', 'aria-label': text, 'data-tip': text }, [
		icon(glyph),
		el('span', { text: String(value) }),
	]);
}

// --- sessions ----------------------------------------------------------------

export function sessionsView(navigate: Navigate): void {
	const watchRoute = (id: string): string => `#/view/${encodeURIComponent(id)}`;

	const list = el('div', { class: 'sc-grid', 'aria-busy': 'true' }, [
		...Array.from({ length: 3 }, () => el('wa-skeleton', { class: 'sc-skeleton', effect: 'sheen' })),
	]);
	const noticeText = el('span');
	const noticeGlyph = icon('shield-alert');
	noticeGlyph.setAttribute('slot', 'icon');
	const notice = el('wa-callout', {
		class: 'sc-notice',
		variant: 'warning',
		appearance: 'filled-outlined',
		size: 's',
		hidden: true,
	}, [noticeGlyph, noticeText]);

	// D-155: what this credential has stored, from `GET /api/v1/overview`; its Sessions tile follows the live list.
	const dashboard = overviewStrip();
	let stored: Overview | null = null;
	let live: SessionSummary[] | null = null;
	const paintDashboard = (): void => {
		if (stored !== null) dashboard.paint(live === null ? stored : withLiveSessions(stored, live));
	};

	// --- launching a session ---------------------------------------------------
	const labelInput = el('input', {
		id: 'sc-label',
		type: 'text',
		placeholder: 'Label',
		'aria-label': 'Session label',
		autocomplete: 'off',
	});
	const profileInput = el('input', {
		id: 'sc-profile',
		type: 'text',
		placeholder: 'Profile (optional)',
		'aria-label': 'Browser profile',
		autocomplete: 'off',
	});
	const createSubmit = button({ label: 'Launch', icon: 'rocket', variant: 'primary', type: 'submit' });
	const createCancel = iconButton('x', 'Cancel');
	const createForm = el('form', { class: 'sc-create', hidden: true, 'aria-label': 'New session' }, [
		el('span', { class: 'sc-create-glyph', 'aria-hidden': 'true' }, [icon('plus')]),
		el('div', { class: 'sc-field' }, [
			el('label', { class: 'sr-only', for: 'sc-label', text: 'Session label' }),
			icon('tag'),
			labelInput,
		]),
		el('div', { class: 'sc-field' }, [
			el('label', { class: 'sr-only', for: 'sc-profile', text: 'Browser profile (optional)' }),
			icon('user'),
			profileInput,
		]),
		el('div', { class: 'sc-create-actions' }, [createCancel, createSubmit]),
	]);

	const newSessionBtn = iconButton('plus', 'New session', undefined, { variant: 'primary' });
	newSessionBtn.setAttribute('aria-expanded', 'false');
	const showCreate = (open: boolean): void => {
		createForm.hidden = !open;
		newSessionBtn.classList.toggle('on', open);
		newSessionBtn.setAttribute('aria-expanded', String(open));
		paintHeader();
		if (open) labelInput.focus();
	};
	on(newSessionBtn, 'click', () => showCreate(createForm.hidden !== false));
	on(createCancel, 'click', () => showCreate(false));
	on(createForm, 'submit', (event) => {
		event.preventDefault();
		void busy(createSubmit, async () => {
			const res = await api.createSession({
				label: labelInput.value.trim() || undefined,
				profile: profileInput.value.trim() || undefined,
			});
			createForm.hidden = true;
			toast(`Session ${res.session_id} launched`, 'ok');
			navigate(`#/view/${encodeURIComponent(res.session_id)}`);
		}).catch((cause) => toast(`Could not launch: ${messageOf(cause)}`, 'error'));
	});

	/** Filled in once the tool list shows this credential may close every session. */
	let closeAll: HTMLButtonElement | null = null;
	const closeAllSlot = el('span', { class: 'slot', hidden: true });
	const actions: Node[] = [closeAllSlot, newSessionBtn];

	/** What the header shows depends on whether there is anything listed. */
	let count = 0;
	/** False until a listing succeeds: a credential that cannot list sessions still gets the header's action. */
	let listed = false;
	function paintHeader(): void {
		// The empty state carries the one "new session" action while the list is empty.
		newSessionBtn.hidden = listed && count === 0 && createForm.hidden;
		if (closeAll !== null) closeAll.hidden = count === 0;
	}

	const screen = [
		dashboard.node,
		createForm,
		notice,
		list,
	];

	function updateStats(sessions: SessionSummary[]): void {
		live = sessions;
		paintDashboard();
	}

	/** The overview is cheap to ask (the server caches its walks), but it moves slowly: a slower poll than the list. */
	async function loadOverview(): Promise<void> {
		try {
			stored = await api.overview();
			paintDashboard();
		} catch {
			// An older server, or a transient failure: the dashboard keeps what it showed, or stays hidden.
		}
	}

	async function preview(session: SessionSummary, trigger: HTMLButtonElement): Promise<void> {
		await busy(trigger, async () => {
			const [shot] = await mcp.read(`ttk://session/${encodeURIComponent(session.session_id)}/screenshot`);
			if (shot?.blob === undefined) throw new Error('The session returned no screenshot');
			openModal(session.label ?? session.session_id, [imageOf(shot.blob, shot.mimeType, 'Session screenshot')], true);
		}).catch((cause) => toast(`Preview failed: ${messageOf(cause)}`, 'error'));
	}

	function card(session: SessionSummary, index: number): HTMLElement {
		const id = session.session_id;
		const name = session.label ?? id;
		const held = session.human_has_control;
		const watched = session.viewer_count > 0;

		const watch = iconButton('live', 'Watch', () => navigate(watchRoute(id)), { variant: 'primary', small: true });
		const shot = iconButton('camera', 'Screenshot', undefined, { small: true });
		on(shot, 'click', () => void preview(session, shot));
		const close = confirmButton({ label: 'Close session', icon: 'trash', iconOnly: true, small: true }, async () => {
			await api.closeSession(id);
			toast(`Session ${id} closed`, 'ok');
			await load();
		});

		// The preview area opens the viewer on a click; the Watch button is the same action for keyboards.
		const screenArea = el('div', { class: `sc-screen hue-${hueOf(id)}` }, [
			el('div', { class: 'sc-chrome', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
			el('div', { class: 'sc-orb', 'aria-hidden': 'true' }, [icon('globe')]),
			el('div', { class: 'sc-state' }, [
				held ? dot('locked', 'In use — a human holds control') : watched ? dot('ok', 'Being watched') : dot('', 'Idle'),
			]),
			el('div', { class: 'sc-actions' }, [watch, shot, close]),
		]);
		on(screenArea, 'click', (event) => {
			if (event.target instanceof Element && event.target.closest('button') !== null) return;
			navigate(watchRoute(id));
		});

		const lockGlyph = el('span', {
			class: `sc-lock ${held ? 'held' : 'free'}`,
			role: 'img',
			'aria-label': held ? 'Locked: someone holds control' : 'Free: nobody holds control',
			'data-tip': held ? 'Someone holds control' : 'Free to take control',
		}, [icon(held ? 'lock' : 'lock-open')]);

		const used = el('span', {
			class: 'sc-time',
			'data-tip': `Last used ${new Date(session.last_used_at).toLocaleString()}`,
		}, [icon('clock'), el('wa-relative-time', { date: session.last_used_at, format: 'narrow', sync: true })]);

		const title = el('div', { class: 'sc-name', text: name });
		tip(title, name);
		// RV-7: in owner mode an admin lists everyone's sessions, and two `default-…` cards are otherwise identical.
		const owner = ownerOf(session);
		const ownerChip = owner === null ? [] : [
			el('span', { class: 'sc-owner', role: 'img', 'aria-label': owner.tip, 'data-tip': owner.tip }, [
				icon('user-cog'),
				el('span', { class: 'sc-owner-name', text: owner.name }),
			]),
		];
		const node = el(
			'article',
			{ class: `sc-card ${held ? 'locked' : watched ? 'live' : 'idle'}`, 'aria-label': name },
			[
				screenArea,
				el('div', { class: 'sc-body' }, [
					title,
					el('div', { class: 'sc-id' }, [
						el('span', { class: 'mono', 'data-tip': id, 'data-session': id, text: shortId(id) }),
						copyButton(() => id, 'Copy session id'),
						...ownerChip,
					]),
					el('div', { class: 'sc-facts' }, [
						fact('eye', session.viewer_count, session.viewer_count === 1 ? 'viewer' : 'viewers'),
						fact('tabs', session.tab_count, session.tab_count === 1 ? 'tab' : 'tabs'),
						lockGlyph,
						el('span', { class: 'grow' }),
						used,
					]),
				]),
			],
		);
		node.style.setProperty('--i', String(index));
		return node;
	}

	/** Makes every session jump-to-able from the command palette (navigation only). */
	function registerSessions(sessions: SessionSummary[]): void {
		registerCommands(
			PALETTE_SOURCE,
			sessions.map((session) => ({
				id: `session:${session.session_id}`,
				label: session.label ?? session.session_id,
				icon: 'live' as const,
				hint: session.session_id,
				keywords: 'session watch view browser',
				group: 'Sessions',
				run: () => navigate(watchRoute(session.session_id)),
			})),
		);
	}

	let signature = '';
	function render(sessions: SessionSummary[]): void {
		count = sessions.length;
		listed = true;
		paintHeader();
		updateStats(sessions);
		setDockBadge('sessions', sessions.length);
		registerSessions(sessions);
		// Re-rendering an unchanged list would restart its entrance animation every poll.
		const next = JSON.stringify(
			sessions.map((s) => [
				s.session_id,
				s.label,
				s.tab_count,
				s.viewer_count,
				s.human_has_control,
				s.last_used_at,
				s.owner,
			]),
		);
		if (next === signature) return;
		signature = next;
		clear(list);
		list.removeAttribute('aria-busy');
		if (sessions.length === 0) {
			list.append(
				empty(
					'brand',
					'No sessions',
					'Launch an isolated browser, or open Live View for the default one.',
					button({ label: 'New session', icon: 'plus', variant: 'primary', onClick: () => showCreate(true) }),
				),
			);
			return;
		}
		sessions.forEach((session, index) => list.append(card(session, index)));
	}

	async function load(): Promise<void> {
		try {
			const { sessions } = await api.listSessions();
			notice.hidden = true;
			render(sessions);
		} catch (cause) {
			clear(list);
			list.removeAttribute('aria-busy');
			signature = '';
			listed = false;
			count = 0;
			// Without the admin list the dashboard's Sessions tile is the overview's own (the caller's reachable sessions).
			live = null;
			paintDashboard();
			paintHeader();
			clearCommands(PALETTE_SOURCE);
			notice.hidden = false;
			noticeText.textContent = cause instanceof ApiError && cause.status === 403
				? 'This credential cannot list sessions. Live View opens the default session.'
				: `Could not list sessions: ${messageOf(cause)}`;
		}
	}

	const shell = renderShell(navigate, {
		active: 'sessions',
		title: 'Sessions',
		subtitle: 'Watch, drive or launch isolated browsers',
		tabs: sessionTabs('sessions'),
		actions,
	}, screen);
	mount(shell);
	onLeave(() => clearCommands(PALETTE_SOURCE));
	void load();
	void loadOverview();
	poll(list, 5000, () => void load());
	poll(dashboard.node, 20_000, () => void loadOverview());

	// `browser_close_all` exists only for an admin credential, so the button does too.
	mcp.tools().then((tools) => {
		if (!tools.some((tool) => tool.name === 'browser_close_all')) return;
		closeAll = confirmButton({ label: 'Close all sessions', icon: 'power', iconOnly: true }, async () => {
			const result = await invoke<{ closed?: number }>('browser_close_all', {});
			toast(`Closed ${result.closed ?? 'all'} sessions`, 'ok');
			await load();
		});
		closeAllSlot.replaceWith(closeAll);
		paintHeader();
	}).catch(() => {});
}
