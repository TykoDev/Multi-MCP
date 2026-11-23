/**
 * Workspaces (the third tab of Sessions): coding workspaces in the sandbox, each with a file tree, an editor and a
 * live shell. Files go through `sandbox_list` / `sandbox_read` / `sandbox_write`; the tree follows saves, shell
 * commands and the screen's poll, since any of them can add files. The shell is a server-sent event stream over the
 * gateway's session routes with a line input under it: what it prints is appended as text, each command sent with
 * its newline.
 */
import { api, ApiError, getUser, streamEvents } from './api.ts';
import { el, mount, on } from './dom.ts';
import { onLeave } from './lifecycle.ts';
import { invoke } from './mcp.ts';
import { type Navigate, rememberWorkspace, renderShell, sessionTabs } from './shell.ts';
import {
	busy,
	button,
	confirmButton,
	dot,
	empty,
	field,
	iconButton,
	input,
	messageOf,
	notice,
	openModal,
	poll,
	relativeTime,
	toast,
} from './ui.ts';
import { fileTree, type TreeListing } from './workspace_tree.ts';

interface Workspace {
	workspace_id: string;
	name?: string;
	created_at: string;
}

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const { result } = await invoke<{ result: T }>(name, args);
	return result;
}

function nameOf(workspace: Workspace): string {
	return workspace.name ?? workspace.workspace_id.slice(0, 8);
}

