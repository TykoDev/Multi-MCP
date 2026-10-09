/**
 * D-154 (owner-requested): the agents' vector memory, in the gateway database (`database.ts`).
 *
 * The built-in model agent acts only through the MCP tool list, so memory is offered as tools (`memory_tools.ts`)
 * over this store. Nothing here loads a native extension (`sqlite-vec` cannot be loaded under `--deny-ffi`, and must
 * not be): a vector is a little-endian Float32 BLOB, L2-normalised on write, so cosine similarity is a dot product,
 * and ranking is one SQL statement over a deterministic scalar function this module registers ({@linkcode DOT_SQL}).
 *
 * - **Owner scoping.** Every collection and item belongs to the realm-qualified owner (`expansionOwner`, D-068) the
 *   MCP extension seam hands an action; every statement here filters on it, so one principal never sees, searches or
 *   deletes another's memory. The credential-less mounts (loopback development, stdio) share their one owner.
 * - **One vector space per collection.** A collection is bound at creation to the embedder then in force and to the
 *   length of its vectors; every later save and search on it uses that embedder, so changing the default never mixes
 *   spaces. A collection whose embedder is no longer configured refuses rather than embedding with another.
 * - **Lengths are checked, never assumed.** {@linkcode DOT_SQL} answers SQL `NULL`, never a number, for vectors of
 *   different lengths; the search sorts such a row first and refuses, so a corrupt or foreign row fails the search
 *   instead of producing a wrong score.
 * - **Provider embeddings** reuse the model transport's discipline (`packages/agents/src/model/transport.ts`): the
 *   provider's own admitted `base_url` is the only URL dialled, redirects are refused, the call and the body are
 *   bounded, and an error answer's body — which may quote the key — is never read. No key or body reaches an error.
 *
 * Node-local, like the database: in a cluster each node keeps its own memory.
 */
import * as z from 'zod';
import { ulid } from '@std/ulid';
import { PROVIDER_BODY_LIMIT, providerEndpoint } from '@tykotech/agents';
import { type Database, now, type Row } from './database.ts';
import { locate, type ModelProviderSettings, phraseOf } from './model_providers.ts';
import { HttpProblem } from './problem.ts';

// --- bounds ---------------------------------------------------------------------------------------------------------

/**
 * The fixed bounds. A search is a full scan of one collection through a JavaScript function, so the item cap and the
 * vector cap bound its cost (10 000 rows × 4096 floats is tens of milliseconds); the text and metadata caps bound a row
 * and a result list (20 hits × 16 KiB); the batch cap bounds one provider call's input and answer, which must fit the
 * transport's body limit ({@linkcode PROVIDER_BODY_LIMIT}: 32 × 4096 floats as JSON is under 3 MiB).
 */
export const MEMORY_LIMITS = {
	/** One item's text, UTF-8 bytes. Also the query's. */
	textBytes: 16 * 1024,
	/** One item's metadata, as compact JSON, UTF-8 bytes. */
	metadataBytes: 4 * 1024,
	collectionsPerOwner: 64,
	itemsPerCollection: 10_000,
	searchLimitDefault: 5,
	searchLimitMax: 20,
	/** Items in one save, and therefore texts in one embedding call. */
	saveBatch: 32,
	/** Ids in one delete. */
	deleteBatch: 100,
	/** Keys in one search filter, and the longest string value one may compare. */
	filterKeys: 8,
	filterValueChars: 256,
	/** The longest vector a provider may answer with (`text-embedding-3-large` is 3072). */
	maxDims: 4096,
} as const;

/** An item id. Ids are caller-chosen keys, so they are plain: no spaces, no separators beyond `._:-`. */
export const MEMORY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A collection name: lower-case, so two spellings can never name one collection differently to two callers. */
export const MEMORY_COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A metadata key a search may filter on; no quote or dot, so it can sit inside a JSON path verbatim. */
export const MEMORY_FILTER_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The `settings` key holding the default embedder: `builtin` (also when unset) or `<providerId>/<model>`. */
export const MEMORY_EMBEDDER_SETTING = 'memory.embedder';

/** The SQL function name of the similarity. */
export const DOT_SQL = 'ttk_dot';

/**
 * The built-in embedder's id. The id names the vector space: the hashing below must never change under it — a
 * changed tokeniser or hash would silently put new vectors in a different space from the stored ones. A new
 * algorithm takes a new id; `memory_test.ts` pins this one's output.
 */
export const BUILTIN_EMBEDDER_ID = 'builtin:lexical-512';

/** The built-in embedder's vector length. */
export const LEXICAL_DIMS = 512;

/** One provider embedding call, below the tool-call bound so a hung provider ends as a provider failure. */
export const EMBED_CALL_TIMEOUT_MS = 60_000;

