/**
 * Tools as leaves of the Resources tree (D-152): what the Tools console was, moved into the one tree. Every tool this
 * credential is served sits under the server it belongs to — the browser's under Browser, `file_*` under Files,
 * `agent_*` under Agents — so a resource and the tools that act on it are one fold apart, and nothing is listed twice.
 *
 * The list is `tools/list`, not a copy of the catalog: a tool added to the server appears without a UI change, and a
 * tool the credential cannot use is absent for the same reason it is absent for an agent. The form is generated from
 * each tool's JSON Schema; anything the generator does not model falls back to a JSON editor rather than being
 * dropped, so no argument is ever unreachable. The result renders as images, structured data, text and resource links,
 * with the raw JSON one tab away; the last calls are kept for this page only.
 */
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { onSignOut } from './lifecycle.ts';
import { type CallToolResult, errorCodeOf, errorMessageOf, mcp, type McpTool } from './mcp.ts';
import { schemaForm } from './schema_form.ts';
import { familyOf } from './tool_families.ts';
import {
	busy,
	button,
	copyButton,
	dot,
	empty,
	iconButton,
	imageOf,
	jsonView,
	messageOf,
	openModal,
	relabel,
	tag,
	textView,
	tip,
	toast,
} from './ui.ts';

/** The tree group a tool's leaf hangs under, by its name prefix; the browser's own file tools are the browser's. */
export type ToolDomain = 'server' | 'browser' | 'files' | 'skills' | 'prompts' | 'sandbox' | 'agents' | 'surfaces';

export function domainOf(name: string): ToolDomain {
	if (name.startsWith('browser_')) return 'browser';
	if (name.startsWith('file_')) return 'files';
	if (name.startsWith('skill_')) return 'skills';
	if (name.startsWith('prompt_')) return 'prompts';
	if (name.startsWith('sandbox_')) return 'sandbox';
	// D-154: the agents' memory sits with the agents.
	if (name.startsWith('agent_') || name.startsWith('memory_')) return 'agents';
	if (name.startsWith('a2ui_')) return 'surfaces';
	return 'server';
}

/** The name people read: the tool's own title, or its id without the server prefix, in sentence case. */
export function humanName(tool: Pick<McpTool, 'name' | 'title'>): string {
	if (tool.title !== undefined && tool.title !== '') return tool.title;
	const bare = tool.name.replace(/^(browser|file|skill|prompt|sandbox|agent|a2ui|memory)_/, '').replace(/_/g, ' ');
	return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** The first sentence of a description, short enough for a tooltip. */
export function gist(text: string): string {
	const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

const MAC = /Mac|iP(hone|ad)/.test(globalThis.navigator?.platform ?? '');

// --- annotations -------------------------------------------------------------

interface Hint {
	readonly glyph: IconName;
	readonly tone: 'ok' | 'warn' | 'danger' | 'info';
	readonly label: string;
}

/** A tool's MCP annotations as glyphs; the words are each glyph's tooltip and accessible name. */
export function hintsOf(tool: McpTool): Hint[] {
	const hints = tool.annotations ?? {};
	return [
		hints.readOnlyHint
			? { glyph: 'eye', tone: 'ok', label: 'Read-only — observes, changes nothing' }
			: { glyph: 'pen', tone: 'warn', label: 'Mutating — may change state' },
		...(hints.destructiveHint
			? [{ glyph: 'alert', tone: 'danger', label: 'Destructive — may delete or overwrite' } as const]
			: []),
		...(hints.idempotentHint ? [{ glyph: 'repeat', tone: 'info', label: 'Idempotent — safe to repeat' } as const] : []),
		...(hints.openWorldHint
			? [{ glyph: 'globe', tone: 'info', label: 'Open world — reaches beyond this server' } as const]
			: []),
	];
}

/** The tree mark beside a tool's name: destructive red, read-only green, otherwise none. */
export function toolMark(tool: McpTool): HTMLElement | null {
	const hints = tool.annotations ?? {};
	if (hints.destructiveHint) return dot('danger', 'Destructive');
	if (hints.readOnlyHint) return dot('live', 'Read-only');
	return null;
}

function flagOf(glyph: IconName, label: string, tone = ''): HTMLElement {
	return el('span', { class: `tc-flag ${tone}`, role: 'img', 'aria-label': label, 'data-tip': label }, [icon(glyph)]);
}

// --- result -----------------------------------------------------------------

/** A failure: the stable error code (when there is one) over the message, in a danger callout. */
function failure(message: string, code: string | null = null): HTMLElement {
	const glyph = icon('alert');
	glyph.setAttribute('slot', 'icon');
	return el('wa-callout', { class: 'tc-failure', variant: 'danger' }, [
		glyph,
		el('div', { class: 'tc-failure-text' }, [
			...(code === null ? [] : [el('code', { class: 'mono strong', text: code })]),
			el('div', { text: message }),
		]),
	]);
}

/** An image block: framed on a checkerboard, enlarged in a dialog on click. */
function media(data: string, mimeType?: string): HTMLElement {
	const frame = el('button', { type: 'button', class: 'tc-media', 'aria-label': 'Enlarge image' }, [
		imageOf(data, mimeType),
	]);
	on(frame, 'click', () => openModal('Image', [imageOf(data, mimeType)], true));
	return frame;
}

function resourceLink(uri: string, navigate: (route: string) => void): HTMLElement {
	return el('div', { class: 'tc-link' }, [
		el('span', { class: 'tc-link-glyph' }, [icon('resources')]),
		el('code', { class: 'mono grow', text: uri }),
		copyButton(() => uri, 'Copy URI'),
		iconButton('arrow-up-right', 'Open resource', () => navigate(`#/resources/${encodeURIComponent(uri)}`), {
			small: true,
		}),
	]);
}

function resultTab(panel: string, glyph: IconName, label: string): HTMLElement {
	return el('wa-tab', { panel, 'aria-label': label, 'data-tip': label, 'data-tip-placement': 'top' }, [icon(glyph)]);
}

/** JSON with object keys sorted, so two encodings of the same value compare equal whatever their key order. */
function canonical(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, item: unknown) =>
			item !== null && typeof item === 'object' && !Array.isArray(item)
				? Object.fromEntries(
					Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
				)
				: item,
	);
}

