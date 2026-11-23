/**
 * Agents: **Chat** (`#/agents`, `#/agents/chat/<task>`) — one task is one conversation; every send starts a new task
 * and the chat moves to it; your tasks are listed beside it — and **Surfaces** (`#/agents/surfaces`), the A2UI
 * surfaces agents published, rendered live.
 *
 * Every route here needs `agent:invoke`, which no other scope implies, `admin` included. A credential without it is
 * told so; an administrator signed in to an account can grant the agent scopes to that account in one step.
 */
import type { A2uiSurface } from '@tykotech/wire';
import { answerOf, type ChatTask, extraArtifacts, requestOf, richText, statusLineOf, titleOf } from './agent_chat.ts';
import { type AgentTaskSummary, api, ApiError, getUser, loadUser, send, setUser } from './api.ts';
import { el, mount, on } from './dom.ts';
import { onLeave } from './lifecycle.ts';
import { invoke } from './mcp.ts';
import { type Navigate, renderShell } from './shell.ts';
import { submittedTaskId, taskComposer } from './task_composer.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	dot,
	empty,
	jsonView,
	messageOf,
	notice,
	textView,
	toast,
} from './ui.ts';

/** The scopes the grant shortcut adds; `model:invoke` only when the server declares it. */
const AGENT_SCOPES = ['agent:invoke', 'a2ui:publish', 'model:invoke'];

/** The states after which a task never changes again. */
const TERMINAL = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];

/** A task state in words and a tone: `TASK_STATE_INPUT_REQUIRED` → `input required`. */
export function stateOf(state: string): { label: string; tone: string } {
	const label = state.replace('TASK_STATE_', '').toLowerCase().replaceAll('_', ' ');
	const tone = state === 'TASK_STATE_COMPLETED'
		? 'ok'
		: state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_REJECTED'
		? 'danger'
		: TERMINAL.includes(state)
		? ''
		: 'live';
	return { label, tone };
}

/** Who answers a task: SlopLord or provider · model, else the kind. */
function speakerOf(task: Pick<AgentTaskSummary, 'metadata'>): string {
	const meta = task.metadata;
	if (typeof meta?.provider === 'string' && meta.provider !== '') {
		const on = meta.model ? `${meta.provider} · ${meta.model}` : meta.provider;
		return meta.agent === 'sloplord' ? `SlopLord · ${on}` : on;
	}
	return meta?.kind === 'tool' ? 'Tool run' : meta?.kind === 'delegation' ? 'Peer agent' : 'Agent';
}

const chatRoute = (taskId: string | null): string =>
	taskId === null ? '#/agents' : `#/agents/chat/${encodeURIComponent(taskId)}`;

