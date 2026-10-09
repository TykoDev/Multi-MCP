/**
 * Agents (D-147, D-152): a chat with the agent. The conversation is the screen — every task one turn, the request as
 * the operator's bubble and the agent's answer beside its avatar, permission requests and results inline — with the
 * composer docked under it. Tasks and Surfaces are two icons in the context bar, each with its count, each opening a
 * popover: the task counters and the recent tasks (a click scrolls the conversation to the turn), and the published
 * (A2UI) surfaces (a click opens one on a stage above the thread) with the one New-surface action.
 *
 * Every route here needs `agent:invoke`, which no other scope implies (D-144) — `admin` included. A credential without
 * it is told so in words, and an administrator is offered to grant the agent scopes to their own account in one step
 * (the same `PATCH /api/v1/users/{name}` the Users screen sends).
 *
 * Each task stays what it was — a question for the coding agent or a model provider, one tool call, or a delegation
 * to a peer — and the composer's kind switch chooses which. State is a glyph and a colour; the words are tooltips.
 *
 * D-158: **New chat** starts an empty conversation: the turns before it leave the thread (one line offers them back)
 * and stay in the Tasks popover; the boundary is this browser's own (a display preference `theme.ts` keeps), and it
 * hides nothing on the server. An administrator's **Agent settings** open in a panel on the right — the System ›
 * Agents tab itself, so the agents, the providers, A2A and the runtime are managed without leaving the chat.
 */
import { type A2uiSurface } from '@tykotech/wire';
import {
	answerOf,
	type ChatTask,
	extraArtifacts,
	orderTurns,
	type Request,
	requestOf,
	richText,
	statusLineOf,
	titleOf,
} from './agent_chat.ts';
import {
	type AgentTaskSummary,
	api,
	ApiError,
	getUser,
	loadUser,
	send as authorizedFetch,
	setUser,
	streamEvents,
} from './api.ts';
import { clear, el, mount, on } from './dom.ts';
import { onLeave } from './lifecycle.ts';
import { icon, type IconName } from './icons.ts';
import { invoke, mcp } from './mcp.ts';
import { newSurfaceHome, taskComposer } from './task_composer.ts';
import { backendChip, KIND_LOOK, taskKindOf } from './task_kinds.ts';
import {
	badge,
	brandLogo,
	busy,
	button,
	confirmAt,
	confirmButton,
	copyButton,
	iconButton,
	jsonView,
	messageOf,
	relabel,
	skeleton,
	textView,
	toast,
} from './ui.ts';
import { type Navigate, renderShell, setDockBadge } from './shell.ts';
import { agentsTab } from './system_agents.ts';
import { agentsSideOpen, chatSince, setAgentsSideOpen, setChatSince } from './theme.ts';

/** When a task was created (ms), from the server's `created_at`, else its status time; `NaN` when neither parses. */
function createdMs(task: ChatTask): number {
	return Date.parse(task.created_at ?? task.status.timestamp);
}

/**
 * D-158: the turns of the current chat — every task created after `since` (a server time, so the browser's clock never
 * hides a new turn), or all of them with `null`. A task whose time does not parse stays in.
 */
export function chatTurns<T extends ChatTask>(tasks: readonly T[], since: number | null): T[] {
	if (since === null) return [...tasks];
	return tasks.filter((task) => {
		const at = createdMs(task);
		return !Number.isFinite(at) || at > since;
	});
}

/** D-158: the boundary a New chat sets: the newest task's creation time, or `null` when there is nothing to hide. */
export function newChatSince(tasks: readonly ChatTask[]): number | null {
	const times = tasks.map(createdMs).filter(Number.isFinite);
	return times.length === 0 ? null : Math.max(...times);
}

const TERMINAL = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];

function stateLabel(state: string): string {
	return state.replace('TASK_STATE_', '').toLowerCase().replaceAll('_', ' ');
}

/** How a task state looks: a glyph (null: the kit's spinner), a tone class, and the words for its tooltip. */
interface StateLook {
	readonly glyph: IconName | null;
	readonly tone: string;
	readonly label: string;
}

const STATES: Readonly<Record<string, StateLook>> = {
	TASK_STATE_SUBMITTED: { glyph: 'hourglass', tone: 'pending', label: 'Submitted' },
	TASK_STATE_WORKING: { glyph: null, tone: 'running', label: 'Working' },
	TASK_STATE_INPUT_REQUIRED: { glyph: 'question', tone: 'input', label: 'Waiting for your decision' },
	TASK_STATE_AUTH_REQUIRED: { glyph: 'key', tone: 'auth', label: 'Authorization required' },
	TASK_STATE_COMPLETED: { glyph: 'circle-check', tone: 'done', label: 'Completed' },
	TASK_STATE_FAILED: { glyph: 'circle-x', tone: 'failed', label: 'Failed' },
	TASK_STATE_REJECTED: { glyph: 'ban', tone: 'failed', label: 'Rejected' },
	TASK_STATE_CANCELED: { glyph: 'circle-stop', tone: 'canceled', label: 'Canceled' },
};

function lookOf(state: string): StateLook {
	return STATES[state] ?? { glyph: 'circle-dashed', tone: 'pending', label: stateLabel(state) };
}

/** A task's state as a small glyph; its words are the tooltip and accessible name. */
function stateGlyph(state: string): HTMLElement {
	const look = lookOf(state);
	return el('span', { class: `ag-state ${look.tone}`, role: 'img', 'aria-label': look.label, 'data-tip': look.label }, [
		look.glyph === null ? el('wa-spinner', { 'aria-hidden': 'true' }) : icon(look.glyph),
	]);
}