/** Renders a `tools/call` result: images, structured data, text, resources — and the raw JSON in a second tab. */
export function renderResult(result: CallToolResult, ms: number, navigate: (route: string) => void): HTMLElement {
	const code = errorCodeOf(result);
	const parts: Node[] = [];
	if (code !== null) parts.push(failure(errorMessageOf(result), code));
	const structured = code === null ? result.structuredContent : undefined;
	const structuredText = structured === undefined ? null : canonical(structured);
	for (const block of result.content ?? []) {
		if (block.type === 'image' && block.data !== undefined) parts.push(media(block.data, block.mimeType));
		else if (block.type === 'text' && block.text !== undefined && code === null) {
			let same = false;
			try {
				same = structuredText !== null && canonical(JSON.parse(block.text)) === structuredText;
			} catch {
				// Not JSON: shown as text.
			}
			if (!same) parts.push(textView(block.text));
		} else if ((block.type === 'resource' || block.type === 'resource_link')) {
			parts.push(resourceLink(block.resource?.uri ?? block.uri ?? '', navigate));
			if (block.resource?.text !== undefined) parts.push(textView(block.resource.text));
		}
	}
	if (structured !== undefined) parts.push(jsonView(structured));
	if (parts.length === 0) {
		parts.push(el('div', { class: 'tc-none' }, [icon('circle-dashed'), el('span', { text: 'No content' })]));
	}

	const ok = code === null;
	const statusText = ok ? 'Succeeded' : `Failed · ${code}`;
	// The raw view is built on first show: a screenshot's base64 is large and most results are never viewed raw.
	const raw = el('wa-tab-panel', { name: 'raw' });
	const tabs = el('wa-tab-group', { class: 'tc-tabs', active: 'view' }, [
		resultTab('view', 'eye', 'Rendered'),
		resultTab('raw', 'braces', 'Raw JSON'),
		el('wa-tab-panel', { name: 'view' }, [el('div', { class: 'tc-parts' }, parts)]),
		raw,
	]);
	tabs.addEventListener('wa-tab-show', (event) => {
		const name = (event as Event & { detail?: { name?: string } }).detail?.name;
		if (name === 'raw' && raw.childElementCount === 0) raw.append(jsonView(result));
	});

	return el('section', { class: `tc-card tc-result ${ok ? 'ok' : 'error'}` }, [
		el('header', { class: 'tc-result-head' }, [
			el('span', {
				class: `tc-status ${ok ? 'ok' : 'error'}`,
				role: 'img',
				'aria-label': statusText,
				'data-tip': statusText,
			}, [
				icon(ok ? 'circle-check' : 'circle-x'),
			]),
			el('span', { class: 'tc-status-text', text: ok ? 'Result' : 'Failed' }),
			tip(tag(`${ms} ms`, 'timer'), 'Round trip'),
			el('span', { class: 'grow' }),
			copyButton(() => JSON.stringify(result, null, 2), 'Copy raw result'),
		]),
		tabs,
	]);
}

