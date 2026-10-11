/**
 * The task composer (run model-providers-ui, F4): one form that composes the three kinds of task — *Ask agent*
 * (a text task on the coding agent or a named model provider), *Run tool* (one tool call as a structured task) and
 * *Delegate* (a message to a configured A2A peer) — behind a worded kind switch.
 *
 * The pure parts are exported for the unit tests: the target options a providers answer offers (and why one is
 * disabled), and the exact body each kind submits. The form itself takes its requests through `deps`, so a test
 * can build it against stubs with the fake document and read the options it painted.
 */
import type { AgentMessagePart, CreateAgentTaskBody, ProvidersResponse } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { McpTool } from './mcp.ts';
import { schemaForm } from './schema_form.ts';
import { TASK_EXCLUDED_TOOLS, type TaskKind } from './task_kinds.ts';
import { FAMILY_ORDER, familyOf } from './tool_families.ts';
import { appOnly } from './tool_visibility.ts';
import { busy, button, dot, messageOf, segmented, type SegmentedOption, tip, toast } from './ui.ts';

// --- pure -------------------------------------------------------------------------------------------------------------

/** The kind switch, in order; the ids are `task.metadata.kind` values. */
export const KIND_OPTIONS: ReadonlyArray<SegmentedOption & { readonly id: TaskKind }> = [
	{ id: 'text', label: 'Ask agent', icon: 'agents' },
	{ id: 'tool', label: 'Run tool', icon: 'wrench' },
	{ id: 'delegation', label: 'Delegate', icon: 'delegate' },
];

/** One choice of the Ask-agent target select. */
export interface TargetOption {
	/** `acp` for the coding agent, else `<provider id>` (the model rides beside it). */
	readonly value: string;
	readonly label: string;
	readonly disabled: boolean;
	/** Why it is disabled: the option's tooltip. */
	readonly reason?: string;
	/** A warn dot beside the label (the provider is configured but not reachable). */
	readonly warn: boolean;
	readonly provider?: string;
	readonly model?: string;
	/** D-156: a built-in profile id (`sloplord`); the task runs on the default provider. */
	readonly agent?: string;
}

export const ACP_TARGET = 'acp';
export const NEEDS_SCOPE = 'needs model:invoke';
export const NO_ACP = 'No ACP agent configured';
/** D-156: a built-in profile option's value is `agent:<id>`, never a provider id (those have no colon). */
export const AGENT_TARGET_PREFIX = 'agent:';
export const AGENT_UNAVAILABLE = 'Needs the coding sandbox and a reachable model provider';
export const NO_DEFAULT_PROVIDER = 'No default model provider';

/**
 * The target select for a providers answer (D-143 §3.3): *Coding agent (ACP)* first, enabled only when a bridge is
 * configured; then one option per provider and model, offered only to a caller holding `model:invoke` (else
 * disabled with "needs model:invoke") and disabled with the server's `reason` when the provider is not reachable.
 */
export function targetOptions(providers: ProvidersResponse): TargetOption[] {
	const options: TargetOption[] = [{
		value: ACP_TARGET,
		label: 'Coding agent (ACP)',
		disabled: !providers.acp,
		...(providers.acp ? {} : { reason: NO_ACP }),
		warn: false,
	}];
	// D-156: the built-in profiles (SlopLord) next, after the ACP agent; each runs on the default provider.
	for (const agent of providers.agents ?? []) {
		const reason = !agent.available
			? AGENT_UNAVAILABLE
			: !providers.invocable
			? NEEDS_SCOPE
			: providers.default === null
			? NO_DEFAULT_PROVIDER
			: undefined;
		options.push({
			value: `${AGENT_TARGET_PREFIX}${agent.id}`,
			label: `${agent.name} (coding)`,
			disabled: reason !== undefined,
			...(reason === undefined ? {} : { reason }),
			warn: false,
			agent: agent.id,
		});
	}
	for (const provider of providers.providers) {
		const models = provider.models.length ? provider.models : [provider.default_model ?? ''];
		for (const model of models) {
			const reason = !providers.invocable
				? NEEDS_SCOPE
				: provider.reachable
				? undefined
				: provider.reason ?? 'Not reachable';
			options.push({
				value: provider.id,
				label: model === '' ? provider.label : `${provider.label} · ${model}`,
				disabled: reason !== undefined,
				...(reason === undefined ? {} : { reason }),
				warn: providers.invocable && !provider.reachable,
				provider: provider.id,
				...(model === '' ? {} : { model }),
			});
		}
	}
	return options;
}

