/**
 * Agents › Chat (D-147, D-152): one task is one conversation. The request is the operator's bubble, the agent's answer
 * sits beside its avatar, permission requests and results inline, and the composer is docked under it. Every request
 * the composer sends starts a new task with its own id, and the chat moves to it (`#/agents/chat/<task>`); `#/agents`
 * is the empty chat that asks what to do. The bar over the conversation names the task — its state, its id with a
 * copy action — and opens its run history on the Tasks tab (`tasks_view.ts`), where every task is listed. Surfaces
 * agents publish live with their workspace (Sessions › Workspaces, `workspace_surfaces.ts`).
 *
 * Every route here needs `agent:invoke`, which no other scope implies (D-144) — `admin` included. A credential without
 * it is told so in words, and an administrator is offered to grant the agent scopes to their own account in one step
 * (the same `PATCH /api/v1/users/{name}` the Users screen sends).
 *
 * Each task stays what it was — a question for the coding agent or a model provider, one tool call, or a delegation
 * to a peer — and the composer's kind switch chooses which. State is a glyph and a colour; the words are tooltips.
 * An administrator's **Agent settings** open in a panel on the right — the System › Agents tab itself, so the agents,
 * the providers, A2A and the runtime are managed without leaving the chat.
 */
import {
	answerOf,
	type ChatTask,
	extraArtifacts,
	type Request,
	requestOf,
	richText,
	statusLineOf,
	titleOf,
} from './agent_chat.ts';
import { agentTabs, chatRoute, rememberChatTask, tasksRoute } from './agent_tabs.ts';
import { type AgentTaskSummary, api, ApiError, getUser, loadUser, setUser, streamEvents } from './api.ts';
import { el, mount, on } from './dom.ts';
import { onLeave } from './lifecycle.ts';
import { icon, type IconName } from './icons.ts';
import { invoke, mcp } from './mcp.ts';
import { submittedTaskId, taskComposer } from './task_composer.ts';
import { backendChip, KIND_LOOK, taskKindOf } from './task_kinds.ts';
import { lookOf, stateGlyph, stateLabel, TERMINAL } from './task_states.ts';
import {
	badge,
	brandLogo,
	busy,
	button,
	confirmAt,
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
import { agentsSideOpen, setAgentsSideOpen } from './theme.ts';

/** The scopes the agent screen needs, granted together by the admin shortcut; `model:invoke` only when declared. */
const AGENT_SCOPES = ['agent:invoke', 'a2ui:publish', 'model:invoke'];

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
 * The chat of one task (`taskId`), or the empty chat that starts a new one (`null`). Owner-only polling uses bearer
 * headers through `api`; credentials never enter URLs.
 */
export function agentView(navigate: Navigate, taskId: string | null = null): void {
	rememberChatTask(taskId);
	const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'ag-status' });
	/** The conversation: the task's one `.ag-turn`, or the welcome; it scrolls, the composer stays under it. */
	const turns = el('div', { class: 'ag-turns' });
	const thread = el('div', { class: 'ag-thread', role: 'log', 'aria-label': 'Conversation' }, [
		el('div', { class: 'ag-thread-inner' }, [turns]),
	]);
	turns.append(taskId === null ? el('span') : skeleton(2));
	/** The bar over the conversation: which task this is, and the way to its run history. */
	const taskBar = el('div', { class: 'ag-task-bar', hidden: true });

	let active = true;
	let loading = false;
	/** The next render scrolls the conversation to its end: the first paint. */
	let stick = true;
	let unavailable: string | null = null;
	let shownSignature = '';
	/** Live event streams per task, kept across turn re-renders and stopped on leave. */
	const follows = new Map<string, { controller: AbortController; log: HTMLElement }>();
	function error(cause: unknown): void {
		status.textContent = messageOf(cause);
	}

	// --- the composer: three kinds of task behind one worded switch; each send is a new task ---------------------
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
		onSubmitted: (result) => {
			// A new request is a new task: the chat moves to it, so every task keeps a conversation of its own.
			const created = submittedTaskId(result);
			if (created !== null && created !== taskId) navigate(chatRoute(created));
			else if (active) void load();
		},
		status,
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

	/** The bar over the conversation: the task's state, its title and id, copy, and its run history. */
	function paintBar(task: ChatTask): void {
		const id = el('code', { class: 'ag-task-id mono', text: task.id, 'data-tip': 'Task id' });
		taskBar.replaceChildren(
			stateGlyph(task.status.state),
			el('span', { class: 'ag-task-title', text: titleOf(task, 120), 'data-tip': titleOf(task, 400) }),
			el('span', { class: 'grow' }),
			id,
			copyButton(() => task.id, 'Copy task id'),
			button({
				label: 'Run history',
				icon: 'history',
				small: true,
				variant: 'ghost',
				onClick: () => navigate(tasksRoute(task.id)),
			}),
		);
		taskBar.hidden = false;
	}

	/** Draws the one task, re-rendering its turn only when it changed so a tooltip open on it survives the poll. */
	function renderTask(task: ChatTask): void {
		const signature = JSON.stringify(task);
		if (signature === shownSignature) return;
		const first = shownSignature === '';
		shownSignature = signature;
		turns.replaceChildren(turn(task));
		paintBar(task);
		if (!first) status.textContent = `Task updated: ${stateLabel(task.status.state)}.`;
		if (stick) {
			stick = false;
			requestAnimationFrame(() => thread.scrollTo({ top: thread.scrollHeight }));
		}
	}

	/** A placeholder in the conversation: why there is nothing to show. */
	function blocked(glyph: IconName, title: string, text: string, action?: HTMLElement): HTMLElement {
		return el('div', { class: 'ag-welcome blocked' }, [
			el('span', { class: 'ag-orb muted', 'aria-hidden': 'true' }, [icon(glyph)]),
			el('h2', { class: 'ag-welcome-title', text: title }),
			el('p', { class: 'ag-welcome-text', text }),
			...(action === undefined ? [] : [el('div', { class: 'ag-welcome-actions' }, [action])]),
		]);
	}

	async function load(): Promise<void> {
		if (!active || loading) return;
		loading = true;
		try {
			const [settled, user] = await Promise.all([
				Promise.allSettled([api.listAgentTasks()]),
				loadUser(),
			]);
			const [listed] = settled;
			if (!active) return;
			if (listed.status === 'rejected') {
				const forbidden = listed.reason instanceof ApiError && listed.reason.status === 403;
				const reason = forbidden ? 'Needs agent:invoke' : messageOf(listed.reason);
				if (unavailable !== reason) {
					unavailable = reason;
					shownSignature = '';
					taskBar.hidden = true;
					turns.replaceChildren(
						forbidden ? scopeWall(user?.scopes ?? []) : blocked('lock', 'Tasks unavailable', reason),
					);
				}
				setDockBadge('agents', null);
				return;
			}
			unavailable = null;
			const all = listed.value.tasks;
			setDockBadge('agents', all.filter((task) => !TERMINAL.includes(task.status.state)).length);
			if (taskId === null) {
				if (turns.querySelector('.ag-welcome.hello') === null) turns.replaceChildren(welcome());
				return;
			}
			let task: ChatTask | undefined = all.find((entry) => entry.id === taskId);
			// A pending permission is only in the task's own read; a task missing from the list is asked for directly.
			if (task === undefined || task.status.state === 'TASK_STATE_INPUT_REQUIRED') {
				try {
					const detail = await api.getAgentTask(taskId);
					task = {
						...task,
						...detail.task,
						...(detail.permission === undefined ? {} : { permission: detail.permission }),
					};
				} catch (cause) {
					if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
					task = undefined;
				}
			}
			if (!active) return;
			if (task === undefined) {
				shownSignature = '';
				taskBar.hidden = true;
				turns.replaceChildren(
					blocked(
						'circle-dashed',
						'Task not found',
						`No task ${taskId} belongs to this account: it may have expired (tasks are kept for a day).`,
						button({ label: 'All tasks', icon: 'list-checks', onClick: () => navigate(tasksRoute(null)) }),
					),
				);
				return;
			}
			renderTask(task);
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
	const newTask = iconButton('edit', 'New task', () => navigate(chatRoute(null)));
	mount(renderShell(navigate, {
		active: 'agents',
		title: 'Agents',
		subtitle: 'Chat with the agent: every request is a task of its own',
		tabs: agentTabs('chat'),
		actions: [...(taskId === null ? [] : [newTask]), ...settings],
		flush: true,
	}, [
		el('div', { class: 'ag-layout' }, [
			el('div', { class: 'ag-chat' }, [
				taskBar,
				thread,
				el('div', { class: 'ag-dock' }, [el('div', { class: 'ag-dock-inner' }, [composer.node])]),
			]),
			side,
		]),
	]));
	if (admin && agentsSideOpen()) openSide(true);
	void load();
}
