/**
 * The Workspaces screen (D-076): coding workspaces in the sandbox, their files, and a live shell per workspace — the
 * third tab of Sessions (D-147).
 *
 * Files: a tree of every file and folder in the workspace (`workspace_tree.ts`, over `sandbox_list` with a path) opens
 * a file on a click; the path field stays for creating a new one. Files go through `sandbox_read` / `sandbox_write`;
 * the tree refreshes after a save, after each shell command and on the screen's poll, since any of them can add files.
 * The shell is a server-sent event stream over the gateway's
 * session routes with a line input underneath. Line mode, no terminal emulation: what the shell prints is appended
 * as text, and each command is sent with its newline.
 *
 * Presentation (D-089): a rail of workspace cards (terminal glyph, name, age, live dot); the chosen workspace below
 * with icon actions (diff, delete confirmed in a popover) and a `wa-split-panel` of editor and shell. The shell's
 * state is a dot, its network an icon toggle; the words are tooltips.
 *
 * An open workspace has two views as tabs in the Agents tabs' look: **Files & shell** (`#/workspaces/<id>`) and
 * **Surfaces** (`#/workspaces/<id>/surfaces`, `workspace_surfaces.ts`: the interfaces agents published for it,
 * rendered live, with the ones in no workspace offered to attach). The tabs switch in place, so the shell's session
 * and the editor survive. A task icon in the header counts the agent tasks that touched the workspace
 * (`GET /api/v1/agent/tasks?workspace_id=`) and opens them on Agents › Tasks.
 */
import { api, ApiError, getUser, streamEvents } from './api.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon } from './icons.ts';
import { onLeave } from './lifecycle.ts';
import { type WorkspaceSurfaces, workspaceSurfaces } from './workspace_surfaces.ts';
import { invoke } from './mcp.ts';
import { clearCommands, registerCommands } from './palette.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	dot,
	empty,
	iconButton,
	messageOf,
	openModal,
	poll,
	relativeTime,
	skeleton,
	tag,
	tip,
	toast,
} from './ui.ts';
import { rememberWorkspace, sessionTabs } from './session_tabs.ts';
import { tasksRoute } from './agent_tabs.ts';
import { fileTree, type TreeListing } from './workspace_tree.ts';
import { type Navigate, renderShell } from './shell.ts';

interface Workspace {
	workspace_id: string;
	name?: string;
	created_at: string;
	busy?: boolean;
}

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const { result } = await invoke<{ result: T }>(name, args);
	return result;
}

function nameOf(workspace: Workspace): string {
	return workspace.name ?? workspace.workspace_id.slice(0, 8);
}

/** A unified diff, one span per line, so additions, removals and hunk headers take their colours. Text only. */
function diffView(patch: string): HTMLElement {
	const pre = el('pre', { class: 'code ws-diff' });
	if (patch === '') {
		pre.textContent = '(no changes)';
		return pre;
	}
	for (const line of patch.split('\n')) {
		const kind = /^(diff |index |\+\+\+ |--- )/.test(line)
			? 'meta'
			: line.startsWith('@@')
			? 'hunk'
			: line.startsWith('+')
			? 'add'
			: line.startsWith('-')
			? 'del'
			: '';
		pre.append(el('span', { class: kind, text: `${line}\n` }));
	}
	return pre;
}

/** A workspace's two views: its files beside the shell, and the A2UI surfaces agents published for it. */
type WorkspaceView = 'files' | 'surfaces';

/** The route of one workspace's view: `#/workspaces/<id>` for its files, `#/workspaces/<id>/surfaces`. */
export function workspaceRoute(workspaceId: string, view: WorkspaceView): string {
	return `#/workspaces/${encodeURIComponent(workspaceId)}${view === 'surfaces' ? '/surfaces' : ''}`;
}

/** The workspace and view a route parameter names (`<id>` or `<id>/surfaces`). */
export function parseWorkspaceParam(param: string | undefined): { id: string | undefined; view: WorkspaceView } {
	if (param === undefined || param === '') return { id: undefined, view: 'files' };
	const [id, view] = param.split('/');
	return { id: id === undefined || id === '' ? undefined : id, view: view === 'surfaces' ? 'surfaces' : 'files' };
}

