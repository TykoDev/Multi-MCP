/**
 * The Agents section's views as page tabs, like the Sessions section's (D-147): the **Chat**, where one task is the
 * conversation, and **Tasks**, the list of every task with its run history. Each keeps its route —
 * `#/agents[/chat/<task>]` and `#/agents/tasks[/<task>][?workspace=<id>]` — so a link, Back and a reload land where
 * they say.
 *
 * The tabs remember where each view last was: Chat returns to the task last open in it, Tasks to the task last
 * inspected. Module state only: a task id is not a credential, and one that no longer exists is answered by its screen.
 */
import type { PageTab, ShellOptions } from './shell.ts';

export type AgentTab = 'chat' | 'tasks';

let chatTask: string | null = null;
let inspected: string | null = null;

/** The chat route of one task, or of a new task with `null`. */
export function chatRoute(taskId: string | null): string {
	return taskId === null ? '#/agents' : `#/agents/chat/${encodeURIComponent(taskId)}`;
}

/**
 * The Tasks route, of one task's run history or of the list with `null`; with `workspace`, the list narrowed to the
 * tasks that touched that coding workspace (`?workspace=<id>`).
 */
export function tasksRoute(taskId: string | null, workspace?: string | null): string {
	const base = taskId === null ? '#/agents/tasks' : `#/agents/tasks/${encodeURIComponent(taskId)}`;
	return workspace === undefined || workspace === null ? base : `${base}?workspace=${encodeURIComponent(workspace)}`;
}

/** The task the chat shows now, or `null` for a new one. */
export function rememberChatTask(taskId: string | null): void {
	chatTask = taskId;
}

/** The task whose run history the Tasks view shows now, or `null`. */
export function rememberInspectedTask(taskId: string | null): void {
	inspected = taskId;
}

/**
 * Which Agents view a route names, and its task: `#/agents` (a new task), `#/agents/chat/<id>`, `#/agents/tasks`
 * and `#/agents/tasks/<id>`; `null` for anything else. The id is decoded; a malformed escape is no route.
 */
export function agentRoute(
	hash: string,
): { tab: AgentTab; taskId: string | null; workspace: string | null } | null {
	const match = /^#\/agents(?:\/(chat|tasks)(?:\/([^/?]+))?)?\/?(?:\?(.*))?$/.exec(hash);
	if (match === null) return null;
	const tab: AgentTab = match[1] === 'tasks' ? 'tasks' : 'chat';
	// Only the Tasks view filters, and only by a well-formed workspace id; anything else in the query is ignored.
	const asked = tab === 'tasks' ? new URLSearchParams(match[3] ?? '').get('workspace') : null;
	const workspace = asked !== null && /^[0-9a-f-]{36}$/i.test(asked) ? asked : null;
	if (match[1] === 'chat' && match[2] === undefined) return { tab, taskId: null, workspace };
	try {
		return { tab, taskId: match[2] === undefined ? null : decodeURIComponent(match[2]), workspace };
	} catch {
		return null;
	}
}

/** The tab strip for one of the two views. */
export function agentTabs(active: AgentTab): NonNullable<ShellOptions['tabs']> {
	const items: PageTab[] = [
		{ id: 'chat', label: 'Chat', glyph: 'message', route: chatRoute(chatTask) },
		{ id: 'tasks', label: 'Tasks', glyph: 'list-checks', route: tasksRoute(inspected) },
	];
	return { label: 'Agents views', items, active };
}
