/**
 * Agents › Tasks: every agent task this account owns, in the Resources screen's frame (D-152) — a searchable list in
 * the glass pane beside a viewer. Selecting a task (`#/agents/tasks/<task>`) shows its run history: the facts of the
 * task (id, kind, backend, times, steps, tokens), the request and the answer, and the run log — each provider request
 * with its timing and usage, each tool call with its arguments and result, each state change — read from
 * `GET /api/v1/agent/tasks/{id}/log`. **Open in chat** shows the task as its conversation on the Chat tab.
 *
 * The list and an unfinished task's history keep themselves current (a poll), so there is no refresh control
 * (D-092); a finished task is read once.
 *
 * `?workspace=<id>` (the workspace screen's task icon) narrows the list to the tasks that touched that coding
 * workspace, names it in a chip with a way back to every task, and opens the newest of them.
 */
import type WaTreeItem from '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { answerOf, type ChatTask, extraArtifacts, requestOf, richText, titleOf } from './agent_chat.ts';
import { agentTabs, chatRoute, rememberInspectedTask, tasksRoute } from './agent_tabs.ts';
import { api, ApiError, type RunLog } from './api.ts';
import { el, mount, on } from './dom.ts';
import { icon } from './icons.ts';
import { jsonFacts } from './json_facts.ts';
import { onLeave } from './lifecycle.ts';
import { invoke } from './mcp.ts';
import { matchesQuery, treeLeaf, viewerHead } from './resources_view.ts';
import { formatDuration, offsetOf, runLogLine } from './run_log.ts';
import { named } from './schema_form.ts';
import { type Navigate, renderShell, setDockBadge } from './shell.ts';
import { backendChip, KIND_LOOK, taskKindOf } from './task_kinds.ts';
import { lookOf, stateGlyph, TERMINAL } from './task_states.ts';
import {
	busy,
	button,
	copyButton,
	empty,
	iconButton,
	jsonView,
	messageOf,
	skeleton,
	tag,
	textView,
	toast,
} from './ui.ts';

/** A section of the viewer: a small uppercase heading with an optional count, then its content. */
function section(title: string, content: Node[], count?: number): HTMLElement {
	return el('section', { class: 'rx-section' }, [
		el('div', { class: 'rx-section-head' }, [
			el('h3', { class: 'rx-section-title', text: title }),
			...(count === undefined ? [] : [el('span', { class: 'rx-section-count', text: String(count) })]),
		]),
		...content,
	]);
}

/** A task's facts, in the order a reader asks for them; absent ones are left out. */
export function taskFacts(task: ChatTask, run: RunLog | null): Record<string, unknown> {
	const metadata = task.metadata;
	const created = run?.created_at ?? task.created_at;
	const finished = run?.finished_at;
	const took = created !== undefined && finished !== undefined ? Date.parse(finished) - Date.parse(created) : NaN;
	const facts: Record<string, unknown> = {
		'Task id': task.id,
		...(task.contextId === undefined ? {} : { 'Context id': task.contextId }),
		State: lookOf(task.status.state).label,
		Kind: KIND_LOOK[taskKindOf(task)].label,
	};
	if (metadata?.agent !== undefined) facts.Agent = metadata.agent;
	if (metadata?.backend !== undefined) facts.Backend = metadata.backend === 'acp' ? 'ACP agent' : 'Model provider';
	if (metadata?.provider !== undefined) facts.Provider = metadata.provider;
	if (metadata?.model !== undefined) facts.Model = metadata.model;
	if (created !== undefined) facts.Created = new Date(created).toLocaleString();
	if (finished !== undefined) facts.Finished = new Date(finished).toLocaleString();
	if (Number.isFinite(took)) facts.Duration = formatDuration(took);
	if (metadata?.steps !== undefined) facts.Steps = metadata.steps;
	if (metadata?.usage !== undefined) {
		facts.Tokens = `${metadata.usage.input.toLocaleString()} in · ${metadata.usage.output.toLocaleString()} out`;
	}
	facts.Artifacts = task.artifacts.length;
	if (run !== null) facts['Run log'] = `${run.entries.length} entries${run.truncated ? ' (cut at its bound)' : ''}`;
	return facts;
}

