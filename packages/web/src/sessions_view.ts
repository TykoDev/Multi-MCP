/**
 * Sessions: every live browser session as a card — who watches it, its tabs, whether a person holds control, its
 * browser's memory and when the idle reaper closes it — with Watch and Close. An administrator also sees three
 * memory meters (`GET /api/v1/system/usage`): the container against its limit, the browsers' private memory against
 * the same limit and their count against `TTK_MAX_SESSIONS`, and the gateway heap against its limit.
 */
import { api, ApiError, getUser, type SessionSummary, type SystemMemory } from './api.ts';
import { el, mount } from './dom.ts';
import { invoke } from './mcp.ts';
import { type Navigate, renderShell, sessionTabs } from './shell.ts';
import {
	busy,
	button,
	confirmButton,
	dot,
	empty,
	formatBytes,
	messageOf,
	notice,
	poll,
	relativeTime,
	toast,
} from './ui.ts';

/** Whose session a card shows (`api-key:alice` → `alice`), sent only to an admin in owner mode; else `null`. */
export function ownerOf(session: Pick<SessionSummary, 'owner'>): string | null {
	const owner = session.owner;
	if (owner === undefined || owner === '') return null;
	const colon = owner.indexOf(':');
	return colon > 0 && colon < owner.length - 1 ? owner.slice(colon + 1) : owner;
}

/** A span of seconds as people read it: `45 s`, `12 min`, `2 h 5 min`. */
export function duration(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
	const minutes = Math.round((seconds % 3600) / 60);
	return `${Math.floor(seconds / 3600)} h${minutes === 0 ? '' : ` ${minutes} min`}`;
}

/** One meter: a label, the figure, and a bar filled to its share of the limit, coloured by how full it is. */
function meter(label: string, used: number | null, limit: number | null): HTMLElement {
	const fraction = used === null || limit === null || limit <= 0 ? 0 : Math.min(1, used / limit);
	const figure = used === null
		? 'not measured'
		: limit === null
		? formatBytes(used)
		: `${formatBytes(used)} of ${formatBytes(limit)}`;
	const fill = el('span', { class: `sc-meter-fill ${fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'ok'}` });
	fill.style.setProperty('--fill', `${Math.round(fraction * 1000) / 10}%`);
	return el('div', { class: 'sc-meter' }, [
		el('div', { class: 'sc-meter-head' }, [el('span', { text: label }), el('span', { class: 'mono', text: figure })]),
		el('span', {
			class: 'sc-meter-bar',
			role: 'meter',
			'aria-label': `${label}: ${figure}`,
			'aria-valuemin': '0',
			'aria-valuemax': '100',
			'aria-valuenow': String(Math.round(fraction * 100)),
		}, [fill]),
	]);
}

function meters(memory: SystemMemory): HTMLElement[] {
	const limit = memory.container.limit_bytes;
	return [
		meter('Container', memory.container.used_bytes, limit),
		meter(
			`Browser sessions · ${memory.sessions.length} of ${memory.limits.max_sessions}`,
			memory.measured ? memory.browsers_private_bytes : null,
			limit,
		),
		meter('Gateway heap', memory.gateway.heap_used_bytes, memory.gateway.heap_limit_bytes),
	];
}

