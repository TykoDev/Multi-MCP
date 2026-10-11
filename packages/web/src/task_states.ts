/**
 * How an agent task's state looks, shared by the chat (`agent_view.ts`) and the Tasks view (`tasks_view.ts`): a glyph
 * (or the kit's spinner while it works), a tone class the stylesheet colours, and the words, which are the tooltip and
 * accessible name — never shown in place of the glyph (D-092).
 */
import { el } from './dom.ts';
import { icon, type IconName } from './icons.ts';

/** The states after which a task never changes again. */
export const TERMINAL: readonly string[] = [
	'TASK_STATE_COMPLETED',
	'TASK_STATE_FAILED',
	'TASK_STATE_CANCELED',
	'TASK_STATE_REJECTED',
];

/** How a task state looks: a glyph (null: the kit's spinner), a tone class, and the words for its tooltip. */
export interface StateLook {
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

/** A state in words, for one the table does not know: `TASK_STATE_SOME_THING` → `some thing`. */
export function stateLabel(state: string): string {
	return state.replace('TASK_STATE_', '').toLowerCase().replaceAll('_', ' ');
}

export function lookOf(state: string): StateLook {
	return STATES[state] ?? { glyph: 'circle-dashed', tone: 'pending', label: stateLabel(state) };
}

/** A task's state as a small glyph; its words are the tooltip and accessible name. */
export function stateGlyph(state: string): HTMLElement {
	const look = lookOf(state);
	return el('span', { class: `ag-state ${look.tone}`, role: 'img', 'aria-label': look.label, 'data-tip': look.label }, [
		look.glyph === null ? el('wa-spinner', { 'aria-hidden': 'true' }) : icon(look.glyph),
	]);
}