/** The run log as a timeline: one row per entry, its detail folded under it. */
function timeline(run: RunLog): HTMLElement {
	if (run.entries.length === 0) {
		return el('p', {
			class: 'rx-lede',
			text: 'No run log: the task ran before run logs were kept, or nothing has happened yet.',
		});
	}
	return el(
		'ol',
		{ class: 'tk-timeline', 'aria-label': 'Run log' },
		run.entries.map((entry) => {
			const line = runLogLine(entry);
			const when = new Date(entry.at);
			const head = el('div', { class: 'tk-entry-head' }, [
				el('span', { class: `tk-entry-glyph ${line.tone}`, 'aria-hidden': 'true' }, [icon(line.glyph)]),
				el('span', { class: 'tk-entry-title', text: line.title }),
				...line.facts.map((fact) => el('span', { class: 'tk-entry-fact', text: fact })),
				el('span', { class: 'grow' }),
				el('time', {
					class: 'tk-entry-time mono',
					datetime: entry.at,
					text: offsetOf(entry.at, run.created_at),
					'data-tip': Number.isFinite(when.getTime()) ? when.toLocaleString() : entry.at,
				}),
			]);
			const detail = line.detail === null ? [] : [
				el('details', { class: 'tk-entry-detail' }, [
					el('summary', { text: typeof line.detail === 'string' ? 'Text' : 'Details' }),
					typeof line.detail === 'string' ? textView(line.detail) : jsonView(line.detail),
				]),
			];
			return el('li', { class: `tk-entry ${entry.kind}` }, [head, ...detail]);
		}),
	);
}

