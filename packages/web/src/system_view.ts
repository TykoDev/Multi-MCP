/**
 * System (admin), three tabs, each its own route:
 *
 * - **Overview** (`#/system`): every capability on or off at a glance, what it does, and while off the setting that
 *   turns it on.
 * - **Agents** (`#/system/agents`): the model providers the built-in agent runs on, held in the gateway's
 *   database and replaced as a whole (`PUT /api/v1/system/model-providers`) without a restart. A key typed here is
 *   sent once and sealed in the database; the page never receives it back.
 * - **Configuration** (`#/system/config`): every reported setting with its running value and its source.
 */
import {
	api,
	ApiError,
	type ManagedProvider,
	type ModelProvidersConfig,
	type ModelProvidersStoreInput,
	type ProviderInput,
	type ProviderKeyInput,
	type SystemDiagnostics,
} from './api.ts';
import {
	readingSource,
	reportedSettings,
	runningValue,
	SECTION_WORDS,
	SECTIONS,
	type Setting,
	widensReach,
} from './config_catalog.ts';
import { el, mount, on } from './dom.ts';
import { type Navigate, renderShell } from './shell.ts';
import { CAPABILITY_INFO, configRowMatches, type FeatureState, OPT_IN, optInState } from './system_facts.ts';
import {
	badge,
	busy,
	button,
	confirmButton,
	dot,
	field,
	input,
	messageOf,
	notice,
	openModal,
	poll,
	toast,
} from './ui.ts';

// --- pure --------------------------------------------------------------------------------------------------------

/** A provider as the PUT body takes it, its key as given (`keep` by default). */
function inputOf(provider: ManagedProvider, key: ProviderKeyInput = { mode: 'keep' }): ProviderInput {
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
function storeOf(config: ModelProvidersConfig): ModelProvidersStoreInput {
	return { default: config.default, providers: config.providers.map((provider) => inputOf(provider)) };
}

/** The list with one provider added or replaced (by id). */
function withProvider(store: ModelProvidersStoreInput, provider: ProviderInput): ModelProvidersStoreInput {
	const known = store.providers.some((entry) => entry.id === provider.id);
	const providers = known
		? store.providers.map((entry) => entry.id === provider.id ? provider : entry)
		: [...store.providers, provider];
	return { ...store, providers };
}

/** The list without a provider; a default that named it is cleared (a sole remaining provider becomes it). */
function withoutProvider(store: ModelProvidersStoreInput, id: string): ModelProvidersStoreInput {
	return {
		default: store.default === id ? null : store.default,
		providers: store.providers.filter((entry) => entry.id !== id),
	};
}

/** The host:port a base URL dials, scheme-defaulted, or `''` when it does not parse. */
export function netHostOf(baseUrl: string): string {
	const url = URL.parse(baseUrl);
	if (url === null) return '';
	return `${url.hostname}:${url.port !== '' ? url.port : url.protocol === 'http:' ? '80' : '443'}`;
}

/** One model per line (or comma), trimmed, duplicates dropped, order kept. */
function parseModels(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))];
}

/** How a provider's key reads in the list — never the key itself. */
function keyWords(key: ManagedProvider['key']): string {
	if (key.source === 'stored') return 'key encrypted in the database';
	if (key.source === 'file' || key.source === 'inline') return 'key in the providers file';
	return 'no key';
}

/** Starting points for a new provider. */
const PRESETS: ReadonlyArray<{
	readonly label: string;
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly baseUrl: string;
	readonly model: string;
	readonly keyless?: true;
	readonly completionTokens?: true;
}> = [
	{
		label: 'OpenAI',
		id: 'openai-main',
		kind: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4.1',
		completionTokens: true,
	},
	{
		label: 'Anthropic',
		id: 'anthropic-main',
		kind: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		model: 'claude-sonnet-5-5',
	},
	{
		label: 'Ollama',
		id: 'ollama',
		kind: 'openai',
		baseUrl: 'http://127.0.0.1:11434/v1',
		model: 'llama3.1',
		keyless: true,
	},
	{
		label: 'OpenRouter',
		id: 'openrouter',
		kind: 'openai',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'openai/gpt-4.1',
	},
];

