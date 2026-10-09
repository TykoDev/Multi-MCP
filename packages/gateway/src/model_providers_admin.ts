/**
 * D-154 (owner-requested; replaces D-153's JSON store and plaintext key files): model providers live in the database.
 *
 * ## One source in force
 *
 * The database's `model_providers` table is the set in force and the only allowlist for model hosts:
 * every row is judged by the providers file's own parser (`parseModelProviders`), so every `base_url`, header,
 * `allow_http` and key rule applies unchanged, and a refusal is the parser's phrase — never a value. The operator's
 * `TTK_MODEL_PROVIDERS_FILE` is a **seed** (`seed.ts`): copied in once, when the table was never seeded and is empty,
 * and again only by `seed --force`. The file is never written. Without a data directory there is no database, and
 * the file's providers are used directly and cannot be changed here (`409 persistence-required`).
 *
 * ## Keys are sealed, write-only, and stay with their host
 *
 * A provider's key is a vault row (`vault.ts`) named `model-provider/<id>`, AES-256-GCM sealed with the provider's net
 * host (`providerNetHost`) as additional data, so a ciphertext copied to another provider or host does not open.
 * - `set`: the typed key is judged by the parser's key rules, sealed, and never returned, logged or echoed.
 * - `keep`: the stored key, refused when the provider's net host changes — a key never follows a provider elsewhere.
 * - `none`: the stored key, if any, is deleted.
 * Storing a key needs `TTK_DB_KEY_FILE`; without it a `set` is refused (`409 conflict`) and nothing is written.
 *
 * Writes are serialised on one queue and each lands in one transaction. Node-local: nothing is replicated.
 */
import { anthropicClient, ModelProviderError, openAiClient } from '@tykotech/agents';
import * as z from 'zod';
import { type Database, now } from './database.ts';
import { modelGrantProven, providerNetHost } from './expansion.ts';
import { serviceUrl } from './expansion_config.ts';
import {
	ID_PATTERN,
	locate,
	MODEL_PROVIDERS_FILE_MAX_BYTES,
	type ModelProvidersConfig,
	type ModelProviderSettings,
	parseModelProviders,
	phraseOf,
	type ProviderView,
} from './model_providers.ts';
import { HttpProblem } from './problem.ts';
import type { Sealed, Vault } from './vault.ts';

/** The PUT body cap: the providers file's own (128 KiB). */
export const MODEL_PROVIDERS_BODY_BYTES = MODEL_PROVIDERS_FILE_MAX_BYTES;

/** The most providers in force at once — the providers file's own limit. */
export const MAX_PROVIDERS = 16;

/** The vault row that holds provider `id`'s key. */
export function providerKeyName(id: string): string {
	return `model-provider/${id}`;
}

/** The `settings` row that holds the default provider id. */
export const DEFAULT_PROVIDER_SETTING = 'model_providers.default';

// --- the body (shape only; every value rule is the parser's, so its refusal names the field the same way) ----------

const KeyChoiceSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('keep') }).strict(),
	// Bounded here only to cap work; the parser's key rules (1–512 characters, no whitespace, not the composer
	// placeholder) are applied before anything is sealed.
	z.object({ mode: z.literal('set'), value: z.string().min(1).max(4096) }).strict(),
	z.object({ mode: z.literal('none') }).strict(),
]);

const ProviderInputSchema = z.object({
	id: z.string().max(64),
	kind: z.enum(['openai', 'anthropic']),
	label: z.string().max(256).optional(),
	base_url: z.string().max(4096),
	models: z.array(z.string().max(256)).max(128),
	default_model: z.string().max(256).optional(),
	headers: z.record(z.string().max(256), z.string().max(4096)).optional(),
	allow_http: z.boolean().optional(),
	max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
	max_steps: z.number().int().optional(),
	max_output_tokens: z.number().int().optional(),
	token_budget: z.number().int().optional(),
	key: KeyChoiceSchema,
}).strict();

/** `PUT /api/v1/system/model-providers`: the whole provider list, replacing it. Strict: no inline key field exists. */
export const ModelProvidersPutSchema = z.object({
	default: z.string().max(64).nullable().optional(),
	providers: z.array(ProviderInputSchema).max(64),
}).strict();