export function tasksView(navigate: Navigate, initial: string | null = null, workspace: string | null = null): void {
	let selected: string | null = initial;
	rememberInspectedTask(selected);
	let alive = true;
	let tasks: ChatTask[] = [];
	let listSignature = '';
	let shownSignature = '';
	/** Each read of the viewer is numbered, so a slow answer for a task no longer selected is dropped. */
	let generation = 0;

	const tree = el('wa-tree', { class: 'rx-tree', selection: 'single', 'aria-label': 'Tasks' });
	const searchGlyph = icon('search');
	searchGlyph.setAttribute('slot', 'start');
	const searchCount = el('span', { class: 'rx-search-count', slot: 'end' });
	const search = named(
		el('wa-input', {
			type: 'search',
			class: 'rx-search',
			placeholder: 'Search tasks: words, id, model, state',
			'with-clear': true,
			size: 's',
		}, [searchGlyph, searchCount]),
		'Search tasks',
		false,
	) as HTMLElement & { value: string };
	const listNote = el('p', { class: 'tk-list-note', role: 'status', 'aria-live': 'polite' });
	// Below 768 px the list folds behind this bar, as the Resources tree does; the viewer takes the screen.
	const browseLabel = el('span', { class: 'label', text: 'Tasks' });
	const browse = el('button', {
		type: 'button',
		class: 'ttk-btn wa-neutral wa-filled wa-outlined rx-browse',
		'aria-expanded': 'false',
		'aria-controls': 'tk-pane-body',
	}, [icon('list'), browseLabel, icon('chevron-down', 'rx-browse-caret')]);
	// The workspace filter, named; its clear button is the way back to every task.
	const filterName = el('span', { class: 'tk-filter-name mono', text: workspace?.slice(0, 8) ?? '' });
	const filter = workspace === null ? null : el('div', { class: 'tk-filter' }, [
		icon('workspace'),
		el('span', { class: 'tk-filter-text' }, [el('span', { text: 'Tasks that used ' }), filterName]),
		el('span', { class: 'grow' }),
		iconButton('x', 'Show every task', () => navigate(tasksRoute(selected)), { small: true }),
	]);
	if (workspace !== null) {
		// The workspace's name, when this credential may list workspaces; its id stands in otherwise.
		void invoke<{ result?: { workspaces?: Array<{ workspace_id: string; name?: string }> } }>('sandbox_list', {})
			.then((answer) => {
				const found = answer.result?.workspaces?.find((entry) => entry.workspace_id === workspace);
				if (found?.name) filterName.textContent = found.name;
			}).catch(() => {});
	}
	const pane = el('aside', { class: 'rx-pane', 'aria-label': 'Tasks list' }, [
		browse,
		el('div', { class: 'rx-pane-body', id: 'tk-pane-body' }, [
			...(filter === null ? [] : [filter]),
			search,
			listNote,
			tree,
		]),
	]);
	const fold = (open: boolean): void => {
		pane.classList.toggle('open', open);
		browse.setAttribute('aria-expanded', String(open));
	};
	on(browse, 'click', () => fold(!pane.classList.contains('open')));
	const viewer = el('section', { class: 'rx-preview rx-viewer', 'aria-label': 'Run history' });

	/** What the search matches a task by: its title, id, kind, state, backend, provider and model. */
	function searchText(task: ChatTask): string {
		return [
			titleOf(task, 400),
			task.id,
			KIND_LOOK[taskKindOf(task)].label,
			lookOf(task.status.state).label,
			task.metadata?.provider ?? '',
			task.metadata?.model ?? '',
			task.metadata?.agent ?? '',
		].join(' ');
	}

	function applySearch(): void {
		const query = String(search.value ?? '');
		let shown = 0;
		for (const item of tree.children) {
			const match = matchesQuery(item.getAttribute('data-search') ?? '', query);
			(item as HTMLElement).hidden = !match;
			if (match) shown++;
		}
		searchCount.textContent = query.trim() === '' ? '' : String(shown);
	}
	on(search, 'input', applySearch);

	function renderList(): void {
		const signature = JSON.stringify(tasks.map((task) => [task.id, task.status.state, titleOf(task, 80)]));
		if (signature === listSignature) return;
		listSignature = signature;
		listNote.textContent = tasks.length === 0 ? '' : tasks.length === 1 ? '1 task' : `${tasks.length} tasks`;
		browseLabel.textContent = tasks.length === 0 ? 'Tasks' : `Tasks · ${tasks.length}`;
		if (tasks.length === 0) {
			tree.replaceChildren(
				workspace === null
					? empty('list-checks', 'No tasks yet', 'Ask the agent something on the Chat tab')
					: empty('list-checks', 'No task has used this workspace', 'Tasks that call its tools appear here'),
			);
			return;
		}
		tree.replaceChildren(...tasks.map((task) => {
			const kind = KIND_LOOK[taskKindOf(task)];
			const mark = el('span', { class: 'tk-row-mark' }, [
				el('wa-relative-time', {
					class: 'tk-row-when',
					date: task.created_at ?? task.status.timestamp,
					format: 'narrow',
					sync: true,
				}),
				stateGlyph(task.status.state),
			]);
			const leaf: WaTreeItem = treeLeaf(
				`task:${task.id}`,
				titleOf(task, 60),
				kind.glyph,
				`${lookOf(task.status.state).label} · ${titleOf(task, 200)}`,
				{ mark, search: searchText(task) },
			);
			leaf.selected = task.id === selected;
			return leaf;
		}));
		applySearch();
	}

	on(tree, 'click', (event) => {
		const item = event.target instanceof Element ? event.target.closest('wa-tree-item') : null;
		const key = item?.getAttribute('data-key');
		if (key === null || key === undefined || !key.startsWith('task:')) return;
		select(key.slice('task:'.length));
	});
	on(tree, 'keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		const item = event.target instanceof Element ? event.target.closest('wa-tree-item') : null;
		const key = item?.getAttribute('data-key');
		if (key?.startsWith('task:') === true) select(key.slice('task:'.length));
	});

	/** Shows one task; the route follows without a history entry per click, as the workspace screen does. */
	function select(taskId: string): void {
		if (taskId === selected) return;
		selected = taskId;
		rememberInspectedTask(taskId);
		fold(false);
		globalThis.history.replaceState(null, '', tasksRoute(taskId, workspace));
		for (const item of tree.children) {
			(item as WaTreeItem).selected = item.getAttribute('data-key') === `task:${taskId}`;
		}
		shownSignature = '';
		viewer.replaceChildren(skeleton(3));
		void loadSelected();
	}

	/** What the viewer shows with no task selected: the counts, and where to start. */
	function overview(): void {
		const counts = new Map<string, number>();
		for (const task of tasks) {
			const label = lookOf(task.status.state).label;
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		const signature = JSON.stringify(['overview', [...counts]]);
		if (signature === shownSignature) return;
		shownSignature = signature;
		viewer.replaceChildren(
			viewerHead({
				glyph: 'list-checks',
				kind: 'Tasks',
				title: tasks.length === 1 ? '1 task' : `${tasks.length} tasks`,
				mono: false,
				tags: [...counts].map(([label, count]) => tag(`${count} ${label.toLowerCase()}`)),
				actions: [button({ label: 'New task', icon: 'plus', small: true, onClick: () => navigate(chatRoute(null)) })],
			}),
			el('div', { class: 'rx-body' }, [
				el('p', {
					class: 'rx-lede',
					text: 'Select a task to see its run history: the request and answer, every provider request with its ' +
						'timing and token usage, every tool call with its arguments and result, and each state change. Tasks ' +
						'are kept for a day.',
				}),
			]),
		);
	}

	function renderTask(task: ChatTask, run: RunLog | null, permission: boolean): void {
		const signature = JSON.stringify([task, run]);
		if (signature === shownSignature) return;
		shownSignature = signature;
		const kind = KIND_LOOK[taskKindOf(task)];
		const look = lookOf(task.status.state);
		const working = !TERMINAL.includes(task.status.state);
		const actions: Node[] = [
			button({
				label: 'Open in chat',
				icon: 'message',
				small: true,
				variant: 'primary',
				onClick: () => navigate(chatRoute(task.id)),
			}),
			copyButton(() => task.id, 'Copy task id'),
		];
		if (working) {
			const cancel = button({ label: 'Cancel task', icon: 'stop', small: true, variant: 'danger' });
			on(cancel, 'click', () => {
				void busy(cancel, () => api.cancelAgentTask(task.id)).then(() => {
					shownSignature = '';
					return loadSelected();
				}).catch((cause) => toast(messageOf(cause), 'error'));
			});
			actions.push(cancel);
		}
		const backend = backendChip(task.metadata);
		const request = requestOf(task);
		const answer = answerOf(task);
		const status = task.status.message?.parts.map((part) => part.text ?? '').join('') ?? '';
		viewer.replaceChildren(
			viewerHead({
				glyph: kind.glyph,
				kind: `${kind.label} task`,
				title: titleOf(task, 200),
				mono: false,
				tags: [
					el('span', { class: 'tk-state' }, [stateGlyph(task.status.state), el('span', { text: look.label })]),
					tag(kind.label, kind.glyph),
					...(backend === null ? [] : [tag(backend, 'model')]),
					el('code', { class: 'tk-id mono', text: task.id }),
				],
				actions,
			}),
			el('div', { class: 'rx-body' }, [
				jsonFacts(taskFacts(task, run), { labels: { '': 'Overview' } }),
				section('Request', [
					request.kind === 'text'
						? el('p', { class: 'tk-request', text: request.text || '(empty message)' })
						: request.kind === 'tool'
						? el('div', {}, [
							el('div', { class: 'ag-call' }, [icon('wrench'), el('code', { text: request.tool })]),
							jsonView(request.args ?? {}),
						])
						: jsonView(request.data),
				]),
				...(permission
					? [
						el('p', { class: 'rx-lede', text: 'The agent waits for your permission decision: answer it in the chat.' }),
					]
					: []),
				...(answer === '' && status === '' ? [] : [
					section('Answer', [
						...(answer === '' ? [] : [richText(answer)]),
						...(status === '' || status === answer ? [] : [el('p', { class: 'tk-status', text: status })]),
					]),
				]),
				...(extraArtifacts(task).length === 0 ? [] : [
					section(
						'Artifacts',
						extraArtifacts(task).map((artifact) =>
							el('details', { class: 'tk-artifact' }, [
								el('summary', { text: artifact.name ?? 'Result' }),
								...(artifact.parts ?? []).map((part) =>
									part.text !== undefined ? textView(part.text) : jsonView(part.data ?? {})
								),
							])
						),
						extraArtifacts(task).length,
					),
				]),
				section(
					'Run history',
					run === null ? [el('p', { class: 'rx-lede', text: 'The run log could not be read.' })] : [timeline(run)],
					run?.entries.length,
				),
			]),
		);
	}

	async function loadSelected(): Promise<void> {
		const taskId = selected;
		if (taskId === null) {
			overview();
			return;
		}
		const mine = ++generation;
		try {
			const [detail, run] = await Promise.all([
				api.getAgentTask(taskId),
				api.getAgentTaskLog(taskId).catch((cause) => {
					// A gateway without run logs answers 404 for the log alone; the task is still shown.
					if (cause instanceof ApiError && cause.status === 404) return null;
					throw cause;
				}),
			]);
			if (!alive || mine !== generation) return;
			const listed = tasks.find((task) => task.id === taskId);
			const task: ChatTask = { ...detail.task, created_at: run?.created_at ?? listed?.created_at };
			renderTask(task, run, detail.permission !== undefined);
		} catch (cause) {
			if (!alive || mine !== generation) return;
			shownSignature = '';
			viewer.replaceChildren(
				cause instanceof ApiError && cause.status === 404
					? empty('circle-dashed', 'Task not found', 'It may have expired: tasks are kept for a day.')
					: empty('circle-x', 'Could not read the task', messageOf(cause)),
			);
		}
	}

	async function loadList(): Promise<void> {
		try {
			const { tasks: listed } = await api.listAgentTasks(workspace ?? undefined);
			if (!alive) return;
			tasks = listed;
			setDockBadge('agents', tasks.filter((task) => !TERMINAL.includes(task.status.state)).length);
			renderList();
		} catch (cause) {
			if (!alive) return;
			listSignature = '';
			const forbidden = cause instanceof ApiError && cause.status === 403;
			tree.replaceChildren(
				empty('lock', forbidden ? 'Needs agent:invoke' : 'Tasks unavailable', forbidden ? '' : messageOf(cause)),
			);
		}
	}

	/** The poll: the list always; the selected task while it can still change (its first read is the select's). */
	async function tick(): Promise<void> {
		await loadList();
		const current = selected === null ? undefined : tasks.find((task) => task.id === selected);
		if (selected === null) overview();
		else if (current !== undefined && !TERMINAL.includes(current.status.state)) await loadSelected();
	}
	const timer = setInterval(() => void tick(), 3000);
	onLeave(() => {
		alive = false;
		clearInterval(timer);
	});

	mount(renderShell(navigate, {
		active: 'agents',
		title: 'Agents',
		subtitle: 'Every agent task with its run history: requests, tool calls and states',
		tabs: agentTabs('tasks'),
		wide: true,
	}, [el('div', { class: 'rx-layout tk-layout' }, [pane, viewer])]));
	tree.replaceChildren(skeleton(4));
	viewer.replaceChildren(skeleton(3));
	void loadList().then(() => {
		// Arriving from a workspace: its newest task opens, so the icon leads straight to the work done there.
		if (workspace !== null && selected === null && tasks[0] !== undefined) select(tasks[0].id);
		else return loadSelected();
	});
}
