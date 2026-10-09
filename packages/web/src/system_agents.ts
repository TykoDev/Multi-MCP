/**
 * System › Agents (`#/system/agents`, D-152, D-154): where the agent side of the gateway is configured.
 *
 * - **Model providers** — one list, held in the gateway's database. The operator's providers file
 *   (`TTK_MODEL_PROVIDERS_FILE`) seeds it once and is never written; from then on every provider — seeded or added
 *   here — is edited here, replaced as a whole by `PUT /api/v1/system/model-providers` and applied without a restart.
 *   A key typed here is sent once and sealed (AES-256-GCM) in the database; the page never receives it back. Without a
 *   data directory the file is used as is and the panel says why nothing can change; without `TTK_DB_KEY_FILE` no key
 *   can be stored.
 * - **Agents** (D-158) — every agent the gateway runs or routes to (the built-in model agent, SlopLord, the ACP coding
 *   agent, the A2A peers), each with its default model, its protocols (A2A, ACP, A2UI) and its memory switch, held in
 *   the database and applied to the next task. The Agents screen's side panel shows this same tab.
 * - **A2A** — the public agent card and the two bindings, with the card's skills (what the gateway advertises).
 * - **Agent runtime** — the ACP bridge, the built-in agent, the peers and the A2UI actions, read from the card and the
 *   agent routes; their settings are environment variables, which the Configuration tab lists.
 *
 * The tab reads its routes once per visit and after every save; the diagnostics poll of the screen is untouched.
 */
import {
	type AgentCard,
	type AgentsConfig,
	type AgentSetting,
	api,
	ApiError,
	type ManagedAgent,
	type ManagedProvider,
	type MemoryConfig,
	type ModelProvidersConfig,
	type ModelProvidersStoreInput,
	type ModelsProbeInput,
	type ProviderInput,
	type ProviderKeyInput,
} from './api.ts';
import { el, on } from './dom.ts';
import { invoke, mcp } from './mcp.ts';
import { SYSTEM_GLYPHS as G } from './system_facts.ts';
import {
	busy,
	button,
	confirmButton,
	copyButton,
	dot,
	iconButton,
	messageOf,
	openModal,
	panel,
	segmented,
	skeleton,
	tag,
	tip,
	toast,
} from './ui.ts';

type Navigate = (route: string) => void;

// --- pure ----------------------------------------------------------------------------------------------------------

/** A provider as the PUT body takes it, its key as given (`keep` by default). */
export function inputOf(provider: ManagedProvider, key: ProviderKeyInput = { mode: 'keep' }): ProviderInput {
	return {
		id: provider.id,
		kind: provider.kind,
		label: provider.label,
		base_url: provider.base_url,
		models: [...provider.models],
		default_model: provider.default_model,
		...(Object.keys(provider.headers).length === 0 ? {} : { headers: { ...provider.headers } }),
		allow_http: provider.allow_http,
		max_tokens_param: provider.max_tokens_param,
		max_steps: provider.max_steps,
		max_output_tokens: provider.max_output_tokens,
		token_budget: provider.token_budget,
		key,
	};
}

/** The provider list as it stands, as the PUT takes it: every provider, each key kept, the default in force. */
export function storeOf(config: ModelProvidersConfig): ModelProvidersStoreInput {
	return { default: config.default, providers: config.providers.map((provider) => inputOf(provider)) };
}

/** The list with one provider added or replaced (by id). */
export function withProvider(store: ModelProvidersStoreInput, provider: ProviderInput): ModelProvidersStoreInput {
	const at = store.providers.findIndex((entry) => entry.id === provider.id);
	const providers = at < 0
		? [...store.providers, provider]
		: store.providers.map((entry, index) => index === at ? provider : entry);
	return { ...store, providers };
}

/** The list without a provider; a default that named it is cleared (a sole remaining provider becomes it). */
export function withoutProvider(store: ModelProvidersStoreInput, id: string): ModelProvidersStoreInput {
	return {
		...store,
		default: store.default === id ? null : store.default,
		providers: store.providers.filter((entry) => entry.id !== id),
	};
}

/** The host:port a base URL dials, scheme-defaulted, or `''` when it does not parse. */
export function netHostOf(baseUrl: string): string {
	const url = URL.parse(baseUrl);
	if (url === null) return '';
	const port = url.port !== '' ? url.port : url.protocol === 'http:' ? '80' : '443';
	return `${url.hostname}:${port}`;
}

/** `name: value` per line → a header map; blank lines are skipped; a line without a colon is an error. */
export function parseHeaders(text: string): Record<string, string> {
	const headers: Record<string, string> = {};
	text.split(/\r?\n/).forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed === '') return;
		const colon = trimmed.indexOf(':');
		if (colon <= 0) throw new Error(`Header line ${index + 1} needs the form name: value`);
		headers[trimmed.slice(0, colon).trim().toLowerCase()] = trimmed.slice(colon + 1).trim();
	});
	return headers;
}

/** One model name per line (or comma), trimmed, duplicates dropped, order kept. */
export function parseModels(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))];
}

/** Up to two initials of a provider's label, for its card's mark. */
export function monogram(label: string): string {
	const words = label.split(/[\s._/-]+/).filter(Boolean);
	const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2);
	return letters.toUpperCase();
}

/** How a provider's key reads in a list — never the key itself. */
export function keyWords(key: ManagedProvider['key']): string {
	if (key.source === 'stored') return 'Key encrypted in the database';
	if (key.source === 'file' || key.source === 'inline') return 'Key in the providers file';
	return 'No key';
}

// --- form pieces ---------------------------------------------------------------------------------------------------

/** A labelled field: the label, the control, and an optional hint under it. */
function field(id: string, label: string, control: HTMLElement, hint?: string, wide = false): HTMLElement {
	return el('div', { class: `pv-field${wide ? ' wide' : ''}` }, [
		el('label', { class: 'pv-label', for: id, text: label }),
		control,
		...(hint === undefined ? [] : [el('span', { class: 'pv-hint', text: hint })]),
	]);
}