/** One SQL value as `node:sqlite` binds and returns it (through `database.ts`, the one module that imports it). */
type SqlValue = Row[string];

const PROVIDER_PREFIX = 'provider:';
const encoder = new TextEncoder();

// --- errors ---------------------------------------------------------------------------------------------------------

/**
 * Why the store refused. `invalid`: the request itself (a bound, a name, a cap); `not-found`: no such collection;
 * `unavailable`: the embedder cannot serve the call (gone, or its provider failed).
 */
export type MemoryErrorCode = 'invalid' | 'not-found' | 'unavailable';

/** A refusal with a fixed detail: it names a field or a caller-chosen name, never a key, a URL or a provider body. */
export class MemoryError extends Error {
	constructor(readonly code: MemoryErrorCode, detail: string) {
		super(detail);
		this.name = 'MemoryError';
	}
}

/** The provider failure details, by class: the whole message, so nothing a provider said can reach a caller. */
const PROVIDER_FAILURES = {
	'4xx': 'the embedding provider refused the request (4xx); check the provider and the model',
	'5xx': 'the embedding provider failed (5xx); try again later',
	timeout: 'the embedding provider did not answer in time',
	network: 'the embedding provider could not be reached',
	malformed: 'the embedding provider answered with an unreadable response',
} as const;

const EMBEDDER_GONE = 'the embedder this collection was created with is no longer configured, so it can be neither ' +
	'searched nor added to; an administrator can restore it, or delete the collection (memory_delete with all)';
const DEFAULT_GONE = 'the default memory embedder is not available, so no new collection can be created; an ' +
	'administrator can choose another';

// --- vectors --------------------------------------------------------------------------------------------------------

/** Every supported target is little-endian; the DataView path keeps the stored format exact on any other. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** A vector as stored: little-endian Float32. */
export function encodeVector(vector: Float32Array): Uint8Array<ArrayBuffer> {
	if (LITTLE_ENDIAN) return new Uint8Array(vector.slice().buffer);
	const bytes = new Uint8Array(vector.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i]!, true);
	return bytes;
}

/** A stored vector, read back; throws on a length that is not whole floats. */
export function decodeVector(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength % 4 !== 0) throw new Error(`${DOT_SQL}: a vector is not a whole number of floats`);
	// The fast path needs a 4-byte-aligned view; anything else is copied.
	if (LITTLE_ENDIAN) {
		return bytes.byteOffset % 4 === 0
			? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
			: new Float32Array(bytes.slice().buffer);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const vector = new Float32Array(bytes.byteLength / 4);
	for (let i = 0; i < vector.length; i++) vector[i] = view.getFloat32(i * 4, true);
	return vector;
}

/**
 * The SQL similarity: the dot product of two stored vectors, or SQL `NULL` for anything it cannot score (not two
 * blobs, different lengths, not whole floats) — never a number for a mismatch.
 *
 * It answers `NULL` rather than throwing because, in Deno 2.9, `StatementSync.all()` never returns once a user
 * function throws (`get()` does): a throw here would hang the process. Two named parameters, not a rest list, because
 * `node:sqlite` registers a function with the arity of its `length`.
 */
function dot(a: SqlValue, b: SqlValue): SqlValue {
	if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return null;
	if (a.byteLength !== b.byteLength || a.byteLength % 4 !== 0) return null;
	const x = decodeVector(a);
	const y = decodeVector(b);
	let sum = 0;
	for (let i = 0; i < x.length; i++) sum += x[i]! * y[i]!;
	return sum;
}

/**
 * `vector` scaled to unit length, as a new Float32Array. A zero vector stays zero (a text with no letters or digits,
 * which then scores 0 against everything); a non-finite component is refused as a malformed embedding.
 */
export function normalise(vector: ArrayLike<number>): Float32Array {
	let sum = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i]!;
		if (!Number.isFinite(value)) throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
		sum += value * value;
	}
	const out = new Float32Array(vector.length);
	const norm = Math.sqrt(sum);
	if (norm === 0) return out;
	for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
	return out;
}

// --- embedders ------------------------------------------------------------------------------------------------------