export function agentView(navigate: Navigate, hash: string): void {
	const surfacesTab = hash === '#/agents/surfaces';
	let taskId: string | null = null;
	if (hash.startsWith('#/agents/chat/')) {
		try {
			taskId = decodeURIComponent(hash.slice('#/agents/chat/'.length));
		} catch {
			taskId = null;
		}
	}
	const tabs = {
		active: surfacesTab ? 'surfaces' : 'chat',
		items: [
			{ id: 'chat', label: 'Chat', route: '#/agents' },
			{ id: 'surfaces', label: 'Surfaces', route: '#/agents/surfaces' },
		],
	};
	if (surfacesTab) {
		mount(renderShell(navigate, { active: 'agents', title: 'Agents', tabs }, [surfacesPanel()]));
		return;
	}

	const tasksList = el('nav', { class: 'ag-tasks', 'aria-label': 'Your tasks' });
	const turns = el('div', { class: 'ag-thread', role: 'log', 'aria-label': 'Conversation' });
	let active = true;
	let shownSignature = '';
	let listSignature = '';

	const composer = taskComposer({
		providers: () => api.listProviders(),
		// Every extension tool answers in the `{ result }` envelope.
		peers: async () =>
			(await invoke<{ result: { peers: Array<{ id: string }> } }>('agent_peers', {})).result.peers.map((p) => p.id),
		createTask: (body) => api.createAgentTask(body),
		delegate: (args) => invoke('agent_delegate', args),
		onSubmitted: (result) => {
			const created = submittedTaskId(result);
			if (created !== null && created !== taskId) navigate(chatRoute(created));
			else void load();
		},
	});

	function scopeWall(held: readonly string[]): HTMLElement {
		const grant = button({ label: 'Grant agent scopes to my account', icon: 'shield-check', variant: 'primary' });
		on(grant, 'click', () => {
			void busy(grant, async () => {
				const { users, vocabulary } = await api.listUsers();
				const self = users.find((entry) => entry.self);
				if (self === undefined) throw new Error('This sign-in is not an account: grant the scopes to its key instead.');
				const known = new Set(vocabulary.map((entry) => entry.scope));
				const scopes = [...new Set([...self.scopes, ...AGENT_SCOPES.filter((scope) => known.has(scope))])];
				await api.updateUser(self.username, { scopes });
				// The next answer carries the account's new scopes; the page re-reads who it is.
				setUser(null);
				await loadUser();
				toast('Agent scopes granted to your account', 'ok');
				navigate(chatRoute(taskId));
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		const admin = held.includes('admin') && getUser()?.username !== undefined;
		return empty(
			'shield-alert',
			'Agents need the agent:invoke scope',
			'Tasks and surfaces are explicit grants: no other scope implies them, admin included.' +
				(admin ? '' : ' An administrator grants them on the Users screen.'),
			admin ? grant : undefined,
		);
	}

	function artifact(item: AgentTaskSummary['artifacts'][number]): HTMLElement {
		return el('details', { class: 'ag-artifact' }, [
			el('summary', { text: item.name ?? 'Result' }),
			...(item.parts ?? []).map((part) => part.text !== undefined ? textView(part.text) : jsonView(part.data ?? {})),
		]);
	}

	function turn(task: ChatTask): HTMLElement {
		const request = requestOf(task);
		const answer = answerOf(task);
		const line = statusLineOf(task);
		const state = stateOf(task.status.state);
		const working = !TERMINAL.includes(task.status.state);
		const tools: HTMLElement[] = [];
		if (answer !== '') tools.push(copyButton(() => answer, 'Copy answer'));
		if (working) {
			const cancel = button({ label: 'Cancel task', icon: 'stop', small: true, variant: 'danger' });
			on(cancel, 'click', () => void busy(cancel, () => api.cancelAgentTask(task.id)).then(load));
			tools.push(cancel);
		}
		const ask = request.kind === 'text'
			? el('p', { text: request.text || '(empty message)' })
			: request.kind === 'tool'
			? el('div', {}, [el('code', { text: request.tool }), jsonView(request.args)])
			: jsonView(request.data);
		return el('article', { class: `ag-turn ${state.tone}`, 'data-task': task.id, 'data-kind': task.metadata?.kind }, [
			el('div', { class: 'ag-bubble' }, [ask]),
			el('div', { class: 'ag-reply' }, [
				el('div', { class: 'ag-reply-head' }, [
					el('strong', { text: speakerOf(task) }),
					dot(state.tone, state.label),
					el('span', { class: 'muted', text: state.label }),
					el('span', { class: 'grow' }),
					...tools,
				]),
				...(answer !== '' ? [richText(answer)] : working ? [el('p', { class: 'muted', text: 'Working…' })] : []),
				...(line !== '' && !working ? [notice(line, state.tone === 'danger' ? 'danger' : 'info')] : []),
				...extraArtifacts(task).map(artifact),
			]),
		]);
	}

	function paintTasks(tasks: readonly ChatTask[]): void {
		const signature = JSON.stringify(tasks.map((task) => [task.id, task.status.state, taskId]));
		if (signature === listSignature) return;
		listSignature = signature;
		tasksList.replaceChildren(
			button({ label: 'New task', icon: 'edit', small: true, onClick: () => navigate(chatRoute(null)) }),
			...tasks.map((task) => {
				const state = stateOf(task.status.state);
				return el('a', {
					class: task.id === taskId ? 'ag-task active' : 'ag-task',
					href: chatRoute(task.id),
					'aria-current': task.id === taskId ? 'page' : undefined,
				}, [dot(state.tone, state.label), el('span', { text: titleOf(task) })]);
			}),
		);
	}

	async function load(): Promise<void> {
		if (!active) return;
		try {
			const { tasks } = await api.listAgentTasks();
			if (!active) return;
			paintTasks(tasks);
			if (taskId === null) {
				if (shownSignature !== 'welcome') {
					shownSignature = 'welcome';
					turns.replaceChildren(
						empty('agents', 'What should the agent do?', 'Ask the coding agent, a model, or a peer.'),
					);
				}
				return;
			}
			let task: ChatTask | undefined = tasks.find((entry) => entry.id === taskId);
			if (task === undefined) {
				task = await api.getAgentTask(taskId).then(({ task }) => task, (cause) => {
					if (cause instanceof ApiError && cause.status === 404) return undefined;
					throw cause;
				});
			}
			if (!active) return;
			if (task === undefined) {
				shownSignature = '';
				turns.replaceChildren(
					empty('circle-dashed', 'Task not found', 'It may have expired: tasks are kept for a day.'),
				);
				return;
			}
			// Re-rendered only when it changed, so a selection or an open artifact survives the poll.
			const signature = JSON.stringify(task);
			if (signature === shownSignature) return;
			shownSignature = signature;
			turns.replaceChildren(turn(task));
		} catch (cause) {
			if (!active) return;
			shownSignature = '';
			if (cause instanceof ApiError && cause.status === 403) {
				clearInterval(timer);
				composer.node.hidden = true;
				tasksList.replaceChildren();
				turns.replaceChildren(scopeWall((await loadUser())?.scopes ?? []));
			} else turns.replaceChildren(notice(messageOf(cause)));
		}
	}
	const timer = setInterval(() => void load(), 3000);
	onLeave(() => {
		active = false;
		clearInterval(timer);
	});
	mount(renderShell(navigate, { active: 'agents', title: 'Agents', tabs, flush: true }, [
		el('div', { class: 'ag-layout' }, [tasksList, el('div', { class: 'ag-chat' }, [turns, composer.node])]),
	]));
	void load();
}

/** How often the surfaces are read again: agents publish while a person watches. */
const SURFACE_POLL_MS = 4000;

/**
 * Every surface this credential can read, each rendered by `a2ui.ts` with Delete. A surface re-renders only when its
 * revision moves, so what a person types into it survives the poll; every rendered surface is released (share reads
 * aborted, object URLs revoked) when it goes and when the screen does.
 */
function surfacesPanel(): HTMLElement {
	const list = el('div', { class: 'ag-surfaces' });
	const status = el('div');
	const node = el('section', { class: 'ws-surfaces', 'aria-label': 'Surfaces' }, [status, list]);
	const rendered = new Map<string, { node: HTMLElement; surface: HTMLElement; signature: string }>();
	let renderer: typeof import('./a2ui.ts') | null = null;
	let alive = true;
	/** `ttk://share/` media is read with the page's own credential and shown from an object URL. */
	const fetchShare = (path: string, signal: AbortSignal): Promise<Response> =>
		send(api.shareFilePath(path), { signal });
	const release = (): void => {
		for (const item of rendered.values()) renderer?.releaseA2uiSurface(item.surface);
		rendered.clear();
	};

	function card(surface: A2uiSurface, a2ui: typeof import('./a2ui.ts'), canPublish: boolean): HTMLElement {
		const body = a2ui.renderA2uiSurface(surface, api.surfaceAction, { fetchShare });
		const remove = confirmButton({ label: 'Delete surface', icon: 'trash', iconOnly: true, small: true }, async () => {
			await api.deleteSurface(surface.surfaceId);
			await load();
		});
		remove.hidden = !canPublish;
		const item = el('article', { class: 'ws-surface', 'data-surface': surface.surfaceId }, [
			el('header', { class: 'ws-surface-head' }, [
				el('span', { class: 'mono', text: surface.surfaceId }),
				el('span', { class: 'muted', text: `revision ${surface.revision}` }),
				...(surface.workspaceId === undefined ? [] : [el('span', { class: 'badge', text: 'workspace' })]),
				el('span', { class: 'grow' }),
				remove,
			]),
			body,
		]);
		rendered.set(surface.surfaceId, {
			node: item,
			surface: body,
			signature: JSON.stringify([surface.revision, surface.availableActions, canPublish]),
		});
		return item;
	}

	async function load(): Promise<void> {
		try {
			const [user, { surfaces }] = await Promise.all([loadUser(), api.listSurfaces()]);
			// The renderer re-validates every surface against the shared schemas: loaded on first use only.
			if (surfaces.length > 0 && renderer === null) renderer = await import('./a2ui.ts');
			if (!alive) return;
			const canPublish = user?.scopes.includes('a2ui:publish') === true;
			status.replaceChildren(
				...(surfaces.length === 0
					? [empty('surface', 'No surfaces yet', 'Agents publish them with a2ui_publish.')]
					: []),
			);
			for (const [id, item] of rendered) {
				if (!surfaces.some((surface) => surface.surfaceId === id)) {
					renderer?.releaseA2uiSurface(item.surface);
					rendered.delete(id);
				}
			}
			const nodes = surfaces.map((surface) => {
				const prior = rendered.get(surface.surfaceId);
				if (prior?.signature === JSON.stringify([surface.revision, surface.availableActions, canPublish])) {
					return prior.node;
				}
				if (prior !== undefined) renderer!.releaseA2uiSurface(prior.surface);
				return card(surface, renderer!, canPublish);
			});
			// Only what moved is moved: detaching a surface would blur the field someone is typing in.
			nodes.forEach((item, index) => {
				if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
			});
			while (list.children.length > nodes.length) list.lastElementChild?.remove();
		} catch (cause) {
			if (!alive) return;
			release();
			list.replaceChildren();
			status.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'Surfaces need the agent:invoke scope.'
					: `Surfaces unavailable: ${messageOf(cause)}`,
			));
		}
	}
	const timer = setInterval(() => void load(), SURFACE_POLL_MS);
	onLeave(() => {
		alive = false;
		clearInterval(timer);
		release();
	});
	void load();
	return node;
}