/** A unified diff, one span per line, so additions, removals and hunks take their colours. Text only. */
function diffView(patch: string): HTMLElement {
	const pre = el('pre', { class: 'code ws-diff' });
	if (patch === '') pre.textContent = '(no changes)';
	for (const line of patch === '' ? [] : patch.split('\n')) {
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

export function workspacesView(navigate: Navigate, initial?: string): void {
	const rail = el('div', { class: 'ws-rail', role: 'group', 'aria-label': 'Workspaces' });
	const detail = el('section', { class: 'ws-detail', 'aria-label': 'Workspace' });
	const can = getUser()?.scopes.includes('sandbox:execute') === true;
	let selected = initial;
	/** The workspace the detail shows; a poll leaves it (and its shell) alone. */
	let shown: string | null = null;
	let controller: AbortController | null = null;
	let refreshTree: (() => void) | null = null;
	let alive = true;
	onLeave(() => {
		alive = false;
		controller?.abort();
	});

	let signature = '';
	async function load(): Promise<void> {
		try {
			const { workspaces } = await tool<{ workspaces: Workspace[] }>('sandbox_list', {});
			const next = JSON.stringify([workspaces, selected]);
			if (next === signature) return;
			signature = next;
			rail.replaceChildren(
				...(workspaces.length === 0 ? [empty('workspace', 'No workspaces', 'Create one to begin.')] : []),
				...workspaces.map((workspace) => {
					const card = el('button', {
						type: 'button',
						class: 'ws-card',
						'aria-pressed': String(workspace.workspace_id === selected),
						title: workspace.workspace_id,
					}, [
						el('span', { class: 'ws-card-name', text: nameOf(workspace) }),
						el('span', { class: 'ws-card-time', text: relativeTime(workspace.created_at) }),
					]);
					on(card, 'click', () => open(workspace));
					return card;
				}),
			);
			const current = workspaces.find((workspace) => workspace.workspace_id === selected);
			if (current !== undefined && current.workspace_id !== shown) open(current);
		} catch (cause) {
			signature = '';
			rail.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'This credential lacks sandbox:execute.'
					: `Sandbox unavailable: ${messageOf(cause)}`,
			));
		}
	}

	function open(workspace: Workspace): void {
		const id = workspace.workspace_id;
		selected = id;
		shown = id;
		signature = '';
		rememberWorkspace(id);
		controller?.abort();
		controller = null;
		globalThis.history.replaceState(null, '', `#/workspaces/${encodeURIComponent(id)}`);
		void load();

		// --- files -------------------------------------------------------------
		const pathInput = input('ws-path', '', { class: 'mono', placeholder: 'src/main.py', 'aria-label': 'File path' });
		const editor = el('textarea', {
			id: 'ws-editor',
			class: 'mono ws-editor',
			rows: 18,
			spellcheck: 'false',
			'aria-label': 'File contents',
		});
		const readBtn = iconButton('folder-open', 'Open file', undefined, { small: true });
		const writeBtn = iconButton('save', 'Save file', undefined, { small: true, variant: 'primary' });
		const tree = fileTree({
			list: (path) => tool<TreeListing>('sandbox_list', { workspace_id: id, ...(path === '' ? {} : { path }) }),
			onOpen: (path) => {
				pathInput.value = path;
				readBtn.click();
			},
			messageOf,
		});
		let refreshTimer: ReturnType<typeof setTimeout> | null = null;
		/** One tree refresh, shortly after the change that asked for it (a command may still be writing). */
		const refreshSoon = (delay = 1_200): void => {
			if (refreshTimer !== null) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				if (alive && shown === id) void tree.refresh();
			}, delay);
		};
		refreshTree = () => void tree.refresh();
		on(readBtn, 'click', () =>
			void busy(readBtn, async () => {
				const path = pathInput.value.trim();
				editor.value = (await tool<{ content: string }>('sandbox_read', { workspace_id: id, path })).content;
				tree.select(path);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(writeBtn, 'click', () =>
			void busy(writeBtn, async () => {
				const path = pathInput.value.trim();
				await tool('sandbox_write', { workspace_id: id, path, content: editor.value });
				toast(`${path} saved`, 'ok');
				await tree.refresh();
				tree.select(path);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(pathInput, 'keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				readBtn.click();
			}
		});

		// --- shell -------------------------------------------------------------
		const log = el('pre', { class: 'terminal mono', 'aria-live': 'polite', 'aria-label': 'Shell output' });
		const line = input('ws-shell', '', {
			class: 'mono',
			placeholder: 'command, then Enter',
			'aria-label': 'Shell input',
			disabled: true,
		});
		const status = dot('', 'No session');
		const network = el('select', { 'aria-label': 'Session network' }, [
			el('option', { value: 'none', text: 'No network' }),
			el('option', { value: 'registries', text: 'Package registries' }),
		]);
		const openBtn = iconButton('play', 'Open session', undefined, { small: true, variant: 'primary' });
		const closeBtn = iconButton('stop', 'Close session', undefined, { small: true });
		closeBtn.disabled = true;
		let sessionId: string | null = null;
		const history: string[] = [];
		let historyAt = 0;

		const append = (text: string, kind = ''): void => {
			log.append(el('span', { class: kind, text }));
			while (log.childElementCount > 2000) log.firstElementChild?.remove();
			log.scrollTop = log.scrollHeight;
		};
		const setStatus = (tone: string, meaning: string): void => {
			status.className = `dot ${tone}`;
			status.setAttribute('aria-label', meaning);
			status.title = meaning;
		};
		function ended(): void {
			sessionId = null;
			setStatus('', 'Session ended');
			line.disabled = true;
			closeBtn.disabled = true;
			openBtn.disabled = false;
		}
		function follow(session: string): void {
			controller?.abort();
			const own = controller = new AbortController();
			streamEvents(api.sandboxSessionEventsPath(session, 0), (kind, data) => {
				if (kind === 'output') {
					const event = JSON.parse(data) as { data: string; gap: boolean };
					if (event.gap) append('[output gap]\n', 'muted');
					append(event.data);
				} else if (kind === 'end') {
					const event = JSON.parse(data) as { exit_code?: number | null; killed?: string | null; error?: string };
					const exit = event.exit_code !== undefined && event.exit_code !== null ? `, exit ${event.exit_code}` : '';
					append(
						`\n[session ended${event.killed ? `: ${event.killed}` : ''}${exit}${
							event.error ? `: ${event.error}` : ''
						}]\n`,
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
		on(openBtn, 'click', () =>
			void busy(openBtn, async () => {
				const chosen = network.value === 'registries' ? 'registries' : 'none';
				sessionId = (await api.openSandboxSession(id, chosen)).session_id;
				log.replaceChildren();
				append(`[session ${sessionId.slice(0, 8)} open]\n`, 'muted');
				setStatus('live', chosen === 'none' ? 'Live · no network' : 'Live · package registries');
				line.disabled = false;
				closeBtn.disabled = false;
				follow(sessionId);
				line.focus();
			}).then(() => {
				// `busy` re-enables the button it ran on; a live session keeps it off.
				openBtn.disabled = sessionId !== null;
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(closeBtn, 'click', () =>
			void busy(closeBtn, async () => {
				if (sessionId !== null) await api.closeSandboxSession(sessionId);
			}).catch((cause) => toast(messageOf(cause), 'error')));
		on(line, 'keydown', (event) => {
			if (event.key === 'ArrowUp' && history.length > 0) {
				historyAt = Math.max(0, historyAt - 1);
				line.value = history[historyAt] ?? '';
				event.preventDefault();
			} else if (event.key === 'ArrowDown') {
				historyAt = Math.min(history.length, historyAt + 1);
				line.value = history[historyAt] ?? '';
				event.preventDefault();
			} else if (event.key === 'Enter' && sessionId !== null) {
				const command = line.value;
				line.value = '';
				history.push(command);
				historyAt = history.length;
				append(`$ ${command}\n`, 'cmd');
				api.sandboxSessionInput(sessionId, `${command}\n`).catch((cause) => toast(messageOf(cause), 'error'));
				refreshSoon();
			}
		});

		// --- header ------------------------------------------------------------
		const remove = confirmButton({ label: 'Delete workspace', icon: 'trash', small: true }, async () => {
			await tool('sandbox_delete', { workspace_id: id });
			toast('Workspace deleted', 'ok');
			selected = undefined;
			shown = null;
			refreshTree = null;
			rememberWorkspace(null);
			controller?.abort();
			detail.replaceChildren();
			globalThis.history.replaceState(null, '', '#/workspaces');
			await load();
		});
		const diff = button({ label: 'Diff', icon: 'diff', small: true });
		on(diff, 'click', () =>
			void busy(diff, async () => {
				const { patch } = await tool<{ patch: string }>('sandbox_diff', { workspace_id: id });
				openModal(`Diff of ${nameOf(workspace)}`, [diffView(patch)], true);
			}).catch((cause) => toast(messageOf(cause), 'error')));

		detail.replaceChildren(
			el('header', { class: 'ws-head' }, [
				el('h2', { text: nameOf(workspace) }),
				el('code', { class: 'mono muted', text: id }),
				el('span', { class: 'grow' }),
				diff,
				remove,
			]),
			el('div', { class: 'ws-split' }, [
				el('section', { class: 'ws-pane', 'aria-label': 'Editor' }, [
					el('div', { class: 'ws-bar' }, [pathInput, readBtn, writeBtn]),
					el('div', { class: 'ws-files' }, [
						el('nav', { class: 'ws-tree-pane', 'aria-label': 'Workspace files' }, [tree.element]),
						editor,
					]),
				]),
				el('section', { class: 'ws-pane', 'aria-label': 'Shell' }, [
					el('div', { class: 'ws-bar' }, [status, el('span', { class: 'grow' }), network, openBtn, closeBtn]),
					log,
					line,
				]),
			]),
		);
		void tree.refresh();
	}

	function createDialog(): void {
		const name = input('ws-name', '', { placeholder: 'demo' });
		const submit = button({ label: 'Create', icon: 'plus', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'form' }, [
			field('ws-name', 'Name', name),
			el('div', { class: 'actions' }, [submit]),
		]);
		const dialog = openModal('New workspace', [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const label = name.value.trim();
				const created = await tool<{ workspace_id: string }>('sandbox_create', {
					...(label === '' ? {} : { name: label }),
					files: { 'README.md': `# ${label || 'workspace'}\n` },
				});
				dialog.close();
				selected = created.workspace_id;
				signature = '';
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		name.focus();
	}

	const create = button({ label: 'New workspace', icon: 'plus', variant: 'primary', onClick: createDialog });
	create.disabled = !can;
	if (!can) create.title = 'This credential lacks sandbox:execute; an administrator grants it on Users.';
	mount(renderShell(navigate, {
		active: 'sessions',
		title: 'Workspaces',
		tabs: sessionTabs('workspaces'),
		actions: [create],
	}, [el('div', { class: 'ws-layout' }, [rail, detail])]));
	void load();
	// Workspaces an agent creates, and files it adds, appear on their own.
	poll(rail, 10_000, () => {
		void load();
		refreshTree?.();
	});
}