/** Turns texts into vectors; one per text, all the same length. */
export interface Embedder {
	readonly id: string;
	/** The vector length; 0 for a provider embedder, whose first answer decides it. */
	readonly dims: number;
	embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** One embedder as the control plane lists it. */
export interface EmbedderInfo {
	readonly id: string;
	readonly label: string;
	readonly kind: 'builtin' | 'provider';
}

/** Letters (with their combining marks) and digits, in any script. */
const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;

/** 32-bit FNV-1a over UTF-8 bytes. */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (const byte of encoder.encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/** MurmurHash3's finaliser: FNV-1a's low bits mix poorly, and the index is taken from them. */
function avalanche(hash: number): number {
	let h = hash;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/**
 * The built-in lexical embedding of one text: NFKC, lower-cased, split into letter/digit tokens; each token and each
 * adjacent pair is a feature, hashed into {@linkcode LEXICAL_DIMS} buckets (low bits of the mixed hash) with a sign
 * (its top bit) so collisions cancel rather than pile up, weighted by sublinear term frequency `1 + ln tf`, then
 * L2-normalised. Deterministic, offline and dependency-free — and lexical: it matches shared words, not meaning.
 */
export function lexicalEmbed(text: string): Float32Array {
	const tokens = text.normalize('NFKC').toLowerCase().match(TOKEN) ?? [];
	const counts = new Map<string, number>();
	const bump = (feature: string): void => {
		counts.set(feature, (counts.get(feature) ?? 0) + 1);
	};
	for (let i = 0; i < tokens.length; i++) {
		bump(tokens[i]!);
		// A token never contains a space, so a pair can never collide with a single token.
		if (i > 0) bump(`${tokens[i - 1]!} ${tokens[i]!}`);
	}
	const sums = new Float64Array(LEXICAL_DIMS);
	for (const [feature, tf] of counts) {
		const hash = avalanche(fnv1a(feature));
		sums[hash & (LEXICAL_DIMS - 1)]! += ((hash & 0x80000000) === 0 ? 1 : -1) * (1 + Math.log(tf));
	}
	return normalise(sums);
}

/** The built-in embedder. */
export const LEXICAL_EMBEDDER: Embedder = {
	id: BUILTIN_EMBEDDER_ID,
	dims: LEXICAL_DIMS,
	embed: (texts) => Promise.resolve(texts.map(lexicalEmbed)),
};

const BUILTIN_INFO: EmbedderInfo = {
	id: BUILTIN_EMBEDDER_ID,
	label: 'Built-in lexical (512 dimensions, offline): matches shared words and word pairs, not meaning',
	kind: 'builtin',
};

/** Test seams for the provider embedder; production passes none. */
export interface ProviderEmbedderOptions {
	readonly fetch?: typeof fetch;
	/** Tests: shorten {@linkcode EMBED_CALL_TIMEOUT_MS}. */
	readonly callTimeoutMs?: number;
}

/** Reads at most {@linkcode PROVIDER_BODY_LIMIT} bytes; one more is `malformed`, and the rest is never buffered. */
async function readBounded(response: Response): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > PROVIDER_BODY_LIMIT) {
		await response.body?.cancel().catch(() => {});
		throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
	}
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > PROVIDER_BODY_LIMIT) throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** The `data[].embedding` vectors of an OpenAI-compatible answer, in input order; `malformed` on any other shape. */
function vectorsOf(parsed: unknown, count: number): Float32Array[] {
	const malformed = (): MemoryError => new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
	const data = (parsed as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== count) throw malformed();
	const out: Array<Float32Array | undefined> = new Array(count);
	for (const [position, entry] of data.entries()) {
		const record = entry as { index?: unknown; embedding?: unknown } | null;
		// `index` orders the answer; a server that omits it is read in answer order.
		const index = record?.index === undefined ? position : record.index;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) throw malformed();
		if (out[index] !== undefined) throw malformed();
		const embedding = record?.embedding;
		if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > MEMORY_LIMITS.maxDims) {
			throw malformed();
		}
		if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) throw malformed();
		out[index] = Float32Array.from(embedding as number[]);
	}
	const vectors = out as Float32Array[];
	if (vectors.some((vector) => vector.length !== vectors[0]!.length)) throw malformed();
	return vectors;
}

/**
 * An OpenAI-compatible embedder (`POST {base_url}/embeddings`, a bare origin getting `/v1` first as the chat client's
 * does — ERRATUM(E-120), `providerEndpoint`; `{ model, input }`) over one configured provider. The
 * headers are built as the chat client builds them (`requestHeaders`): the operator's lower-cased, then the fixed
 * ones, then `authorization` — sent only when the provider has a key, and last, so nothing displaces it.
 */