/**
 * The option the select starts on: the coding agent when it is enabled (§3.10: a bridge serves a text task without
 * a selection anyway), else the built-in agent's chosen model (D-158), else the default provider's default model,
 * else the first enabled option; `-1` for none.
 */
export function defaultTarget(options: readonly TargetOption[], providers: ProvidersResponse): number {
	const acp = options.findIndex((option) => option.value === ACP_TARGET && !option.disabled);
	if (acp >= 0) return acp;
	// D-158: the built-in agent's own default model, when an administrator chose one.
	const chosen = providers.agent_default;
	const own = chosen === undefined
		? -1
		: options.findIndex((option) =>
			!option.disabled && option.provider === chosen.provider && option.model === chosen.model
		);
	if (own >= 0) return own;
	const fallback = providers.providers.find((provider) => provider.id === providers.default);
	const preferred = options.findIndex((option) =>
		!option.disabled && option.provider === providers.default && option.model === (fallback?.default_model ?? undefined)
	);
	if (preferred >= 0) return preferred;
	return options.findIndex((option) => !option.disabled);
}

/**
 * D-156: a target another screen asked the next composer to start on (Resources › Agents' "Chat with SlopLord"), by
 * option value. Read once by the next paint, and used only when that option is enabled; else the default stands.
 */
let preferred: string | null = null;
export function preferTarget(value: string): void {
	preferred = value;
}
/** The index `preferTarget` asked for, when enabled, else `fallback`; the request is consumed either way. */
export function preferredTarget(options: readonly TargetOption[], fallback: number): number {
	const wanted = preferred;
	preferred = null;
	const at = wanted === null ? -1 : options.findIndex((option) => option.value === wanted && !option.disabled);
	return at >= 0 ? at : fallback;
}

/** `POST /api/v1/agent/tasks`: the message, and the provider and model only when a provider was chosen. */
export function textTaskBody(message: string, target: TargetOption | undefined): CreateAgentTaskBody {
	if (target?.agent !== undefined) return { message, agent: target.agent };
	if (target === undefined || target.provider === undefined) return { message };
	return { message, provider: target.provider, ...(target.model === undefined ? {} : { model: target.model }) };
}

/** One A2A data part `{tool, arguments}`: the structured task the runtime runs through `invoke`. */
export function toolTaskParts(tool: string, args: Record<string, unknown>): AgentMessagePart[] {
	return [{ data: { tool, arguments: args } }];
}

/**
 * The id of the task a submission created, from whichever envelope answered it: `POST /api/v1/agent/tasks`
 * (`{ task }`), the A2A `SendMessage` result (`{ task }` or the task itself), or `agent_delegate`'s `{ result }`
 * (`{ result: { task } }` or `{ result: <task> }`). `null` when none of them holds a task.
 */
export function submittedTaskId(result: unknown): string | null {
	let value: unknown = result;
	for (let depth = 0; depth < 4 && value !== null && typeof value === 'object'; depth++) {
		const record = value as Record<string, unknown>;
		if (typeof record.id === 'string' && typeof record.status === 'object' && record.status !== null) return record.id;
		value = record.task ?? record.result;
	}
	return null;
}

/** The arguments of `agent_delegate`. */
export function delegateArgs(peer: string, message: string): { peer: string; message: string } {
	return { peer, message };
}

/**
 * D-092: the one place the "New surface" action is offered — the Surfaces header while surfaces exist, the empty
 * state while none do, nowhere without `a2ui:publish` (the server refuses anyway; the screen does not pretend).
 * Here rather than in `surface_builder.ts`, which is lazy with the renderer and its schemas: the screen decides
 * where the action lives before any surface has been rendered.
 */
export function newSurfaceHome(count: number, canPublish: boolean): 'header' | 'empty' | 'none' {
	if (!canPublish) return 'none';
	return count === 0 ? 'empty' : 'header';
}

/** The tools the Run-tool select offers: everyone's tools, minus the excluded set, in family order then by name. */
export function offeredTools(tools: readonly McpTool[]): McpTool[] {
	return tools.filter((tool) => !TASK_EXCLUDED_TOOLS.has(tool.name) && !appOnly(tool)).sort((a, b) => {
		const fa = FAMILY_ORDER.indexOf(familyOf(a.name)[0]);
		const fb = FAMILY_ORDER.indexOf(familyOf(b.name)[0]);
		return fa === fb ? a.name.localeCompare(b.name) : fa - fb;
	});
}

