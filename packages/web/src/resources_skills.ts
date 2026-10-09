/**
 * The Skills group of the Resources tree: one leaf per skill (`skill_list`, D-075), folded with the `ttk://skill/`
 * root that `resources/list` also advertises so a skill is listed once. The group shows its skills as cards in the
 * viewer; a leaf or a card opens the skill's editor drawer (`resources_drawer.ts`). **New skill** is the group's one
 * primary while it has skills, and the empty state's one action while it has none (D-092); without `files:write` it
 * is disabled with the reason as its tooltip.
 *
 * No refresh control: the listing is re-read when the group opens and after every write (D-092).
 */
import { el, on } from './dom.ts';
import { icon } from './icons.ts';
import type { Command } from './palette.ts';
import {
	closeDrawerFor,
	createSkill,
	type EditorContext,
	fact,
	gate,
	openSkill,
	READ_ONLY_REASON,
	type SkillSummary,
	tool,
} from './resources_drawer.ts';
import { type Group, type GroupContext, setBranchCount, treeBranch, treeLeaf, viewerHead } from './resources_view.ts';
import { button, confirmButton, empty, iconButton, messageOf, relativeTime, tag, tip, toast } from './ui.ts';

export function skillsGroup(ctx: GroupContext): Group {
	const { writable } = ctx;
	const node = treeBranch('group:skills', 'Skills', 'skills', 'Skills · ttk://skill');
	let skills: SkillSummary[] = [];
	let error: string | null = null;
	let listing: Promise<void> | null = null;
	/** Whether the group is what the viewer shows, so a write repaints it. */
	let inView = false;

	const editor: EditorContext = {
		writable,
		changed: async () => {
			await load(true);
			if (inView) paint();
		},
	};

	function command(skill: SkillSummary): Command {
		return {
			id: `skills:${skill.name}`,
			label: skill.name,
			hint: 'skill',
			icon: 'skills',
			group: 'Skills',
			keywords: skill.description,
			run: () => void open(skill.name),
		};
	}

	function load(again = false): Promise<void> {
		if (!again && listing !== null) return listing;
		listing = (async () => {
			try {
				({ skills } = await tool<{ skills: SkillSummary[] }>('skill_list', {}));
				error = null;
			} catch (cause) {
				skills = [];
				error = messageOf(cause);
			}
			if (!ctx.alive()) return;
			// The listing's own leaves only: the group's Tools branch (D-152) is the tree's.
			for (const child of Array.from(node.querySelectorAll(':scope > wa-tree-item:not(.rx-tools)'))) child.remove();
			node.append(...skills.map((skill) => treeLeaf(`skill:${skill.name}`, skill.name, 'skills', skill.description)));
			node.loading = false;
			setBranchCount(node, error === null ? String(skills.length) : null);
			ctx.commands('skills', skills.map(command));
		})();
		return listing;
	}

	/** The "new skill" button: the group's one primary, worded; disabled with the reason when read-only. */
	function newSkill(): HTMLElement {
		const control = button({ label: 'New skill', icon: 'plus', variant: 'primary' });
		on(control, 'click', () => createSkill(editor));
		return writable ? control : gate(control, READ_ONLY_REASON);
	}

	function card(skill: SkillSummary, index: number): HTMLElement {
		const openBtn = el('button', { type: 'button', class: 'lib-card-open' }, [
			el('span', { class: 'lib-card-glyph', 'aria-hidden': 'true' }, [icon('skills')]),
			el('span', { class: 'lib-card-text' }, [
				el('span', { class: 'lib-card-title', text: skill.name }),
				el('span', { class: 'lib-card-desc', text: skill.description }),
			]),
		]);
		on(openBtn, 'click', () => void open(skill.name));
		const count = skill.files.length;
		const facts = el('div', { class: 'lib-card-facts' }, [
			fact('file', String(count), `${count} file${count === 1 ? '' : 's'}`),
			...(skill.updated_at === null
				? []
				: [fact('clock', relativeTime(skill.updated_at), `Updated ${new Date(skill.updated_at).toLocaleString()}`)]),
		]);
		const edit = iconButton(
			writable ? 'pen' : 'eye',
			writable ? `Edit ${skill.name}` : `View ${skill.name}`,
			() => void open(skill.name),
			{ small: true },
		);
		const remove = confirmButton(
			{ label: `Delete ${skill.name}`, icon: 'trash', small: true, iconOnly: true },
			async () => {
				await tool('skill_delete', { name: skill.name });
				toast(`${skill.name} deleted`, 'ok');
				closeDrawerFor(`skill:${skill.name}`);
				await editor.changed();
			},
		);
		remove.disabled = !writable;
		const cardNode = el('article', { class: 'lib-card' }, [
			openBtn,
			facts,
			el('div', { class: 'lib-card-actions' }, [edit, remove]),
		]);
		cardNode.style.setProperty('--i', String(Math.min(index, 20)));
		return cardNode;
	}

	/** The group in the viewer: its name and count, the one primary, and the cards (or a teaching empty state). */
	function paint(selected?: string): void {
		inView = true;
		const body = error !== null
			? [empty('lock', 'Skills unavailable', error)]
			: skills.length === 0
			? [empty('skills', 'No skills yet', 'A skill is a folder with a SKILL.md.', newSkill())]
			: skills.map(card);
		ctx.show(selected === undefined ? 'group:skills' : `skill:${selected}`, [
			viewerHead({
				glyph: 'skills',
				kind: 'Skills',
				title: 'Skills',
				mono: false,
				tags: [tip(tag(String(skills.length)), 'Skills')],
				actions: skills.length > 0 && error === null ? [newSkill()] : [],
			}),
			el('div', { class: 'rx-body' }, [el('div', { class: 'lib-cards' }, body)]),
		]);
	}

	/** Shows the group; with a name, the skill's editor drawer over it. */
	async function open(name?: string): Promise<void> {
		if (listing === null) {
			ctx.loading(name === undefined ? 'group:skills' : `skill:${name}`);
			void load();
		}
		// The mount may have started the listing already: painting before it answers would show "No skills yet" over
		// a tree that is about to fill (BUG-3).
		await listing;
		if (!ctx.alive()) return;
		paint(name);
		if (name !== undefined) await openSkill(name, editor);
	}

	return { node, load, open };
}