function input(id: string, value: string, placeholder = '', type = 'text'): HTMLInputElement {
	const node = el('input', { id, type, class: 'pv-input', placeholder, autocomplete: 'off', spellcheck: 'false' });
	node.value = value;
	return node;
}

function select(id: string, options: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
	const node = el(
		'select',
		{ id, class: 'pv-input' },
		options.map(([v, label]) => el('option', { value: v, text: label })),
	);
	node.value = value;
	return node;
}

/** A refusal shown in the dialog that caused it, in the server's words. */
function failureLine(): { node: HTMLElement; show(text: string): void; hide(): void } {
	const node = el('p', { class: 'pv-error', role: 'alert', hidden: true });
	return {
		node,
		show(text: string) {
			node.textContent = text;
			node.hidden = false;
		},
		hide() {
			node.hidden = true;
		},
	};
}

// --- the provider editor -------------------------------------------------------------------------------------------

/**
 * The provider editor: presets (for a new one), identity, endpoint and models, the key, and the advanced limits. The
 * key is typed into a password field and sent once (`set`, sealed in the database), kept as sealed (`keep`), or none.
 * Without a vault key only `keep` and `none` are offered. `save` receives the provider as the PUT takes it; a refusal
 * stays in the dialog, under the form.
 */
function openEditor(
	config: ModelProvidersConfig,
	existing: ManagedProvider | null,
	save: (provider: ProviderInput) => Promise<void>,
): void {
	const isNew = existing === null;
	const sealable = config.store.vault === 'unlocked';
	const taken = new Set(config.providers.map((provider) => provider.id));
	const id = input('pv-id', existing?.id ?? '', 'openai-main');
	id.readOnly = !isNew;
	const kind = select(
		'pv-kind',
		[['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic']],
		existing?.kind ?? 'openai',
	);
	const label = input('pv-label', existing?.label ?? '', 'Shown in the agent picker');
	const baseUrl = input('pv-base-url', existing?.base_url ?? '', 'https://api.openai.com/v1', 'url');
	const models = el('textarea', { id: 'pv-models', class: 'pv-input mono', rows: 3, spellcheck: 'false' });
	models.value = (existing?.models ?? []).join('\n');
	const defaultModel = el('select', { id: 'pv-default-model', class: 'pv-input' });
	const paintModels = (): void => {
		const list = parseModels(models.value);
		const keep = defaultModel.value || existing?.default_model || list[0] || '';
		defaultModel.replaceChildren(...list.map((model) => el('option', { value: model, text: model })));
		defaultModel.value = list.includes(keep) ? keep : list[0] ?? '';
	};
	on(models, 'input', () => {
		paintModels();
		paintFetched();
	});

	// D-158: the models the provider lists, fetched by the gateway (the key never reaches the page), each a chip that
	// adds or removes its line in the list above, which stays editable by hand.
	let listed: string[] = [];
	const fetched = el('div', {
		class: 'pv-fetched',
		role: 'group',
		'aria-label': 'Models the provider lists',
		hidden: true,
	});
	const fetchNote = el('span', { class: 'pv-hint', role: 'status', 'aria-live': 'polite' });
	const paintFetched = (): void => {
		const chosen = new Set(parseModels(models.value));
		fetched.hidden = listed.length === 0;
		const addAll = button({ label: 'Add all', variant: 'ghost', small: true });
		on(addAll, 'click', () => {
			models.value = [...new Set([...parseModels(models.value), ...listed])].join('\n');
			paintModels();
			paintFetched();
		});
		fetched.replaceChildren(
			el('div', { class: 'pv-fetched-head' }, [
				el('span', { text: `${listed.length} listed · ${listed.filter((model) => chosen.has(model)).length} chosen` }),
				...(listed.every((model) => chosen.has(model)) ? [] : [addAll]),
			]),
			el(
				'div',
				{ class: 'pv-fetched-list' },
				listed.map((model) => {
					const chip = el('button', {
						type: 'button',
						class: 'pv-fetched-chip mono',
						'aria-pressed': String(chosen.has(model)),
						text: model,
					});
					on(chip, 'click', () => {
						const list = parseModels(models.value);
						models.value = (list.includes(model) ? list.filter((entry) => entry !== model) : [...list, model])
							.join('\n');
						paintModels();
						paintFetched();
					});
					return chip;
				}),
			),
		);
	};
	const reload = iconButton(G.reloadModels, 'Fetch the models this provider lists', undefined, { small: true });
	paintModels();

	// The key: typed once and sealed, kept as sealed, or none. Sealing needs the vault's key (TTK_DB_KEY_FILE).
	const hasKey = existing !== null && existing.key.source !== 'none';
	const keyModes: Array<{ id: ProviderKeyInput['mode']; label: string }> = [
		...(hasKey ? [{ id: 'keep' as const, label: 'Keep current' }] : []),
		...(sealable ? [{ id: 'set' as const, label: hasKey ? 'Replace key' : 'Enter key' }] : []),
		{ id: 'none', label: 'No key' },
	];
	let keyMode: ProviderKeyInput['mode'] = keyModes[0]!.id;
	// `new-password`: the browser must not offer the operator's own sign-in password for this field.
	const keyValue = el('input', {
		id: 'pv-key-value',
		type: 'password',
		class: 'pv-input mono',
		autocomplete: 'new-password',
		spellcheck: 'false',
		maxlength: 512,
		placeholder: 'sk-…',
	});
	const keyValueField = field(
		'pv-key-value',
		'API key',
		keyValue,
		'Sent once, encrypted in the database (AES-256-GCM) and never shown again.',
		true,
	);
	const lockedNote = sealable ? null : el('p', {
		class: 'pv-warn',
		text: 'Keys cannot be stored: TTK_DB_KEY_FILE is not set. Create one with doctor --new-db-key and restart.',
	});
	const paintKey = (): void => {
		keyValueField.hidden = keyMode !== 'set';
	};
	const hostNote = el('p', { class: 'pv-warn', hidden: true });
	/** A kept key cannot follow its provider to a new host: say so before the server does. */
	const checkHost = (): void => {
		const moved = existing !== null && keyMode === 'keep' && netHostOf(baseUrl.value) !== netHostOf(existing.base_url);
		hostNote.hidden = !moved;
		hostNote.textContent = moved ? 'The endpoint moved to a new host: enter the key again, or choose No key.' : '';
	};
	on(baseUrl, 'input', checkHost);
	const keySwitch = segmented(keyModes, keyMode, (mode) => {
		keyMode = mode as ProviderKeyInput['mode'];
		paintKey();
		checkHost();
		if (keyMode === 'set') keyValue.focus();
	});
	keySwitch.node.setAttribute('aria-label', 'Key');
	paintKey();
	const keyNow = existing === null ? null : el('span', { class: 'pv-key-now', text: keyWords(existing.key) });

	const allowHttp = el('input', { id: 'pv-allow-http', type: 'checkbox', class: 'pv-check' });
	allowHttp.checked = existing?.allow_http ?? false;
	const tokensParam = select('pv-tokens-param', [
		['max_tokens', 'max_tokens'],
		['max_completion_tokens', 'max_completion_tokens'],
	], existing?.max_tokens_param ?? 'max_tokens');
	const maxSteps = input('pv-max-steps', String(existing?.max_steps ?? 24), '24', 'number');
	const maxOutput = input('pv-max-output', String(existing?.max_output_tokens ?? 4096), '4096', 'number');
	const budget = input('pv-budget', String(existing?.token_budget ?? 400000), '400000', 'number');
	const headers = el('textarea', { id: 'pv-headers', class: 'pv-input mono', rows: 2, spellcheck: 'false' });
	headers.value = Object.entries(existing?.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n');

	const failure = failureLine();
	// Worded, no glyph: the System screen's glyphs each mean one thing (FXD-N1), and a text button draws none.
	const submit = button({ label: isNew ? 'Add provider' : 'Save provider', variant: 'primary', type: 'submit' });
	const presets = el('div', { class: 'pv-presets', role: 'group', 'aria-label': 'Start from a preset' });
	if (isNew) {
		void import('./config_composer.ts').then(({ PROVIDER_PRESETS }) => {
			presets.replaceChildren(
				el('span', { class: 'pv-presets-label', text: 'Start from' }),
				...PROVIDER_PRESETS.map((preset) => {
					const chip = el('button', { type: 'button', class: 'pv-preset', text: preset.label });
					on(chip, 'click', () => {
						const draft = preset.draft;
						// An id the effective set already uses gets a suffix, so a preset never collides.
						let candidate = draft.id;
						for (let n = 2; taken.has(candidate); n++) candidate = `${draft.id}-${n}`;
						id.value = candidate;
						kind.value = draft.kind;
						label.value = preset.label;
						baseUrl.value = draft.baseUrl;
						models.value = draft.models.join('\n');
						paintModels();
						defaultModel.value = draft.defaultModel ?? draft.models[0] ?? '';
						tokensParam.value = draft.maxTokensParam ?? 'max_tokens';
						allowHttp.checked = draft.baseUrl.startsWith('http:') && !/^http:\/\/(127\.|localhost)/.test(draft.baseUrl);
						keyMode = draft.key.mode !== 'none' && sealable ? 'set' : 'none';
						keySwitch.set(keyMode);
						paintKey();
					});
					return chip;
				}),
			);
		});
	}

	on(reload, 'click', () => {
		fetchNote.textContent = '';
		let probe: ModelsProbeInput;
		try {
			const headerMap = parseHeaders(headers.value);
			if (keyMode === 'set' && keyValue.value.trim() === '') {
				throw new Error('Enter the API key first, or choose No key');
			}
			probe = {
				id: id.value.trim() || 'draft',
				kind: kind.value as ModelsProbeInput['kind'],
				base_url: baseUrl.value.trim(),
				...(Object.keys(headerMap).length === 0 ? {} : { headers: headerMap }),
				allow_http: allowHttp.checked,
				key: keyMode === 'set'
					? { mode: 'set', value: keyValue.value.trim() }
					: keyMode === 'keep'
					? { mode: 'keep' }
					: { mode: 'none' },
			};
		} catch (cause) {
			fetchNote.textContent = messageOf(cause);
			return;
		}
		void busy(reload, () => api.listProviderModels(probe)).then(({ models: names }) => {
			listed = names;
			fetchNote.textContent = names.length === 0 ? 'The provider lists no models.' : '';
			paintFetched();
		}).catch((cause) => {
			fetchNote.textContent = messageOf(cause);
		});
	});

	const form = el('form', { class: 'pv-form' }, [
		...(isNew ? [presets] : []),
		el('div', { class: 'pv-grid' }, [
			field(
				'pv-id',
				'Id',
				id,
				isNew ? 'Lowercase letters, digits, - and _; how tasks name it.' : 'The id cannot change.',
			),
			field('pv-kind', 'Kind', kind),
			field('pv-label', 'Label', label, undefined, true),
			field(
				'pv-base-url',
				'Base URL',
				baseUrl,
				'https for remote hosts; http only on loopback or with Allow http.',
				true,
			),
			el('div', { class: 'pv-field wide' }, [
				el('div', { class: 'pv-label-row' }, [
					el('label', { class: 'pv-label', for: 'pv-models', text: 'Models' }),
					reload,
				]),
				models,
				el('span', {
					class: 'pv-hint',
					text: 'One per line, typed or fetched: reload lists what the provider serves (a saved provider’s host only).',
				}),
				fetchNote,
				fetched,
			]),
			field('pv-default-model', 'Default model', defaultModel, undefined, true),
		]),
		el('section', { class: 'pv-key' }, [
			el('div', { class: 'pv-key-head' }, [
				el('span', { class: 'pv-label', text: 'API key' }),
				...(keyNow === null ? [] : [keyNow]),
			]),
			keySwitch.node,
			keyValueField,
			...(lockedNote === null ? [] : [lockedNote]),
			hostNote,
		]),
		el('details', { class: 'pv-advanced' }, [
			el('summary', {}, [el('span', { text: 'Advanced' })]),
			el('div', { class: 'pv-grid' }, [
				el('label', { class: 'pv-toggle wide', for: 'pv-allow-http' }, [
					allowHttp,
					el('span', { text: 'Allow http to a private or named host (never with a key off loopback)' }),
				]),
				field('pv-tokens-param', 'Output limit parameter', tokensParam),
				field('pv-max-steps', 'Max steps', maxSteps, '1–64 tool steps per task.'),
				field('pv-max-output', 'Max output tokens', maxOutput, '256–32768 per reply.'),
				field('pv-budget', 'Token budget', budget, '1000–4000000 per task.'),
				field('pv-headers', 'Extra headers', headers, 'name: value per line; no credentials.', true),
			]),
		]),
		failure.node,
		el('div', { class: 'pv-actions' }, [submit]),
	]);
	const dialog = openModal(isNew ? 'Add model provider' : `Edit ${existing.label}`, [form]);
	dialog.node.classList.add('pv-modal');
	// The typed key lives in this one field: it is cleared when the dialog goes, whatever closed it.
	dialog.node.addEventListener('wa-after-hide', (event) => {
		if (event.target === dialog.node) keyValue.value = '';
	});
	on(form, 'submit', (event) => {
		event.preventDefault();
		failure.hide();
		let provider: ProviderInput;
		try {
			const list = parseModels(models.value);
			if (list.length === 0) throw new Error('Name at least one model');
			if (isNew && taken.has(id.value.trim())) throw new Error(`The id ${id.value.trim()} is already in use`);
			if (keyMode === 'set' && keyValue.value.trim() === '') throw new Error('Enter the API key, or choose No key');
			const key: ProviderKeyInput = keyMode === 'set'
				? { mode: 'set', value: keyValue.value.trim() }
				: keyMode === 'keep'
				? { mode: 'keep' }
				: { mode: 'none' };
			const headerMap = parseHeaders(headers.value);
			provider = {
				id: id.value.trim(),
				kind: kind.value as ProviderInput['kind'],
				...(label.value.trim() === '' ? {} : { label: label.value.trim() }),
				base_url: baseUrl.value.trim(),
				models: list,
				default_model: defaultModel.value || list[0]!,
				...(Object.keys(headerMap).length === 0 ? {} : { headers: headerMap }),
				allow_http: allowHttp.checked,
				max_tokens_param: tokensParam.value as ProviderInput['max_tokens_param'],
				max_steps: Number(maxSteps.value),
				max_output_tokens: Number(maxOutput.value),
				token_budget: Number(budget.value),
				key,
			};
		} catch (cause) {
			failure.show(messageOf(cause));
			return;
		}
		void busy(submit, async () => {
			await save(provider);
			dialog.close();
		}).catch((cause) => failure.show(messageOf(cause)));
	});
	(isNew ? id : label).focus();
}

// --- the agents (D-158) -------------------------------------------------------------------------------------------

/** The protocols an agent may be offered over, in the order the dialog shows them, with why one does not apply. */
const PROTOCOLS: ReadonlyArray<readonly ['a2a' | 'acp' | 'a2ui', string, string, string]> = [
	['a2a', 'A2A', 'Offered to A2A clients: its skill on the agent card, its tasks accepted over A2A.', ''],
	[
		'acp',
		'ACP',
		'Text tasks that name no provider go to the coding agent over the ACP bridge.',
		'Only the coding agent is reached over ACP.',
	],
	[
		'a2ui',
		'A2UI',
		'May publish A2UI surfaces (the a2ui_* tools), with the caller’s a2ui:publish.',
		'The external agent’s tools are its own.',
	],
];

/** The words for an agent's default model: the choice, or what the providers' default resolves to. */
export function modelWords(setting: AgentSetting, config: Pick<AgentsConfig, 'default_model'>): string {
	if (setting.model !== null) return `${setting.model.provider} · ${setting.model.model}`;
	const fallback = config.default_model;
	return fallback === null ? 'Providers’ default (none set)' : `Default · ${fallback.provider} · ${fallback.model}`;
}

/** The protocols an agent is on, as the row's tags read them. */
export function protocolsOn(agent: ManagedAgent): string[] {
	const setting = agent.settings;
	if (setting === null) return agent.kind === 'peer' ? ['A2A'] : [];
	return PROTOCOLS.filter(([key]) => agent.applies[key] && setting[key]).map(([, label]) => label);
}

/**
 * The settings dialog of one agent: its default model, its protocols and its memory. A field that does not apply is
 * shown, disabled, with the reason — so every agent reads the same — and only the fields that apply are sent.
 */
function openAgentEditor(
	config: AgentsConfig,
	agent: ManagedAgent,
	save: (patch: Partial<AgentSetting>) => Promise<void>,
): void {
	const setting = agent.settings!;
	const writable = config.store.writable;
	const toggle = (name: string, label: string, on: boolean, enabled: boolean, hint: string): {
		node: HTMLElement;
		input: HTMLInputElement;
	} => {
		const input = el('input', { id: `ag-set-${name}`, type: 'checkbox', class: 'pv-check' });
		input.checked = on;
		input.disabled = !enabled || !writable;
		return {
			input,
			node: el('label', { class: `pv-toggle ag-set-toggle${enabled ? '' : ' na'}`, for: `ag-set-${name}` }, [
				input,
				el('span', { class: 'ag-set-text' }, [
					el('span', { class: 'ag-set-name', text: label }),
					el('span', { class: 'pv-hint', text: hint }),
				]),
			]),
		};
	};

	const fallback = config.default_model;
	const model = select('ag-set-model', [
		[
			'',
			fallback === null
				? 'Providers’ default (none set)'
				: `Providers’ default · ${fallback.provider} · ${fallback.model}`,
		],
		...config.models.map((entry) =>
			[
				`${entry.provider}\u0000${entry.model}`,
				`${entry.provider_label} · ${entry.model}${entry.reachable ? '' : ' (not reachable)'}`,
			] as const
		),
		// A stale choice stays selectable as itself, so saving other fields never silently drops it.
		...(agent.stale === true && setting.model !== null
			? [[`${setting.model.provider}\u0000${setting.model.model}`, `${modelWords(setting, config)} (removed)`] as const]
			: []),
	], setting.model === null ? '' : `${setting.model.provider}\u0000${setting.model.model}`);
	model.disabled = !agent.applies.model || !writable;

	const protocols = PROTOCOLS.map(([key, label, hint, na]) =>
		[key, toggle(key, label, setting[key], agent.applies[key], agent.applies[key] ? hint : na)] as const
	);
	const memory = toggle(
		'memory',
		'Agent memory',
		setting.memory,
		agent.applies.memory,
		!agent.applies.memory
			? 'The external agent keeps its own memory.'
			: config.memory_available
			? 'May save and search notes with the memory_* tools.'
			: 'No memory store here (TTK_DATA_DIR is not set): the switch is kept for when there is one.',
	);

	const failure = failureLine();
	const submit = button({ label: 'Save agent', variant: 'primary', type: 'submit' });
	submit.disabled = !writable;
	const form = el('form', { class: 'pv-form ag-set-form' }, [
		el('p', { class: 'pv-hint', text: agent.description }),
		...(agent.available ? [] : [el('p', { class: 'pv-warn', text: `Not available here: ${agent.reason ?? ''}` })]),
		...(writable ? [] : [el('p', { class: 'pv-warn', text: config.store.reason ?? 'Settings cannot change here.' })]),
		field(
			'ag-set-model',
			'Default model',
			model,
			agent.applies.model
				? 'Used when a task names no model. A request that names one still gets it.'
				: 'The external agent chooses its own model.',
			true,
		),
		el('fieldset', { class: 'ag-set-group' }, [
			el('legend', { class: 'pv-label', text: 'Protocols' }),
			...protocols.map(([, entry]) => entry.node),
		]),
		el('fieldset', { class: 'ag-set-group' }, [el('legend', { class: 'pv-label', text: 'Memory' }), memory.node]),
		failure.node,
		el('div', { class: 'pv-actions' }, [submit]),
	]);
	const dialog = openModal(`${agent.name} settings`, [form]);
	dialog.node.classList.add('pv-modal');
	on(form, 'submit', (event) => {
		event.preventDefault();
		failure.hide();
		const patch: Record<string, unknown> = {};
		if (agent.applies.model) {
			const [provider, name] = model.value.split('\u0000');
			patch.model = model.value === '' ? null : { provider, model: name };
		}
		for (const [key, entry] of protocols) if (agent.applies[key]) patch[key] = entry.input.checked;
		if (agent.applies.memory) patch.memory = memory.input.checked;
		void busy(submit, async () => {
			await save(patch as Partial<AgentSetting>);
			dialog.close();
		}).catch((cause) => failure.show(messageOf(cause)));
	});
	(agent.applies.model ? model : protocols[0]![1].input).focus();
}

/**
 * D-158: every agent this gateway runs or routes to — the built-in model agent, SlopLord, the ACP coding agent and
 * the A2A peers — one row each: its mark, whether it can run here, its default model, its protocols and its memory,
 * and Edit (the settings dialog). A peer is configured where it runs, so it has no Edit. Used by this tab and by the
 * Agents screen's side panel; `onSaved` lets the host refresh what depends on the settings.
 */
export function agentRoster(onSaved?: () => void): { node: HTMLElement; load(): Promise<void> } {
	const node = el('div', { class: 'ag-roster' }, [skeleton(3)]);
	let config: AgentsConfig | null = null;

	function row(agent: ManagedAgent): HTMLElement {
		const current = config!;
		const setting = agent.settings;
		const tags = protocolsOn(agent);
		const memoryOn = setting !== null && agent.applies.memory && setting.memory;
		const actions: HTMLElement[] = [];
		if (setting !== null) {
			actions.push(iconButton('edit', `Edit ${agent.name}`, () =>
				openAgentEditor(current, agent, async (patch) => {
					config = await api.saveAgentSettings({ [agent.id]: patch });
					paint();
					toast(`${agent.name} saved`, 'ok');
					onSaved?.();
				}), { small: true }));
		}
		return el('article', { class: `ag-roster-row ${agent.kind}`, 'data-agent': agent.id }, [
			// A monogram, as a provider card's: one glyph per row would repeat (FXD-N1).
			el('span', { class: `pv-kind ag-roster-mark ${agent.kind}`, 'aria-hidden': 'true', text: monogram(agent.name) }),
			el('div', { class: 'ag-roster-main' }, [
				el('div', { class: 'ag-roster-name' }, [
					el('span', { text: agent.name }),
					el('span', { class: `pv-reach ${agent.available ? 'ok' : 'warn'}` }, [
						dot(agent.available ? 'live' : 'warn', agent.available ? 'Available' : agent.reason ?? 'Unavailable'),
						el('span', { text: agent.available ? 'Available' : 'Unavailable' }),
					]),
				]),
				el('div', { class: 'ag-roster-facts' }, [
					...(setting !== null && agent.applies.model
						? [
							tip(
								tag(modelWords(setting, current), undefined, agent.stale === true ? 'warn' : ''),
								agent.stale === true
									? 'Its provider or model was removed: the providers’ default runs instead'
									: 'Default model',
								'top',
							),
						]
						: agent.kind === 'acp'
						? [tag('Own model')]
						: []),
					...tags.map((label) => tag(label, undefined, 'accent')),
					...(memoryOn ? [tag('Memory', undefined, 'ok')] : []),
					...(agent.kind === 'peer' ? [tip(tag('Remote'), agent.description, 'top')] : []),
				]),
			]),
			el('div', { class: 'pv-card-actions' }, actions),
		]);
	}

	function paint(): void {
		const current = config;
		if (current === null) return;
		node.replaceChildren(
			...(current.store.writable ? [] : [el('p', { class: 'pv-warn', text: current.store.reason ?? '' })]),
			el('div', { class: 'ag-roster-list' }, current.agents.map(row)),
		);
	}

	async function load(): Promise<void> {
		try {
			config = await api.agentsConfig();
			paint();
		} catch (cause) {
			const forbidden = cause instanceof ApiError && cause.status === 403;
			node.replaceChildren(
				el('div', { class: 'pv-empty' }, [
					el('span', { class: 'pv-empty-title', text: forbidden ? 'Needs the admin scope' : 'Agents unavailable' }),
					el('span', {
						class: 'pv-empty-hint',
						text: forbidden ? 'Managing agents is an administrator task.' : messageOf(cause),
					}),
				]),
			);
		}
	}

	return { node, load };
}

// --- the tab -------------------------------------------------------------------------------------------------------

/** One fact row of a side panel: name over value, the value in mono when it is data. */
function factRow(name: string, value: string | Node, mono = true): HTMLElement {
	return el('div', { class: 'pv-fact' }, [
		el('span', { class: 'pv-fact-name', text: name }),
		typeof value === 'string' ? el('span', { class: `pv-fact-value${mono ? ' mono' : ''}`, text: value }) : value,
	]);
}

function onOff(on: boolean, yes: string, no: string): HTMLElement {
	return el('span', { class: `pv-state ${on ? 'on' : 'off'}` }, [
		dot(on ? 'live' : '', on ? yes : no),
		el('span', { text: on ? yes : no }),
	]);
}

/** One source of providers in the status strip: what it is, what the page may do with it, and where it lives. */
function sourceRow(title: string, detail: string, path: string | null, tone: 'ok' | 'locked' | 'off'): HTMLElement {
	return el('div', { class: `pv-source ${tone}` }, [
		el('div', { class: 'pv-source-text' }, [
			el('span', { class: 'pv-source-title' }, [
				dot(tone === 'ok' ? 'live' : tone === 'locked' ? 'warn' : '', title),
				el('span', {
					text: title,
				}),
			]),
			el('span', { class: 'pv-source-hint', text: detail }),
		]),
		...(path === null ? [] : [
			el('span', { class: 'pv-file' }, [
				el('code', { class: 'mono', text: path }),
				copyButton(() => path, `Copy ${title.toLowerCase()} path`),
			]),
		]),
	]);
}

/**
 * The tab's content. `onChange` (D-158) is told after every saved change — the Agents screen's side panel hosts this
 * same content and refreshes its composer's targets from it.
 */
export function agentsTab(navigate: Navigate, onChange?: () => void): { node: HTMLElement; load(): Promise<void> } {
	const providersBody = el('div', { class: 'pv-body' }, [skeleton(3)]);
	const providersActions = el('div', { class: 'pv-head-actions' });
	const providersPanel = panel('Model providers', G.providersPanel, [providersBody], [providersActions]);
	providersPanel.classList.add('sys-providers');
	// D-158: the agents first — what runs — then the providers they run on.
	const roster = agentRoster(onChange);
	const agentsPanel = panel('Agents', G.agentsPanel, [roster.node]);
	agentsPanel.classList.add('sys-agent-roster');
	const a2aBody = el('div', { class: 'pv-side-body' }, [skeleton(2)]);
	const runtimeBody = el('div', { class: 'pv-side-body' }, [skeleton(2)]);
	const a2a = panel('A2A', G.a2a, [a2aBody], [
		iconButton(G.agentResources, 'Open the agents in Resources', () => navigate('#/resources/agents/a2a'), {
			small: true,
		}),
	]);
	const runtime = panel('Agent runtime', G.agentRuntime, [runtimeBody]);
	const memoryBody = el('div', { class: 'pv-side-body' }, [skeleton(2)]);
	const memory = panel('Agent memory', G.memoryPanel, [memoryBody]);
	const node = el('div', { class: 'sys-grid sys-agents' }, [
		el('div', { class: 'sys-side' }, [agentsPanel, providersPanel]),
		el('div', { class: 'sys-side' }, [memory, a2a, runtime]),
	]);

	let config: ModelProvidersConfig | null = null;

	/** Replaces the store with `next`, shows what the server now holds, and says so. */
	async function saveStore(next: ModelProvidersStoreInput, words: string): Promise<void> {
		config = await api.saveModelProviders(next);
		paintProviders();
		toast(words, 'ok');
		// D-158: the agents' model choices are the providers' models.
		void roster.load();
		onChange?.();
		// A provider's models are the memory's provider embedders: the choice list follows the providers.
		void api.memoryConfig().then((value) => paintMemory(value, null), () => {});
	}

	function providerCard(provider: ManagedProvider, manageable: boolean): HTMLElement {
		const current = config!;
		const store = storeOf(current);
		const isDefault = current.default === provider.id;
		const seeded = provider.origin === 'seed';
		const actions: HTMLElement[] = [];
		if (manageable) {
			if (!isDefault) {
				const makeDefault = iconButton('check', `Make ${provider.label} the default`, undefined, { small: true });
				on(makeDefault, 'click', () =>
					void busy(
						makeDefault,
						() => saveStore({ ...store, default: provider.id }, `${provider.label} is the default`),
					).catch((cause) => toast(messageOf(cause), 'error')));
				actions.push(makeDefault);
			}
			actions.push(
				iconButton('edit', `Edit ${provider.label}`, () =>
					openEditor(
						current,
						provider,
						(next) => saveStore(withProvider(store, next), `${provider.label} saved`),
					), { small: true }),
				confirmButton(
					{ label: `Remove ${provider.label}`, icon: 'trash', small: true, iconOnly: true },
					() => saveStore(withoutProvider(store, provider.id), `${provider.label} removed`),
				),
			);
		}
		const origin = seeded
			? tip(tag('From providers file'), 'Seeded from TTK_MODEL_PROVIDERS_FILE; the file itself is never written', 'top')
			: tip(tag('Added here', undefined, 'accent'), 'Added in the web app', 'top');
		return el('article', { class: `pv-card${isDefault ? ' default' : ''}` }, [
			el('header', { class: 'pv-card-head' }, [
				// A monogram, not a glyph: a card per provider must not repeat a glyph (FXD-N1, D-152 amended).
				el('span', { class: `pv-kind ${provider.kind}`, 'aria-hidden': 'true', text: monogram(provider.label) }),
				el('div', { class: 'pv-card-title' }, [
					el('div', { class: 'pv-card-name' }, [
						el('span', { text: provider.label }),
						...(isDefault ? [tag('default', undefined, 'ok')] : []),
					]),
					el('div', { class: 'pv-card-sub' }, [
						el('code', { class: 'mono', text: provider.id }),
						el('span', { text: provider.kind === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible' }),
						origin,
					]),
				]),
				el('span', { class: `pv-reach ${provider.reachable ? 'ok' : 'warn'}` }, [
					dot(
						provider.reachable ? 'live' : 'warn',
						provider.reachable ? 'Reachable' : provider.reason ?? 'Not reachable',
					),
					el('span', { text: provider.reachable ? 'Reachable' : 'Not reachable' }),
				]),
				el('div', { class: 'pv-card-actions' }, actions),
			]),
			el('div', { class: 'pv-card-body' }, [
				el('div', { class: 'pv-endpoint' }, [
					el('code', { class: 'mono', text: provider.base_url }),
					copyButton(() => provider.base_url, 'Copy base URL'),
				]),
				el(
					'div',
					{ class: 'pv-models' },
					provider.models.map((model) =>
						el('span', {
							class: `pv-model mono${model === provider.default_model ? ' on' : ''}`,
							text: model,
							'data-tip': model === provider.default_model ? 'Default model' : undefined,
						})
					),
				),
				el('div', { class: 'pv-meta' }, [
					el('span', { class: `pv-key-source ${provider.key.source}`, text: keyWords(provider.key) }),
					el('span', { text: `${provider.max_steps} steps` }),
					el('span', { text: `${provider.max_output_tokens.toLocaleString()} out` }),
					el('span', { text: `${provider.token_budget.toLocaleString()} budget` }),
					...(provider.allow_http ? [tag('http', undefined, 'warn')] : []),
				]),
			]),
		]);
	}

	function paintProviders(): void {
		const current = config;
		if (current === null) return;
		const manageable = current.store.available;
		const store = storeOf(current);
		// Worded, no glyph: `plus` is the origins overlay's Add on this screen (FXD-N1).
		const add = button({ label: 'Add provider', variant: 'primary', small: true });
		on(
			add,
			'click',
			() => openEditor(current, null, (next) => saveStore(withProvider(store, next), `${next.label ?? next.id} added`)),
		);
		add.disabled = !manageable;
		// A disabled button takes no pointer: the reason rides on a wrapper (the menuButton pattern).
		providersActions.replaceChildren(
			manageable
				? add
				: tip(el('span', { class: 'menu-item-gate' }, [add]), current.store.reason ?? 'Providers cannot change here'),
		);

		const vault = current.store.vault;
		const sources = el('div', { class: 'pv-sources' }, [
			sourceRow(
				'Database',
				!manageable
					? current.store.reason ?? 'Providers cannot change here.'
					: vault === 'unlocked'
					? 'Holds every provider; keys are encrypted (AES-256-GCM). Changes apply without a restart.'
					: 'Holds every provider. No TTK_DB_KEY_FILE: keys cannot be stored (doctor --new-db-key).',
				current.store.database,
				!manageable ? 'off' : vault === 'unlocked' ? 'ok' : 'locked',
			),
			sourceRow(
				'Providers file',
				current.seed.file === null
					? 'TTK_MODEL_PROVIDERS_FILE is not set: every provider is added here.'
					: current.seed.seeded_at === null
					? 'Used as is: there is no database to seed. Never written.'
					: `Seed only: copied in ${
						new Date(current.seed.seeded_at).toLocaleString()
					}; never written. seed --force copies it again.`,
				current.seed.file,
				current.seed.file === null ? 'off' : 'locked',
			),
		]);
		const list = current.providers;
		providersBody.replaceChildren(
			sources,
			list.length === 0
				? el('div', { class: 'pv-empty' }, [
					el('span', { class: 'pv-empty-title', text: 'No model providers yet' }),
					el('span', {
						class: 'pv-empty-hint',
						text: manageable
							? 'Add one — OpenAI, Anthropic, Ollama, vLLM, OpenRouter or any OpenAI-compatible endpoint.'
							: 'Set TTK_DATA_DIR to add providers here, or mount a providers file.',
					}),
				])
				: el('div', { class: 'pv-list' }, list.map((provider) => providerCard(provider, manageable))),
		);
	}

	/**
	 * D-154: the embedder new memory collections use, and what is stored per embedder (counts only). A collection keeps
	 * the embedder it was created with, so changing the default never mixes vector spaces.
	 */
	function paintMemory(value: MemoryConfig | null, error: string | null): void {
		if (value === null) {
			memoryBody.replaceChildren(el('p', { class: 'muted', text: error ?? 'Agent memory is unavailable.' }));
			return;
		}
		const picker = select(
			'pv-embedder',
			value.embedders.map((embedder) => [embedder.id, embedder.label] as const),
			value.embedder,
		);
		on(picker, 'change', () => {
			const chosen = picker.value;
			picker.disabled = true;
			void api.saveMemoryConfig(chosen).then((next) => {
				paintMemory(next, null);
				toast('Memory embedder saved', 'ok');
			}).catch((cause) => {
				picker.value = value.embedder;
				picker.disabled = false;
				toast(messageOf(cause), 'error');
			});
		});
		const items = value.totals.reduce((sum, total) => sum + total.items, 0);
		const collections = value.totals.reduce((sum, total) => sum + total.collections, 0);
		memoryBody.replaceChildren(
			factRow('Embedder for new collections', picker, false),
			factRow('Stored', `${collections} collections · ${items} items`, false),
			el('p', {
				class: 'pv-hint',
				text: 'Built-in is lexical (word overlap), offline and free. A provider model gives semantic search; list ' +
					'an embedding model (e.g. text-embedding-3-small) on an OpenAI-compatible provider to offer it here.',
			}),
		);
	}

	function paintA2a(card: AgentCard | null, error: string | null): void {
		if (card === null) {
			a2aBody.replaceChildren(el('p', { class: 'muted', text: error ?? 'The agent card could not be read.' }));
			return;
		}
		const caps = card.capabilities ?? {};
		const url = (path: string): string => new URL(path, location.origin).href;
		const endpoint = (name: string, path: string): HTMLElement =>
			factRow(
				name,
				el('span', { class: 'pv-fact-value mono pv-copy' }, [
					el('span', { text: url(path) }),
					copyButton(() => url(path), `Copy ${name}`),
				]),
			);
		a2aBody.replaceChildren(
			factRow('Agent', card.name ?? '—', false),
			endpoint('Agent card', '/.well-known/agent-card.json'),
			endpoint('JSON-RPC', '/a2a'),
			endpoint('HTTP+JSON', '/a2a/v1'),
			// D-156: the built-in coding agent's own A2A agent; its card says whether this deployment can run it.
			endpoint('SlopLord card', '/a2a/agents/sloplord/.well-known/agent-card.json'),
			endpoint('SlopLord JSON-RPC', '/a2a/agents/sloplord'),
			factRow(
				'Push notifications',
				onOff(caps.pushNotifications === true, 'Offered', 'Off — TTK_A2A_PUSH_ALLOWED_HOSTS'),
			),
			factRow(
				'Skills',
				el(
					'span',
					{ class: 'pv-skills' },
					(card.skills ?? []).map((skill) => tip(tag(skill.name ?? skill.id), skill.description ?? skill.id)),
				),
			),
		);
	}

	function paintRuntime(
		card: AgentCard | null,
		peers: string[] | null,
		actions: string[] | null,
		why: string | null,
	): void {
		const skills = new Set((card?.skills ?? []).map((skill) => skill.id));
		runtimeBody.replaceChildren(
			factRow(
				'Coding agent (ACP)',
				onOff(skills.has('external-agent'), 'Bridge configured', 'Off — TTK_AGENT_BRIDGE_URL'),
			),
			factRow('Built-in model agent', onOff(skills.has('builtin-model'), 'On', 'Off — no reachable provider')),
			factRow(
				'A2A peers',
				peers === null
					? el('span', { class: 'muted', text: why ?? 'Needs agent:invoke to read' })
					: peers.length === 0
					? onOff(false, '', 'None — TTK_AGENT_PEERS_FILE')
					: el('span', { class: 'pv-skills' }, peers.map((peer) => tag(peer))),
			),
			factRow(
				'A2UI actions',
				actions === null
					? el('span', { class: 'muted', text: why ?? 'Needs agent:invoke to read' })
					: el('span', { class: 'pv-skills' }, actions.map((name) => el('code', { class: 'pv-code', text: name }))),
			),
		);
	}

	async function load(): Promise<void> {
		void roster.load();
		const [providers, card, actions, memoryConfig] = await Promise.allSettled([
			api.modelProviders(),
			api.agentCard(),
			api.listActionNames(),
			api.memoryConfig(),
		]);
		paintMemory(
			memoryConfig.status === 'fulfilled' ? memoryConfig.value : null,
			memoryConfig.status === 'rejected' ? messageOf(memoryConfig.reason) : null,
		);
		if (providers.status === 'fulfilled') {
			config = providers.value;
			paintProviders();
		} else {
			const forbidden = providers.reason instanceof ApiError && providers.reason.status === 403;
			providersActions.replaceChildren();
			providersBody.replaceChildren(
				el('div', { class: 'pv-empty' }, [
					el('span', { class: 'pv-empty-title', text: forbidden ? 'Needs the admin scope' : 'Providers unavailable' }),
					el('span', {
						class: 'pv-empty-hint',
						text: forbidden ? 'Managing model providers is an administrator task.' : messageOf(providers.reason),
					}),
				]),
			);
		}
		const cardValue = card.status === 'fulfilled' ? card.value : null;
		paintA2a(cardValue, card.status === 'rejected' ? messageOf(card.reason) : null);
		let peers: string[] | null = null;
		let why: string | null = null;
		try {
			if ((await mcp.tools()).some((entry) => entry.name === 'agent_peers')) {
				const { result } = await invoke<{ result: { peers: Array<{ id: string }> } }>('agent_peers', {});
				peers = result.peers.map((peer) => peer.id);
			} else why = 'Needs agent:invoke to read';
		} catch (cause) {
			why = messageOf(cause);
		}
		paintRuntime(cardValue, peers, actions.status === 'fulfilled' ? actions.value.names : null, why);
	}

	return { node, load };
}
