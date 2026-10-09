/**
 * The Prompts group of the Resources tree: the union of the prompts stored in the library (`prompt_list`, editable,
 * D-075) and the prompts the server serves (`prompts/list` — among them `skill:<name>` for each skill), one entry per
 * name, the stored one winning (`mergePrompts`). A prompt the server only serves carries the lock mark in the tree
 * and on its card, and opens read-only; a stored one opens its editor drawer (`resources_drawer.ts`). **New prompt**
 * is the group's one primary while it has prompts, and the empty state's one action while it has none (D-092).
 *
 * No refresh control: the listing is re-read when the group opens and after every write (D-092).
 */
import { el, on } from './dom.ts';
import { icon } from './icons.ts';
import { mcp, McpError, METHOD_NOT_FOUND } from './mcp.ts';
import type { Command } from './palette.ts';
import {
	closeDrawerFor,
	createPrompt,
	type EditorContext,
	fact,
	gate,
	glyphTip,
	openPrompt,
	openServedPrompt,
	type Prompt,
	type PromptArgument,
	READ_ONLY_REASON,
	type ServedPrompt,
	tool,
} from './resources_drawer.ts';
import { type Group, type GroupContext, setBranchCount, treeBranch, treeLeaf, viewerHead } from './resources_view.ts';
import { button, confirmButton, empty, iconButton, messageOf, relativeTime, tag, tip, toast } from './ui.ts';

const SERVED_ONLY = 'Served by the server: read-only';

/** One prompt as the group lists it: stored (editable) or only served (read-only). */
export interface PromptEntry {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly arguments: PromptArgument[];
	/** The stored prompt, when the library holds it. */
	readonly stored?: Prompt;
}

/** The union of stored and served prompts by name, stored first and winning a clash, then the served-only ones. */
export function mergePrompts(stored: readonly Prompt[], served: readonly ServedPrompt[]): PromptEntry[] {
	const byName = new Map<string, PromptEntry>();
	for (const prompt of stored) {
		byName.set(prompt.name, {
			name: prompt.name,
			title: prompt.title,
			description: prompt.description,
			arguments: prompt.arguments,
			stored: prompt,
		});
	}
	for (const prompt of served) {
		if (byName.has(prompt.name)) continue;
		byName.set(prompt.name, {
			name: prompt.name,
			title: prompt.title,
			description: prompt.description,
			arguments: prompt.arguments ?? [],
		});
	}
	return [...byName.values()];
}