/**
 * A number whose meaning is its tooltip and accessible name, with a glyph, the kit's spinner, or none (FE-3,
 * D-092: a chip beside a heading that already draws the glyph does not draw it again).
 */
function countChip(
	glyph: IconName | 'spinner' | 'none',
	value: number | string,
	meaning: string,
	tone = '',
): HTMLElement {
	return el('span', { class: `ag-chip ${tone}`, role: 'img', 'aria-label': meaning, 'data-tip': meaning }, [
		...(glyph === 'none' ? [] : [glyph === 'spinner' ? el('wa-spinner', { 'aria-hidden': 'true' }) : icon(glyph)]),
		el('span', { text: String(value) }),
	]);
}

/** The task counters in the Tasks card: running, waiting on you, completed, failed. */
const WAITING = ['input', 'auth'];
const COUNTERS: ReadonlyArray<readonly [IconName | 'spinner', string, string, (state: string) => boolean]> = [
	['spinner', 'running', 'running', (state) => !TERMINAL.includes(state) && !WAITING.includes(lookOf(state).tone)],
	['question', 'input', 'waiting for you', (state) => WAITING.includes(lookOf(state).tone)],
	['circle-check', 'done', 'completed', (state) => state === 'TASK_STATE_COMPLETED'],
	['circle-x', 'failed', 'failed', (state) => lookOf(state).tone === 'failed'],
];

/**
 * One of the bar's compact toggles (D-152): an icon button with a count badge that opens a popover holding `panel`.
 * The popover is the list's one home; the badge is decorative and the count is in the button's accessible name.
 */
function barToggle(id: string, glyph: IconName, label: string, panel: HTMLElement): {
	node: HTMLElement;
	popover: HTMLElement & { open: boolean };
	paint(count: number, words: string, live?: boolean): void;
} {
	const trigger = iconButton(glyph, label);
	trigger.id = id;
	trigger.classList.add('ag-bar-btn');
	trigger.setAttribute('aria-haspopup', 'dialog');
	const count = el('span', { class: 'ag-bar-count', 'aria-hidden': 'true', hidden: true });
	trigger.append(count);
	const popover = el('wa-popover', { class: 'ag-pop', for: id, placement: 'bottom-end' }, [panel]);
	return {
		node: el('span', { class: 'ag-bar-item' }, [trigger, popover]),
		popover,
		paint(n: number, words: string, live = false) {
			count.hidden = n === 0;
			count.textContent = n > 99 ? '99+' : String(n);
			count.classList.toggle('live', live);
			const name = n === 0 ? label : `${label} · ${words}`;
			trigger.setAttribute('aria-label', name);
			trigger.setAttribute('data-tip', name);
		},
	};
}

/** The scopes the agent screen needs, granted together by the admin shortcut; `model:invoke` only when declared. */
const AGENT_SCOPES = ['agent:invoke', 'a2ui:publish', 'model:invoke'];

/** What a card says while it has nothing to show: one quiet line, and the one action when the card owns it. */
function quiet(text: string, action?: HTMLElement): HTMLElement {
	return el('div', { class: 'ag-dash-empty' }, [el('span', { text }), ...(action === undefined ? [] : [action])]);
}

/** Starters for an empty conversation: each fills the composer, nothing is sent until the operator sends it. */
const STARTERS: ReadonlyArray<readonly [IconName, string]> = [
	['globe', 'Open https://example.com in a browser session and describe the page'],
	['workspace', 'Create a coding workspace with a hello-world Python script and run it'],
	['tools', 'Which tools can you use here, and what is each for?'],
];

/** An artifact longer than this many lines is folded under its name in the conversation. */
const ARTIFACT_INLINE_LINES = 14;

const FOLLOW = 'Follow live events';
const UNFOLLOW = 'Stop following';

/**
 * R3-4: releases every rendered surface the screen holds — its share reads aborted, its object URLs revoked — and
 * forgets them, so the next render starts from nothing. Run when the screen is left and when a load of the
 * surface list fails (whose placeholder replaces the nodes, which must not stay marked as rendered either).
 */
export function releaseSurfaces(
	nodes: Map<string, { readonly surface: Element }>,
	release: ((surface: Element) => void) | null,
): void {
	if (release !== null) { for (const { surface } of nodes.values()) release(surface); }
	nodes.clear();
}

/**
 * BUG-2: the open surface-builder drawer, if any. It lives in `document.body`, outside the screen's nodes, so the
 * screen's `stop()` must close it itself; the handle is module-level because one builder is open at most, across
 * renders of this screen.
 */
let builder: { close(): void } | null = null;