export function providerEmbedder(
	provider: ModelProviderSettings,
	model: string,
	options: ProviderEmbedderOptions = {},
): Embedder {
	const url = providerEndpoint('openai', provider.baseUrl, 'embeddings');
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(provider.headers)) headers[name.toLowerCase()] = value;
	headers['content-type'] = 'application/json';
	headers['accept'] = 'application/json';
	if (provider.apiKey !== null) headers['authorization'] = `Bearer ${provider.apiKey}`;
	const dial = options.fetch ?? fetch;
	const timeoutMs = options.callTimeoutMs ?? EMBED_CALL_TIMEOUT_MS;
	return {
		id: `${PROVIDER_PREFIX}${provider.id}/${model}`,
		dims: 0,
		async embed(texts, signal): Promise<Float32Array[]> {
			signal?.throwIfAborted();
			// A timer of our own rather than `AbortSignal.timeout`, so it is cleared the moment the call ends.
			const timer = new AbortController();
			const handle = setTimeout(() => timer.abort(), timeoutMs);
			const bound = signal === undefined ? timer.signal : AbortSignal.any([signal, timer.signal]);
			try {
				let response: Response;
				try {
					response = await dial(url, {
						method: 'POST',
						headers,
						body: JSON.stringify({ model, input: texts }),
						redirect: 'error',
						signal: bound,
					});
				} catch {
					if (signal?.aborted) throw signal.reason;
					// A refused redirect, a closed port, a TLS fault: none of them carries anything worth passing on.
					throw new MemoryError(
						'unavailable',
						timer.signal.aborted ? PROVIDER_FAILURES.timeout : PROVIDER_FAILURES.network,
					);
				}
				if (!response.ok) {
					// Never read: a 401 body may quote the key it was sent.
					await response.body?.cancel().catch(() => {});
					throw new MemoryError('unavailable', PROVIDER_FAILURES[response.status >= 500 ? '5xx' : '4xx']);
				}
				if (!/^application\/json\b/i.test((response.headers.get('content-type') ?? '').trim())) {
					await response.body?.cancel().catch(() => {});
					throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
				}
				let bytes: Uint8Array;
				try {
					bytes = await readBounded(response);
				} catch (error) {
					if (signal?.aborted) throw signal.reason;
					if (error instanceof MemoryError) throw error;
					throw new MemoryError(
						'unavailable',
						timer.signal.aborted ? PROVIDER_FAILURES.timeout : PROVIDER_FAILURES.network,
					);
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
				} catch {
					throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
				}
				return vectorsOf(parsed, texts.length);
			} finally {
				clearTimeout(handle);
			}
		},
	};
}

// --- the store ------------------------------------------------------------------------------------------------------

/** One item to save. */
export interface MemoryItemInput {
	/** Omitted: a new ULID. Present: an existing item under it is replaced (upsert). */
	readonly id?: string;
	readonly text: string;
	readonly metadata?: Record<string, unknown>;
}

/** What a save did. */
export interface MemorySaveResult {
	readonly collection: string;
	readonly embedder: string;
	/** Whether this save created the collection (and bound it to `embedder`). */
	readonly created: boolean;
	/** The saved items' ids, in input order. */
	readonly ids: string[];
}

/** One search hit. `text` and `metadata` are what was stored — data, never instructions. */
export interface MemoryHit {
	readonly id: string;
	readonly text: string;
	readonly metadata: Record<string, unknown>;
	/** Cosine similarity, −1…1 (0…1 in practice for the built-in embedder's typical texts). */
	readonly score: number;
}

/** A metadata filter: every key must hold exactly this scalar at the metadata's top level. */
export type MemoryFilter = Readonly<Record<string, string | number | boolean | null>>;

/** One collection as its owner sees it. */
export interface MemoryCollectionInfo {
	readonly name: string;
	readonly embedder: string;
	readonly dims: number;
	readonly items: number;
	readonly created_at: string;
	/** Whether its embedder is configured now; `false` means it refuses saves and searches. */
	readonly available: boolean;
}

/** The control plane's totals for one embedder: counts only, never a text or an owner. */
export interface MemoryEmbedderTotal {
	readonly embedder: string;
	readonly collections: number;
	readonly items: number;
}

/** What {@linkcode MemoryStore} is built with. */
export interface MemoryStoreOptions {
	/**
	 * The model providers in force (operator file and control-plane store), read on every call so a provider added or
	 * removed applies at once. Only `kind: 'openai'` providers embed; Anthropic has no embeddings API.
	 */
	readonly providers?: () => readonly ModelProviderSettings[];
	/** Test seams for provider calls. */
	readonly provider?: ProviderEmbedderOptions;
}

/** A refusal for a field, with a fixed phrase. */
function invalid(detail: string): MemoryError {
	return new MemoryError('invalid', detail);
}

function checkCollection(name: string): void {
	if (!MEMORY_COLLECTION_PATTERN.test(name)) {
		throw invalid('collection: lower-case letters, digits, _ and -, starting with a letter or digit, up to 64');
	}
}

function checkText(field: string, text: string): void {
	if (text.trim() === '') throw invalid(`${field}: empty`);
	if (encoder.encode(text).byteLength > MEMORY_LIMITS.textBytes) {
		throw invalid(`${field}: longer than ${MEMORY_LIMITS.textBytes} bytes`);
	}
}