export function promptsGroup(ctx: GroupContext): Group {
	const { writable } = ctx;
	const node = treeBranch(
		'group:prompts',
		'Prompts',
		'prompt',
		'Stored prompt templates and the prompts the server serves',
	);
	let entries: PromptEntry[] = [];
	let error: string | null = null;
	let listing: Promise<void> | null = null;
	let inView = false;

	const editor: EditorContext = {
		writable,
		changed: async () => {
			await load(true);
			if (inView) paint();
		},
	};

	function show(entry: PromptEntry): void {
		if (entry.stored === undefined) openServedPrompt(entry);
		else openPrompt(entry.stored, editor);
	}

	function command(entry: PromptEntry): Command {
		return {
			id: `prompts:${entry.name}`,
			label: entry.title ?? entry.name,
			hint: entry.name,
			icon: 'prompt',
			group: 'Prompts',
			keywords: entry.description,
			run: () => void open(entry.name),
		};
	}

	function load(again = false): Promise<void> {
		if (!again && listing !== null) return listing;
		listing = (async () => {
			const [stored, served] = await Promise.allSettled([
				tool<{ prompts: Prompt[] }>('prompt_list', {}),
				mcp.prompts() as Promise<ServedPrompt[]>,
			]);
			// A server without prompts answers method-not-found: that is "none", not a failure.
			const servedNone = served.status === 'rejected' && served.reason instanceof McpError &&
				served.reason.code === METHOD_NOT_FOUND;
			const servedList = served.status === 'fulfilled' ? served.value : [];
			const storedList = stored.status === 'fulfilled' ? stored.value.prompts : [];
			entries = mergePrompts(storedList, servedList);
			error = stored.status === 'rejected' && served.status === 'rejected' && !servedNone
				? messageOf(stored.reason)
				: null;
			if (!ctx.alive()) return;
			// The listing's own leaves only: the group's Tools branch (D-152) is the tree's.
			for (const child of Array.from(node.querySelectorAll(':scope > wa-tree-item:not(.rx-tools)'))) child.remove();
			node.append(...entries.map((entry) =>
				treeLeaf(
					`prompt:${entry.name}`,
					entry.title ?? entry.name,
					'prompt',
					entry.description ?? entry.name,
					entry.stored === undefined ? { locked: SERVED_ONLY } : {},
				)
			));
			node.loading = false;
			setBranchCount(node, error === null ? String(entries.length) : null);
			ctx.commands('prompts', entries.map(command));
		})();
		return listing;
	}

	/** The "new prompt" button: the group's one primary, worded; disabled with the reason when read-only. */
	function newPrompt(): HTMLElement {
		const control = button({ label: 'New prompt', icon: 'plus', variant: 'primary' });
		on(control, 'click', () => createPrompt(editor));
		return writable ? control : gate(control, READ_ONLY_REASON);
	}

	function card(entry: PromptEntry, index: number): HTMLElement {
		const openBtn = el('button', { type: 'button', class: 'lib-card-open' }, [
			el('span', { class: 'lib-card-glyph prompt', 'aria-hidden': 'true' }, [icon('prompt')]),
			el('span', { class: 'lib-card-text' }, [
				el('span', { class: 'lib-card-title', text: entry.title ?? entry.name }),
				el('span', { class: 'lib-card-name mono', text: entry.name }),
				...(entry.description === undefined || entry.description === ''
					? []
					: [el('span', { class: 'lib-card-desc', text: entry.description })]),
			]),
		]);
		on(openBtn, 'click', () => show(entry));
		const count = entry.arguments.length;
		const facts = el('div', { class: 'lib-card-facts' }, [
			fact('braces', String(count), `${count} argument${count === 1 ? '' : 's'}`),
			...(entry.stored === undefined ? [] : [
				fact(
					'clock',
					relativeTime(entry.stored.updated_at),
					`Updated ${new Date(entry.stored.updated_at).toLocaleString()}`,
				),
			]),
		]);
		const actions: Node[] = [];
		if (entry.stored === undefined) {
			actions.push(glyphTip('lock', SERVED_ONLY, 'lib-ro'));
		} else {
			const stored = entry.stored;
			const edit = iconButton(
				writable ? 'pen' : 'eye',
				writable ? `Edit ${entry.name}` : `View ${entry.name}`,
				() => openPrompt(stored, editor),
				{ small: true },
			);
			const remove = confirmButton(
				{ label: `Delete ${entry.name}`, icon: 'trash', small: true, iconOnly: true },
				async () => {
					await tool('prompt_delete', { name: entry.name });
					toast(`${entry.name} deleted`, 'ok');
					closeDrawerFor(`prompt:${entry.name}`);
					await editor.changed();
				},
			);
			remove.disabled = !writable;
			actions.push(edit, remove);
		}
		const cardNode = el('article', { class: 'lib-card' }, [
			openBtn,
			facts,
			el('div', { class: 'lib-card-actions' }, actions),
		]);
		cardNode.style.setProperty('--i', String(Math.min(index, 20)));
		return cardNode;
	}

	/** The group in the viewer: its name and count, the one primary, and the cards (or a teaching empty state). */
	function paint(selected?: string): void {
		inView = true;
		const body = error !== null ? [empty('lock', 'Prompts unavailable', error)] : entries.length === 0
			? [
				empty(
					'prompt',
					'No prompts yet',
					'Prompts are templates with {{arguments}}, served as MCP prompts.',
					newPrompt(),
				),
			]
			: entries.map(card);
		ctx.show(selected === undefined ? 'group:prompts' : `prompt:${selected}`, [
			viewerHead({
				glyph: 'prompt',
				kind: 'Prompts',
				title: 'Prompts',
				mono: false,
				tags: [tip(tag(String(entries.length)), 'Prompts')],
				actions: entries.length > 0 && error === null ? [newPrompt()] : [],
			}),
			el('div', { class: 'rx-body' }, [el('div', { class: 'lib-cards' }, body)]),
		]);
	}

	/** Shows the group; with a name, that prompt's drawer over it. */
	async function open(name?: string): Promise<void> {
		if (listing === null) {
			ctx.loading(name === undefined ? 'group:prompts' : `prompt:${name}`);
			void load();
		}
		// The mount may have started the listing already: painting before it answers would show "No prompts yet"
		// over a tree that is about to fill (BUG-3).
		await listing;
		if (!ctx.alive()) return;
		const entry = name === undefined ? undefined : entries.find((candidate) => candidate.name === name);
		paint(entry?.name);
		if (entry !== undefined) show(entry);
		else if (name !== undefined) toast(`No prompt named ${name}`, 'info');
	}

	return { node, load, open };
}
