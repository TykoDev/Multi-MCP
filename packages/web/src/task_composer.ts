/**
 * The Agents chat composer: a message and a target — a built-in agent (SlopLord), a model provider and model, or a
 * configured A2A peer. Every send starts a new task. The pure parts (the targets a providers answer offers, and the
 * body each submits) are exported for the unit tests; the form takes its requests through `deps`.
 */
import type { CreateAgentTaskBody, ProvidersResponse } from './api.ts';
import { el, on } from './dom.ts';
import { busy, button, messageOf, toast } from './ui.ts';

/** One choice of the target select. */
export interface TargetOption {
	readonly label: string;
	readonly disabled: boolean;
	/** Why it is disabled. */
	readonly reason?: string;
	readonly provider?: string;
	readonly model?: string;
	/** A built-in profile id (`sloplord`); the task runs on the default provider. */
	readonly agent?: string;
	/** An A2A peer id: the message is delegated (`agent_delegate`). */
	readonly peer?: string;
}

export const NEEDS_SCOPE = 'needs model:invoke';
export const AGENT_UNAVAILABLE = 'Needs the coding sandbox and a reachable model provider';
const NO_DEFAULT_PROVIDER = 'No default model provider';

/**
 * The targets: the built-in profiles first; then one per provider and model, offered only with `model:invoke` and
 * disabled with the server's reason while unreachable; then the peers.
 */
export function targetOptions(providers: ProvidersResponse, peers: readonly string[] = []): TargetOption[] {
	const options: TargetOption[] = [];
	for (const agent of providers.agents ?? []) {
		const reason = !agent.available
			? AGENT_UNAVAILABLE
			: !providers.invocable
			? NEEDS_SCOPE
			: providers.default === null
			? NO_DEFAULT_PROVIDER
			: undefined;
		options.push({ label: `${agent.name} (coding)`, disabled: reason !== undefined, reason, agent: agent.id });
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
				label: model === '' ? provider.label : `${provider.label} · ${model}`,
				disabled: reason !== undefined,
				reason,
				provider: provider.id,
				...(model === '' ? {} : { model }),
			});
		}
	}
	for (const peer of peers) options.push({ label: `Peer · ${peer}`, disabled: false, peer });
	return options;
}

/**
 * The target the select starts on: the built-in agent's chosen model, else the default provider's default model,
 * else the first enabled option; `-1` for none.
 */
export function defaultTarget(options: readonly TargetOption[], providers: ProvidersResponse): number {
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
	return preferred >= 0 ? preferred : options.findIndex((option) => !option.disabled);
}

/** `POST /api/v1/agent/tasks`: the message, and the provider and model only when a provider was chosen. */
export function textTaskBody(message: string, target: TargetOption | undefined): CreateAgentTaskBody {
	if (target?.agent !== undefined) return { message, agent: target.agent };
	if (target === undefined || target.provider === undefined) return { message };
	return { message, provider: target.provider, ...(target.model === undefined ? {} : { model: target.model }) };
}

/**
 * The id of the task a submission created, from whichever envelope answered: `{ task }` from the REST route, or
 * `agent_delegate`'s `{ result: { task } }` / `{ result: <task> }`. `null` when none holds a task.
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

export interface ComposerDeps {
	readonly providers: () => Promise<ProvidersResponse>;
	/** The configured peer ids; an empty list when there are none or the tool is not served. */
	readonly peers: () => Promise<string[]>;
	readonly createTask: (body: CreateAgentTaskBody) => Promise<unknown>;
	readonly delegate: (args: { peer: string; message: string }) => Promise<unknown>;
	/** After a submission is accepted, with what the server answered. */
	readonly onSubmitted: (result: unknown) => void;
}

export function taskComposer(
	deps: ComposerDeps,
): { node: HTMLElement; ready: Promise<void>; prefill(text: string): void } {
	let targets: TargetOption[] = [];
	const target = el('select', { id: 'agent-target', 'aria-label': 'Target' });
	const prompt = el('textarea', {
		id: 'agent-prompt',
		rows: 2,
		maxlength: 65536,
		placeholder: 'Message the agent… (Enter sends, Shift+Enter is a new line)',
		'aria-label': 'Agent prompt',
	});
	const submit = button({ label: 'Send', icon: 'send', variant: 'primary', type: 'submit' });
	const reason = el('span', { class: 'ag-reason', role: 'status' });
	const selected = (): TargetOption | undefined => target.value === '' ? undefined : targets[Number(target.value)];
	const chosen = (): TargetOption | undefined => selected()?.disabled === false ? selected() : undefined;
	/** The submit waits for a usable target and says why while there is none. */
	const gate = (): void => {
		const why = targets.every((option) => option.disabled)
			? 'No agent or model provider is available'
			: chosen() === undefined
			? selected()?.reason ?? 'Choose a target'
			: '';
		submit.disabled = why !== '';
		reason.textContent = why;
	};
	on(target, 'change', gate);

	async function loadTargets(): Promise<void> {
		try {
			const [providers, peers] = await Promise.all([deps.providers(), deps.peers().catch(() => [])]);
			targets = targetOptions(providers, peers);
			target.replaceChildren(...targets.map((option, index) =>
				el('option', {
					value: String(index),
					disabled: option.disabled,
					text: option.reason === undefined ? option.label : `${option.label} — ${option.reason}`,
				})
			));
			const start = defaultTarget(targets, providers);
			target.value = start < 0 ? '' : String(start);
		} catch (cause) {
			targets = [];
			target.replaceChildren();
			reason.textContent = `Could not load the targets: ${messageOf(cause)}`;
			submit.disabled = true;
			return;
		}
		gate();
	}

	const node = el('form', { class: 'ag-composer' }, [
		prompt,
		el('div', { class: 'ag-composer-bar' }, [target, reason, el('span', { class: 'grow' }), submit]),
	]);

	function send(): void {
		const option = chosen();
		const message = prompt.value.trim();
		if (submit.disabled || option === undefined || message === '') return;
		const work = option.peer !== undefined
			? () => deps.delegate({ peer: option.peer!, message })
			: () => deps.createTask(textTaskBody(message, option));
		void busy(submit, work).then((result) => {
			prompt.value = '';
			deps.onSubmitted(result);
		}).catch((cause) => toast(messageOf(cause), 'error')).finally(gate);
	}
	on(node, 'submit', (event) => {
		event.preventDefault();
		send();
	});
	// Enter sends, as in every chat; Shift+Enter is a new line, and Enter ending an IME composition is not a send.
	on(prompt, 'keydown', (event) => {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		send();
	});
	submit.disabled = true;
	return {
		node,
		ready: loadTargets(),
		prefill: (text: string) => {
			prompt.value = text;
			prompt.focus();
		},
	};
}