/** The metadata as stored (compact JSON of a plain object), or a refusal. */
function metadataJson(field: string, metadata: unknown): string {
	if (metadata === undefined) return '{}';
	if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
		throw invalid(`${field}: not a JSON object`);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(metadata);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw invalid(`${field}: not a JSON object`);
	if (encoder.encode(json).byteLength > MEMORY_LIMITS.metadataBytes) {
		throw invalid(`${field}: longer than ${MEMORY_LIMITS.metadataBytes} bytes as JSON`);
	}
	return json;
}

/** The SQL conditions and parameters for a filter, judged exactly by JSON type (so `true` never matches `1`). */
function filterSql(filter: MemoryFilter | undefined): { sql: string; params: SqlValue[] } {
	if (filter === undefined) return { sql: '', params: [] };
	const entries = Object.entries(filter);
	if (entries.length > MEMORY_LIMITS.filterKeys) throw invalid(`filter: more than ${MEMORY_LIMITS.filterKeys} keys`);
	const parts: string[] = [];
	const params: SqlValue[] = [];
	for (const [key, value] of entries) {
		if (!MEMORY_FILTER_KEY_PATTERN.test(key)) throw invalid('filter: a key is not [A-Za-z0-9_-], up to 64');
		const path = `$."${key}"`;
		if (value === null) {
			parts.push(`json_type(metadata, ?) = 'null'`);
			params.push(path);
		} else if (typeof value === 'boolean') {
			parts.push('json_type(metadata, ?) = ?');
			params.push(path, value ? 'true' : 'false');
		} else if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw invalid(`filter.${key}: not a finite number`);
			parts.push(`json_type(metadata, ?) IN ('integer', 'real') AND json_extract(metadata, ?) = ?`);
			params.push(path, path, value);
		} else if (typeof value === 'string') {
			if (value.length > MEMORY_LIMITS.filterValueChars) {
				throw invalid(`filter.${key}: longer than ${MEMORY_LIMITS.filterValueChars} characters`);
			}
			parts.push(`json_type(metadata, ?) = 'text' AND json_extract(metadata, ?) = ?`);
			params.push(path, path, value);
		} else {
			throw invalid(`filter.${key}: not a string, number, boolean or null`);
		}
	}
	return { sql: parts.map((part) => ` AND (${part})`).join(''), params };
}

/** The agents' vector memory over one {@linkcode Database}. Synchronous SQL; only embedding awaits. */
export class MemoryStore {
	readonly #db: Database;
	readonly #providers: () => readonly ModelProviderSettings[];
	readonly #providerOptions: ProviderEmbedderOptions;

	constructor(db: Database, options: MemoryStoreOptions = {}) {
		this.#db = db;
		this.#providers = options.providers ?? (() => []);
		this.#providerOptions = options.provider ?? {};
		db.defineFunction(DOT_SQL, dot);
	}

	// --- embedders --------------------------------------------------------------------------------------------------

	/**
	 * The embedders an administrator may choose: the built-in one, then one per model listed on each OpenAI-compatible
	 * provider (an embedding model must be listed on its provider like any other model — the providers file and the
	 * control plane remain the only places a model is named). Anthropic providers have no embeddings API.
	 */
	availableEmbedders(): EmbedderInfo[] {
		const out: EmbedderInfo[] = [BUILTIN_INFO];
		for (const provider of this.#providers()) {
			if (provider.kind !== 'openai') continue;
			for (const model of provider.models) {
				out.push({
					id: `${PROVIDER_PREFIX}${provider.id}/${model}`,
					label: `${provider.label}: ${model}`,
					kind: 'provider',
				});
			}
		}
		return out;
	}

	/** The stored setting: `builtin` (also when unset) or `<providerId>/<model>`. */
	embedderSetting(): string {
		return this.#db.setting(MEMORY_EMBEDDER_SETTING) ?? 'builtin';
	}

	/** The embedder id a new collection binds to (it may name one that is no longer available). */
	defaultEmbedderId(): string {
		const setting = this.embedderSetting();
		return setting === 'builtin' ? BUILTIN_EMBEDDER_ID : `${PROVIDER_PREFIX}${setting}`;
	}

