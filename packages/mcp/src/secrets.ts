/**
 * Secret placeholders for `browser_type` (SPECS/ROADMAP.md R14).
 *
 * The problem this solves: to log a model into something, *somebody* has to
 * send the password. Without this, that somebody is the model — the credential
 * appears in its context, in the tool call, in the transcript the client keeps,
 * and in whatever that client logs. None of those are places a credential
 * should be.
 *
 * So the value never leaves the server. The operator configures it here; the
 * model is told only the *name* and writes `<secret>github_password</secret>`;
 * substitution happens in the handler, after validation, on the way to the
 * browser. The model can use a credential it is never shown.
 *
 * Two rules make that safe rather than merely convenient:
 *
 * 1. **Domain scoping.** A secret declares where it may be typed. A model that
 *    has been talked into visiting an attacker's page cannot spend the banking
 *    password there: substitution on a non-matching origin is refused, and the
 *    refusal is reported to the model as an error rather than silently typing
 *    the placeholder text into the field.
 * 2. **One direction.** Nothing reads a secret back out. The value is not in
 *    any result, any log line, or any error message — only its name is.
 *
 * **The pin is a secret-scoping decision, not a navigation one** (SEC-FH-23).
 * Rule 1 is enforced by {@linkcode urlMatch} in its `'secret'` context, which is
 * the primitive `sensitiveData` scoping calls (the `M4` scheme rule lives with
 * the matcher, `packages/browser/src/security/url_matcher.ts`). The
 * navigation predicate is a *different rule* that deliberately permits
 * `about:blank`, `data:`, `blob:` and plaintext `http:` — all correct for "may
 * the agent go here", all wrong for "may a credential be spent here" — and
 * resolving the pin through it typed pinned credentials at opaque and plaintext
 * origins. The two predicates are not interchangeable and this module must never
 * reach for the navigation one again.
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
	 * Domain patterns this secret may be used on, in the same *pattern* syntax as
	 * the navigation allowlist but under the stricter `'secret'` scheme rule: a
	 * scheme-less pattern covers `https:` only, and a secret that genuinely has to
	 * be typed over plaintext HTTP needs an explicit `http://host` pattern
	 * (the matcher's M4 scheme rule, `packages/browser/src/security/url_matcher.ts`;
	 * SECURITY-AUTH.md §7.1 states the pin). Empty means any origin the server itself
	 * permits — which is why `browser_fill_secret` refuses an empty one outright.
	 */
	readonly domains: readonly string[];
}

/** What a substitution did, with no value anywhere in it. */
export interface Substitution {
	/** The text to actually type. */
	readonly text: string;
	/** Names substituted, in first-use order. */
	readonly used: readonly string[];
	/** True when any placeholder was replaced, so the caller can mask its echo. */
	readonly substituted: boolean;
}

