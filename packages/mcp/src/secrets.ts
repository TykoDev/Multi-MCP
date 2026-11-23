/**
 * Secret placeholders for `browser_type`: the model writes `<secret>name</secret>`, the server substitutes the value
 * on the way to the browser, and nothing reads it back out.
 * A secret is pinned to its domains with `urlMatch`'s `'secret'` context, never the navigation predicate, which
 * admits `about:blank`, `data:` and plaintext `http:`.
 */
import { urlMatch } from '@tykotech/browser';
import { ToolError } from './errors.ts';

/** `<secret>name</secret>`, the placeholder a model writes. */
const PLACEHOLDER = /<secret>([A-Za-z0-9_.\-]{1,64})<\/secret>/g;

/** One configured secret: a value plus the origins it may be typed into. */
export interface SecretEntry {
	readonly name: string;
	readonly value: string;
	/**
	 * Domain patterns this secret may be used on, in the same *pattern* syntax as the navigation allowlist but under
	 * the stricter `'secret'` scheme rule: a scheme-less pattern covers `https:` only, and a secret that genuinely
	 * has to be typed over plaintext HTTP needs an explicit
	 * `http://host` pattern (the matcher's scheme rule, `packages/browser/src/security/url_matcher.ts`).
	 */
	readonly domains: readonly string[];
}

/** What a substitution did, with no value anywhere in it. */
interface Substitution {
	/** The text to actually type. */
	readonly text: string;
	/** Names substituted, in first-use order. */
	readonly used: readonly string[];
	/** True when any placeholder was replaced, so the caller can mask its echo. */
	readonly substituted: boolean;
}

/** The configured secrets; immutable, since a writable store would be an exfiltration oracle. */
export class SecretStore {
	readonly #entries: ReadonlyMap<string, SecretEntry>;

	constructor(entries: readonly SecretEntry[] = []) {
		this.#entries = new Map(entries.map((entry) => [entry.name, entry]));
	}

	get size(): number {
		return this.#entries.size;
	}

	/** True when nothing is configured, so callers can skip the work entirely. */
	get empty(): boolean {
		return this.#entries.size === 0;
	}

