/**
 * The Agents chat (D-147): how a task reads as one turn of a conversation — what was asked, what the agent answered,
 * what else it produced — and the safe rich-text renderer the answers are drawn with.
 *
 * A task is one turn. The request is the first message of its history; the answer is the agent's own messages in that
 * history (E-5: a text task's reply joins it), else its `agent-response` artifact, which carries the same text; any
 * other artifact (a tool's `result`, a `delegated-task`) is shown as data under the answer. The status message is a
 * progress or failure line, never the answer: a completed task writes none.
 *
 * Everything here is pure or builds DOM with `createElement` and `textContent` — the answer is model output, so no
 * string of it ever becomes markup. The renderer understands the Markdown a model writes most (fenced code, headings,
 * lists, quotes, inline code, bold, italic, links) and draws nothing else: an unknown construct stays text.
 */
import type { AgentTaskSummary } from './api.ts';
import { el } from './dom.ts';
import { taskKindOf } from './task_kinds.ts';

/** One message part as a task carries it. */
type Part = { readonly text?: string; readonly data?: unknown };

/** What a turn asked: words, a tool call, or other structured data. */
export type Request =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly tool: string; readonly args: unknown }
	| { readonly kind: 'data'; readonly data: unknown };

/** A task as the chat reads it: the shared summary plus the creation time the list carries (newer gateways). */
export type ChatTask = AgentTaskSummary & { readonly created_at?: string };

function textOf(parts: readonly Part[] | undefined): string {
	return (parts ?? []).map((part) => part.text ?? '').filter((text) => text !== '').join('\n');
}

/** The `{tool, arguments}` data part a structured task is sent as, or `null`. */
function toolCallOf(data: unknown): { tool: string; args: unknown } | null {
	if (data === null || typeof data !== 'object') return null;
	const record = data as Record<string, unknown>;
	return typeof record.tool === 'string' ? { tool: record.tool, args: record.arguments ?? {} } : null;
}

/** The turn's request: the first message's words, or its tool call, or its data. */
export function requestOf(task: ChatTask): Request {
	const first = task.history?.[0]?.parts ?? [];
	const text = textOf(first);
	const data = first.find((part) => part.data !== undefined)?.data;
	const call = toolCallOf(data);
	if (call !== null) return { kind: 'tool', tool: call.tool, args: call.args };
	if (text !== '') return { kind: 'text', text };
	if (data !== undefined) return { kind: 'data', data };
	return { kind: 'text', text: '' };
}

/**
 * The agent's answer as text: its messages in the history, joined; else the `agent-response` artifact's text; else
 * `''` (still working, or a task whose result is data).
 */
export function answerOf(task: ChatTask): string {
	const spoken = (task.history ?? []).slice(1)
		.filter((message) => message.role === 'ROLE_AGENT')
		.map((message) => textOf(message.parts))
		.filter((text) => text !== '');
	if (spoken.length > 0) return spoken.join('\n\n');
	return textOf(task.artifacts.find((artifact) => artifact.name === 'agent-response')?.parts);
}

/** The artifacts the answer does not already say: a tool's result, a delegation's record, anything else named. */
export function extraArtifacts(task: ChatTask): AgentTaskSummary['artifacts'] {
	return task.artifacts.filter((artifact) => artifact.name !== 'agent-response');
}

/** The status line: the words of the status message, when it has any (a failure's reason, a progress note). */
export function statusLineOf(task: ChatTask): string {
	return textOf(task.status.message?.parts);
}

/** A short title for the turn, for the Tasks strip: the request's first line, the tool, or the kind. */
export function titleOf(task: ChatTask, max = 48): string {
	const request = requestOf(task);
	const raw = request.kind === 'tool'
		? request.tool
		: request.kind === 'text' && request.text !== ''
		? request.text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
		: taskKindOf(task) === 'delegation'
		? 'Delegation'
		: 'Task';
	return raw.length > max ? `${raw.slice(0, max - 1).trimEnd()}…` : raw;
}

/** The moment a turn began: its creation time when the gateway sends one, else its last update. */
function startOf(task: ChatTask): string {
	return task.created_at ?? task.status.timestamp;
}