// --- the console --------------------------------------------------------------

interface HistoryEntry {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly result: CallToolResult;
	readonly ms: number;
	readonly at: Date;
}

/**
 * Call history survives route changes within the page's lifetime, never a reload,
 * and never a change of credential: arguments and results belong to whoever ran them (G-5).
 */
const calls: HistoryEntry[] = [];
onSignOut(() => {
	calls.length = 0;
});

/** Sampling tools cannot complete from the console; the short form is shown, the reason is its tooltip. */
function samplingNote(): HTMLElement {
	const glyph = icon('sparkles');
	glyph.setAttribute('slot', 'icon');
	const reason = 'This tool asks the calling client’s model through MCP sampling. The web console has no model, so ' +
		'the server will report that sampling is unavailable; run it from an MCP host instead.';
	return tip(
		el('wa-callout', { class: 'tc-note', variant: 'warning' }, [
			glyph,
			el('span', { text: 'Needs MCP sampling — run it from an MCP host' }),
			el('span', { class: 'sr-only', text: reason }),
		]),
		reason,
		'top',
	);
}

/**
 * The viewer for one tool: the request card — its glyph, title, name and annotations, the description, the argument
 * form (or JSON), the Run bar — beside the result column with this tool's recent calls. `where` names the tree group,
 * shown in the tile's tooltip. Re-rendering with a history entry restores that call's arguments and result.
 */