export function sessionsView(navigate: Navigate): void {
	const watch = (id: string): void => navigate(`#/view/${encodeURIComponent(id)}`);
	const memoryPanel = el('section', { class: 'sc-mem', 'aria-label': 'Memory', hidden: true });
	const status = el('div');
	const list = el('div', { class: 'sc-grid', 'aria-busy': 'true' });
	let memory: SystemMemory | null = null;

	const newSession = button({ label: 'New session', icon: 'plus', variant: 'primary' });
	newSession.addEventListener('click', () => {
		void busy(newSession, async () => {
			const created = await api.createSession();
			toast(`Session ${created.session_id} launched`, 'ok');
			watch(created.session_id);
		}).catch((cause) => toast(`Could not launch: ${messageOf(cause)}`, 'error'));
	});
	const closeAll = confirmButton({ label: 'Close all sessions', icon: 'power' }, async () => {
		const result = await invoke<{ closed?: number }>('browser_close_all', {});
		toast(`Closed ${result.closed ?? 'all'} sessions`, 'ok');
		await load();
	});
	closeAll.hidden = true;
	const admin = getUser()?.scopes.includes('admin') === true;

	function card(session: SessionSummary): HTMLElement {
		const id = session.session_id;
		const held = session.human_has_control;
		const owner = ownerOf(session);
		const entry = memory?.sessions.find((item) => item.session_id === id);
		const facts = [
			`${session.viewer_count} ${session.viewer_count === 1 ? 'viewer' : 'viewers'}`,
			`${session.tab_count} ${session.tab_count === 1 ? 'tab' : 'tabs'}`,
			`used ${relativeTime(session.last_used_at)}`,
		];
		if (entry?.memory) facts.push(`${formatBytes(entry.memory.private_bytes)} memory`);
		// A watched session is never reaped; an idle one closes once its timeout runs out.
		if (entry !== undefined && session.viewer_count === 0) {
			facts.push(`closes in ${duration(Math.max(0, entry.idle_timeout_s - entry.idle_seconds))} if idle`);
		}
		const close = confirmButton({ label: 'Close', icon: 'power', small: true }, async () => {
			await api.closeSession(id);
			toast(`Session ${id} closed`, 'ok');
			await load();
		});
		close.classList.add('sc-close');
		return el('article', { class: `sc-card${held ? ' locked' : ''}`, 'aria-label': session.label ?? id }, [
			el('div', { class: 'sc-head' }, [
				held
					? dot('locked', 'A person holds control')
					: session.viewer_count > 0
					? dot('ok', 'Being watched')
					: dot('', 'Idle'),
				el('span', { class: 'sc-name', text: session.label ?? id }),
				...(owner === null ? [] : [el('span', { class: 'badge', title: `Owner · ${session.owner}`, text: owner })]),
			]),
			el('code', { class: 'sc-id mono', 'data-session': id, text: id }),
			el('p', { class: 'sc-facts', text: facts.join(' · ') }),
			el('div', { class: 'actions' }, [
				button({ label: 'Watch', icon: 'live', variant: 'primary', small: true, onClick: () => watch(id) }),
				close,
			]),
		]);
	}

	let signature = '';
	async function load(): Promise<void> {
		try {
			const [{ sessions }, measured] = await Promise.all([
				api.listSessions(),
				// Admin only; anyone else, or an older server, gets the list without the figures.
				admin ? api.systemMemory().catch(() => null) : Promise.resolve(null),
			]);
			memory = measured;
			memoryPanel.hidden = memory === null;
			if (memory !== null) memoryPanel.replaceChildren(...meters(memory));
			status.replaceChildren();
			closeAll.hidden = !admin || sessions.length === 0;
			list.removeAttribute('aria-busy');
			// Rebuilt only when it changed, and never under an open confirmation (it would lose its anchor).
			const next = JSON.stringify([sessions, memory?.sessions]);
			if (next === signature || document.querySelector('.ttk-confirm') !== null) return;
			signature = next;
			list.replaceChildren(
				...(sessions.length === 0
					? [empty('sessions', 'No sessions', 'Launch an isolated browser, or open Live View for the default one.')]
					: sessions.map(card)),
			);
		} catch (cause) {
			signature = '';
			list.replaceChildren();
			status.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'This credential cannot list sessions. Live View opens the default session.'
					: `Could not list sessions: ${messageOf(cause)}`,
			));
		}
	}

	mount(renderShell(navigate, {
		active: 'sessions',
		title: 'Sessions',
		tabs: sessionTabs('sessions'),
		actions: [closeAll, newSession],
	}, [memoryPanel, status, list]));
	void load();
	poll(list, 5000, () => void load());
}