// --- Overview ----------------------------------------------------------------------------------------------------

/** One capability tile: its name, its state in words, what it does, and while off how to turn it on. */
function tile(name: string, state: FeatureState | { value: string }, warnOff = false): HTMLElement {
	const info = CAPABILITY_INFO[name];
	const kind = 'value' in state
		? 'value'
		: 'unknown' in state
		? 'unknown'
		: state.on
		? 'on'
		: warnOff
		? 'off warn'
		: 'off';
	const words = 'value' in state
		? state.value
		: 'unknown' in state
		? 'Not reported'
		: `${state.on ? state.yes : state.no}${state.detail === undefined ? '' : ` · ${state.detail}`}`;
	const off = !('value' in state) && !('unknown' in state) && !state.on;
	return el('li', { class: `sys-cap ${kind}`, 'data-name': name, title: `${name} · ${words}` }, [
		el('div', { class: 'sys-cap-name', text: name }),
		el('div', { class: 'sys-cap-words', text: words }),
		...(info === undefined ? [] : [el('div', { class: 'muted', text: info.about })]),
		...(off && info?.enable !== undefined
			? [el('code', { class: 'sys-cap-enable', text: `Enable: ${info.enable}` })]
			: []),
	]);
}

function uptime(seconds: number): string {
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function overview(diag: SystemDiagnostics): HTMLElement[] {
	const c = diag.config as SystemDiagnostics['config'] & Record<string, unknown>;
	const chromium = typeof c.chromiumSandboxed === 'boolean' ? c.chromiumSandboxed : undefined;
	const held = typeof c.accountKeysCount === 'number' ? c.accountKeysCount : 0;
	const backend = typeof c.sandboxBackend === 'string' && /^[a-z0-9-]{1,16}$/.test(c.sandboxBackend)
		? c.sandboxBackend
		: undefined;
	const tiles = [
		tile('Admin user', { on: c.hasAdminUser, yes: 'Configured', no: 'Not set' }),
		tile(
			'Sandboxed Chromium',
			chromium === undefined ? { unknown: 'not reported' } : { on: chromium, yes: 'Isolated', no: 'Sandbox disabled' },
			true,
		),
		tile('Coding sandbox', {
			on: c.sandboxEnabled,
			yes: 'Available',
			no: 'Unavailable',
			...(backend === undefined ? {} : { detail: backend }),
		}),
		tile('Outbound egress', { on: c.egressEnabled, yes: 'Enabled', no: 'Loopback only' }),
		tile('Persistence', { on: c.persistenceEnabled, yes: 'On', no: 'Off' }),
		tile('Screencast recording', { on: c.recordingEnabled, yes: 'On', no: 'Off' }),
		tile('API keys', { value: String(c.apiKeysCount + held) }),
		...OPT_IN.map(([name, key, yes, no]) => tile(name, optInState(key, yes, no, c, diag))),
	];
	return [
		el('p', {
			class: 'muted',
			text: `Version ${diag.version} · up ${uptime(diag.uptimeSeconds)} · ${diag.sessions.total} sessions · ` +
				`public URL ${c.publicUrl}`,
		}),
		el('ul', { class: 'sys-caps' }, tiles),
	];
}

// --- Configuration -----------------------------------------------------------------------------------------------

function configTab(diag: SystemDiagnostics): HTMLElement[] {
	const query = el('input', {
		type: 'search',
		class: 'sys-filter',
		placeholder: 'Filter by variable or value',
		'aria-label': 'Filter settings',
	});
	const rows: Array<{ node: HTMLElement; name: string; value: string }> = [];
	const section = (setting: Setting): HTMLElement => {
		const running = runningValue(setting, diag.config, diag);
		const value = running.kind === 'reading' ? running.reading.text : 'not reported';
		const tags: string[] = [];
		if (running.kind === 'reading') {
			const source = readingSource(setting, running.reading, diag.config);
			if (source !== undefined) tags.push(source);
			if (widensReach(setting, running.reading.value)) tags.push('widens reach');
		}
		if (setting.kind === 'secret-file') tags.push('file-backed');
		const node = el('tr', { class: 'sys-config-row' }, [
			el('th', { scope: 'row', class: 'mono', title: setting.explain, text: setting.name }),
			el('td', { class: 'mono', text: value }),
			el('td', {}, tags.map((text) => badge(text, text === 'widens reach' ? 'warn' : ''))),
		]);
		rows.push({ node, name: setting.name, value });
		return node;
	};
	const settings = reportedSettings();
	const tables = SECTIONS.flatMap((id) => {
		const members = settings.filter((setting) => setting.section === id);
		if (members.length === 0) return [];
		return [el('table', { class: 'sys-config' }, [
			el('caption', { text: SECTION_WORDS[id] }),
			el('tbody', {}, members.map(section)),
		])];
	});
	on(query, 'input', () => {
		for (const row of rows) row.node.hidden = !configRowMatches(query.value, row.name, row.value);
	});
	return [query, ...tables];
}

// --- Model providers ---------------------------------------------------------------------------------------------

/** The provider editor; `save` receives the provider as the PUT takes it, and a refusal stays in the dialog. */
function openEditor(
	config: ModelProvidersConfig,
	existing: ManagedProvider | null,
	save: (p: ProviderInput) => Promise<void>,
): void {
	const sealable = config.store.vault === 'unlocked';
	const preset = el('select', { id: 'pv-preset' }, [
		el('option', { value: '', text: 'Custom' }),
		...PRESETS.map((entry, index) => el('option', { value: String(index), text: entry.label })),
	]);
	const id = input('pv-id', existing?.id ?? '', { placeholder: 'openai-main', readonly: existing !== null });
	const kind = el('select', { id: 'pv-kind' }, [
		el('option', { value: 'openai', text: 'OpenAI-compatible' }),
		el('option', { value: 'anthropic', text: 'Anthropic' }),
	]);
	kind.value = existing?.kind ?? 'openai';
	const label = input('pv-label', existing?.label ?? '');
	const baseUrl = input('pv-base-url', existing?.base_url ?? '', {
		type: 'url',
		placeholder: 'https://api.openai.com/v1',
	});
	const models = el('textarea', { id: 'pv-models', class: 'mono', rows: 3, spellcheck: 'false' });
	models.value = (existing?.models ?? []).join('\n');
	const defaultModel = input('pv-default-model', existing?.default_model ?? '');
	const hasKey = existing !== null && existing.key.source !== 'none';
	const keyMode = el('select', { id: 'pv-key-mode' }, [
		...(hasKey ? [el('option', { value: 'keep', text: 'Keep the current key' })] : []),
		...(sealable ? [el('option', { value: 'set', text: hasKey ? 'Replace the key' : 'Enter a key' })] : []),
		el('option', { value: 'none', text: 'No key' }),
	]);
	// `new-password`: the browser must not offer the operator's own sign-in password here.
	const keyValue = input('pv-key', '', { type: 'password', autocomplete: 'new-password', maxlength: 512 });
	const keyField = field('pv-key', 'API key', keyValue, 'Sent once, encrypted in the database, never shown again.');
	const allowHttp = el('input', { id: 'pv-allow-http', type: 'checkbox' });
	allowHttp.checked = existing?.allow_http ?? false;
	const paintKey = (): void => {
		keyField.hidden = keyMode.value !== 'set';
	};
	on(keyMode, 'change', paintKey);
	paintKey();
	let completionTokens = existing?.max_tokens_param === 'max_completion_tokens';
	on(preset, 'change', () => {
		const chosen = PRESETS[Number(preset.value)];
		if (preset.value === '' || chosen === undefined) return;
		let candidate = chosen.id;
		for (let n = 2; config.providers.some((p) => p.id === candidate); n++) candidate = `${chosen.id}-${n}`;
		id.value = candidate;
		kind.value = chosen.kind;
		label.value = chosen.label;
		baseUrl.value = chosen.baseUrl;
		models.value = chosen.model;
		defaultModel.value = chosen.model;
		completionTokens = chosen.completionTokens === true;
		keyMode.value = chosen.keyless || !sealable ? 'none' : 'set';
		paintKey();
	});
	const keyInput = (): ProviderKeyInput =>
		keyMode.value === 'set'
			? { mode: 'set', value: keyValue.value.trim() }
			: keyMode.value === 'keep'
			? { mode: 'keep' }
			: { mode: 'none' };
	const fetchModels = button({ label: 'Fetch models', icon: 'refresh', small: true });
	on(fetchModels, 'click', () =>
		void busy(fetchModels, async () => {
			const listed = await api.listProviderModels({
				id: id.value.trim() || 'draft',
				kind: kind.value === 'anthropic' ? 'anthropic' : 'openai',
				base_url: baseUrl.value.trim(),
				allow_http: allowHttp.checked,
				...(existing === null || Object.keys(existing.headers).length === 0 ? {} : { headers: existing.headers }),
				key: keyInput(),
			});
			models.value = [...new Set([...parseModels(models.value), ...listed.models])].join('\n');
		}).catch((cause) => toast(messageOf(cause), 'error')));
	const failure = el('p', { class: 'notice danger', role: 'alert', hidden: true });
	const submit = button({
		label: existing === null ? 'Add provider' : 'Save provider',
		variant: 'primary',
		type: 'submit',
	});
	const form = el('form', { class: 'form' }, [
		...(existing === null ? [field('pv-preset', 'Start from', preset)] : []),
		field('pv-id', 'Id', id, 'Lowercase letters, digits, - and _; it cannot change later.'),
		field('pv-kind', 'Kind', kind),
		field('pv-label', 'Label', label),
		field('pv-base-url', 'Base URL', baseUrl, 'https for remote hosts; http only on loopback or with Allow http.'),
		field('pv-models', 'Models (one per line)', models),
		el('div', { class: 'actions' }, [fetchModels]),
		field('pv-default-model', 'Default model', defaultModel),
		field('pv-key-mode', 'Key', keyMode),
		keyField,
		...(sealable ? [] : [notice('Keys cannot be stored: TTK_DB_KEY_FILE is not set.')]),
		el('label', { class: 'check', for: 'pv-allow-http' }, [
			allowHttp,
			el('span', { text: 'Allow http to a private or named host (the key is then sent in plaintext)' }),
		]),
		failure,
		el('div', { class: 'actions' }, [submit]),
	]);
	const dialog = openModal(existing === null ? 'Add model provider' : `Edit ${existing.label}`, [form]);
	// The typed key lives in this one field and goes with the dialog, whatever closed it.
	dialog.node.addEventListener('wa-after-hide', (event) => {
		if (event.target === dialog.node) keyValue.value = '';
	});
	on(form, 'submit', (event) => {
		event.preventDefault();
		failure.hidden = true;
		const list = parseModels(models.value);
		const problem = list.length === 0
			? 'Name at least one model'
			: keyMode.value === 'set' && keyValue.value.trim() === ''
			? 'Enter the API key, or choose No key'
			: existing !== null && keyMode.value === 'keep' && netHostOf(baseUrl.value) !== netHostOf(existing.base_url)
			? 'The endpoint moved to a new host: enter the key again, or choose No key'
			: '';
		if (problem !== '') {
			failure.textContent = problem;
			failure.hidden = false;
			return;
		}
		const base = existing === null ? {} : inputOf(existing);
		const provider: ProviderInput = {
			...base,
			id: id.value.trim(),
			kind: kind.value === 'anthropic' ? 'anthropic' : 'openai',
			...(label.value.trim() === '' ? {} : { label: label.value.trim() }),
			base_url: baseUrl.value.trim(),
			models: list,
			default_model: list.includes(defaultModel.value.trim()) ? defaultModel.value.trim() : list[0]!,
			allow_http: allowHttp.checked,
			...(completionTokens ? { max_tokens_param: 'max_completion_tokens' as const } : {}),
			key: keyInput(),
		};
		void busy(submit, async () => {
			await save(provider);
			dialog.close();
		}).catch((cause) => {
			failure.textContent = messageOf(cause);
			failure.hidden = false;
		});
	});
	(existing === null ? preset : label).focus();
}

function providersTab(): HTMLElement {
	const node = el('div', { class: 'sys-providers' });
	async function load(): Promise<void> {
		let config: ModelProvidersConfig;
		try {
			config = await api.modelProviders();
		} catch (cause) {
			node.replaceChildren(notice(`Could not read the model providers: ${messageOf(cause)}`));
			return;
		}
		const save = async (store: ModelProvidersStoreInput, words: string): Promise<void> => {
			await api.saveModelProviders(store);
			toast(words, 'ok');
			await load();
		};
		const writable = config.store.available;
		const add = button({
			label: 'Add provider',
			icon: 'plus',
			variant: 'primary',
			onClick: () =>
				openEditor(config, null, (provider) => save(withProvider(storeOf(config), provider), `${provider.id} added`)),
		});
		add.disabled = !writable;
		const rows = config.providers.map((provider) => {
			const isDefault = config.default === provider.id;
			const edit = button({
				label: 'Edit',
				icon: 'edit',
				small: true,
				onClick: () =>
					openEditor(config, provider, (next) => save(withProvider(storeOf(config), next), `${next.id} saved`)),
			});
			const makeDefault = button({ label: 'Make default', icon: 'check', small: true });
			on(
				makeDefault,
				'click',
				() =>
					void busy(
						makeDefault,
						() => save({ ...storeOf(config), default: provider.id }, `${provider.id} is the default`),
					)
						.catch((cause) => toast(messageOf(cause), 'error')),
			);
			const remove = confirmButton(
				{ label: `Remove ${provider.label}`, icon: 'trash', iconOnly: true, small: true },
				() => save(withoutProvider(storeOf(config), provider.id), `${provider.id} removed`),
			);
			edit.disabled = makeDefault.disabled = remove.disabled = !writable;
			makeDefault.hidden = isDefault;
			return el('li', { class: 'sys-provider', 'data-provider': provider.id }, [
				el('div', { class: 'sys-provider-head' }, [
					dot(
						provider.reachable ? 'ok' : 'warn',
						provider.reachable ? 'Reachable' : provider.reason ?? 'Not reachable',
					),
					el('strong', { text: provider.label }),
					el('code', { class: 'mono muted', text: provider.id }),
					...(isDefault ? [badge('default', 'accent')] : []),
				]),
				el('p', {
					class: 'muted',
					text:
						`${provider.kind} · ${provider.host} · ${provider.models.length} models, default ${provider.default_model} · ${
							keyWords(provider.key)
						}${provider.reachable ? '' : ` · ${provider.reason ?? 'not reachable'}`}`,
				}),
				el('div', { class: 'actions' }, [makeDefault, edit, remove]),
			]);
		});
		node.replaceChildren(
			...(writable ? [] : [notice(`The providers cannot be changed here: ${config.store.reason ?? 'no database'}.`)]),
			...(config.store.vault === 'locked'
				? [notice('Keys cannot be stored: TTK_DB_KEY_FILE is not set.', 'info')]
				: []),
			el('div', { class: 'actions' }, [add]),
			rows.length === 0 ? el('p', { class: 'muted', text: 'No model provider yet.' }) : el('ul', {}, rows),
		);
	}
	void load();
	return node;
}

export function systemView(navigate: Navigate, tab?: string): void {
	const active = tab === 'agents' || tab === 'config' ? tab : 'overview';
	const content = el('div', { class: `sys-${active}` });
	mount(renderShell(navigate, {
		active: 'system',
		title: 'System',
		tabs: {
			active,
			items: [
				{ id: 'overview', label: 'Overview', route: '#/system' },
				{ id: 'agents', label: 'Agents', route: '#/system/agents' },
				{ id: 'config', label: 'Configuration', route: '#/system/config' },
			],
		},
	}, [content]));
	if (active === 'agents') {
		content.append(providersTab());
		return;
	}
	const load = (): void => {
		api.diagnostics().then((diag) => {
			content.replaceChildren(...(active === 'config' ? configTab(diag) : overview(diag)));
		}).catch((cause) => {
			content.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'The System screen needs the admin scope.'
					: `Could not read the diagnostics: ${messageOf(cause)}`,
			));
		});
	};
	load();
	// The Overview follows the gateway; the configuration is read once, so a filter being typed is never reset.
	if (active === 'overview') poll(content, 10_000, load);
}