/** The turns oldest first, as a conversation reads; ties by id, so the order is stable across polls. */
export function orderTurns<T extends ChatTask>(tasks: readonly T[]): T[] {
	return tasks.slice().sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.id.localeCompare(b.id));
}

// --- rich text ------------------------------------------------------------------------------------------------------

/** Only these schemes become links; anything else stays the words it was written as. */
const LINKABLE = /^https?:\/\//i;

/**
 * Inline Markdown into nodes: `code`, **bold**, *italic* / _italic_, and [text](http…) links. One pass, left to
 * right; a marker without its partner is text. Links open in a new tab without the opener or a referrer.
 */
export function inlineNodes(text: string): Node[] {
	const nodes: Node[] = [];
	const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > at) nodes.push(document.createTextNode(text.slice(at, index)));
		const [whole, code, bold, bold2, italic, italic2, label, href] = match;
		if (code !== undefined) nodes.push(el('code', { class: 'ag-md-code', text: code }));
		else if (bold !== undefined || bold2 !== undefined) nodes.push(el('strong', { text: bold ?? bold2 }));
		else if (italic !== undefined || italic2 !== undefined) nodes.push(el('em', { text: italic ?? italic2 }));
		else if (label !== undefined && href !== undefined && LINKABLE.test(href)) {
			nodes.push(el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }));
		} else nodes.push(document.createTextNode(whole));
		at = index + whole.length;
	}
	if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
	return nodes;
}

/** A paragraph's lines, joined by line breaks (a model's single newlines are meant). */
function paragraph(lines: readonly string[]): HTMLElement {
	const node = el('p');
	lines.forEach((line, index) => {
		if (index > 0) node.append(el('br'));
		node.append(...inlineNodes(line));
	});
	return node;
}

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Block Markdown into a `div.ag-md`: fenced code (with its language as a label), headings (drawn as one size, bold),
 * bullet and numbered lists, block quotes, rules and paragraphs. Bounded: past `max` characters the rest is cut and
 * says so, so a runaway answer cannot build an unbounded tree on every poll.
 */
export function richText(source: string, max = 200_000): HTMLElement {
	const root = el('div', { class: 'ag-md' });
	const text = source.length > max ? `${source.slice(0, max)}\n\n… (truncated)` : source;
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? '';
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence[1]!)) {
				body.push(lines[index] ?? '');
				index += 1;
			}
			index += 1;
			const language = fence[2] ?? '';
			root.append(el('figure', { class: 'ag-md-block' }, [
				...(language === '' ? [] : [el('figcaption', { class: 'ag-md-lang', text: language })]),
				el('pre', { class: 'code' }, [el('code', { text: body.join('\n') })]),
			]));
			continue;
		}
		if (line.trim() === '') {
			index += 1;
			continue;
		}
		if (RULE.test(line)) {
			root.append(el('hr'));
			index += 1;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			root.append(el('p', { class: `ag-md-h h${heading[1]!.length}` }, inlineNodes(heading[2] ?? '')));
			index += 1;
			continue;
		}
		if (BULLET.test(line) || NUMBERED.test(line)) {
			const numbered = !BULLET.test(line);
			const list = el(numbered ? 'ol' : 'ul');
			const item = numbered ? NUMBERED : BULLET;
			while (index < lines.length && item.test(lines[index] ?? '')) {
				list.append(el('li', {}, inlineNodes(item.exec(lines[index] ?? '')?.[1] ?? '')));
				index += 1;
			}
			root.append(list);
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
				quoted.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '');
				index += 1;
			}
			root.append(el('blockquote', {}, [paragraph(quoted)]));
			continue;
		}
		const block: string[] = [];
		while (index < lines.length) {
			const next = lines[index] ?? '';
			if (
				next.trim() === '' || FENCE.test(next) || HEADING.test(next) || BULLET.test(next) || NUMBERED.test(next) ||
				QUOTE.test(next) || RULE.test(next)
			) break;
			block.push(next);
			index += 1;
		}
		root.append(paragraph(block));
	}
	return root;
}