export function workspacesView(navigate: Navigate, initial?: string): void {
	const route = parseWorkspaceParam(initial);
	/** The view each opened workspace shows: the route's at first, then whichever the person last chose. */
	let view: WorkspaceView = route.view;
	const rail = el('div', { class: 'ws-rail', role: 'group', 'aria-label': 'Workspaces' }, [skeleton(1)]);
	const detail = el('section', { class: 'ws-detail', 'aria-label': 'Workspace' }, [
		empty('workspace', 'Select a workspace', 'Or create one to start coding in a cage.'),
	]);
	const can = getUser()?.scopes.includes('sandbox:execute') === true;
	let selected: string | undefined = route.id;
	/** The workspace the detail shows; a refresh leaves it (and its shell) alone. */
	let shown: string | null = null;
	/** The workspace whose live session this screen is following, for its card's dot. */
	let live: string | null = null;
	let controller: AbortController | null = null;
	/** Lists the shown workspace's file tree again; set while a workspace is open. */
	let refreshShownTree: (() => void) | null = null;
	/** Counts the tasks that touched the shown workspace again; set while a workspace is open. */
	let refreshTaskCount: (() => void) | null = null;
	/** The shown workspace's surfaces panel, stopped (renders released) whenever the workspace changes or goes. */
	let surfaces: WorkspaceSurfaces | null = null;
	const dropSurfaces = (): void => {
		surfaces?.stop();
		surfaces = null;
	};
	let alive = true;
	onLeave(() => {
		alive = false;
		dropSurfaces();
		controller?.abort();
		clearCommands('workspaces');
	});

	function paintCards(): void {
		for (const node of Array.from(rail.querySelectorAll<HTMLElement>('.ws-card'))) {
			const id = node.getAttribute('data-id');
			node.setAttribute('aria-pressed', String(id === selected));
			const liveDot = node.querySelector<HTMLElement>('.ws-live');
			if (liveDot !== null) liveDot.hidden = id !== live;
		}
	}

	function card(workspace: Workspace, index: number): HTMLElement {
		const id = workspace.workspace_id;
		const liveDot = dot('live', 'Live session');
		liveDot.classList.add('ws-live');
		liveDot.hidden = id !== live;
		const node = el('button', {
			type: 'button',
			class: 'ws-card',
			'data-id': id,
			'aria-pressed': String(id === selected),
		}, [
			el('span', { class: 'ws-card-glyph', 'aria-hidden': 'true' }, [icon('terminal')]),
			el('span', { class: 'ws-card-text' }, [
				el('span', { class: 'ws-card-name', text: nameOf(workspace) }),
				el('wa-relative-time', { class: 'ws-card-time', date: workspace.created_at, format: 'narrow', sync: true }),
			]),
			el('span', { class: 'ws-card-state' }, [liveDot, ...(workspace.busy ? [dot('warn', 'Busy')] : [])]),
		]);
		node.setAttribute('data-tip', `${id} · created ${new Date(workspace.created_at).toLocaleString()}`);
		node.style.setProperty('--i', String(Math.min(index, 20)));
		on(node, 'click', () => open(workspace));
		return node;
	}

	/** The list as last drawn, so a poll that finds nothing new leaves the rail (and its animations) alone. */
	let signature = '';

	async function load(): Promise<void> {
		try {
			const { workspaces } = await tool<{ workspaces: Workspace[] }>('sandbox_list', {});
			// The empty state carries the one "new workspace" action while there are none.
			create.hidden = workspaces.length === 0;
			const next = JSON.stringify(workspaces);
			if (next === signature) return;
			signature = next;
			if (alive) {
				registerCommands(
					'workspaces',
					workspaces.map((workspace) => ({
						id: `workspace:${workspace.workspace_id}`,
						label: nameOf(workspace),
						hint: workspace.workspace_id.slice(0, 8),
						icon: 'workspace',
						group: 'Workspaces',
						keywords: workspace.workspace_id,
						run: () => open(workspace),
					})),
				);
			}
			clear(rail);
			rail.classList.toggle('has-cards', workspaces.length > 0);
			detail.hidden = workspaces.length === 0;
			if (workspaces.length === 0) {
				rail.append(empty('workspace', 'No workspaces', 'Create one to begin.', newButton()));
			}
			workspaces.forEach((workspace, index) => rail.append(card(workspace, index)));
			const current = workspaces.find((workspace) => workspace.workspace_id === selected);
			if (current !== undefined && current.workspace_id !== shown) open(current);
		} catch (cause) {
			if (alive) clearCommands('workspaces');
			signature = '';
			create.hidden = false;
			clear(rail);
			rail.classList.remove('has-cards');
			detail.hidden = true;
			rail.append(
				empty(
					'lock',
					'Sandbox unavailable',
					cause instanceof ApiError && cause.status === 403
						? 'This credential lacks sandbox:execute.'
						: `${messageOf(cause)} Is the sandbox overlay deployed?`,
				),
			);
		}
	}

	function open(workspace: Workspace): void {
		selected = workspace.workspace_id;
		shown = workspace.workspace_id;
		rememberWorkspace(workspace.workspace_id);
		controller?.abort();
		controller = null;
		live = null;
		refreshShownTree = null;
		refreshTaskCount = null;
		dropSurfaces();
		globalThis.history.replaceState(null, '', workspaceRoute(workspace.workspace_id, view));
		paintCards();
		clear(detail);
		detail.hidden = false;

		// --- files -------------------------------------------------------------
		const pathInput = el('input', {
			type: 'text',
			id: 'ws-path',
			placeholder: 'src/main.py',
			class: 'mono',
			autocomplete: 'off',
			spellcheck: 'false',
		});
		const editor = el('textarea', {
			id: 'ws-editor',
			class: 'mono editor ws-editor',
			rows: 18,
			spellcheck: 'false',
			'aria-label': 'File contents',
		});
		const readBtn = iconButton('folder-open', 'Open file', undefined, { small: true });
		const writeBtn = iconButton('save', 'Save file', undefined, { small: true, variant: 'primary' });
		const tree = fileTree({
			list: (path) =>
				tool<TreeListing>('sandbox_list', {
					workspace_id: workspace.workspace_id,
					...(path === '' ? {} : { path }),
				}),
			onOpen: (path) => {
				pathInput.value = path;
				readBtn.click();
			},
			messageOf,
		});
		/** One refresh at a time, shortly after the change that asked for it (a command may still be writing). */
		let refreshTimer: ReturnType<typeof setTimeout> | null = null;
		const refreshSoon = (delay = 1_200): void => {
			if (refreshTimer !== null) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				if (alive && shown === workspace.workspace_id) void tree.refresh();
			}, delay);
		};
		// D-092: the screen polls, so there is no refresh button; the poll lists the tree again too (files an agent adds).
		refreshShownTree = () => void tree.refresh();
		on(readBtn, 'click', () =>
			void busy(readBtn, async () => {
				const path = pathInput.value.trim();
				const { content } = await tool<{ content: string }>('sandbox_read', {
					workspace_id: workspace.workspace_id,
					path,
				});
				editor.value = content;
				tree.select(path);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(writeBtn, 'click', () =>
			void busy(writeBtn, async () => {
				const path = pathInput.value.trim();
				await tool('sandbox_write', {
					workspace_id: workspace.workspace_id,
					path,
					content: editor.value,
				});
				toast(`${path} saved`, 'ok');
				// A new file (or folder in its path) appears in the tree, selected.
				await tree.refresh();
				tree.select(path);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		// Enter in the path opens the file, as the open button does.
		on(pathInput, 'keydown', (event) => {
			if (event.key === 'Enter' && !readBtn.disabled) {
				event.preventDefault();
				readBtn.click();
			}
		});

		// --- terminal ----------------------------------------------------------
		const log = el('pre', { class: 'terminal mono', 'aria-live': 'polite', 'aria-label': 'Shell output' });
		const input = el('input', {
			type: 'text',
			class: 'mono term-input',
			placeholder: 'command, then Enter',
			'aria-label': 'Shell input',
			autocomplete: 'off',
			spellcheck: 'false',
		});
		const status = dot('', 'No session');
		const setStatus = (tone: string, meaning: string): void => {
			status.className = `dot ${tone}`;
			status.setAttribute('aria-label', meaning);
			status.setAttribute('data-tip', meaning);
		};
		const openBtn = iconButton('play', 'Open session', undefined, { small: true, variant: 'primary' });
		const closeBtn = iconButton('stop', 'Close session', undefined, { small: true });

		// The network the next session gets: an icon toggle instead of a select.
		let network: 'none' | 'registries' = 'none';
		const netNone = iconButton('wifi-off', 'No network', () => setNetwork('none'), { small: true });
		const netRegistries = iconButton('package', 'Package registries', () => setNetwork('registries'), { small: true });
		function setNetwork(value: 'none' | 'registries'): void {
			network = value;
			netNone.setAttribute('aria-pressed', String(value === 'none'));
			netRegistries.setAttribute('aria-pressed', String(value === 'registries'));
		}
		setNetwork('none');

		let sessionId: string | null = null;
		const history: string[] = [];
		let historyAt = 0;
		closeBtn.disabled = true;
		input.disabled = true;

		const append = (text: string, kind = ''): void => {
			const node = el('span', { class: kind, text });
			log.append(node);
			while (log.childElementCount > 2000) log.firstElementChild?.remove();
			log.scrollTop = log.scrollHeight;
		};

		function follow(id: string): void {
			controller?.abort();
			controller = new AbortController();
			const own = controller;
			let after = 0;
			streamEvents(api.sandboxSessionEventsPath(id, after), (kind, data) => {
				if (kind === 'output') {
					const event = JSON.parse(data) as { seq: number; data: string; gap: boolean };
					if (event.gap) append('[output gap]\n', 'muted');
					append(event.data);
					after = event.seq;
				} else if (kind === 'end') {
					const event = JSON.parse(data) as { exit_code?: number | null; killed?: string | null; error?: string };
					append(
						`\n[session ended${event.killed ? `: ${event.killed}` : ''}${
							event.exit_code !== undefined && event.exit_code !== null ? `, exit ${event.exit_code}` : ''
						}${event.error ? `: ${event.error}` : ''}]\n`,
						'muted',
					);
					ended();
					refreshSoon(0);
				}
			}, own.signal).catch((cause) => {
				if (!own.signal.aborted) {
					append(`\n[stream ended: ${messageOf(cause)}]\n`, 'muted');
					ended();
				}
			});
		}

		function ended(): void {
			sessionId = null;
			setStatus('', 'Session ended');
			shell.classList.remove('is-live');
			input.disabled = true;
			closeBtn.disabled = true;
			openBtn.disabled = false;
			if (live === workspace.workspace_id) {
				live = null;
				paintCards();
			}
		}

		on(openBtn, 'click', () =>
			void busy(openBtn, async () => {
				const { session_id } = await api.openSandboxSession(workspace.workspace_id, network);
				sessionId = session_id;
				clear(log);
				append(`[session ${session_id.slice(0, 8)} open]\n`, 'muted');
				setStatus('live', network === 'none' ? 'Live · no network' : 'Live · package registries');
				shell.classList.add('is-live');
				input.disabled = false;
				closeBtn.disabled = false;
				openBtn.disabled = true;
				live = workspace.workspace_id;
				paintCards();
				follow(session_id);
				input.focus();
			}).then(() => {
				// `busy` re-enables the button it ran on; a live session keeps it off.
				openBtn.disabled = sessionId !== null;
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(closeBtn, 'click', () =>
			void busy(closeBtn, async () => {
				if (sessionId !== null) await api.closeSandboxSession(sessionId);
			}).then(() => {
				closeBtn.disabled = sessionId === null;
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(input, 'keydown', (event) => {
			if (event.key === 'ArrowUp' && history.length > 0) {
				historyAt = Math.max(0, historyAt - 1);
				input.value = history[historyAt] ?? '';
				event.preventDefault();
			} else if (event.key === 'ArrowDown') {
				historyAt = Math.min(history.length, historyAt + 1);
				input.value = history[historyAt] ?? '';
				event.preventDefault();
			} else if (event.key === 'Enter' && sessionId !== null) {
				const line = input.value;
				input.value = '';
				history.push(line);
				historyAt = history.length;
				append(`$ ${line}\n`, 'cmd');
				api.sandboxSessionInput(sessionId, `${line}\n`).catch((cause) => toast(messageOf(cause), 'error'));
				// A command can create, move or delete files: the tree follows shortly after.
				refreshSoon();
			}
		});

		// --- header --------------------------------------------------------------
		const remove = confirmButton(
			{ label: 'Delete workspace', icon: 'trash', small: true, iconOnly: true },
			async () => {
				await tool('sandbox_delete', { workspace_id: workspace.workspace_id });
				toast('Workspace deleted', 'ok');
				selected = undefined;
				shown = null;
				refreshShownTree = null;
				refreshTaskCount = null;
				dropSurfaces();
				rememberWorkspace(null);
				controller?.abort();
				live = null;
				clear(detail);
				detail.append(empty('workspace', 'Select a workspace'));
				await load();
			},
		);
		const diff = iconButton('diff', 'Diff', undefined, { small: true });
		on(diff, 'click', () =>
			void busy(diff, async () => {
				const { patch } = await tool<{ patch: string }>('sandbox_diff', { workspace_id: workspace.workspace_id });
				openModal(`Diff of ${nameOf(workspace)}`, [diffView(patch)], true);
			}).catch((cause) => toast(messageOf(cause), 'error')));

		const editorPane = el('section', { class: 'ws-pane ws-editor-pane', slot: 'start', 'aria-label': 'Editor' }, [
			el('div', { class: 'ws-bar' }, [
				el('label', { for: 'ws-path', class: 'sr-only', text: 'File path' }),
				el('span', { class: 'ws-bar-glyph', 'aria-hidden': 'true' }, [icon('file-code')]),
				pathInput,
				readBtn,
				writeBtn,
			]),
			el('div', { class: 'ws-files' }, [
				el('nav', { class: 'ws-tree-pane', 'aria-label': 'Workspace files' }, [
					el('div', { class: 'ws-tree-head' }, [el('span', { class: 'ws-tree-title', text: 'Files' })]),
					tree.element,
				]),
				editor,
			]),
		]);
		const shell = el('section', { class: 'ws-pane ws-shell-pane', slot: 'end', 'aria-label': 'Shell' }, [
			el('div', { class: 'ws-bar' }, [
				el('span', { class: 'ws-bar-glyph', 'aria-hidden': 'true' }, [icon('terminal')]),
				status,
				el('span', { class: 'grow' }),
				el('div', { class: 'segmented ws-network', role: 'group', 'aria-label': 'Session network' }, [
					netNone,
					netRegistries,
				]),
				openBtn,
				closeBtn,
			]),
			log,
			el('div', { class: 'ws-prompt' }, [
				el('span', { class: 'ws-prompt-mark', 'aria-hidden': 'true', text: '$' }),
				input,
			]),
		]);

		// --- the views: files and shell, or surfaces — tabs in the Agents tabs' look, switched in place --------------
		// In place, not by route: the shell's live session and the editor's unsaved text survive the switch; the address
		// follows with `replaceState`, so a reload or a shared link opens the same view.
		const split = el('wa-split-panel', { class: 'ws-split', position: 55 }, [
			editorPane,
			el('span', { class: 'ws-grip', slot: 'divider', 'aria-hidden': 'true' }, [icon('grip')]),
			shell,
		]);
		const surfaceCount = el('span', { class: 'ws-tab-count', hidden: true });
		surfaces = workspaceSurfaces(workspace.workspace_id, {
			onCount: (count) => {
				surfaceCount.hidden = count === 0;
				surfaceCount.textContent = String(count);
				surfacesTab.setAttribute('aria-label', count === 1 ? 'Surfaces · 1' : `Surfaces · ${count}`);
			},
		});
		const filesView = el('div', { class: 'ws-view', 'data-view': 'files' }, [split]);
		const surfacesView = el('div', { class: 'ws-view', 'data-view': 'surfaces' }, [surfaces.node]);
		const tab = (id: WorkspaceView, label: string, glyph: 'file-code' | 'surface', extra: Node[] = []) =>
			el('a', { class: 'page-tab', href: workspaceRoute(workspace.workspace_id, id), 'data-tab': id }, [
				icon(glyph),
				el('span', { class: 'page-tab-label', text: label }),
				...extra,
			]);
		const filesTab = tab('files', 'Files & shell', 'file-code');
		const surfacesTab = tab('surfaces', 'Surfaces', 'surface', [surfaceCount]);
		const show = (next: WorkspaceView): void => {
			view = next;
			for (const [node, id] of [[filesTab, 'files'], [surfacesTab, 'surfaces']] as const) {
				node.classList.toggle('active', id === next);
				if (id === next) node.setAttribute('aria-current', 'page');
				else node.removeAttribute('aria-current');
			}
			filesView.hidden = next !== 'files';
			surfacesView.hidden = next !== 'surfaces';
			globalThis.history.replaceState(null, '', workspaceRoute(workspace.workspace_id, next));
		};
		for (const [node, id] of [[filesTab, 'files'], [surfacesTab, 'surfaces']] as const) {
			on(node, 'click', (event) => {
				event.preventDefault();
				show(id);
			});
		}
		const viewTabs = el('nav', { class: 'page-tabs ws-tabs', 'aria-label': 'Workspace views' }, [
			filesTab,
			surfacesTab,
		]);

		// --- the tasks that used this workspace: one icon, its count, and the way to their run histories -------------
		const taskCount = el('span', { class: 'ws-task-count', 'aria-hidden': 'true', hidden: true });
		const tasksButton = iconButton(
			'list-checks',
			'Agent tasks that used this workspace',
			() => navigate(tasksRoute(null, workspace.workspace_id)),
			{ small: true },
		);
		tasksButton.classList.add('ws-tasks');
		tasksButton.append(taskCount);
		tasksButton.hidden = true;
		const countTasks = (): void => {
			api.listAgentTasks(workspace.workspace_id).then(({ tasks }) => {
				if (shown !== workspace.workspace_id) return;
				const words = tasks.length === 0
					? 'No agent task has used this workspace yet'
					: tasks.length === 1
					? '1 agent task used this workspace: open its run history'
					: `${tasks.length} agent tasks used this workspace: open their run histories`;
				tasksButton.hidden = false;
				tasksButton.setAttribute('aria-label', words);
				tasksButton.setAttribute('data-tip', words);
				taskCount.hidden = tasks.length === 0;
				taskCount.textContent = tasks.length > 99 ? '99+' : String(tasks.length);
			}).catch(() => {
				// Without agent:invoke there are no tasks to show: the icon stays away.
				tasksButton.hidden = true;
			});
		};
		refreshTaskCount = countTasks;

		detail.append(
			el('header', { class: 'ws-head' }, [
				el('div', { class: 'ws-head-glyph', 'aria-hidden': 'true' }, [icon('workspace')]),
				el('div', { class: 'ws-head-text' }, [
					el('h2', { text: nameOf(workspace) }),
					el('div', { class: 'ws-head-meta' }, [
						el('code', { class: 'mono ws-id', text: workspace.workspace_id }),
						copyButton(() => workspace.workspace_id, 'Copy workspace id'),
						tip(
							el('span', { class: 'ws-age' }, [icon('clock'), relativeTime(workspace.created_at)]),
							`Created ${new Date(workspace.created_at).toLocaleString()}`,
						),
					]),
				]),
				viewTabs,
				el('div', { class: 'ws-head-actions' }, [tasksButton, diff, remove]),
			]),
			filesView,
			surfacesView,
		);
		show(view);
		countTasks();
		void tree.refresh();
	}

	function createDialog(): void {
		const name = el('input', {
			type: 'text',
			id: 'ws-name',
			placeholder: 'demo',
			autocomplete: 'off',
			autofocus: true,
		});
		const submit = button({ label: 'Create', icon: 'plus', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'lib-form' }, [
			el('div', { class: 'lib-field', 'data-tip': 'Name' }, [
				el('label', { for: 'ws-name', class: 'sr-only', text: 'Name' }),
				el('span', { class: 'lib-field-glyph', 'aria-hidden': 'true' }, [icon('workspace')]),
				name,
			]),
			el('div', { class: 'lib-form-actions' }, [submit]),
		]);
		const dialog = openModal('New workspace', [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const created = await tool<{ workspace_id: string }>('sandbox_create', {
					...(name.value.trim() === '' ? {} : { name: name.value.trim() }),
					files: { 'README.md': `# ${name.value.trim() || 'workspace'}\n` },
				});
				dialog.close();
				selected = created.workspace_id;
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		name.focus();
	}

	/** The empty state's one action: the same dialog as the header's icon button. */
	function newButton(): HTMLButtonElement {
		const node = button({ label: 'New workspace', icon: 'plus', variant: 'primary' });
		node.disabled = !can;
		on(node, 'click', createDialog);
		return node;
	}

	const create = iconButton('plus', 'New workspace', createDialog, { variant: 'primary' });
	create.disabled = !can;
	create.hidden = true;

	const actions: Node[] = [create];
	if (!can) {
		actions.unshift(
			tip(
				tag('No sandbox access', 'lock', 'warn'),
				'This credential lacks sandbox:execute; grant it on the Users screen to use workspaces.',
			),
		);
	}
	mount(renderShell(navigate, {
		active: 'sessions',
		title: 'Workspaces',
		subtitle: 'Coding workspaces in the sandbox, with a live shell',
		tabs: sessionTabs('workspaces'),
		actions,
		wide: true,
	}, [rail, detail]));
	void load();
	// No refresh button (D-092): workspaces an agent creates appear on their own.
	poll(rail, 10_000, () => {
		void load();
		refreshShownTree?.();
		refreshTaskCount?.();
	});
}