	/**
	 * Chooses the default embedder for new collections; existing collections keep theirs. Takes the setting's spelling
	 * (`builtin`, `<providerId>/<model>`) or an embedder id; refuses one not in {@linkcode availableEmbedders}. Returns
	 * the embedder id now in force.
	 */
	setEmbedder(value: string): string {
		const id = value === 'builtin'
			? BUILTIN_EMBEDDER_ID
			: value === BUILTIN_EMBEDDER_ID || value.startsWith(PROVIDER_PREFIX)
			? value
			: `${PROVIDER_PREFIX}${value}`;
		if (!this.availableEmbedders().some((embedder) => embedder.id === id)) {
			throw invalid('embedder: not one of the available embedders');
		}
		this.#db.setSetting(
			MEMORY_EMBEDDER_SETTING,
			id === BUILTIN_EMBEDDER_ID ? 'builtin' : id.slice(PROVIDER_PREFIX.length),
		);
		return id;
	}

	/** The embedder behind `id`, or `null` when it is not configured now. */
	#embedder(id: string): Embedder | null {
		if (id === BUILTIN_EMBEDDER_ID) return LEXICAL_EMBEDDER;
		if (!id.startsWith(PROVIDER_PREFIX)) return null;
		const rest = id.slice(PROVIDER_PREFIX.length);
		// A provider id has no `/`; a model may (`org/model`), so the first one separates them.
		const slash = rest.indexOf('/');
		if (slash <= 0) return null;
		const providerId = rest.slice(0, slash);
		const model = rest.slice(slash + 1);
		const provider = this.#providers().find((entry) => entry.id === providerId);
		if (provider === undefined || provider.kind !== 'openai' || !provider.models.includes(model)) return null;
		return providerEmbedder(provider, model, this.#providerOptions);
	}

	/** Embeds and normalises, checking count and length against what the collection (or the embedder) fixes. */
	async #vectors(
		embedder: Embedder,
		texts: readonly string[],
		dims: number,
		signal: AbortSignal | undefined,
	): Promise<Float32Array[]> {
		const raw = await embedder.embed(texts, signal);
		signal?.throwIfAborted();
		if (raw.length !== texts.length) throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
		const expected = dims > 0 ? dims : raw[0]?.length ?? 0;
		for (const vector of raw) {
			if (vector.length === 0 || vector.length > MEMORY_LIMITS.maxDims) {
				throw new MemoryError('unavailable', PROVIDER_FAILURES.malformed);
			}
			if (vector.length !== expected) {
				// The embedder now answers in another space than the collection holds: refuse, never mix.
				throw new MemoryError(
					'unavailable',
					`the embedder answered ${vector.length} dimensions where the collection holds ${expected}`,
				);
			}
		}
		return raw.map(normalise);
	}

	#binding(owner: string, collection: string): { embedder: string; dims: number } | null {
		const row = this.#db.get(
			'SELECT embedder, dims FROM memory_collections WHERE owner = ? AND name = ?',
			owner,
			collection,
		);
		return row === undefined ? null : { embedder: String(row.embedder), dims: Number(row.dims) };
	}

	// --- items ------------------------------------------------------------------------------------------------------

	/**
	 * Saves (upserts) `items` into `owner`'s `collection`, creating it — bound to the default embedder — when absent.
	 * Embedding happens before the write; the write is one transaction that re-checks the binding and the caps, so a
	 * concurrent save or drop cannot slip a vector of another space in.
	 */
	async save(
		owner: string,
		collection: string,
		items: readonly MemoryItemInput[],
		signal?: AbortSignal,
	): Promise<MemorySaveResult> {
		checkCollection(collection);
		if (items.length === 0) throw invalid('items: none given');
		if (items.length > MEMORY_LIMITS.saveBatch) throw invalid(`items: more than ${MEMORY_LIMITS.saveBatch}`);
		const prepared = items.map((item, index) => {
			const field = `items[${index}]`;
			const id = item.id ?? ulid();
			if (!MEMORY_ID_PATTERN.test(id)) throw invalid(`${field}.id: [A-Za-z0-9._:-], 1 to 128 characters`);
			if (typeof item.text !== 'string') throw invalid(`${field}.text: not a string`);
			checkText(`${field}.text`, item.text);
			return { id, text: item.text, metadata: metadataJson(`${field}.metadata`, item.metadata) };
		});
		if (new Set(prepared.map((item) => item.id)).size !== prepared.length) throw invalid('items: an id is repeated');

		const bound = this.#binding(owner, collection);
		const embedderId = bound?.embedder ?? this.defaultEmbedderId();
		const embedder = this.#embedder(embedderId);
		if (embedder === null) throw new MemoryError('unavailable', bound === null ? DEFAULT_GONE : EMBEDDER_GONE);
		if (bound === null) this.#checkCollectionCap(owner);
		const vectors = await this.#vectors(
			embedder,
			prepared.map((item) => item.text),
			bound?.dims ?? embedder.dims,
			signal,
		);
		const dims = vectors[0]!.length;

		return this.#db.transaction(() => {
			const current = this.#binding(owner, collection);
			let created = false;
			if (current === null) {
				this.#checkCollectionCap(owner);
				this.#db.run(
					'INSERT INTO memory_collections (owner, name, embedder, dims, created_at) VALUES (?, ?, ?, ?, ?)',
					owner,
					collection,
					embedderId,
					dims,
					now(),
				);
				created = true;
			} else if (current.embedder !== embedderId || current.dims !== dims) {
				throw new MemoryError('unavailable', 'the collection was replaced while this save was embedding; try again');
			}
			const held = Number(
				this.#db.get('SELECT count(*) AS n FROM memory_items WHERE owner = ? AND collection = ?', owner, collection)
					?.n ?? 0,
			);
			const ids = prepared.map((item) => item.id);
			const existing = this.#db.all(
				`SELECT id FROM memory_items WHERE owner = ? AND collection = ? AND id IN (${ids.map(() => '?').join(', ')})`,
				owner,
				collection,
				...ids,
			).length;
			if (held + ids.length - existing > MEMORY_LIMITS.itemsPerCollection) {
				throw invalid(
					`collection ${collection} would hold more than ${MEMORY_LIMITS.itemsPerCollection} items; delete some first`,
				);
			}
			const at = now();
			for (const [index, item] of prepared.entries()) {
				this.#db.run(
					'INSERT INTO memory_items (owner, collection, id, text, metadata, embedding, updated_at) ' +
						'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, collection, id) DO UPDATE SET text = excluded.text, ' +
						'metadata = excluded.metadata, embedding = excluded.embedding, updated_at = excluded.updated_at',
					owner,
					collection,
					item.id,
					item.text,
					item.metadata,
					encodeVector(vectors[index]!),
					at,
				);
			}
			return { collection, embedder: embedderId, created, ids };
		});
	}

	#checkCollectionCap(owner: string): void {
		const count = Number(this.#db.get('SELECT count(*) AS n FROM memory_collections WHERE owner = ?', owner)?.n ?? 0);
		if (count >= MEMORY_LIMITS.collectionsPerOwner) {
			throw invalid(`you already have ${MEMORY_LIMITS.collectionsPerOwner} collections; delete one first`);
		}
	}

	/**
	 * The `limit` items of `owner`'s `collection` most similar to `query` (by the collection's own embedder), best
	 * first, optionally only those whose metadata matches `filter`.
	 */
	async search(
		owner: string,
		collection: string,
		query: string,
		limit: number = MEMORY_LIMITS.searchLimitDefault,
		filter?: MemoryFilter,
		signal?: AbortSignal,
	): Promise<{ readonly collection: string; readonly embedder: string; readonly results: MemoryHit[] }> {
		checkCollection(collection);
		if (typeof query !== 'string') throw invalid('query: not a string');
		checkText('query', query);
		if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIMITS.searchLimitMax) {
			throw invalid(`limit: a whole number from 1 to ${MEMORY_LIMITS.searchLimitMax}`);
		}
		const conditions = filterSql(filter);
		const bound = this.#binding(owner, collection);
		if (bound === null) throw new MemoryError('not-found', `no memory collection named ${collection}`);
		const embedder = this.#embedder(bound.embedder);
		if (embedder === null) throw new MemoryError('unavailable', EMBEDDER_GONE);
		const [vector] = await this.#vectors(embedder, [query], bound.dims, signal);
		// A row the similarity cannot score (`NULL`) sorts first, whatever the limit, so the check below sees it.
		const rows = this.#db.all(
			`SELECT id, text, metadata, ${DOT_SQL}(embedding, ?) AS score FROM memory_items ` +
				`WHERE owner = ? AND collection = ?${conditions.sql} ORDER BY score IS NULL DESC, score DESC, id ASC LIMIT ?`,
			encodeVector(vector!),
			owner,
			collection,
			...conditions.params,
			limit,
		);
		if (rows.some((row) => typeof row.score !== 'number')) {
			throw new MemoryError(
				'unavailable',
				`collection ${collection} holds a vector of another length than its embedder's; it cannot be searched ` +
					'until that item is replaced or deleted',
			);
		}
		return {
			collection,
			embedder: bound.embedder,
			results: rows.map((row) => ({
				id: String(row.id),
				text: String(row.text),
				metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
				// Float32 storage makes digits past the sixth noise.
				score: Math.round(Number(row.score) * 1e6) / 1e6,
			})),
		};
	}

	/**
	 * Deletes `ids` from `owner`'s `collection`, or every item with `'all'` (the collection and its binding stay; see
	 * {@linkcode drop}). Returns how many were removed; an absent collection removes none.
	 */
	delete(owner: string, collection: string, ids: readonly string[] | 'all'): number {
		checkCollection(collection);
		if (ids === 'all') {
			return this.#db.run('DELETE FROM memory_items WHERE owner = ? AND collection = ?', owner, collection);
		}
		if (ids.length === 0) throw invalid('ids: none given');
		if (ids.length > MEMORY_LIMITS.deleteBatch) throw invalid(`ids: more than ${MEMORY_LIMITS.deleteBatch}`);
		if (!ids.every((id) => MEMORY_ID_PATTERN.test(id))) throw invalid('ids: [A-Za-z0-9._:-], 1 to 128 characters');
		return this.#db.run(
			`DELETE FROM memory_items WHERE owner = ? AND collection = ? AND id IN (${ids.map(() => '?').join(', ')})`,
			owner,
			collection,
			...ids,
		);
	}

	/**
	 * Removes `owner`'s `collection` with every item in it (the foreign key cascades) and its embedder binding, so the
	 * name can be reused with the embedder then in force. Returns the number of items removed, or `null` when there was
	 * no such collection.
	 */
	drop(owner: string, collection: string): number | null {
		checkCollection(collection);
		return this.#db.transaction(() => {
			const items = Number(
				this.#db.get('SELECT count(*) AS n FROM memory_items WHERE owner = ? AND collection = ?', owner, collection)
					?.n ?? 0,
			);
			const removed = this.#db.run('DELETE FROM memory_collections WHERE owner = ? AND name = ?', owner, collection);
			return removed === 0 ? null : items;
		});
	}

	/** `owner`'s collections, by name, with item counts and whether each one's embedder is configured now. */
	collections(owner: string): MemoryCollectionInfo[] {
		const rows = this.#db.all(
			'SELECT c.name, c.embedder, c.dims, c.created_at, ' +
				'(SELECT count(*) FROM memory_items i WHERE i.owner = c.owner AND i.collection = c.name) AS items ' +
				'FROM memory_collections c WHERE c.owner = ? ORDER BY c.name',
			owner,
		);
		const available = new Map<string, boolean>();
		return rows.map((row) => {
			const embedder = String(row.embedder);
			if (!available.has(embedder)) available.set(embedder, this.#embedder(embedder) !== null);
			return {
				name: String(row.name),
				embedder,
				dims: Number(row.dims),
				items: Number(row.items),
				created_at: String(row.created_at),
				available: available.get(embedder)!,
			};
		});
	}

	/** Collections and items per embedder across every owner, for the control plane: counts only. */
	summary(): MemoryEmbedderTotal[] {
		return this.#db.all(
			'SELECT c.embedder, count(*) AS collections, coalesce(sum(i.n), 0) AS items FROM memory_collections c ' +
				'LEFT JOIN (SELECT owner, collection, count(*) AS n FROM memory_items GROUP BY owner, collection) i ' +
				'ON i.owner = c.owner AND i.collection = c.name GROUP BY c.embedder ORDER BY c.embedder',
		).map((row) => ({
			embedder: String(row.embedder),
			collections: Number(row.collections),
			items: Number(row.items),
		}));
	}
}

