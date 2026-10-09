/**
 * The command palette (Ctrl/⌘+K, or `/` outside a text field): one search box
 * over every section, whatever the current screen registered (sessions, tools,
 * files…) and a few safe actions.
 *
 * Entries navigate, select (which may read: opening a file or a resource
 * reads it), or toggle a view preference; none runs a mutating tool or changes
 * server state, so a stray Enter here is never destructive (S-5).
 */
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { setTheme, THEMES } from './theme.ts';

export interface Command {
	readonly id: string;
	readonly label: string;
	readonly icon: IconName;
	/** A secondary word or id shown faintly after the label (a session id, a tool name). */
	readonly hint?: string;
	/** Extra words the filter matches. */
	readonly keywords?: string;
	/** Which group it is listed under. */
	readonly group?: string;
	run(): void;
}

const sources = new Map<string, readonly Command[]>();
let navigateTo: ((route: string) => void) | null = null;
let open: (() => void) | null = null;

/** Replaces the commands one source (a screen, the shell) contributes. */
export function registerCommands(source: string, commands: readonly Command[]): void {
	sources.set(source, commands);
}

export function clearCommands(source: string): void {
	sources.delete(source);
}

const SECTION_COMMANDS: ReadonlyArray<readonly [string, string, IconName]> = [
	['#/sessions', 'Sessions', 'sessions'],
	['#/view/default', 'Live View', 'live'],
	['#/resources', 'Resources', 'resources'],
	// D-152: the tools are leaves of the Resources tree; the command opens their filter.
	['#/resources/tools', 'Tools', 'tools'],
	['#/workspaces', 'Workspaces', 'workspace'],
	['#/agents', 'Agents', 'agents'],
	['#/users', 'Users', 'users'],
	['#/system', 'System', 'system'],
];

function builtIns(): Command[] {
	const go = (route: string) => () => navigateTo?.(route);
	return [
		...SECTION_COMMANDS.map(([route, label, glyph]) => ({
			id: `go:${route}`,
			label,
			icon: glyph,
			group: 'Go to',
			run: go(route),
		})),
		// D-152: one command per theme; the palette never cycles blind.
		...THEMES.map((theme) => ({
			id: `theme:${theme.id}`,
			label: `Theme: ${theme.label}`,
			icon: (theme.scheme === 'dark' ? 'moon' : 'sun') as IconName,
			hint: theme.hint,
			keywords: `theme mode appearance ${theme.id} ${theme.scheme}`,
			group: 'Appearance',
			run: () => setTheme(theme.id),
		})),
	];
}

/**
 * How well `query` matches `text`: every query character must appear in order.
 * Consecutive runs and a match at a word start score higher; -1 means no match.
 */
export function fuzzyScore(query: string, text: string): number {
	const q = query.toLowerCase().trim();
	const t = text.toLowerCase();
	if (q === '') return 0;
	let score = 0;
	let at = 0;
	let run = 0;
	for (const char of q) {
		if (char === ' ') continue;
		const found = t.indexOf(char, at);
		if (found < 0) return -1;
		run = found === at ? run + 1 : 0;
		score += 1 + run * 2 + (found === 0 || /[\s:_/.-]/.test(t[found - 1] ?? '') ? 3 : 0);
		at = found + 1;
	}
	return score;
}

function allCommands(): Command[] {
	return [...builtIns(), ...[...sources.values()].flat()];
}

/** Opens the palette (no-op before `installPalette`). */
export function openPalette(): void {
	open?.();
}

/** Wires the shortcut and remembers how to navigate; called once at start-up. */
export function installPalette(navigate: (route: string) => void): void {
	navigateTo = navigate;
	let dialog: (HTMLElement & { open: boolean }) | null = null;

	open = () => {
		if (dialog !== null) return;
		const input = el('input', {
			class: 'palette-input',
			type: 'search',
			placeholder: 'Search',
			'aria-label': 'Search sections, sessions, tools and actions',
			autocomplete: 'off',
			spellcheck: 'false',
		});
		const list = el('div', { class: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
		let shown: Command[] = [];
		let active = 0;

		const paint = (): void => {
			const query = input.value;
			shown = allCommands()
				.map((command) => ({
					command,
					score: fuzzyScore(query, `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`),
				}))
				.filter(({ score }) => score >= 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 40)
				.map(({ command }) => command);
			active = Math.min(active, Math.max(0, shown.length - 1));
			list.replaceChildren();
			let group = '';
			shown.forEach((command, i) => {
				if (query.trim() === '' && (command.group ?? '') !== group) {
					group = command.group ?? '';
					if (group !== '') list.append(el('div', { class: 'palette-group', role: 'presentation', text: group }));
				}
				const row = el('button', {
					class: i === active ? 'palette-item active' : 'palette-item',
					type: 'button',
					role: 'option',
					'aria-selected': String(i === active),
				}, [
					el('span', { class: 'palette-glyph' }, [icon(command.icon)]),
					el('span', { class: 'palette-label', text: command.label }),
					...(command.hint === undefined ? [] : [el('span', { class: 'palette-hint', text: command.hint })]),
				]);
				on(row, 'click', () => choose(command));
				on(row, 'pointermove', () => {
					if (active !== i) {
						active = i;
						paint();
					}
				});
				list.append(row);
			});
			if (shown.length === 0) {
				list.append(el('div', { class: 'palette-empty' }, [icon('search'), el('span', { text: 'No match' })]));
			}
			list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
		};

		const close = (): void => {
			if (dialog !== null) dialog.open = false;
		};
		const choose = (command: Command): void => {
			close();
			command.run();
		};

		on(input, 'input', () => {
			active = 0;
			paint();
		});
		on(input, 'keydown', (event) => {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				active = shown.length === 0 ? 0 : (active + 1) % shown.length;
				paint();
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				active = shown.length === 0 ? 0 : (active - 1 + shown.length) % shown.length;
				paint();
			} else if (event.key === 'Enter') {
				event.preventDefault();
				const command = shown[active];
				if (command !== undefined) choose(command);
			}
		});

		const node = el('wa-dialog', {
			class: 'palette',
			label: 'Command palette',
			'without-header': true,
			'light-dismiss': true,
		}, [
			el('div', { class: 'palette-search' }, [icon('search'), input, el('kbd', { text: 'Esc' })]),
			list,
		]);
		node.addEventListener('wa-after-hide', (event) => {
			if (event.target !== node) return;
			node.remove();
			dialog = null;
		});
		node.addEventListener('wa-after-show', () => input.focus());
		dialog = node;
		document.body.append(node);
		paint();
		requestAnimationFrame(() => (node.open = true));
	};

	document.addEventListener('keydown', (event) => {
		// A key something else already claimed — above all the live viewer, which forwards keystrokes to the
		// remote page and prevents their default — is not the palette's.
		if (event.defaultPrevented) return;
		const typing = event.target instanceof HTMLElement &&
			(event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) ||
				event.target.tagName.startsWith('WA-'));
		const combo = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
		if (combo || (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey)) {
			event.preventDefault();
			open?.();
		}
	});
}
