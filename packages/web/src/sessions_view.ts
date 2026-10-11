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
 *
 * Memory (admin, `GET /api/v1/system/usage`): a panel of three meters — the container's use against its limit, the
 * browser sessions' private memory against the same limit with their count against `TTK_MAX_SESSIONS`, and the
 * gateway's heap against its limit — and the sessions in two groups, **Active** (watched, held, or used in the last
 * five minutes) and **Idle** (with when the reaper closes each), every card showing its browser's private memory and
 * a Close button. The Idle group closes all its sessions in one confirmed step. Figures update in place each poll.
 */
import { api, ApiError, type Overview, type SessionSummary, type SystemMemory } from './api.ts';
import { activityOf, duration, meterTone, share } from './session_activity.ts';
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
	formatBytes,
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

	const list = el('div', { class: 'sc-groups', 'aria-busy': 'true' }, [
		el('div', { class: 'sc-grid' }, [
			...Array.from({ length: 3 }, () => el('wa-skeleton', { class: 'sc-skeleton', effect: 'sheen' })),
		]),
	]);
	/** The last memory answer, or `null` (not an admin, an older server, or not read yet). */
	let memory: SystemMemory | null = null;
	/** Per card: repaints its memory row and idle line from the latest answer, without rebuilding the card. */
	const cardPainters = new Map<string, () => void>();

	// --- the memory panel: three meters against the limits -------------------------------------------------------
	const memoryPanel = el('section', { class: 'sc-mem', 'aria-label': 'Memory', hidden: true });
	/** One meter: a label, the figure, and a bar filled to its share of the limit, coloured by how full it is. */
	function meter(
		label: string,
		glyph: IconName,
		used: number | null,
		limit: number | null,
		detail: string,
	): HTMLElement {
		const fraction = share(used, limit);
		const figure = used === null
			? 'not measured'
			: limit === null
			? formatBytes(used)
			: `${formatBytes(used)} of ${formatBytes(limit)}`;
		const bar = el('span', { class: `sc-meter-fill ${meterTone(fraction)}` });
		bar.style.setProperty('--fill', `${Math.round(fraction * 1000) / 10}%`);
		return el('div', { class: 'sc-meter', 'data-tip': detail }, [
			el('div', { class: 'sc-meter-head' }, [
				icon(glyph),
				el('span', { class: 'sc-meter-label', text: label }),
				el('span', { class: 'grow' }),
				el('span', { class: 'sc-meter-figure mono', text: figure }),
			]),
			el('span', {
				class: 'sc-meter-bar',
				role: 'meter',
				'aria-label': `${label}: ${figure}`,
				'aria-valuemin': '0',
				'aria-valuemax': '100',
				'aria-valuenow': String(Math.round(fraction * 100)),
			}, [bar]),
		]);
	}
	function paintMemoryPanel(): void {
		if (memory === null) {
			memoryPanel.hidden = true;
			return;
		}
		const { container, gateway, limits } = memory;
		const count = memory.sessions.length;
		const limit = container.limit_bytes;
		memoryPanel.hidden = false;
		memoryPanel.replaceChildren(
			meter(
				'Container',
				'disk',
				container.used_bytes,
				limit,
				limit === null
					? 'No container limit is configured (TTK_MEMORY_LIMIT, from TTK_GATEWAY_MEMORY in Compose)'
					: 'Estimated use of the gateway container — the server plus every browser — against its limit',
			),
			meter(
				`Browser sessions · ${count} of ${limits.max_sessions}`,
				'globe',
				memory.measured ? memory.browsers_private_bytes : null,
				limit,
				memory.measured
					? `Private memory of every session's Chromium processes, from Chromium's own memory dump; sessions idle for ${
						duration(limits.session_ttl_s)
					} close by themselves`
					: 'The browsers did not answer a memory dump yet',
			),
			meter(
				'Gateway heap',
				'gauge',
				gateway.heap_used_bytes,
				gateway.heap_limit_bytes,
				`The server's JavaScript heap (${formatBytes(gateway.heap_total_bytes)} reserved, ${
					formatBytes(gateway.rss_bytes)
				} resident) against its limit (TTK_GATEWAY_HEAP_MB)`,
			),
		);
	}
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
		memoryPanel,
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
		// The memory row and the idle line repaint in place from each memory answer.
		const memFigure = el('span', { class: 'sc-mem-figure mono' });
		const memFill = el('span', { class: 'sc-meter-fill ok' });
		const memRow = el('div', { class: 'sc-mem-row', hidden: true }, [
			icon('gauge'),
			el('span', { class: 'sc-meter-bar small' }, [memFill]),
			memFigure,
		]);
		const idleLine = el('span', { class: 'sc-idle' });
		const closeVisible = confirmButton(
			{ label: 'Close', icon: 'power', small: true },
			async () => {
				await api.closeSession(id);
				toast(`Session ${id} closed`, 'ok');
				await load();
			},
		);
		closeVisible.classList.add('sc-close');
		cardPainters.set(id, () => {
			const entry = memory?.sessions.find((item) => item.session_id === id);
			const activity = activityOf(session, entry);
			idleLine.textContent = activity.active
				? activity.reason
				: activity.closesIn === null
				? `Idle ${duration(activity.idleSeconds)}`
				: `Idle ${duration(activity.idleSeconds)} · closes in ${duration(activity.closesIn)}`;
			idleLine.setAttribute('data-tip', activity.reason);
			const used = entry?.memory ?? null;
			memRow.hidden = memory === null;
			if (memory === null) return;
			const limit = memory.container.limit_bytes;
			const fraction = share(used?.private_bytes, limit ?? memory.browsers_private_bytes);
			memFill.className = `sc-meter-fill ${meterTone(share(used?.private_bytes, limit))}`;
			memFill.style.setProperty('--fill', `${Math.round(fraction * 1000) / 10}%`);
			memFigure.textContent = used === null ? 'not measured' : formatBytes(used.private_bytes);
			memRow.setAttribute(
				'data-tip',
				used === null
					? "This browser's memory is not measured here"
					: `${formatBytes(used.private_bytes)} private across ${used.processes} Chromium processes${
						limit === null ? '' : ` · ${Math.round(share(used.private_bytes, limit) * 100)} % of the container's limit`
					}`,
			);
		});
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
					memRow,
					el('div', { class: 'sc-card-foot' }, [idleLine, el('span', { class: 'grow' }), closeVisible]),
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
		const activeOf = (session: SessionSummary): boolean =>
			activityOf(session, memory?.sessions.find((item) => item.session_id === session.session_id)).active;
		// Re-rendering an unchanged list would restart its entrance animation every poll; memory and idle time repaint
		// in place, so only what moves a card (or between the groups) rebuilds the list.
		const next = JSON.stringify(
			sessions.map((s) => [
				s.session_id,
				s.label,
				s.tab_count,
				s.viewer_count,
				s.human_has_control,
				s.last_used_at,
				s.owner,
				activeOf(s),
			]),
		);
		if (next === signature) {
			for (const paint of cardPainters.values()) paint();
			return;
		}
		signature = next;
		clear(list);
		cardPainters.clear();
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
		const active = sessions.filter(activeOf);
		const idle = sessions.filter((session) => !activeOf(session));
		const group = (title: string, members: SessionSummary[], extra: Node[] = []): HTMLElement =>
			el('section', { class: 'sc-group', 'aria-label': `${title} sessions` }, [
				el('div', { class: 'sc-group-head' }, [
					el('h2', { class: 'sc-group-title', text: title }),
					el('span', { class: 'sc-group-count', text: String(members.length) }),
					el('span', { class: 'grow' }),
					...extra,
				]),
				members.length === 0
					? el('p', {
						class: 'sc-group-empty',
						text: title === 'Active' ? 'No session is in use right now.' : 'No idle session.',
					})
					: el('div', { class: 'sc-grid' }, members.map((session, index) => card(session, index))),
			]);
		const closeIdle = confirmButton(
			{ label: `Close idle sessions (${idle.length})`, icon: 'power', small: true },
			async () => {
				const results = await Promise.allSettled(idle.map((session) => api.closeSession(session.session_id)));
				const closed = results.filter((result) => result.status === 'fulfilled').length;
				toast(closed === 1 ? '1 idle session closed' : `${closed} idle sessions closed`, 'ok');
				await load();
			},
		);
		list.append(group('Active', active), group('Idle', idle, idle.length === 0 ? [] : [closeIdle]));
		for (const paint of cardPainters.values()) paint();
	}

	async function load(): Promise<void> {
		try {
			const [{ sessions }, measured] = await Promise.all([
				api.listSessions(),
				// The memory figures accompany the list; an older server or a refusal leaves the list without them.
				api.systemMemory().catch(() => null),
			]);
			memory = measured;
			paintMemoryPanel();
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