/**
 * D-158: `POST /api/v1/system/model-providers/models` — a provider as the editor holds it, for listing its models. The
 * `models` list is not part of it: that is what the answer fills in.
 */
export const ModelsProbeSchema = z.object({
	id: z.string().max(64),
	kind: z.enum(['openai', 'anthropic']),
	base_url: z.string().max(4096),
	headers: z.record(z.string().max(256), z.string().max(4096)).optional(),
	allow_http: z.boolean().optional(),
	key: KeyChoiceSchema,
}).strict();

/** D-158: how long a model list may take, end to end — the picker waits on it, so far less than a task's call. */
export const MODELS_PROBE_TIMEOUT_MS = 20_000;

/** D-158: the answer of the model-list probe. */
export interface ModelsProbeAnswer {
	readonly models: readonly string[];
}

/** A validated PUT body. */
export type ModelProvidersPut = z.infer<typeof ModelProvidersPutSchema>;
type ProviderInput = ModelProvidersPut['providers'][number];

/** The optional fields a body may carry, in the order a row stores them. */
const PASSTHROUGH_FIELDS = [
	'headers',
	'allow_http',
	'max_tokens_param',
	'max_steps',
	'max_output_tokens',
	'token_budget',
] as const satisfies readonly (keyof ProviderInput)[];

// --- the read-back ------------------------------------------------------------------------------------------------

/** Where a provider row came from: the providers file (`seed`), or the web app (`admin`). */
export type ProviderOrigin = 'seed' | 'admin';

/** One provider in force, as the control plane reads it: effective values, origin, whether a key is stored. */
export interface ModelProviderAdminView {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly label: string;
	readonly base_url: string;
	readonly models: readonly string[];
	readonly default_model: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly allow_http: boolean;
	readonly max_tokens_param: 'max_tokens' | 'max_completion_tokens';
	readonly max_steps: number;
	readonly max_output_tokens: number;
	readonly token_budget: number;
	readonly origin: ProviderOrigin;
	/** `stored`: sealed in the vault, never shown. `file`/`inline`: read from the providers file (no database). */
	readonly key: { readonly source: 'stored' | 'file' | 'inline' | 'none' };
	/** `host:port`, the `--allow-net` spelling the grant proof queried. */
	readonly host: string;
	readonly reachable: boolean;
	readonly reason?: 'no-net-grant';
}

/** `GET /api/v1/system/model-providers` (and the `PUT` answer). */
export interface ModelProvidersDocument {
	/** The providers file: a seed, never written. `seeded_at` is when the database last took it in. */
	readonly seed: { readonly file: string | null; readonly seeded_at: string | null };
	readonly store: {
		/** Whether a `PUT` can be honoured now; `reason` says why not. */
		readonly available: boolean;
		readonly reason?: string;
		/** The database file, or `null` without a data directory. */
		readonly database: string | null;
		/** `unlocked`: keys can be stored. `locked`: no `TTK_DB_KEY_FILE`. `none`: no database. */
		readonly vault: 'unlocked' | 'locked' | 'none';
	};
	readonly default: string | null;
	readonly providers: readonly ModelProviderAdminView[];
}

export interface ModelProvidersAdminOptions {
	/** `Config.modelProviders`: the providers file as the CLI resolved it, or `null` without one. */
	readonly operator: ModelProvidersConfig | null;
	/** The database and its vault, or `null` without a data directory. */
	readonly store: { readonly db: Database; readonly vault: Vault } | null;
	readonly logger?: { warn(message: string): void; info(message: string): void };
}

/** What the composition root hands the store once the expansion exists. */
export interface ModelProvidersAttachment {
	/** Installs a set in the running process (`ExpansionServices.applyModelProviders`). */
	readonly apply?: (next: ModelProvidersConfig) => void;
	/** The provider views in force (`ExpansionServices.modelProviders.providers`), for `host` and `reachable`. */
	readonly views: () => readonly ProviderView[];
}