	/** Every configured name. Names only — never values. */
	names(): string[] {
		return [...this.#entries.keys()].sort();
	}

	/** True when a secret of this name is configured. A name, never a value. */
	has(name: string): boolean {
		return this.#entries.has(name);
	}

	/** The domain patterns a named secret is pinned to, or `undefined` when there is no such secret. */
	domainsOf(name: string): readonly string[] | undefined {
		return this.#entries.get(name)?.domains;
	}

	/** The names usable on `url`, which is what a model is told about. */
	namesFor(url: string): string[] {
		return [...this.#entries.values()]
			.filter((entry) => this.#permits(entry, url))
			.map((entry) => entry.name)
			.sort();
	}

	/** True when `entry` may be typed into a page at `url` — **the domain pin, and the one place it is decided**. */
	#permits(entry: SecretEntry, url: string): boolean {
		if (entry.domains.length === 0) return true;
		return entry.domains.some((pattern) => urlMatch(url, pattern, 'secret'));
	}

	/** Replaces every `<secret>name</secret>` in `text` with its value. */
	substitute(text: string, url: string): Substitution {
		if (this.empty || !text.includes('<secret>')) {
			return { text, used: [], substituted: false };
		}

		const used: string[] = [];
		const missing: string[] = [];
		const refused: string[] = [];

		const out = text.replace(PLACEHOLDER, (_match, rawName: string) => {
			const entry = this.#entries.get(rawName);
			if (entry === undefined) {
				missing.push(rawName);
				return '';
			}
			if (!this.#permits(entry, url)) {
				refused.push(rawName);
				return '';
			}
			if (!used.includes(rawName)) used.push(rawName);
			return entry.value;
		});

		if (missing.length > 0) {
			throw new ToolError(
				'invalid-arguments',
				`no secret named ${missing.join(', ')}; browser_get_state lists the names available on this page`,
			);
		}
		if (refused.length > 0) {
			throw new ToolError(
				'navigation-blocked',
				`the secret ${refused.join(', ')} is not permitted on ${originOf(url)}`,
			);
		}
		return { text: out, used, substituted: used.length > 0 };
	}

	/** `text` with every stored value of four or more characters, as written, replaced by `[secret]`. Pure. */
	redact(text: string): string {
		if (this.empty || text === '') return text;
		const values = [...new Set([...this.#entries.values()].map((entry) => entry.value))]
			.filter((value) => value.length >= REDACT_MIN_LENGTH)
			.sort((a, b) => b.length - a.length);
		if (values.length === 0) return text;
		const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
		return text.replace(pattern, REDACTED);
	}
}

/**
 * `value` with {@linkcode SecretStore.redact} applied to every string inside it: object values, array items and
 * nested content blocks, never keys. Pure; returns `value` itself when nothing changed or the store is empty.
 */
export function redactDeep<T>(value: T, store: SecretStore | undefined): T {
	if (store === undefined || store.empty) return value;
	return walk(value, store) as T;
}

/** {@linkcode redactDeep}'s recursion; returns the same reference when nothing below it changed. */
function walk(value: unknown, store: SecretStore): unknown {
	if (typeof value === 'string') return store.redact(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((item) => {
			const next = walk(item, store);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (value === null || typeof value !== 'object') return value;
	const record = value as Record<string, unknown>;
	const binary = record.type === 'image' || record.type === 'audio';
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		const next = (binary && key === 'data') || key === 'blob' ? item : walk(item, store);
		if (next !== item) changed = true;
		out[key] = next;
	}
	return changed ? out : value;
}

/** The shortest stored value `SecretStore.redact` replaces. */
const REDACT_MIN_LENGTH = 4;
/** What `SecretStore.redact` writes in place of a value. */
const REDACTED = '[secret]';

/** The origin of a URL for an error message, or the raw string when unparseable. */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

/** Parses the configured secrets. */
export function parseSecrets(raw: string): SecretEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		// V8's own message quotes the input — the whole of it when short, its start otherwise — so a bare credential
		// stored where this document belongs (the file, the variable, a provider) would be printed by the refusal.
		const at = cause instanceof SyntaxError ? /\bat position (\d+)\b/.exec(cause.message)?.[1] : undefined;
		throw new Error(at === undefined ? 'not valid JSON' : `not valid JSON at position ${at}`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('expected a JSON object mapping secret names to values');
	}

	const entries: SecretEntry[] = [];
	let entry = 0;
	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		entry += 1;
		if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(name)) {
			// Located, never repeated. A map written the wrong way round puts the credential where the name
			// belongs, and a name that fails this grammar is exactly where it would land.
			throw new Error(`invalid secret name (entry ${entry}): use letters, digits, _ . - (max 64)`);
		}
		if (typeof value === 'string') {
			if (value === '') throw new Error(`secret ${name} is empty`);
			entries.push({ name, value, domains: [] });
			continue;
		}
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`secret ${name} must be a string or an object with a value`);
		}
		const record = value as { value?: unknown; domains?: unknown };
		if (typeof record.value !== 'string' || record.value === '') {
			throw new Error(`secret ${name} must carry a non-empty string value`);
		}
		let domains: string[] = [];
		if (record.domains !== undefined) {
			if (!Array.isArray(record.domains) || record.domains.some((d) => typeof d !== 'string')) {
				throw new Error(`secret ${name}: domains must be an array of strings`);
			}
			domains = record.domains as string[];
		}
		entries.push({ name, value: record.value, domains });
	}
	return entries;
}

// --- the secret-fill element contract ----------------------------------------

/** The element shapes `browser_fill_secret` will type a server-held credential into. */
const FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'text']);

/** What a fillable element turned out to be, for the result and for the refusal messages. */
interface FillTarget {
	/** Lower-cased tag name: `input` or `textarea`. */
	readonly tag: string;
	/** The input's `type`, or `textarea` for one. Structural, never content. */
	readonly type: string;
}

/** Names an element for a refusal message — **tag, `type=` and `#id` only**. */
export function describeFillTarget(node: {
	nodeName?: string;
	attributes?: Record<string, string> | null;
}): string {
	const tag = (node.nodeName ?? 'unknown').toLowerCase();
	const type = node.attributes?.type;
	const id = node.attributes?.id;
	return `<${tag}${type === undefined ? '' : ` type=${type}`}${id === undefined ? '' : ` #${id}`}>`;
}

/** Refuses an element a server-held credential must not be typed into. */
export function assertFillable(node: {
	nodeName?: string;
	attributes?: Record<string, string> | null;
}, index: number): FillTarget {
	const tag = (node.nodeName ?? '').toLowerCase();
	if (tag !== 'input' && tag !== 'textarea') {
		throw new ToolError(
			'element-not-interactable',
			`${describeFillTarget(node)} is not an input or textarea; a secret is only ever typed into one`,
			{ index, tag },
		);
	}
	if (tag === 'textarea') return { tag, type: 'textarea' };
	const type = (node.attributes?.type ?? 'text').toLowerCase();
	if (!FILLABLE_INPUT_TYPES.has(type)) {
		throw new ToolError(
			'element-not-interactable',
			`${describeFillTarget(node)} is not a password or text input; a secret is only ever typed into one`,
			{ index, tag },
		);
	}
	return { tag, type };
}