// --- the form ---------------------------------------------------------------------------------------------------------

export interface ComposerDeps {
	readonly providers: () => Promise<ProvidersResponse>;
	readonly tools: () => Promise<McpTool[]>;
	/** The configured peer ids (`agent_peers`). */
	readonly peers: () => Promise<string[]>;
	readonly createTask: (body: CreateAgentTaskBody) => Promise<unknown>;
	readonly sendParts: (parts: AgentMessagePart[]) => Promise<unknown>;
	readonly delegate: (args: { peer: string; message: string }) => Promise<unknown>;
	/** After a task was accepted. */
	/** After a submission is accepted, with what the server answered (the new task, in one of three envelopes). */
	readonly onSubmitted: (result: unknown) => void;
	/** The screen's live region: what the composer says goes there. */
	readonly status: HTMLElement;
}

/** The submit button's name and glyph per kind. */
const SUBMIT: Readonly<Record<TaskKind, { readonly label: string; readonly glyph: IconName }>> = {
	text: { label: 'Send to agent', glyph: 'send' },
	tool: { label: 'Run as task', glyph: 'play' },
	// FE-3 (D-092): the Delegate tab already draws `delegate`; the submit is the verb, `send`.
	delegation: { label: 'Delegate to peer', glyph: 'send' },
};

const value = (node: { value: unknown }): string => typeof node.value === 'string' ? node.value : '';