/** One `model_providers` row as read. */
interface ProviderRow {
	readonly id: string;
	readonly origin: ProviderOrigin;
	/** The providers-file entry without its key. */
	readonly entry: Record<string, unknown>;
	/** The net host the stored key is sealed to, or `null` when no key is stored. */
	readonly keyHost: string | null;
}

/** A candidate judged: the set it yields and what to write for it. */
interface Candidate {
	readonly config: ModelProvidersConfig;
	readonly rows: readonly ProviderRow[];
	readonly sealed: readonly Sealed[];
	readonly warnings: readonly string[];
}

/**
 * The model providers in force and the control plane's management of them (D-154).
 *
 * Built by {@linkcode ModelProvidersAdmin.load} before the gateway composes the runtime (its set is the runtime's
 * initial one), then {@linkcode ModelProvidersAdmin.attach}ed to the expansion that installs every change.
 */
export class ModelProvidersAdmin {
	readonly #operator: ModelProvidersConfig | null;
	readonly #db: Database | null;
	readonly #vault: Vault | null;
	readonly #logger: { warn(message: string): void; info(message: string): void } | undefined;
	#loaded = false;
	/** The parser's phrase for stored rows it did not admit; the set is then empty until a write replaces them. */
	#rejected: string | null = null;
	#rows: readonly ProviderRow[] = [];
	#config: ModelProvidersConfig | null;
	#apply: ((next: ModelProvidersConfig) => void) | undefined;
	#views: () => readonly ProviderView[] = () => [];
	#queue: Promise<void> = Promise.resolve();

	private constructor(options: ModelProvidersAdminOptions) {
		this.#operator = options.operator;
		this.#db = options.store?.db ?? null;
		this.#vault = options.store?.vault ?? null;
		this.#logger = options.logger;
		// Without a database the providers file is the set in force, used directly as before D-154.
		this.#config = this.#db === null ? options.operator : null;
	}

