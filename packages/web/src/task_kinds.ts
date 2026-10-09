/**
 * What kind of task a card shows, and which tools the Run-tool composer never offers (run model-providers-ui, F4).
 *
 * Pure and dependency-free on purpose: the Agents screen, the composer and `screens_test`-style unit tests read it
 * without the kit, and `tests/unit/task_excluded_test.ts` compares {@linkcode TASK_EXCLUDED_TOOLS} with the gateway's
 * `NOT_TASKABLE` (`packages/gateway/src/taskable.ts`) so the two lists cannot drift apart. The gateway set is the
 * judge — a task naming one of these tools is refused at the runtime's `invoke` — and this copy only keeps the
 * composer from offering a certain refusal.
 */
import type { IconName } from './icon_names.ts';

/** The three things a task can be, as `task.metadata.kind` says (D-143, addendum A). */
export type TaskKind = 'text' | 'tool' | 'delegation';

/**
 * D-141 / D-121: every tool a structured task cannot run — the sampling tools (they need the MCP client's model),
 * `agent_run_tool` (a task that only queues a task), the three that hand something to the caller at the other end
 * of *this* call (an elicitation, an embed, a ticket), `browser_file_link` (a bearer link kept at rest), and the
 * confirmation set (a client able to confirm must not route a destructive tool around its human). A literal rather
 * than an import from the gateway: this file ships in the browser bundle and names nothing of the server's graph.
 */
export const TASK_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	'browser_run_task',
	'browser_extract_content',
	'agent_run_tool',
	'browser_request_human',
	'browser_live_view',
	'browser_live_ticket',
	'browser_file_link',
	'browser_close_all',
	'sandbox_delete',
	'file_delete',
	'skill_delete',
	'prompt_delete',
	'a2ui_delete',
	// D-154: the confirmation set's newest member.
	'memory_delete',
]);

/** The minimum of a task summary the kind is read from. */
export interface TaskKindSource {
	readonly metadata?: { readonly kind?: unknown; readonly backend?: unknown } | null;
	readonly history?: ReadonlyArray<
		{ readonly parts: ReadonlyArray<{ readonly text?: string; readonly data?: unknown }> }
	>;
	readonly artifacts?: ReadonlyArray<{ readonly name?: string }>;
}

function isKind(value: unknown): value is TaskKind {
	return value === 'text' || value === 'tool' || value === 'delegation';
}

/**
 * The task's kind: `metadata.kind` when the gateway wrote one (every task since D-143), otherwise read from what an
 * older task kept — a data part in its first message means a tool task, a `delegated-task` artifact a delegation,
 * anything else a text task. The fallback exists for tasks persisted before the seam; the SPA never parses history
 * for a task that carries metadata (C6).
 */
export function taskKindOf(task: TaskKindSource): TaskKind {
	const kind = task.metadata?.kind;
	if (isKind(kind)) return kind;
	if (task.artifacts?.some((artifact) => artifact.name === 'delegated-task')) return 'delegation';
	const first = task.history?.[0]?.parts ?? [];
	if (first.some((part) => part.data !== undefined)) return 'tool';
	return 'text';
}

/** How a kind looks on a card: its glyph and the word on the chip. */
export const KIND_LOOK: Readonly<Record<TaskKind, { readonly glyph: IconName; readonly label: string }>> = {
	text: { glyph: 'agents', label: 'text' },
	tool: { glyph: 'wrench', label: 'tool' },
	delegation: { glyph: 'delegate', label: 'delegation' },
};

/**
 * The words of a card's backend chip, or `null` for none: `provider · model` when the built-in agent runs the task,
 * `Coding agent` when an ACP bridge does. A task that carries neither (a tool task, an older task) shows no chip.
 */
export function backendChip(
	metadata:
		| { readonly backend?: unknown; readonly provider?: unknown; readonly model?: unknown; readonly agent?: unknown }
		| null
		| undefined,
): string | null {
	if (metadata === null || metadata === undefined) return null;
	if (typeof metadata.provider === 'string' && metadata.provider !== '') {
		const on = typeof metadata.model === 'string' && metadata.model !== ''
			? `${metadata.provider} · ${metadata.model}`
			: metadata.provider;
		// D-156: a built-in profile's task names the profile first, then what it ran on.
		return metadata.agent === 'sloplord' ? `SlopLord · ${on}` : on;
	}
	if (metadata.backend === 'acp') return 'Coding agent';
	return null;
}