/**
 * The configured secrets.
 *
 * Immutable after construction: a store that could be written at runtime would
 * be a way to exfiltrate one (write a known value, read the effect).
 */
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

	/**
	 * The domain patterns a named secret is pinned to, or `undefined` when there is no such secret.
	 *
	 * An **empty array is the meaningful answer**, not a missing one: it is what `parseSecrets`
	 * produces for the short form, and `#permits` reads it as "any origin the server itself permits".
	 * `browser_fill_secret` refuses on exactly that answer (SEC-07), so it needs to be able to see it
	 * without being handed the entry — and being handed the entry would mean being handed the value.
	 */
	domainsOf(name: string): readonly string[] | undefined {
		return this.#entries.get(name)?.domains;
	}

	/**
	 * The names usable on `url`, which is what a model is told about.
	 *
	 * Naming a secret that cannot be used here would invite the model to plan
	 * around an affordance it does not have.
	 */
	namesFor(url: string): string[] {
		return [...this.#entries.values()]
			.filter((entry) => this.#permits(entry, url))
			.map((entry) => entry.name)
			.sort();
	}

	/**
	 * True when `entry` may be typed into a page at `url` — **the SEC-07 pin, and the one place it is
	 * decided** (SEC-FH-23).
	 *
	 * Both consumers come through here: {@linkcode substitute}, which binds the value, and
	 * {@linkcode namesFor}, which is what `browser_get_state` advertises to the model. That is not an
	 * accident of factoring, it is the property being kept — `available_secrets` is an authorization
	 * statement, so a predicate that disagreed with the pin would have the server *proposing* a spend
	 * it would then refuse, or worse, advertising one it would allow.
	 *
	 * `urlMatch(…, 'secret')` fails closed on an empty, unparseable or host-less URL (M1) and on a
	 * new-tab URL (M2), so `about:blank`, `data:`, `blob:` and `javascript:` have no host to match and
	 * are refused; in the `'secret'` context a scheme-less pattern covers `https:` only, so a pinned
	 * host reached over plaintext `http:` is refused too. Each of those was a measured fail-open row.
	 */
	#permits(entry: SecretEntry, url: string): boolean {
		if (entry.domains.length === 0) return true;
		return entry.domains.some((pattern) => urlMatch(url, pattern, 'secret'));
	}

	/**
	 * Replaces every `<secret>name</secret>` in `text` with its value.
	 *
	 * @throws ToolError when a named secret does not exist, or exists but is not
	 * permitted on `url`. Both are refusals rather than pass-throughs: typing the
	 * literal string `<secret>x</secret>` into a password field would look to the
	 * model like success and leave a broken login nobody can debug.
	 */
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

	/**
	 * `text` with every stored value of four or more characters, as written, replaced by `[secret]` (design §2.0
	 * item 10). Pure.
	 *
	 * S0 seam for the read paths that hand page-derived text back to a model — W1's network log and HAR, W2's
	 * accessibility tree — where a typed secret can reappear in a header, a URL or a field's accessible name. One
	 * pass with the longest value tried first at each position, so a value containing a shorter one is never left
	 * half-replaced and a value that happens to spell part of `[secret]` cannot rewrite an earlier replacement.
	 * Shorter values are skipped: replacing two or three characters everywhere would wreck the text and hide nothing.
	 */
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

/**
 * Parses the configured secrets.
 *
 * Two shapes, both JSON: a flat `{"name": "value"}` map for secrets usable
 * anywhere, and `{"name": {"value": "…", "domains": ["*.example.com"]}}` when a
 * secret should be pinned to where it belongs. Mixing them in one document is
 * allowed — the common case is one pinned credential among several unpinned
 * ones, and forcing the long form on all of them would just invite the operator
 * to skip the pinning.
 */
export function parseSecrets(raw: string): SecretEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		// Review R1-1 (D-123, S-10): V8's own message quotes the input — the whole of it when short, its start otherwise
		// — so a bare credential stored where this document belongs (the file, the variable, a provider) was printed by
		// the refusal. A fixed phrase, and the position when the parser reports one.
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
			// Review R1-1: located, never repeated. A map written the wrong way round puts the credential where the name
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

// --- the secret-fill element contract (B2.8) ---------------------------------

/**
 * The element shapes `browser_fill_secret` will type a server-held credential into.
 *
 * `text` is here because the requirement asks for it and because it is right: plenty of login forms
 * use `type=text` for the username, and a reveal toggle turns a password field into one. The
 * consequence is worth stating rather than leaving implied — **once `text` is permitted, the "is this
 * a password field" check carries no weight, and the secret's domain pinning is the only control that
 * remains** (SEC-07). That is why `browser_fill_secret` refuses an unpinned secret where
 * `browser_type` allows one.
 */
const FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set(['password', 'text']);

/** What a fillable element turned out to be, for the result and for the refusal messages. */
export interface FillTarget {
	/** Lower-cased tag name: `input` or `textarea`. */
	readonly tag: string;
	/** The input's `type`, or `textarea` for one. Structural, never content. */
	readonly type: string;
}

/**
 * Names an element for a refusal message — **tag, `type=` and `#id` only**.
 *
 * One function, so a refusal cannot become the disclosure the result avoided. The obvious
 * implementation of "say which element" is to serialise the node's attribute map, and a password
 * input the browser has already filled carries the credential in that map — which would put it into
 * an error string that reaches the transcript and the logs. Three attributes are named here and
 * nothing is iterated, so widening it is an edit rather than an accident; the BF-8 matrix exercises
 * this function against the three password shapes for exactly that reason.
 *
 * (The invariant I-14 scanner reads comments as well as code, deliberately, which is why this note
 * describes the attribute rather than spelling it — a module that only *mentions* the read would
 * otherwise have to be allowlisted beside the ones that perform it.)
 */
export function describeFillTarget(node: {
	nodeName?: string;
	attributes?: Record<string, string> | null;
}): string {
	const tag = (node.nodeName ?? 'unknown').toLowerCase();
	const type = node.attributes?.type;
	const id = node.attributes?.id;
	return `<${tag}${type === undefined ? '' : ` type=${type}`}${id === undefined ? '' : ` #${id}`}>`;
}

/**
 * Refuses an element a server-held credential must not be typed into.
 *
 * `element-not-interactable` rather than `unknown-index` or `invalid-arguments`: the index resolved
 * and the element is the one the caller meant — it simply cannot take this action. The other two
 * codes would be false in opposite directions (B2.5's reason for the code existing at all).
 */
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