export function taskComposer(
	deps: ComposerDeps,
): { node: HTMLElement; focus(): void; ready: Promise<void>; prefill(text: string): void; reload(): void } {
	let kind: TaskKind = 'text';
	const say = (text: string): void => {
		deps.status.textContent = text;
	};

	// --- Ask agent ---------------------------------------------------------------------------------------------------
	let targets: TargetOption[] = [];
	/**
	 * The index the select was last set to — by `paintTargets` or by the user. The kit's `value` getter filters
	 * against an option cache that is rebuilt a microtask after `replaceChildren`, so right after a paint it reads
	 * `''` for the option the form just chose (F-01/CRW-1); `chosenTarget()` falls back to this. `-1` for none.
	 */
	let chosen = -1;
	/** Why `GET /api/v1/agent/providers` failed, while it has (BUG-5); `null` while loading or after a paint. */
	let targetsFailed: string | null = null;
	// D-147: the target is a compact picker in the chat bar, so it carries no visible label of its own.
	const targetGlyph = icon('brain');
	targetGlyph.setAttribute('slot', 'start');
	const target = el('wa-select', {
		id: 'agent-target',
		class: 'ag-target tc-kit',
		size: 's',
		placeholder: 'Loading…',
		'aria-label': 'Target',
	}, [targetGlyph]);
	// BUG-5: the one retry home, shown only while the providers request has failed.
	const retryTargets = button({ label: 'Try again', icon: 'refresh', variant: 'ghost', small: true });
	retryTargets.classList.add('ag-target-retry');
	retryTargets.hidden = true;
	const prompt = el('textarea', {
		id: 'agent-prompt',
		rows: 1,
		maxlength: 65536,
		placeholder: 'Message the agent…',
		'aria-label': 'Agent prompt',
	});
	function paintTargets(providers: ProvidersResponse): void {
		targets = targetOptions(providers);
		targetsFailed = null;
		retryTargets.hidden = true;
		target.removeAttribute('data-tip');
		target.replaceChildren(
			targetGlyph,
			...targets.flatMap((option, index) => {
				const node = el('wa-option', {
					value: String(index),
					disabled: option.disabled,
					'data-tip': option.reason,
					'data-tip-placement': 'left',
				}, [
					el('span', { text: option.label }),
					// FE-2: a disabled option never takes focus, so its tooltip never reaches a keyboard or screen-reader
					// user; the reason rides in the option's content too, visually hidden.
					...(option.reason === undefined ? [] : [el('span', { class: 'sr-only', text: ` — ${option.reason}` })]),
				]);
				if (option.warn) {
					const mark = dot('warn', option.reason ?? 'Not reachable');
					mark.setAttribute('slot', 'end');
					node.append(mark);
				}
				// D-152: the options read in labelled groups — the coding agent, (D-156) the built-in agents, then the model
				// providers.
				const group = (item: TargetOption | undefined): string | null =>
					item === undefined
						? null
						: item.value === ACP_TARGET
						? 'Coding agent'
						: item.agent !== undefined
						? 'Built-in agents'
						: 'Model providers';
				const heading = group(option) === group(targets[index - 1]) ? null : group(option);
				return heading === null ? [node] : [el('small', { class: 'ag-target-group', text: heading }), node];
			}),
		);
		chosen = preferredTarget(targets, defaultTarget(targets, providers));
		target.value = chosen < 0 ? '' : String(chosen);
		// Short: the bar's picker is narrow, and the submit's tooltip carries the whole reason.
		target.setAttribute('placeholder', chosen < 0 ? 'No agent available' : 'Target');
		gate();
	}
	/** The option the kit reports chosen, or the one the form last set when the kit's cache has not caught up yet. */
	const chosenTarget = (): TargetOption | undefined => {
		const read = value(target);
		const index = read === '' ? chosen : Number(read);
		const option = Number.isInteger(index) && index >= 0 ? targets[index] : undefined;
		return option === undefined || option.disabled ? undefined : option;
	};
	/** BUG-5: the providers request failed — say why, offer the retry, and leave a plain text task sendable. */
	function failTargets(cause: unknown): void {
		targets = [];
		chosen = -1;
		targetsFailed = messageOf(cause);
		const words = `Could not load the targets: ${targetsFailed}`;
		target.setAttribute('placeholder', 'Targets unavailable');
		tip(target, words, 'top');
		retryTargets.hidden = false;
		say(words);
		gate();
	}
	/** Asks for the providers and paints the targets; rerun by the retry. */
	function loadTargets(): Promise<void> {
		targetsFailed = null;
		retryTargets.hidden = true;
		gate();
		return deps.providers().then(paintTargets).catch(failTargets);
	}
	on(retryTargets, 'click', () => void busy(retryTargets, loadTargets));

	// --- Run tool ---------------------------------------------------------------------------------------------------
	let tools: McpTool[] = [];
	let toolsLoaded = false;
	let form: { node: HTMLElement; read(): Record<string, unknown> } | null = null;
	let tool: McpTool | null = null;
	const toolSelect = el('wa-select', {
		id: 'agent-tool',
		label: 'Tool',
		class: 'ag-tool tc-kit',
		placeholder: 'Loading…',
		'aria-label': 'Tool',
	});
	const toolForm = el('div', { id: 'agent-tool-form', class: 'ag-tool-form' });
	function paintTools(): void {
		const families = new Map<string, McpTool[]>();
		for (const entry of tools) {
			const [family] = familyOf(entry.name);
			families.set(family, [...(families.get(family) ?? []), entry]);
		}
		const options: HTMLElement[] = [];
		for (const [family, members] of families) {
			options.push(el('wa-option', { value: `family:${family}`, disabled: true, class: 'ag-tool-family' }, [
				el('span', { text: family }),
			]));
			for (const entry of members) {
				const glyph = icon(familyOf(entry.name)[1]);
				glyph.setAttribute('slot', 'start');
				options.push(el('wa-option', { value: entry.name, class: 'ag-tool-option' }, [
					glyph,
					el('span', { class: 'mono', text: entry.name }),
				]));
			}
		}
		toolSelect.replaceChildren(...options);
		toolSelect.setAttribute('placeholder', tools.length === 0 ? 'No tool can run as a task' : 'Choose a tool…');
	}
	function pickTool(name: string): void {
		tool = tools.find((entry) => entry.name === name) ?? null;
		toolForm.replaceChildren();
		form = null;
		if (tool === null) {
			gate();
			return;
		}
		form = schemaForm(tool.inputSchema, 'task-arg-');
		if (Object.keys(tool.inputSchema.properties ?? {}).length === 0) {
			form.node.append(
				el('div', { class: 'tc-noargs' }, [icon('circle-dashed'), el('span', { text: 'No arguments' })]),
			);
		}
		toolForm.append(
			...(tool.description === undefined || tool.description === ''
				? []
				: [el('p', { class: 'ag-tool-desc', text: tool.description })]),
			form.node,
		);
		gate();
	}
	on(toolSelect, 'change', () => pickTool(value(toolSelect)));
	async function loadTools(): Promise<void> {
		if (toolsLoaded) return;
		toolsLoaded = true;
		try {
			tools = offeredTools(await deps.tools());
			paintTools();
		} catch (cause) {
			toolsLoaded = false;
			say(messageOf(cause));
		}
		gate();
	}

	// --- Delegate ---------------------------------------------------------------------------------------------------
	let peers: string[] | null = null;
	let delegateServed = false;
	const peerSelect = el('wa-select', {
		id: 'agent-peer',
		label: 'Peer',
		class: 'ag-peer tc-kit',
		placeholder: 'Loading…',
		'aria-label': 'Peer',
	});
	const delegateMessage = el('textarea', {
		id: 'agent-delegate-message',
		rows: 1,
		maxlength: 65536,
		placeholder: 'What to ask the peer…',
		'aria-label': 'Message to the peer',
	});
	const peerNote = el('div', { class: 'ag-peer-note', hidden: true });
	async function loadPeers(): Promise<void> {
		if (peers !== null) return;
		try {
			const served = (await deps.tools()).some((entry) => entry.name === 'agent_delegate');
			delegateServed = served;
			peers = served ? await deps.peers() : [];
		} catch (cause) {
			peers = [];
			say(messageOf(cause));
		}
		peerSelect.replaceChildren(...peers.map((peer) => el('wa-option', { value: peer, text: peer })));
		peerSelect.setAttribute('placeholder', peers.length === 0 ? 'No peer configured' : 'Choose a peer…');
		if (peers[0] !== undefined) peerSelect.value = peers[0];
		peerNote.hidden = peers.length > 0;
		peerNote.replaceChildren(
			el('wa-callout', { variant: 'neutral', appearance: 'outlined', size: 's' }, [
				el('span', {
					text: delegateServed
						? 'No peer is configured: TTK_AGENT_PEERS_FILE names the A2A peers this server may delegate to.'
						: 'Delegation is not served here: configure A2A peers (TTK_AGENT_PEERS_FILE) to enable agent_delegate.',
				}),
			]),
		);
		gate();
	}

	// --- the switch, the bar, the submit ---------------------------------------------------------------------------
	const submit = button({
		label: SUBMIT.text.label,
		icon: SUBMIT.text.glyph,
		variant: 'primary',
		type: 'submit',
		iconOnly: true,
		tip: 'top',
	});
	let submitGlyph: SVGSVGElement | null = (submit.children[0] as SVGSVGElement | undefined) ?? null;
	function name(label: string, glyph?: IconName): void {
		submit.setAttribute('aria-label', label);
		submit.setAttribute('data-tip', label);
		if (glyph !== undefined && submitGlyph !== null) {
			const next = icon(glyph);
			submitGlyph.replaceWith(next);
			submitGlyph = next;
		}
	}
	/** Enables the submit when the active kind can be sent; otherwise names the reason in its tooltip. */
	function gate(): void {
		let reason: string | null = null;
		if (kind === 'text') {
			// BUG-5: with the targets unknown, a plain text task is still what the server accepts (`{message}` alone).
			if (targetsFailed !== null) reason = null;
			else if (targets.length === 0) reason = 'Loading the targets…';
			else if (chosenTarget() === undefined) reason = 'No coding agent or model provider is available';
		} else if (kind === 'tool') {
			if (!toolsLoaded) reason = 'Loading the tools…';
			else if (tool === null) reason = 'Choose a tool first';
		} else if (peers === null) reason = 'Loading the peers…';
		else if (!delegateServed) reason = 'Delegation is not served here';
		else if (peers.length === 0) reason = 'No peer is configured';
		submit.disabled = reason !== null;
		name(reason ?? SUBMIT[kind].label, SUBMIT[kind].glyph);
	}
	on(target, 'change', () => {
		// A `change` the kit reports with a value moves the index; one it reports with '' leaves it alone.
		const read = Number(value(target));
		if (value(target) !== '' && Number.isInteger(read)) chosen = read;
		gate();
	});
	on(peerSelect, 'change', gate);

	// The target picker lives in the bar (D-147) and shows only while the kind is Ask agent.
	const targetBox = el('div', { class: 'ag-target-box' }, [target, retryTargets]);
	const panes: Readonly<Record<TaskKind, HTMLElement>> = {
		text: el('div', { class: 'ag-pane', 'data-kind': 'text', role: 'tabpanel', 'aria-label': 'Ask agent' }, [
			prompt,
		]),
		tool: el(
			'div',
			{ class: 'ag-pane', 'data-kind': 'tool', role: 'tabpanel', 'aria-label': 'Run tool', hidden: true },
			[
				el('div', { class: 'ag-pane-row' }, [toolSelect]),
				toolForm,
			],
		),
		delegation: el('div', {
			class: 'ag-pane',
			'data-kind': 'delegation',
			role: 'tabpanel',
			'aria-label': 'Delegate',
			hidden: true,
		}, [
			el('div', { class: 'ag-pane-row' }, [peerSelect]),
			peerNote,
			delegateMessage,
		]),
	};
	const firstField: Readonly<Record<TaskKind, HTMLElement>> = {
		text: prompt,
		tool: toolSelect,
		delegation: peerSelect,
	};
	function switchTo(next: TaskKind): void {
		kind = next;
		for (const [id, pane] of Object.entries(panes)) pane.hidden = id !== next;
		targetBox.hidden = next !== 'text';
		if (next === 'tool') void loadTools();
		if (next === 'delegation') void loadPeers();
		gate();
		firstField[next].focus();
	}
	const kinds = segmented(KIND_OPTIONS, 'text', (id) => switchTo(id as TaskKind));
	kinds.node.classList.add('ag-kinds');
	kinds.node.setAttribute('aria-label', 'Task kind');

	const keys = tip(
		el('span', { class: 'ag-hint' }, [el('kbd', { text: '↵' })]),
		'Enter sends; Shift + Enter starts a new line',
		'top',
	);
	// D-152: the controls float above the input — the kind, the target and the live status on one toolbar — and the
	// input is one card: what to send, with the send button inside it at the end, as in every assistant.
	const node = el('form', { class: 'ag-composer' }, [
		el('div', { class: 'ag-toolbar' }, [
			kinds.node,
			targetBox,
			// The live status takes the toolbar's free room, at its end.
			deps.status,
		]),
		el('div', { class: 'ag-input' }, [
			el('div', { class: 'ag-input-panes' }, [panes.text, panes.tool, panes.delegation]),
			el('div', { class: 'ag-input-actions' }, [keys, submit]),
		]),
	]);

	/** The message boxes grow with what is typed, up to the stylesheet's cap, then scroll (a CSSOM write). */
	const fit = (box: HTMLTextAreaElement): void => {
		box.style.height = 'auto';
		box.style.height = `${box.scrollHeight}px`;
	};
	for (const box of [prompt, delegateMessage]) {
		on(box, 'input', () => fit(box));
		// Enter sends, as in every chat; Shift + Enter is a new line, and Enter that ends an IME composition is not a send.
		on(box, 'keydown', (event) => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			send();
		});
	}

	function send(): void {
		if (submit.disabled) return;
		let work: () => Promise<unknown>;
		let done: () => void;
		try {
			if (kind === 'text') {
				const message = prompt.value.trim();
				if (message === '') return;
				const body = textTaskBody(message, chosenTarget());
				work = () => deps.createTask(body);
				done = (): void => {
					prompt.value = '';
					fit(prompt);
				};
			} else if (kind === 'tool') {
				if (tool === null || form === null) return;
				const parts = toolTaskParts(tool.name, form.read());
				work = () => deps.sendParts(parts);
				done = (): void => toast('Tool task submitted', 'ok');
			} else {
				const peer = value(peerSelect);
				const message = delegateMessage.value.trim();
				if (peer === '' || message === '') return;
				const args = delegateArgs(peer, message);
				work = () => deps.delegate(args);
				done = (): void => {
					delegateMessage.value = '';
					fit(delegateMessage);
					toast(`Delegated to ${peer}`, 'ok');
				};
			}
		} catch (cause) {
			// `form.read()` names the field that is missing or malformed.
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
			return;
		}
		void busy(submit, work).then((result) => {
			done();
			deps.onSubmitted(result);
		}).catch((cause) => {
			say(messageOf(cause));
			toast(messageOf(cause), 'error');
		}).finally(gate);
	}
	on(node, 'submit', (event) => {
		event.preventDefault();
		send();
	});
	on(node, 'keydown', (event) => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			send();
		}
	});

	const ready = loadTargets();
	return {
		node,
		focus: () => firstField[kind].focus(),
		ready,
		prefill: (text: string) => {
			kinds.set('text');
			switchTo('text');
			prompt.value = text;
			fit(prompt);
			prompt.focus();
		},
		/** Asks again for what the credential may target (D-152: after its scopes changed). */
		reload: () => {
			toolsLoaded = false;
			peers = null;
			void loadTargets();
			if (kind === 'tool') void loadTools();
			if (kind === 'delegation') void loadPeers();
		},
	};
}