/** Owner-only polling uses bearer headers through api; credentials never enter URLs. */
export function agentView(navigate: Navigate): void {
	const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'ag-status' });
	/** The conversation: one `.ag-turn` per task, oldest first; it scrolls, the composer stays under it. */
	const turns = el('div', { class: 'ag-turns' });
	// D-158: after a New chat, the one way back to the turns before it.
	const earlier = el('button', { type: 'button', class: 'ag-earlier', hidden: true });
	const thread = el('div', { class: 'ag-thread', role: 'log', 'aria-label': 'Conversation' }, [
		el('div', { class: 'ag-thread-inner' }, [earlier, turns]),
	]);
	turns.append(skeleton(2));
	// The lists are named groups of buttons: a list role would take the rows' button role away.
	const taskStrip = el('div', { class: 'ag-strip', role: 'group', 'aria-label': 'Recent tasks' });
	const counters = el('div', { class: 'ag-counters' });
	/** The rendered surfaces, one shown at a time on the stage; the strip holds a chip per surface. */
	const surfaces = el('div', { class: 'ag-surfaces' });
	const surfaceStrip = el('div', { class: 'ag-strip', role: 'group', 'aria-label': 'Published surfaces' });
	const surfaceCount = el('span', { class: 'ag-counters' });
	const stage = el('section', { class: 'ag-stage', 'aria-label': 'Surface', hidden: true }, [surfaces]);

	let active = true;
	let loading = false;
	/** D-158: the New-chat boundary (a server time, ms), or `null` for the whole history. */
	let since: number | null = chatSince();
	/** Every task as last loaded, so New chat and Show earlier re-render at once rather than at the next poll. */
	let lastTasks: ChatTask[] = [];
	/** The next render scrolls the conversation to its end: the first paint, and after the operator sends. */
	let stick = true;
	let unavailable: string | null = null;
	/** The Tasks strip as last drawn. */
	let stripSignature = '';
	const turnNodes = new Map<string, { node: HTMLElement; signature: string }>();
	const surfaceNodes = new Map<
		string,
		{ node: HTMLElement; chip: HTMLElement; surface: HTMLElement; signature: string }
	>();
	/** The surface on the stage, or `null` while the stage is closed. */
	let shown: string | null = null;
	/**
	 * The surfaces this visit has seen, or `null` before the first list. A surface that arrives later — an agent just
	 * published it — takes the stage, as an assistant shows the interface it made; the first list opens nothing, so the
	 * conversation stays the screen.
	 */
	let known: Set<string> | null = null;
	/** Live event streams per task, kept across turn re-renders and stopped on leave. */
	const follows = new Map<string, { controller: AbortController; log: HTMLElement }>();
	function error(cause: unknown): void {
		status.textContent = messageOf(cause);
	}

	// --- the composer: three kinds of task behind one worded switch ---------------------------------------------
	// Providers are asked once per render of this screen; the tool list is the page's cached `tools/list`; the peers
	// are asked when the Delegate kind is first shown.
	const composer = taskComposer({
		providers: () => api.listProviders(),
		tools: () => mcp.tools(),
		// Every extension tool answers in the D-064 `{ result }` envelope; reading `.peers` off the envelope listed none.
		peers: async () =>
			(await invoke<{ result: { peers: Array<{ id: string }> } }>('agent_peers', {})).result.peers.map((peer) =>
				peer.id
			),
		createTask: (body) => api.createAgentTask(body),
		sendParts: (parts) => api.sendAgentMessage(parts),
		delegate: (args) => invoke('agent_delegate', args),
		onSubmitted: () => {
			stick = true;
			if (active) void load();
		},
		status,
	});

	// --- the surface builder: one "New surface" action, in the card's header or its empty state (D-092) -------------
	/** `a2ui:publish` on this session; the action is offered nowhere without it. */
	let canPublish = false;
	/** The Surfaces strip shows its empty line (which may hold the action). */
	let surfacesEmpty = false;
	const newSurface = button({ label: 'New surface', icon: 'plus', variant: 'primary', small: true });
	const surfaceActions = el('span', { class: 'ag-surface-actions' });
	on(newSurface, 'click', () => {
		void busy(newSurface, () => import('./surface_builder.ts')).then((module) => {
			if (!active) return;
			builder?.close();
			builder = module.openSurfaceBuilder({
				publish: (message) => api.publishSurface(message),
				actionNames: async () => (await api.listActionNames()).names,
				fetchShare,
				onPublished: () => {
					if (active) void load();
				},
			});
		}).catch(error);
	});

	/**
	 * What the screen shows a credential without `agent:invoke` (D-152): what the scope is for, what this credential
	 * holds instead, and — to an administrator, whose own account it is — one confirmed step that adds the agent scopes
	 * to that account. Anyone else is told who can grant them.
	 */
	function scopeWall(held: readonly string[]): HTMLElement {
		const admin = held.includes('admin');
		const missing = AGENT_SCOPES.filter((scope) => !held.includes(scope));
		const grant = button({ label: 'Grant agent scopes to my account', icon: 'shield-check', variant: 'primary' });
		on(grant, 'click', () => {
			void confirmAt(grant, `Add ${missing.join(', ')} to your account?`, 'shield-check').then((ok) => {
				if (!ok) return;
				void busy(grant, async () => {
					const { users, vocabulary } = await api.listUsers();
					const self = users.find((entry) => entry.self);
					if (self === undefined) {
						throw new Error('This sign-in is not an account: grant the scopes to its key instead.');
					}
					const known = new Set(vocabulary.map((entry) => entry.scope));
					const scopes = [...new Set([...self.scopes, ...AGENT_SCOPES.filter((scope) => known.has(scope))])];
					await api.updateUser(self.username, { scopes });
					// The next request is answered with the account's current scopes; the page re-reads who it is.
					setUser(null);
					await loadUser();
					unavailable = null;
					turns.replaceChildren(skeleton(2));
					composer.reload();
					toast('Agent scopes granted to your account', 'ok');
					await load();
				}).catch((cause) => toast(messageOf(cause), 'error'));
			});
		});
		return el('div', { class: 'ag-welcome blocked scope-wall' }, [
			el('span', { class: 'ag-orb muted', 'aria-hidden': 'true' }, [icon('shield-alert')]),
			el('h2', { class: 'ag-welcome-title', text: 'Agents need the agent:invoke scope' }),
			el('p', {
				class: 'ag-welcome-text',
				text: 'Tasks, surfaces and model providers are explicit grants: no other scope implies them, admin ' +
					'included. agent:invoke reads and runs tasks, a2ui:publish publishes surfaces, model:invoke runs text ' +
					'tasks on a model provider.',
			}),
			el(
				'div',
				{ class: 'ag-scope-list' },
				AGENT_SCOPES.map((scope) =>
					el('span', { class: `ag-scope${held.includes(scope) ? ' held' : ''}` }, [
						icon(held.includes(scope) ? 'circle-check' : 'circle-dashed'),
						el('code', { text: scope }),
					])
				),
			),
			admin && getUser()?.username !== undefined
				? el('div', { class: 'ag-welcome-actions' }, [
					grant,
					button({ label: 'Users', icon: 'users', variant: 'ghost', onClick: () => navigate('#/users') }),
				])
				: el('p', { class: 'ag-welcome-text', text: 'An administrator grants them on the Users screen.' }),
		]);
	}

	// --- the bar: Tasks and Surfaces as compact icons that open their lists (D-152) ------------------------------
	const tasksToggle = barToggle(
		'ag-tasks-trigger',
		'list-checks',
		'Tasks',
		el('div', { class: 'ag-pop-panel', 'aria-label': 'Tasks' }, [
			el('header', { class: 'ag-pop-head' }, [el('h2', { text: 'Tasks' }), counters]),
			taskStrip,
		]),
	);
	const surfacesToggle = barToggle(
		'ag-surfaces-trigger',
		'surface',
		'Surfaces',
		el('div', { class: 'ag-pop-panel', 'aria-label': 'Surfaces' }, [
			el('header', { class: 'ag-pop-head' }, [
				el('h2', { text: 'Surfaces' }),
				surfaceCount,
				el('span', { class: 'grow' }),
				surfaceActions,
			]),
			surfaceStrip,
		]),
	);

	function follow(taskId: string, toggle: HTMLButtonElement, log: HTMLElement): void {
		const existing = follows.get(taskId);
		if (existing !== undefined) {
			existing.controller.abort();
			follows.delete(taskId);
			relabel(toggle, FOLLOW, 'radio');
			toggle.classList.remove('live');
			return;
		}
		const controller = new AbortController();
		follows.set(taskId, { controller, log });
		relabel(toggle, UNFOLLOW, 'pause');
		toggle.classList.add('live');
		log.hidden = false;
		streamEvents(api.agentTaskEventsPath(taskId), (kind, data) => {
			const entry = follows.get(taskId)?.log ?? log;
			entry.prepend(
				el('li', { class: 'ag-event' }, [
					badge(kind),
					el('span', { class: 'ag-event-text mono', text: data.slice(0, 400) }),
				]),
			);
			while (entry.childElementCount > 60) entry.lastElementChild?.remove();
		}, controller.signal).catch((cause) => {
			if (!controller.signal.aborted) toast(`Event stream ended: ${messageOf(cause)}`, 'error');
		}).finally(() => {
			if (follows.get(taskId)?.controller === controller) {
				follows.delete(taskId);
				relabel(toggle, FOLLOW, 'radio');
				toggle.classList.remove('live');
			}
		});
	}

	/** The permission the agent is waiting on: a callout whose options are the buttons. */
	function permissionCallout(
		task: AgentTaskSummary,
		pending: NonNullable<AgentTaskSummary['permission']>,
	): HTMLElement {
		const decisions = el('div', { class: 'ag-decisions' });
		for (const option of pending.params.options ?? []) {
			if (option.kind === 'allow_always') continue;
			const choice = button({ label: option.name, icon: 'check', small: true, variant: 'primary' });
			on(choice, 'click', () => {
				void busy(choice, () => api.decideAgentPermission(task.id, pending.id, option.optionId)).then(() => load())
					.catch(error);
			});
			decisions.append(choice);
		}
		const deny = button({ label: 'Deny permission', icon: 'shield-ban', small: true, variant: 'danger' });
		on(deny, 'click', () => {
			void busy(deny, () => api.decideAgentPermission(task.id, pending.id)).then(() => load()).catch(error);
		});
		decisions.append(deny);
		const glyph = icon('shield-alert');
		glyph.setAttribute('slot', 'icon');
		const expires = new Date(pending.expires);
		return el('wa-callout', { class: 'ag-permission', variant: 'warning', appearance: 'filled-outlined', size: 's' }, [
			glyph,
			el('div', { class: 'ag-permission-body' }, [
				el('div', { class: 'ag-permission-title' }, [
					el('span', { class: 'grow', text: pending.params.toolCall?.title ?? 'The agent requests permission.' }),
					...(Number.isFinite(expires.getTime())
						? [
							el('span', {
								class: 'ag-expiry',
								role: 'img',
								'aria-label': `Expires at ${expires.toLocaleTimeString()}`,
								'data-tip': `Expires at ${expires.toLocaleTimeString()}`,
							}, [icon('timer')]),
						]
						: []),
				]),
				decisions,
			]),
		]);
	}

	/** The operator's side of a turn: their words as written, or the tool call (name, then its arguments). */
	function askBody(request: Request): Node[] {
		if (request.kind === 'text') return [el('p', { class: 'ag-ask-text', text: request.text || '(empty message)' })];
		if (request.kind === 'tool') {
			const args = request.args !== null && typeof request.args === 'object' &&
					Object.keys(request.args as Record<string, unknown>).length > 0
				? [jsonView(request.args)]
				: [];
			return [el('div', { class: 'ag-call' }, [icon('wrench'), el('code', { text: request.tool })]), ...args];
		}
		return [jsonView(request.data)];
	}

	/**
	 * One artifact under the answer: its name, then its text, or its data as JSON. A long one (a tool's whole MCP
	 * result, say) folds behind its name and line count, so the conversation stays readable; a short one is shown.
	 */
	function artifactBlock(artifact: AgentTaskSummary['artifacts'][number]): HTMLElement {
		const parts = artifact.parts ?? [];
		const views = parts.map((part) => part.text !== undefined ? textView(part.text) : jsonView(part.data ?? {}));
		const lines = parts.reduce(
			(sum, part) => sum + (part.text ?? JSON.stringify(part.data ?? {}, null, 2)).split('\n').length,
			0,
		);
		const head = [icon('file'), el('span', { text: artifact.name ?? 'Result' })];
		if (lines <= ARTIFACT_INLINE_LINES) {
			return el('div', { class: 'ag-artifact' }, [el('div', { class: 'ag-artifact-head' }, head), ...views]);
		}
		return el('details', { class: 'ag-artifact folded' }, [
			el('summary', { class: 'ag-artifact-head' }, [
				...head,
				el('span', { class: 'ag-artifact-size', text: `${lines} lines` }),
			]),
			...views,
		]);
	}

	/** Who answers a turn: the provider and model, the coding agent, or the kind of task. */
	function speakerOf(task: ChatTask): string {
		const backend = backendChip(task.metadata);
		if (backend !== null) return backend;
		const kind = taskKindOf(task);
		return kind === 'tool' ? 'Tool run' : kind === 'delegation' ? 'Peer agent' : 'Agent';
	}

	function turn(task: ChatTask): HTMLElement {
		const look = lookOf(task.status.state);
		const request = requestOf(task);
		const kind = KIND_LOOK[taskKindOf(task)];
		const answer = answerOf(task);
		const line = statusLineOf(task);
		const working = !TERMINAL.includes(task.status.state);
		const prior = follows.get(task.id);
		const log = prior?.log ?? el('ol', { class: 'ag-events', hidden: true, 'aria-label': 'Live events' });

		// The reply's tools: copy the answer, ask the same again, follow or cancel while it runs, copy the id.
		const tools = el('div', { class: 'ag-reply-tools' });
		if (answer !== '') tools.append(copyButton(() => answer, 'Copy answer'));
		if (request.kind === 'text' && request.text !== '') {
			tools.append(iconButton('repeat', 'Ask again', () => composer.prefill(request.text), { small: true }));
		}
		if (working) {
			const following = prior !== undefined;
			const watch = iconButton(following ? 'pause' : 'radio', following ? UNFOLLOW : FOLLOW, undefined, {
				small: true,
			});
			if (following) watch.classList.add('live');
			on(watch, 'click', () => follow(task.id, watch, log));
			const cancel = iconButton('stop', 'Cancel task', undefined, { small: true, variant: 'danger' });
			on(cancel, 'click', () => {
				void busy(cancel, () => api.cancelAgentTask(task.id)).then(() => load()).catch(error);
			});
			tools.append(watch, cancel);
		}
		tools.append(copyButton(() => task.id, 'Copy task id'));

		const started = task.created_at ?? task.status.timestamp;
		const when = new Date(started);
		const usage = task.metadata?.usage;
		const steps = task.metadata?.steps;
		const body: Node[] = [];
		if (answer !== '') body.push(richText(answer));
		else if (working && task.permission === undefined) {
			body.push(el('div', { class: 'ag-typing', role: 'img', 'aria-label': look.label, 'data-tip': look.label }, [
				el('i'),
				el('i'),
				el('i'),
				el('span', {
					class: 'ag-typing-text',
					text: steps === undefined ? look.label : `${look.label} · step ${steps}`,
				}),
			]));
		}
		if (line !== '' && !working) {
			body.push(el('div', { class: `ag-note ${look.tone}` }, [
				icon(look.glyph ?? 'info'),
				el('span', { text: line }),
			]));
		} else if (!working && answer === '' && extraArtifacts(task).length === 0) {
			body.push(el('div', { class: `ag-note ${look.tone}` }, [
				icon(look.glyph ?? 'info'),
				el('span', { text: look.label }),
			]));
		}
		if (task.permission) body.push(permissionCallout(task, task.permission));
		body.push(...extraArtifacts(task).map(artifactBlock), log);

		const node = el('article', {
			class: `ag-turn ${look.tone}`,
			'data-task': task.id,
			// D-143: the kind from `metadata.kind` (an older task: from its history), for the stylesheet and the tests.
			'data-kind': kind.label,
			tabindex: -1,
		}, [
			el('div', { class: 'ag-ask' }, [
				el('div', { class: `ag-bubble${request.kind === 'text' ? '' : ' structured'}` }, askBody(request)),
			]),
			el('div', { class: 'ag-reply' }, [
				el('span', { class: `ag-avatar ${kind.label}`, 'aria-hidden': 'true' }, [icon(kind.glyph)]),
				el('div', { class: 'ag-reply-main' }, [
					el('div', { class: 'ag-reply-head' }, [
						el('span', { class: 'ag-speaker', text: speakerOf(task) }),
						stateGlyph(task.status.state),
						el('span', { class: 'ag-when', 'data-tip': when.toLocaleString() }, [
							el('wa-relative-time', { date: started, format: 'narrow', sync: true }),
						]),
						...(usage === undefined ? [] : [
							el('span', {
								class: 'ag-usage',
								'data-tip': `${usage.input.toLocaleString()} tokens in · ${usage.output.toLocaleString()} out`,
							}, [icon('gauge'), el('span', { text: `${Math.round((usage.input + usage.output) / 100) / 10}k` })]),
						]),
						el('span', { class: 'grow' }),
						tools,
					]),
					el('div', { class: 'ag-reply-body' }, body),
				]),
			]),
		]);
		return node;
	}

	/** Scrolls the conversation to one turn and marks it (a click on its chip in the Tasks strip). */
	function reveal(taskId: string): void {
		// D-158: a turn from before a New chat brings the earlier turns back first.
		if (!turnNodes.has(taskId) && lastTasks.some((task) => task.id === taskId)) {
			showEarlier();
			requestAnimationFrame(() => reveal(taskId));
			return;
		}
		const node = turnNodes.get(taskId)?.node;
		if (node === undefined || !node.isConnected) return;
		node.scrollIntoView({ behavior: 'smooth', block: 'center' });
		node.focus({ preventScroll: true });
		node.classList.remove('picked');
		void node.offsetWidth;
		node.classList.add('picked');
	}

	/** D-158: starts an empty conversation; the turns so far stay one click away and in the Tasks popover. */
	function newChat(): void {
		since = newChatSince(lastTasks);
		setChatSince(since);
		stick = true;
		renderTasks(lastTasks);
		status.textContent = 'New chat started.';
		composer.focus();
	}

	/** D-158: undoes New chat: every turn is back in the thread. */
	function showEarlier(): void {
		since = null;
		setChatSince(null);
		renderTasks(lastTasks);
	}
	on(earlier, 'click', showEarlier);

	/** The welcome an empty conversation shows: what the agent is, and starters that fill the composer. */
	function welcome(): HTMLElement {
		return el('div', { class: 'ag-welcome hello' }, [
			el('span', { class: 'ag-orb brand', 'aria-hidden': 'true' }, [brandLogo('ag-orb-logo')]),
			el('h2', { class: 'ag-welcome-title', text: 'What should the agent do?' }),
			el('p', {
				class: 'ag-welcome-text',
				text: 'Ask the coding agent or a model provider, run one tool as a task, or delegate to a peer.',
			}),
			el(
				'div',
				{ class: 'ag-starters' },
				STARTERS.map(([glyph, text]) => {
					const starter = el('button', { type: 'button', class: 'ag-starter' }, [
						icon(glyph),
						el('span', { text }),
					]);
					on(starter, 'click', () => composer.prefill(text));
					return starter;
				}),
			),
		]);
	}

	function renderTasks(all: ChatTask[]): void {
		lastTasks = all;
		const values = chatTurns(all, since);
		const hidden = all.length - values.length;
		earlier.hidden = hidden === 0;
		earlier.replaceChildren(
			icon('history'),
			el('span', { text: hidden === 1 ? 'Show 1 earlier task' : `Show ${hidden} earlier tasks` }),
		);
		const ordered = orderTurns(values);
		const pinned = stick || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
		for (const [id, item] of turnNodes) {
			if (!values.some((task) => task.id === id)) {
				item.node.remove();
				turnNodes.delete(id);
			}
		}
		// The placeholders go once the list answers: the loading skeleton, and a "Tasks unavailable" that no longer is.
		turns.querySelector('.skeleton-group')?.remove();
		turns.querySelector('.ag-welcome.blocked')?.remove();
		if (ordered.length === 0) {
			if (turns.querySelector('.ag-welcome.hello') === null) turns.replaceChildren(welcome());
		} else turns.querySelector('.ag-welcome.hello')?.remove();
		ordered.forEach((task, index) => {
			const signature = JSON.stringify(task);
			const prior = turnNodes.get(task.id);
			let node = prior?.node;
			if (prior?.signature !== signature) {
				node = turn(task);
				if (prior) prior.node.replaceWith(node);
				turnNodes.set(task.id, { node, signature });
				if (prior !== undefined) status.textContent = `Task updated: ${stateLabel(task.status.state)}.`;
			}
			// Keep the DOM in conversation order: a turn that is not where it belongs moves there.
			const at = turns.children[index];
			if (node !== undefined && at !== node) turns.insertBefore(node, at ?? null);
		});
		if (pinned && ordered.length > 0) {
			stick = false;
			requestAnimationFrame(() => thread.scrollTo({ top: thread.scrollHeight }));
		}
		// The strip: newest first, a state glyph and a title each; a click finds the turn. Redrawn only when it changes,
		// so a tooltip open on a chip survives the poll.
		// D-158: the strip lists every task, the ones before a New chat included.
		const everything = orderTurns(all);
		const strip = JSON.stringify(everything.map((task) => [task.id, task.status.state, titleOf(task, 160)]));
		if (strip === stripSignature) return;
		stripSignature = strip;
		taskStrip.replaceChildren(
			...(everything.length === 0 ? [quiet('No tasks yet')] : everything.slice().reverse().map((task) => {
				const chip = el('button', {
					type: 'button',
					class: `ag-pill ${lookOf(task.status.state).tone}`,
					'data-tip': `${lookOf(task.status.state).label} · ${titleOf(task, 160)}`,
				}, [
					stateGlyph(task.status.state),
					el('span', { class: 'ag-pill-text', text: titleOf(task, 60) }),
					el('wa-relative-time', {
						class: 'ag-pill-when',
						date: task.created_at ?? task.status.timestamp,
						format: 'narrow',
						sync: true,
					}),
				]);
				on(chip, 'click', () => {
					tasksToggle.popover.open = false;
					reveal(task.id);
				});
				return chip;
			})),
		);
	}

	function paintCounters(values: AgentTaskSummary[]): void {
		counters.replaceChildren(
			...COUNTERS.flatMap(([glyph, tone, words, test]) => {
				const count = values.filter((task) => test(task.status.state)).length;
				return count === 0 ? [] : [countChip(glyph, count, `${count} ${words}`, tone)];
			}),
		);
		const open = values.filter((task) => !TERMINAL.includes(task.status.state)).length;
		setDockBadge('agents', open);
		tasksToggle.paint(
			open > 0 ? open : values.length,
			open > 0 ? `${open} running` : `${values.length} tasks`,
			open > 0,
		);
	}

	/**
	 * D-111: `ttk://share/` media is read with this screen's own credential and shown from an object URL. The
	 * renderer reads the body (it bounds the bytes) and owns the signal (it aborts on release), R3-4.
	 */
	const fetchShare = (path: string, signal: AbortSignal): Promise<Response> =>
		authorizedFetch(api.shareFilePath(path), { signal });
	/** The renderer module once a surface list has needed it; `null` means no surface was ever rendered. */
	let renderer: typeof import('./a2ui.ts') | null = null;

	/** Puts one surface on the stage, or closes the stage with `null`; the chips say which is shown. */
	function show(surfaceId: string | null): void {
		shown = surfaceId !== null && surfaceNodes.has(surfaceId) ? surfaceId : null;
		stage.hidden = shown === null;
		for (const [id, item] of surfaceNodes) {
			item.node.hidden = id !== shown;
			item.chip.setAttribute('aria-pressed', String(id === shown));
		}
	}

	function renderSurfaces(values: A2uiSurface[], a2ui: typeof import('./a2ui.ts')): void {
		for (const [id, item] of surfaceNodes) {
			if (!values.some((surface) => surface.surfaceId === id)) {
				a2ui.releaseA2uiSurface(item.surface);
				item.node.remove();
				item.chip.remove();
				surfaceNodes.delete(id);
				// Published again under the same id later, it is new again.
				known?.delete(id);
			}
		}
		const arrived = known === null ? [] : values.filter((surface) => !known!.has(surface.surfaceId));
		known = new Set([...(known ?? []), ...values.map((surface) => surface.surfaceId)]);
		// D-092: the one "New surface" action moves between the header and the empty state with the count.
		const home = newSurfaceHome(values.length, canPublish);
		surfaceActions.replaceChildren(...(home === 'header' ? [newSurface] : []));
		if (!values.length && !surfaceNodes.size) {
			// Rebuilt only when it is not already shown, so the action in it keeps its focus across polls.
			if (!surfacesEmpty || (home === 'empty') !== surfaceStrip.contains(newSurface)) {
				surfaceStrip.replaceChildren(quiet('No surfaces yet', home === 'empty' ? newSurface : undefined));
				surfacesEmpty = true;
			}
		} else {
			if (surfacesEmpty) surfaceStrip.replaceChildren();
			surfacesEmpty = false;
		}
		for (const surface of values) {
			const signature = JSON.stringify([surface.revision, surface.availableActions]);
			const prior = surfaceNodes.get(surface.surfaceId);
			if (prior?.signature === signature) continue;
			// D-092: quiet until reached for, and it asks first.
			const remove = confirmButton(
				{ label: 'Delete surface', icon: 'trash', iconOnly: true, small: true },
				async () => {
					await api.deleteSurface(surface.surfaceId);
					await load();
				},
			);
			remove.classList.add('destructive');
			const actions = surface.availableActions?.length ?? 0;
			const rendered = a2ui.renderA2uiSurface(surface, api.surfaceAction, { fetchShare });
			const node = el('article', { class: 'ag-surface', hidden: surface.surfaceId !== shown }, [
				el('header', { class: 'ag-surface-head' }, [
					el('span', { class: 'ag-surface-id mono', text: surface.surfaceId, 'data-tip': surface.surfaceId }),
					countChip('revision', surface.revision, `Revision ${surface.revision}`),
					countChip(
						'control',
						actions,
						actions === 1 ? '1 authorized action' : `${actions} authorized actions`,
						actions > 0 ? 'live' : '',
					),
					el('span', { class: 'grow' }),
					remove,
					iconButton('x', 'Close surface', () => show(null), { small: true }),
				]),
				el('div', { class: 'ag-surface-body' }, [rendered]),
			]);
			const chip = prior?.chip ?? el('button', {
				type: 'button',
				class: 'ag-pill surface',
				'aria-pressed': 'false',
				'data-tip': `Open ${surface.surfaceId}`,
			}, [el('span', { class: 'ag-pill-text mono', text: surface.surfaceId })]);
			if (prior === undefined) {
				on(chip, 'click', () => {
					surfacesToggle.popover.open = false;
					show(shown === surface.surfaceId ? null : surface.surfaceId);
				});
				surfaceStrip.append(chip);
			}
			chip.replaceChildren(
				el('span', { class: 'ag-pill-text mono', text: surface.surfaceId }),
				el('span', { class: 'ag-pill-count', text: `r${surface.revision}` }),
			);
			if (prior) {
				a2ui.releaseA2uiSurface(prior.surface);
				prior.node.replaceWith(node);
			} else surfaces.append(node);
			surfaceNodes.set(surface.surfaceId, { node, chip, surface: rendered, signature });
		}
		show(arrived.at(-1)?.surfaceId ?? shown);
		surfaceCount.replaceChildren(
			...(values.length === 0 ? [] : [countChip('none', values.length, `${values.length} published`, 'accent')]),
		);
		surfacesToggle.paint(values.length, `${values.length} published`);
	}

	async function load(): Promise<void> {
		if (!active || loading) return;
		loading = true;
		try {
			const [settled, user] = await Promise.all([
				Promise.allSettled([api.listAgentTasks(), api.listSurfaces()]),
				loadUser(),
			]);
			const [taskResult, surfaceResult] = settled;
			if (!active) return;
			canPublish = user?.scopes.includes('a2ui:publish') === true;
			if (taskResult.status === 'fulfilled') {
				unavailable = null;
				const values = await Promise.all(taskResult.value.tasks.map(async (task) => {
					if (task.status.state !== 'TASK_STATE_INPUT_REQUIRED') return task;
					const detail = await api.getAgentTask(task.id);
					return { ...task, ...detail.task, permission: detail.permission };
				}));
				if (active) {
					renderTasks(values);
					paintCounters(values);
				}
			} else {
				const forbidden = taskResult.reason instanceof ApiError && taskResult.reason.status === 403;
				const reason = forbidden ? 'Needs agent:invoke' : messageOf(taskResult.reason);
				if (unavailable !== reason) {
					unavailable = reason;
					turnNodes.clear();
					turns.replaceChildren(
						forbidden ? scopeWall(user?.scopes ?? []) : el('div', { class: 'ag-welcome blocked' }, [
							el('span', { class: 'ag-orb muted', 'aria-hidden': 'true' }, [icon('lock')]),
							el('h2', { class: 'ag-welcome-title', text: 'Tasks unavailable' }),
							el('p', { class: 'ag-welcome-text', text: reason }),
						]),
					);
				}
				taskStrip.replaceChildren(quiet(forbidden ? 'Needs agent:invoke' : 'Tasks unavailable'));
				stripSignature = '';
				counters.replaceChildren();
				tasksToggle.paint(0, '');
				setDockBadge('agents', null);
			}
			// The renderer re-validates every surface against the shared A2UI schemas, so it is
			// loaded with them, on first use, rather than with the app's first paint.
			if (surfaceResult.status === 'fulfilled') {
				renderer = await import('./a2ui.ts');
				if (active) renderSurfaces(surfaceResult.value.surfaces, renderer);
			} else {
				releaseSurfaces(surfaceNodes, renderer?.releaseA2uiSurface ?? null);
				clear(surfaces);
				show(null);
				surfacesEmpty = false;
				surfaceActions.replaceChildren();
				const forbidden = surfaceResult.reason instanceof ApiError && surfaceResult.reason.status === 403;
				surfaceStrip.replaceChildren(
					quiet(forbidden ? 'Needs agent:invoke' : `Surfaces unavailable: ${messageOf(surfaceResult.reason)}`),
				);
				surfacesToggle.paint(0, '');
			}
		} catch (cause) {
			if (active) error(cause);
		} finally {
			loading = false;
		}
	}
	const timer = setInterval(() => void load(), 3000);
	const stop = (): void => {
		active = false;
		clearInterval(timer);
		for (const { controller } of follows.values()) controller.abort();
		follows.clear();
		releaseSurfaces(surfaceNodes, renderer?.releaseA2uiSurface ?? null);
		// BUG-2: the builder drawer is not under the screen's nodes; it goes with the screen.
		builder?.close();
		builder = null;
	};
	// Not `hashchange`: re-rendering this same route (its rail item) changes no hash (G-1).
	onLeave(stop);
	// D-158: the settings open beside the chat — the System › Agents tab itself, read when the panel opens — instead of
	// leaving the conversation. Open or closed is remembered per browser.
	const side = el('aside', { class: 'ag-side', id: 'ag-side', 'aria-label': 'Agent settings', hidden: true });
	let sideTab: ReturnType<typeof agentsTab> | null = null;
	const settingsToggle = iconButton('sliders', 'Agent settings: providers, A2A, ACP');
	settingsToggle.setAttribute('aria-controls', 'ag-side');
	settingsToggle.setAttribute('aria-expanded', 'false');
	function openSide(open: boolean): void {
		side.hidden = !open;
		settingsToggle.setAttribute('aria-expanded', String(open));
		settingsToggle.classList.toggle('live', open);
		setAgentsSideOpen(open);
		if (!open) return;
		if (sideTab === null) {
			sideTab = agentsTab(navigate, () => composer.reload());
			side.replaceChildren(
				el('header', { class: 'ag-side-head' }, [
					el('h2', { text: 'Agent settings' }),
					el('span', { class: 'grow' }),
					iconButton('external', 'Open in System › Agents', () => navigate('#/system/agents'), { small: true }),
					iconButton('x', 'Close agent settings', () => openSide(false), { small: true }),
				]),
				el('div', { class: 'ag-side-body' }, [sideTab.node]),
			);
		}
		void sideTab.load().catch((cause) => toast(`Could not load the agent settings: ${messageOf(cause)}`, 'error'));
	}
	on(settingsToggle, 'click', () => openSide(side.hasAttribute('hidden')));
	const admin = getUser()?.scopes.includes('admin') === true;
	const settings = admin ? [settingsToggle] : [];
	const newChatButton = iconButton('edit', 'New chat', newChat);
	mount(renderShell(navigate, {
		active: 'agents',
		title: 'Agents',
		subtitle: 'Chat with the agent, follow its tasks, use the surfaces agents publish',
		actions: [newChatButton, tasksToggle.node, surfacesToggle.node, ...settings],
		flush: true,
	}, [
		el('div', { class: 'ag-layout' }, [
			el('div', { class: 'ag-chat' }, [
				stage,
				thread,
				el('div', { class: 'ag-dock' }, [el('div', { class: 'ag-dock-inner' }, [composer.node])]),
			]),
			side,
		]),
	]));
	tasksToggle.paint(0, '');
	surfacesToggle.paint(0, '');
	if (admin && agentsSideOpen()) openSide(true);
	void load();
}