export function toolConsole(
	tool: McpTool,
	navigate: (route: string) => void,
	where: string,
	preset?: HistoryEntry,
): HTMLElement {
	const detail = el('div', { class: 'tc-detail' });
	const [familyName, glyph] = familyOf(tool.name);
	const form = schemaForm(tool.inputSchema, 'arg-');
	if (Object.keys(tool.inputSchema.properties ?? {}).length === 0) {
		form.node.append(
			el('div', { class: 'tc-noargs' }, [icon('circle-dashed'), el('span', { text: 'No arguments' })]),
		);
	}
	const jsonArea = el('wa-textarea', {
		class: 'tc-code tc-json tc-kit',
		rows: 10,
		resize: 'vertical',
		label: 'Arguments as JSON',
		'aria-label': 'Arguments as JSON',
		hidden: true,
	});
	const output = el('div', { class: 'tc-output' });
	let jsonMode = false;

	const run = button({ label: 'Run', icon: 'play', variant: 'primary', type: 'submit' });
	run.setAttribute('aria-keyshortcuts', MAC ? 'Meta+Enter' : 'Control+Enter');
	const shortcut = tip(
		el('kbd', { class: 'tc-kbd', text: MAC ? '⌘ ↵' : 'Ctrl ↵' }),
		`Run with ${MAC ? '⌘' : 'Ctrl'} + Enter`,
	);
	const toggle = iconButton('braces', 'JSON mode', undefined, { small: true });
	toggle.setAttribute('aria-pressed', 'false');
	const reset = iconButton('undo', 'Reset form', undefined, { small: true });

	function setJsonMode(next: boolean, args?: Record<string, unknown>): void {
		if (next) {
			try {
				jsonArea.value = JSON.stringify(args ?? form.read(), null, 2);
			} catch {
				jsonArea.value = '{}';
			}
		}
		jsonMode = next;
		jsonArea.hidden = !next;
		form.node.hidden = next;
		toggle.classList.toggle('on', next);
		toggle.setAttribute('aria-pressed', String(next));
	}
	on(toggle, 'click', () => setJsonMode(!jsonMode));
	on(reset, 'click', () => detail.replaceWith(toolConsole(tool, navigate, where)));

	const formNode = el('form', { class: 'tc-card tc-form tc-request', 'aria-label': humanName(tool) });
	// Until the first run the result column says where the result will appear.
	const waiting = el('div', { class: 'tc-waiting' }, [
		el('span', { class: 'tc-waiting-glyph', 'aria-hidden': 'true' }, [icon('play')]),
		el('span', { class: 'tc-waiting-title', text: 'No result yet' }),
		el('span', { class: 'tc-waiting-hint', text: `Run ${humanName(tool)}; its result appears here.` }),
	]);
	const showOutput = (node: HTMLElement): void => {
		waiting.hidden = true;
		output.replaceChildren(node);
	};

	const historyList = el('section', { class: 'tc-card tc-history' });
	function renderHistory(): void {
		historyList.replaceChildren();
		const mine = calls.filter((entry) => entry.tool === tool.name).slice(0, 8);
		historyList.hidden = mine.length === 0;
		if (mine.length === 0) return;
		historyList.append(
			tip(
				el('div', { class: 'tc-section-head' }, [
					icon('history'),
					el('span', { text: 'Recent calls' }),
					el('span', { class: 'tc-section-count', text: String(mine.length) }),
				]),
				'This tab only; click one to restore it',
				'top',
			),
		);
		for (const entry of mine) {
			const code = errorCodeOf(entry.result);
			const item = el('button', { type: 'button', class: 'tc-history-item' }, [
				dot(code === null ? 'live' : 'error', code === null ? 'Succeeded' : `Failed · ${code}`),
				el('span', { class: 'mono tc-history-args', text: JSON.stringify(entry.args) }),
				el('span', { class: 'tc-history-meta', text: `${entry.ms} ms` }),
				el('span', { class: 'tc-history-meta', text: entry.at.toLocaleTimeString() }),
			]);
			on(item, 'click', () => detail.replaceWith(toolConsole(tool, navigate, where, entry)));
			historyList.append(item);
		}
	}

	async function execute(): Promise<void> {
		let args: Record<string, unknown>;
		try {
			args = jsonMode ? JSON.parse(jsonArea.value || '{}') as Record<string, unknown> : form.read();
		} catch (cause) {
			toast(messageOf(cause), 'error');
			return;
		}
		await busy(run, async () => {
			const started = performance.now();
			const result = await mcp.call(tool.name, args);
			const ms = Math.round(performance.now() - started);
			calls.unshift({ tool: tool.name, args, result, ms, at: new Date() });
			calls.length = Math.min(calls.length, 25);
			showOutput(renderResult(result, ms, navigate));
			renderHistory();
		}).catch((cause) => showOutput(failure(messageOf(cause))));
	}
	on(formNode, 'submit', (event) => {
		event.preventDefault();
		void execute();
	});
	on(formNode, 'keydown', (event) => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void execute();
		}
	});

	const description = tool.description ?? '';
	const descNode = el('p', { class: 'tc-desc', text: description });
	const descRow = el('div', { class: 'tc-desc-row' }, [descNode]);
	if (description.length > 180) {
		descNode.classList.add('clamp');
		const more = iconButton('chevron-down', 'Show more', undefined, { small: true });
		on(more, 'click', () => {
			const clamped = descNode.classList.toggle('clamp');
			relabel(more, clamped ? 'Show more' : 'Show less', clamped ? 'chevron-down' : 'chevron-up');
		});
		descRow.append(more);
	}

	const family = `${familyName} · ${where}`;
	// One card for the request: what the tool is on top, its arguments and the run bar below.
	formNode.append(
		el('header', { class: 'tc-head' }, [
			el('div', { class: 'tc-tile', role: 'img', 'aria-label': family, 'data-tip': family }, [icon(glyph)]),
			el('div', { class: 'tc-head-text' }, [
				el('h2', { class: 'tc-title', text: humanName(tool) }),
				el('div', { class: 'tc-id' }, [
					el('code', { class: 'mono', text: tool.name }),
					copyButton(() => tool.name, 'Copy tool name'),
				]),
			]),
			el(
				'div',
				{ class: 'tc-flags', role: 'group', 'aria-label': 'Annotations' },
				hintsOf(tool).map((hint) => flagOf(hint.glyph, hint.label, hint.tone)),
			),
		]),
		...(description === '' ? [] : [descRow]),
		...(/\bsampling\b/i.test(description) ? [samplingNote()] : []),
		el('div', { class: 'tc-rule', 'aria-hidden': 'true' }),
		form.node,
		jsonArea,
		el('div', { class: 'tc-actions' }, [run, shortcut, el('span', { class: 'grow' }), toggle, reset]),
	);
	// The request beside the result: the result (JSON, screenshots, history) is what needs the room.
	detail.append(
		formNode,
		el('section', { class: 'tc-response', 'aria-label': 'Result' }, [waiting, output, historyList]),
	);
	renderHistory();
	if (preset !== undefined) {
		setJsonMode(true, preset.args);
		showOutput(renderResult(preset.result, preset.ms, navigate));
	}
	return detail;
}

/** The viewer of a tool name this credential is not served (a stale link, a narrowed key). */
export function missingTool(name: string): HTMLElement {
	return empty('tools', 'Tool not served', `${name} is not among the tools this credential is served.`);
}