// --- the control plane (`/api/v1/system/memory`) --------------------------------------------------------------------

/** `GET /api/v1/system/memory`: the default embedder in force, the choices, and counts per embedder. */
export interface MemorySystemView {
	/** The default embedder's id; it may be absent from `embedders` when its provider was removed. */
	readonly embedder: string;
	readonly embedders: readonly EmbedderInfo[];
	readonly totals: readonly MemoryEmbedderTotal[];
}

/** The `PUT /api/v1/system/memory` body: an embedder id or the setting's spelling (`builtin`, `<provider>/<model>`). */
export const MemoryConfigBodySchema = z.object({ embedder: z.string().min(1).max(256) }).strict();

/** The body of `GET /api/v1/system/memory`. */
export function memorySystemView(store: MemoryStore): MemorySystemView {
	return { embedder: store.defaultEmbedderId(), embedders: store.availableEmbedders(), totals: store.summary() };
}

/** The `PUT` body, parsed; a refusal is `400 invalid-request` with a fixed phrase naming the field, never the value. */
export function parseMemoryConfigBody(body: unknown): { readonly embedder: string } {
	const parsed = MemoryConfigBodySchema.safeParse(body);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		throw new HttpProblem('invalid-request', `${phraseOf(issue)}, ${locate(issue.path)}`);
	}
	return parsed.data;
}

/**
 * `PUT /api/v1/system/memory`: validates the body, sets the default embedder and answers the new view. An embedder
 * that is not available is `400 invalid-request`. Existing collections keep their own embedder.
 */
export function applyMemoryConfig(store: MemoryStore, body: unknown): MemorySystemView {
	const { embedder } = parseMemoryConfigBody(body);
	try {
		store.setEmbedder(embedder);
	} catch (cause) {
		if (cause instanceof MemoryError) throw new HttpProblem('invalid-request', cause.message);
		throw cause;
	}
	return memorySystemView(store);
}