	/**
	 * Reads and judges the stored providers (opening their keys). Never throws for the rows' content: rows the parser
	 * refuses are logged by phrase and offer nothing until a write replaces them.
	 */
	static async load(options: ModelProvidersAdminOptions): Promise<ModelProvidersAdmin> {
		const admin = new ModelProvidersAdmin(options);
		admin.#loaded = true;
		if (admin.#db !== null) await admin.#load();
		return admin;
	}

	/** A store that was not loaded (an app composed without `startGateway`): the file's providers, writes refused. */
	static unloaded(options: ModelProvidersAdminOptions): ModelProvidersAdmin {
		const admin = new ModelProvidersAdmin({ ...options, store: null });
		return admin;
	}

	/** The set in force, or `null` when no provider is configured. */
	effective(): ModelProvidersConfig | null {
		const config = this.#config;
		if (config === null) return null;
		// A database with no rows is still managed: an empty set (not `null`) keeps the agent's routes composed.
		return config.providers.length === 0 && this.#db === null ? null : config;
	}

	/** Binds the expansion that installs every change and shows reachability. */
	attach(attachment: ModelProvidersAttachment): void {
		this.#apply = attachment.apply;
		this.#views = attachment.views;
	}

	/** The read-back: seed, store, and every provider in force. Never a key. */
	document(): ModelProvidersDocument {
		const refusal = this.#refusal();
		const views = new Map(this.#views().map((view) => [view.id, view]));
		const origins = new Map(this.#rows.map((row) => [row.id, row.origin]));
		const config = this.#config;
		return {
			seed: {
				file: this.#operator?.file ?? null,
				seeded_at: this.#db?.setting(PROVIDERS_SEED_MARKER) ?? null,
			},
			store: {
				available: refusal === undefined,
				...(refusal === undefined ? {} : { reason: refusal.reason }),
				database: this.#db?.path ?? null,
				vault: this.#vault === null ? 'none' : this.#vault.unlocked ? 'unlocked' : 'locked',
			},
			default: config?.default ?? null,
			providers: (config?.providers ?? []).map((settings) =>
				adminView(settings, views.get(settings.id), origins.get(settings.id) ?? 'seed')
			),
		};
	}

	/**
	 * Validates `body`, writes it in one transaction (sealed keys with it) and installs the set live. Every refusal is
	 * an {@linkcode HttpProblem}: `409 persistence-required` without a database, `409 conflict` when nothing can be
	 * written now (or a key cannot be sealed), `400 invalid-request` for a body the parser refuses.
	 */
	replace(body: unknown): Promise<ModelProvidersDocument> {
		const refusal = this.#refusal();
		if (refusal !== undefined) return Promise.reject(new HttpProblem(refusal.slug, refusal.reason));
		const parsed = ModelProvidersPutSchema.safeParse(body);
		if (!parsed.success) {
			const issue = parsed.error.issues[0]!;
			return Promise.reject(new HttpProblem('invalid-request', `${phraseOf(issue)}, ${locate(issue.path)}`));
		}
		const run = this.#queue.then(() => this.#write(parsed.data));
		// The chain survives a refused write: one bad body must not reject every write queued behind it.
		this.#queue = run.then(() => {}, () => {});
		return run;
	}

	/**
	 * D-158: lists the models the provider in `body` serves (`GET …/models`), for the editor's picker. It dials only a
	 * host a provider in force already names — the set in force stays the only allowlist for model hosts, so a new host
	 * is listed once it is saved — and only with the process's net grant for it. The draft is judged by the providers
	 * file's parser like a saved row (`base_url`, `allow_http`, headers, key rules). Its key: `set` is used for this one
	 * call and never stored; `keep` opens the stored key only while the host is the one it is sealed to; `none` sends
	 * none. A provider failure is `503 service-unavailable` with the transport's text (a status and a hint, never a
	 * body); a provider without a model list (404) is told to type its models by hand.
	 */
	async models(body: unknown, fetchImpl?: typeof fetch): Promise<ModelsProbeAnswer> {
		const refusal = this.#refusal();
		if (refusal !== undefined) throw new HttpProblem(refusal.slug, refusal.reason);
		const parsed = ModelsProbeSchema.safeParse(body);
		if (!parsed.success) {
			const issue = parsed.error.issues[0]!;
			throw new HttpProblem('invalid-request', `${phraseOf(issue)}, ${locate(issue.path)}`);
		}
		const probe = parsed.data;
		if (!ID_PATTERN.test(probe.id)) throw new HttpProblem('invalid-request', 'malformed, field id');
		const host = netHostOf(probe.base_url);
		const allowed = new Set((this.#config?.providers ?? []).map((settings) => providerNetHost(settings)));
		if (host !== null && !allowed.has(host)) {
			throw new HttpProblem(
				'conflict',
				'models are listed only from the host of a saved provider: save the provider, then reload its models',
			);
		}
		let key: string | null = null;
		if (probe.key.mode === 'set') key = probe.key.value;
		else if (probe.key.mode === 'keep') {
			const existing = this.#rows.find((row) => row.id === probe.id);
			if (existing?.keyHost !== null && existing?.keyHost !== undefined) {
				if (host !== existing.keyHost) {
					throw new HttpProblem('invalid-request', 'a kept key cannot follow its provider to another host, field key');
				}
				if (!this.#vault!.unlocked) throw new HttpProblem('conflict', LOCKED_REASON);
				key = await this.#vault!.get(providerKeyName(probe.id), existing.keyHost);
			}
		}
		// The parser judges the draft as it would a saved row; `models` is a placeholder it requires and nothing reads.
		const entry: Record<string, unknown> = {
			id: probe.id,
			kind: probe.kind,
			base_url: probe.base_url,
			models: ['probe'],
		};
		if (probe.headers !== undefined) entry.headers = probe.headers;
		if (probe.allow_http !== undefined) entry.allow_http = probe.allow_http;
		const row: ProviderRow = { id: probe.id, origin: 'admin', entry, keyHost: null };
		let settings: ModelProviderSettings;
		try {
			const judged = await judge([row], key === null ? new Map() : new Map([[probe.id, key]]), null, []);
			settings = judged.providers[0]!;
		} catch (cause) {
			if (cause instanceof HttpProblem && cause.detail !== undefined) {
				// One draft, so no entry number; the parser's `api_key` is the body's `key`.
				const detail = cause.detail.replace(/, field (api_key_file|api_key)$/, ', field key');
				throw new HttpProblem(cause.slug, detail.replace(', entry 1,', ','));
			}
			throw cause;
		}
		if (modelGrantProven([settings]).get(settings.id) !== true) {
			throw new HttpProblem('conflict', 'this process has no outbound net grant for the provider host');
		}
		const options = { settings, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) };
		const client = settings.kind === 'anthropic' ? anthropicClient(options) : openAiClient(options);
		try {
			return { models: await client.listModels!(AbortSignal.timeout(MODELS_PROBE_TIMEOUT_MS)) };
		} catch (cause) {
			if (cause instanceof ModelProviderError) {
				throw new HttpProblem(
					'service-unavailable',
					cause.status === 404
						? 'the provider does not list its models (404): type them by hand'
						: cause.kind === 'malformed'
						? 'the provider answered without a model list: type the models by hand'
						: cause.message,
				);
			}
			if (cause instanceof DOMException && cause.name === 'TimeoutError') {
				throw new HttpProblem('service-unavailable', 'the provider did not list its models in time');
			}
			throw cause;
		}
	}

	async #load(): Promise<void> {
		const rows = readRows(this.#db!);
		this.#rows = rows;
		const defaultId = this.#db!.setting(DEFAULT_PROVIDER_SETTING);
		try {
			const keys = new Map<string, string>();
			for (const row of rows) {
				if (row.keyHost === null) continue;
				const key = await this.#vault!.get(providerKeyName(row.id), row.keyHost);
				if (key !== null) keys.set(row.id, key);
			}
			const warnings: string[] = [];
			this.#config = await judge(rows, keys, defaultId, warnings);
			for (const line of warnings) this.#logger?.warn(line);
			this.#logger?.info(`model providers: ${rows.length} in the database`);
		} catch (cause) {
			const detail = cause instanceof HttpProblem ? cause.detail ?? 'refused' : 'a stored key does not open';
			this.#rejected = detail;
			this.#config = { default: null, providers: [] };
			this.#logger?.warn(
				`the stored model providers are not admitted (${detail}); none is offered until they are saved again`,
			);
		}
	}

	async #write(input: ModelProvidersPut): Promise<ModelProvidersDocument> {
		const refusal = this.#refusal();
		if (refusal !== undefined) throw new HttpProblem(refusal.slug, refusal.reason);
		const candidate = await this.#candidate(input);
		const db = this.#db!;
		const vault = this.#vault!;
		const kept = new Set(candidate.rows.filter((row) => row.keyHost !== null).map((row) => row.id));
		db.transaction(() => {
			db.run('DELETE FROM model_providers');
			const stamp = now();
			for (const [position, row] of candidate.rows.entries()) {
				db.run(
					'INSERT INTO model_providers (id, position, origin, entry, key_host, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
					row.id,
					position,
					row.origin,
					JSON.stringify(row.entry),
					row.keyHost,
					stamp,
				);
			}
			for (const sealed of candidate.sealed) vault.write(sealed);
			// A key no row references any more is deleted with the change that dropped it.
			for (const name of vault.names('model-provider/')) {
				if (!kept.has(name.slice('model-provider/'.length))) vault.delete(name);
			}
			db.setSetting(DEFAULT_PROVIDER_SETTING, input.default ?? null);
		});
		// Installed after the commit: should the install throw, the database still holds what the next start loads.
		this.#apply!(candidate.config);
		this.#rows = candidate.rows;
		this.#config = candidate.config;
		this.#rejected = null;
		for (const line of candidate.warnings) this.#logger?.warn(line);
		return this.document();
	}

	/** The body judged: rows to store, keys to seal, and the parser's set — or the first refusal, by field. */
	async #candidate(input: ModelProvidersPut): Promise<Candidate> {
		if (input.providers.length > MAX_PROVIDERS) {
			throw new HttpProblem('invalid-request', `more than ${MAX_PROVIDERS} providers, field providers`);
		}
		const current = new Map(this.#rows.map((row) => [row.id, row]));
		const vault = this.#vault!;
		const rows: ProviderRow[] = [];
		const keys = new Map<string, string>();
		const toSeal: Array<{ id: string; value: string; host: string }> = [];
		for (const [index, provider] of input.providers.entries()) {
			const fail = (field: string, phrase: string): HttpProblem =>
				new HttpProblem('invalid-request', `${phrase}, entry ${index + 1}, field ${field}`);
			// The id names the key's vault row, so it is judged before anything is built from it — as the parser would.
			if (!ID_PATTERN.test(provider.id)) throw fail('id', 'malformed');
			const entry: Record<string, unknown> = { id: provider.id, kind: provider.kind };
			if (provider.label !== undefined) entry.label = provider.label;
			entry.base_url = provider.base_url;
			entry.models = [...provider.models];
			if (provider.default_model !== undefined) entry.default_model = provider.default_model;
			for (const field of PASSTHROUGH_FIELDS) {
				if (provider[field] !== undefined) entry[field] = provider[field];
			}
			const existing = current.get(provider.id);
			const next = netHostOf(provider.base_url);
			let keyHost: string | null = null;
			if (provider.key.mode === 'keep') {
				if (existing === undefined) throw fail('key', 'key mode keep names no stored provider');
				if (existing.keyHost !== null) {
					// An unparsable new URL is left to the parser, which refuses it by its own phrase.
					if (next !== null && next !== existing.keyHost) {
						throw fail('key', 'a kept key cannot follow its provider to another host');
					}
					if (!vault.unlocked) throw new HttpProblem('conflict', LOCKED_REASON);
					const key = await vault.get(providerKeyName(provider.id), existing.keyHost);
					if (key !== null) {
						keys.set(provider.id, key);
						keyHost = existing.keyHost;
					}
				}
			} else if (provider.key.mode === 'set') {
				if (!vault.unlocked) throw new HttpProblem('conflict', LOCKED_REASON);
				keys.set(provider.id, provider.key.value);
				// A URL that does not parse is refused by the parser below, before anything is sealed.
				if (next !== null) {
					keyHost = next;
					toSeal.push({ id: provider.id, value: provider.key.value, host: next });
				}
			}
			rows.push({ id: provider.id, origin: existing?.origin ?? 'admin', entry, keyHost });
		}
		const warnings: string[] = [];
		let config: ModelProvidersConfig;
		try {
			config = await judge(rows, keys, input.default ?? null, warnings);
		} catch (cause) {
			// The parser names a key `api_key`; the body names it `key.value` (set) or `key`.
			if (cause instanceof HttpProblem && cause.detail !== undefined) {
				throw new HttpProblem(cause.slug, keyFieldOf(cause.detail, input.providers));
			}
			throw cause;
		}
		const sealed: Sealed[] = [];
		for (const item of toSeal) sealed.push(await vault.seal(providerKeyName(item.id), item.value, item.host));
		return { config, rows, sealed, warnings };
	}

	/** Why the providers cannot be changed right now, and the problem that says so; `undefined` when they can. */
	#refusal(): { slug: 'persistence-required' | 'conflict'; reason: string } | undefined {
		if (this.#db === null) {
			return {
				slug: 'persistence-required',
				reason: 'TTK_DATA_DIR is not set, so there is no database for providers; the providers file is used as is',
			};
		}
		if (!this.#loaded) return { slug: 'conflict', reason: 'the model providers were not loaded' };
		if (this.#apply === undefined) {
			return { slug: 'conflict', reason: 'the built-in agent is not composed with the provider store' };
		}
		return undefined;
	}
}

/** Why a key cannot be stored or kept: the vault has no key. */
const LOCKED_REASON = 'TTK_DB_KEY_FILE is not set, so a provider key cannot be stored encrypted (doctor --new-db-key)';

/** The `settings` row that records when the providers file was last seeded in (`seed.ts`). */
export const PROVIDERS_SEED_MARKER = 'seed.model_providers';

/** Every provider row, in order. */
export function readRows(db: Database): ProviderRow[] {
	return db.all('SELECT id, origin, entry, key_host FROM model_providers ORDER BY position').map((row) => ({
		id: String(row.id),
		origin: row.origin === 'admin' ? 'admin' : 'seed',
		entry: JSON.parse(String(row.entry)) as Record<string, unknown>,
		keyHost: row.key_host === null ? null : String(row.key_host),
	}));
}

/**
 * Rows (with their opened keys) judged by the providers file's parser. An empty list is an empty set, not a refusal:
 * the database may legitimately hold no providers. Keys come back as `stored`.
 */
async function judge(
	rows: readonly ProviderRow[],
	keys: ReadonlyMap<string, string>,
	defaultId: string | null,
	warnings: string[],
): Promise<ModelProvidersConfig> {
	const invalid = (detail: string): HttpProblem => new HttpProblem('invalid-request', detail);
	if (rows.length === 0) {
		if (defaultId !== null) throw invalid('default names no listed provider, field default');
		return { default: null, providers: [] };
	}
	const document = {
		version: 1,
		...(defaultId === null ? {} : { default: defaultId }),
		providers: rows.map((row) => {
			const key = keys.get(row.id);
			return key === undefined ? row.entry : { ...row.entry, api_key: key };
		}),
	};
	const parsed = await parseModelProviders(document, invalid, {
		// A row never names a key file; one that did would be a hand edit, refused rather than read.
		readFile: () => Promise.reject(new Error('a stored provider names no key file')),
		warn: (line) => warnings.push(line),
	});
	return {
		default: parsed.default,
		providers: parsed.providers.map((settings) =>
			settings.keySource === 'inline' ? { ...settings, keySource: 'stored' as const } : settings
		),
	};
}

/** A raw `base_url`'s net host as the grant proof spells it (`providerNetHost`), or `null` when it does not parse. */
export function netHostOf(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	try {
		const baseUrl = serviceUrl(raw);
		return providerNetHost({ host: new URL(baseUrl).host, baseUrl });
	} catch {
		return null;
	}
}

/** The parser's `api_key` field renamed to the body's: `key.value` (set) or `key`. */
function keyFieldOf(detail: string, inputs: readonly ProviderInput[]): string {
	const match = /, entry (\d+), field (api_key_file|api_key)$/.exec(detail);
	if (match === null) return detail;
	const mode = inputs[Number(match[1]) - 1]?.key.mode;
	return `${detail.slice(0, match.index)}, entry ${match[1]}, field ${mode === 'set' ? 'key.value' : 'key'}`;
}

/** One provider's read-back: the settings in force, its origin, the proof's answer for it, whether a key is stored. */
function adminView(
	settings: ModelProviderSettings,
	view: ProviderView | undefined,
	origin: ProviderOrigin,
): ModelProviderAdminView {
	return {
		id: settings.id,
		kind: settings.kind,
		label: settings.label,
		base_url: settings.baseUrl,
		models: [...settings.models],
		default_model: settings.defaultModel,
		headers: { ...settings.headers },
		allow_http: settings.allowHttp,
		max_tokens_param: settings.maxTokensParam,
		max_steps: settings.maxSteps,
		max_output_tokens: settings.maxOutputTokens,
		token_budget: settings.tokenBudget,
		origin,
		// Where the key comes from — never the key.
		key: { source: settings.keySource },
		host: view?.host ?? settings.host,
		// Fail-closed: a provider the proof has not answered for is not reachable.
		reachable: view?.reachable === true,
		...(view?.reason === undefined ? {} : { reason: view.reason }),
	};
}

/**
 * A providers-file setting as a row's entry (no key): what `seed.ts` stores, in the file's field order. Defaults are
 * written out, so a later change of a default does not silently change a stored provider.
 */
export function entryOf(settings: ModelProviderSettings): Record<string, unknown> {
	return {
		id: settings.id,
		kind: settings.kind,
		label: settings.label,
		base_url: settings.baseUrl,
		models: [...settings.models],
		default_model: settings.defaultModel,
		...(Object.keys(settings.headers).length === 0 ? {} : { headers: { ...settings.headers } }),
		...(settings.allowHttp ? { allow_http: true } : {}),
		max_tokens_param: settings.maxTokensParam,
		max_steps: settings.maxSteps,
		max_output_tokens: settings.maxOutputTokens,
		token_budget: settings.tokenBudget,
	};
}
