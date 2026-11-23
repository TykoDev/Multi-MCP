/**
 * Derived members of `EnhancedDomTreeNode`: computed on demand, never stored on the node.
 *
 * They are functions rather than fields so the IR stays JSON-shaped (the node graph is cyclic via
 * `parentNode`; adding methods would make stripping that cycle for serialization harder, not easier).
 *
 * The three replay hashes of the same contract (`elementHash`, `stableHash`, `parentBranchHash`) live
 * in `hashes.ts` and are owned by the serialization builder; {@linkcode DomNodeDerivedCore} is exactly
 * this file's half of `DomNodeDerived`.
 */

import type { DomNodeDerived, EnhancedDomTreeNode, ScrollInfo } from './types.ts';

/** DOM-spec node types this module branches on. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;

/** Subtrees whose text is markup, not content. */
const NON_TEXT_TAGS: ReadonlySet<string> = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * Attribute order for {@linkcode getMeaningfulTextForLlm}: the first non-empty of
 * `value`/`aria-label`/`title`/`placeholder`/`alt`, else the children's text.
 */
export const MEANINGFUL_TEXT_ATTRIBUTES: readonly string[] = ['value', 'aria-label', 'title', 'placeholder', 'alt'];

/**
 * A scroll extent must exceed its client extent by more than this (CSS px) to count as scrollable.
 *
 * 1 px absorbs the sub-pixel rounding Chrome
 * applies to `scrollWidth`/`scrollHeight`, which otherwise reports a 1 px "scrollable" overflow on
 * ordinary non-scrolling boxes.
 */
export const SCROLLABLE_EPSILON_PX = 1;

/** This file's half of the `DomNodeDerived` contract — everything except the three replay hashes. */
export type DomNodeDerivedCore = Omit<DomNodeDerived, 'elementHash' | 'stableHash' | 'parentBranchHash'>;

/** Lowercase `nodeName`. */
export function tagName(node: EnhancedDomTreeNode): string {
	return node.nodeName.toLowerCase();
}

/** `IFRAME`/`FRAME` as CDP spells them. */
export function isFrameTag(node: EnhancedDomTreeNode): boolean {
	return node.nodeName === 'IFRAME' || node.nodeName === 'FRAME';
}

/**
 * Same-tag XPath; passes shadow roots; stops at iframe boundaries.
 *
 * The walk terminates at the first `DOCUMENT_NODE`, which is precisely the iframe boundary: a frame's
 * document is the root of its own coordinate *and* id space, and its `parentNode` (the host `<iframe>`
 * in the enclosing document) belongs to a different document. Shadow roots are `DOCUMENT_FRAGMENT`s
 * and contribute no step, so the path passes straight through them — deliberately not a resolvable
 * document XPath, but the one `MatchLevel.XPATH` is defined against.
 *
 * Non-element nodes contribute no step of their own, so a text node's xpath is its parent element's.
 *
 * The path reads `html/body/main/button`, as the recorded reference corpus spells it: **no** leading
 * slash, and a `[k]` position **only** where the element actually has same-tag siblings
 * (`html/body/main/table[1]/tfoot/tr`: `tfoot` holds one `tr`, `tbody` holds three and they are
 * numbered). Both points are load-bearing beyond cosmetics because this string is the
 * `MatchLevel.XPATH` replay key.
 */
export function xpath(node: EnhancedDomTreeNode): string {
	const steps: string[] = [];
	let current: EnhancedDomTreeNode | null = node;
	while (current !== null && current.nodeType !== DOCUMENT_NODE) {
		if (current.nodeType === ELEMENT_NODE) steps.unshift(elementStep(current));
		current = current.parentNode;
	}
	return steps.join('/');
}

function elementStep(node: EnhancedDomTreeNode): string {
	const tag = tagName(node);
	const siblings = node.parentNode?.childrenNodes;
	// Not found among a parent's children — the node hangs off `shadowRoots`/`contentDocument`
	// instead, both of which are single-slot, so it is a lone child and carries no position.
	if (siblings === undefined) return tag;
	let position = 0;
	let total = 0;
	for (const sibling of siblings) {
		// `nodeName` and not `tagName`: SVG is case-sensitive, so its `<a>` is a different element from
		// HTML's `<A>` and the two must not share a counter.
		if (sibling.nodeName !== node.nodeName) continue;
		total += 1;
		if (sibling === node) position = total;
	}
	return total <= 1 ? tag : `${tag}[${position}]`;
}

/**
 * `overflow` values that let a box scroll. Everything else (`visible`, `hidden`, `clip`) clips or
 * spills, and a clipped box is not reachable by a scroll action however far its content overflows.
 */
const SCROLLING_OVERFLOW: ReadonlySet<string> = new Set(['auto', 'scroll', 'overlay']);

/** True when either axis of this box is declared scrollable by its computed `overflow`. */
export function overflowAllowsScrolling(node: EnhancedDomTreeNode): boolean {
	const styles = node.snapshotNode?.computedStyles ?? null;
	// No styles at all: `DOMSnapshot` emitted no layout row, so nothing is known — defer to the flag.
	if (styles === null) return true;
	const shorthand = styles['overflow'];
	const x = styles['overflow-x'] ?? shorthand;
	const y = styles['overflow-y'] ?? shorthand;
	// All three absent is the same "nothing known" case as above.
	if (x === undefined && y === undefined) return true;
	return (x !== undefined && SCROLLING_OVERFLOW.has(x)) || (y !== undefined && SCROLLING_OVERFLOW.has(y));
}

/**
 * Whether the node can actually be scrolled, as opposed to merely being marked scrollable.
 *
 * **This is the sole implementation of the predicate.** `serialize_derived.ts` re-exports it rather
 * than keeping a copy, so the serializer and the extractor cannot disagree.
 *
 * Three gates, in order:
 *
 * 1. Chrome must have flagged the box. `DOM.Node.isScrollable` is Blink's own "this layout box owns a
 *    scrollable area", and nothing else has that information.
 * 2. The computed `overflow` must admit scrolling on at least one axis. Corroboration, not a
 *    substitute: the reference wraps `#scroller`/`#auto-scroller` in `|scroll element|` and emits
 *    `#hidden-overflow`'s buttons bare.
 * 3. The geometry decides: `scrollRects` carries `[scrollLeft, scrollTop, scrollWidth, scrollHeight]`
 *    and `clientRects` carries `[clientLeft, clientTop, clientWidth, clientHeight]`, so a real overflow
 *    is `scrollExtent - clientExtent > `{@linkcode SCROLLABLE_EPSILON_PX}. A flagged box with no
 *    layout row at all passes — that is the document node, which Chrome flags and DOMSnapshot skips.
 *
 * Gate 1 reads `isScrollable !== true`, not `=== false`: `DOM.Node.isScrollable` is an *optional*
 * field (`packages/cdp/src/domains/dom.ts`) that Blink sets only when true, so `null` is what CDP emits
 * for every unflagged box. Across the 37 recorded captures the flag occurs 24 times, **all `true`, none
 * `false`**, so `=== false` would never fire and scrollability would be decided from the two proxies
 * alone. The discriminating input is a real corpus node: `select_native`'s `<select multiple>` has the
 * UA's `overflow-y: scroll` and no flag, and its options fit its box by exactly 0 px; one more
 * `<option>` and a proxy-only reading would emit a `|scroll element|` marker the reference does not.
 */
export function isActuallyScrollable(node: EnhancedDomTreeNode): boolean {
	if (node.isScrollable !== true) return false;
	if (!overflowAllowsScrolling(node)) return false;
	const scroll = node.snapshotNode?.scrollRects ?? null;
	const client = node.snapshotNode?.clientRects ?? null;
	if (scroll === null || client === null) return true;
	if (client.width <= 0 && client.height <= 0) return true;
	const vertical = scroll.height - client.height > SCROLLABLE_EPSILON_PX;
	const horizontal = scroll.width - client.width > SCROLLABLE_EPSILON_PX;
	return vertical || horizontal;
}

/**
 * Scroll position expressed the way the serializer's scroll suffixes render it: pages above/below plus an optional
 * horizontal percentage. `null` when the node has no usable scroll geometry.
 */
export function scrollInfo(node: EnhancedDomTreeNode): ScrollInfo | null {
	const scroll = node.snapshotNode?.scrollRects ?? null;
	const client = node.snapshotNode?.clientRects ?? null;
	if (scroll === null || client === null) return null;
	if (client.height <= 0) return null;

	const scrollTop = Math.max(0, scroll.y);
	const hiddenBelow = Math.max(0, scroll.height - client.height - scrollTop);
	const pagesAbove = scrollTop / client.height;
	const pagesBelow = hiddenBelow / client.height;

	const horizontalRange = scroll.width - client.width;
	const horizontalPercent = horizontalRange > SCROLLABLE_EPSILON_PX && client.width > 0
		? clamp((100 * Math.max(0, scroll.x)) / horizontalRange, 0, 100)
		: null;

	return { pagesAbove, pagesBelow, horizontalPercent };
}

/** Whether the serializer's `(X.X pages above, Y.Y pages below)` suffix has anything to say about this node. */
export function shouldShowScrollInfo(node: EnhancedDomTreeNode): boolean {
	if (!isActuallyScrollable(node)) return false;
	const info = scrollInfo(node);
	if (info === null) return false;
	return info.pagesAbove > 0 || info.pagesBelow > 0 || info.horizontalPercent !== null;
}

/**
 * Concatenated visible descendant text, whitespace-normalized and single-space joined.
 *
 * `maxDepth` counts hops from `node`; negative means unlimited. The walk descends into shadow roots
 * (their content is rendered as part of this element) but never into `contentDocument` — an iframe's
 * text belongs to the iframe, not to its host.
 *
 * Subtrees whose node has `isVisible === false` are skipped, because everything downstream of this function is LLM-visible
 * text and `display:none` copy is exactly the kind of content that must not reach the model.
 * `isVisible === null` (unknown, e.g. fragments) still descends.
 */
export function getAllChildrenText(node: EnhancedDomTreeNode, maxDepth: number, includeHidden = false): string {
	const parts: string[] = [];
	collectText(node, maxDepth, 0, parts, includeHidden);
	return parts.join(' ');
}

/**
 * The text of an element the *viewport* gate excluded, for the serializer's "scroll to reveal" hints.
 *
 * `getMeaningfulTextForLlm` skips `isVisible === false` subtrees, which is right for prompt text and
 * wrong here — a hidden-element hint fires precisely because the element is off-band, so that helper
 * would give hints empty labels ("`<button> "" ~2.3 pages down`"), naming nothing. Positional invisibility must not blank the label; `display:none` still does, because
 * `isHiddenHintCandidate` applies the CSS gate before this is ever called.
 */
export function getOffscreenTextForLlm(node: EnhancedDomTreeNode): string {
	for (const attribute of MEANINGFUL_TEXT_ATTRIBUTES) {
		if (isPasswordField(node) && attribute === 'value') continue;
		const value = normalizeWhitespace(node.attributes[attribute] ?? '');
		if (value !== '') return value;
	}
	return getAllChildrenText(node, -1, true);
}

function collectText(
	node: EnhancedDomTreeNode,
	maxDepth: number,
	depth: number,
	out: string[],
	includeHidden: boolean,
): void {
	if (maxDepth >= 0 && depth > maxDepth) return;
	if (!includeHidden && node.isVisible === false) return;
	if (node.nodeType === TEXT_NODE) {
		const text = normalizeWhitespace(node.nodeValue);
		if (text !== '') out.push(text);
		return;
	}
	if (node.nodeType === ELEMENT_NODE && NON_TEXT_TAGS.has(node.nodeName)) return;
	for (const child of node.childrenNodes) collectText(child, maxDepth, depth + 1, out, includeHidden);
	for (const shadowRoot of node.shadowRoots ?? []) collectText(shadowRoot, maxDepth, depth + 1, out, includeHidden);
}

/**
 * The text an LLM should see for this element: the first non-empty of
 * `value` / `aria-label` / `title` / `placeholder` / `alt`, else its children's text.
 *
 * `value` is skipped for password inputs — the anti-exfiltration rule forbids ever emitting it, and
 * a helper that leaks it into an iframe hint or a log line would defeat the rule at the emission site.
 */
export function getMeaningfulTextForLlm(node: EnhancedDomTreeNode): string {
	const password = isPasswordField(node);
	for (const attribute of MEANINGFUL_TEXT_ATTRIBUTES) {
		if (password && attribute === 'value') continue;
		const value = normalizeWhitespace(node.attributes[attribute] ?? '');
		if (value !== '') return value;
	}
	return getAllChildrenText(node, -1);
}

/**
 * Attribute-name tokens that mark a field as a credential.
 *
 * Deliberately bounded and anchored on token boundaries rather than a bare substring.
 * A bare `/pass/` would scrub `passenger_name`, `boarding_pass` and `compass`; the boundary
 * characters are the four separators HTML form names actually use (`-`, `_`, `.`, `[`).
 *
 * `pass`, `pw`, `pin`, `secret` and the API/access-token spellings are included: `name="pass"` is the
 * single most common credential field name in PHP and Rails forms in existence.
 */
const CREDENTIAL_NAME_PATTERN =
	/(?:^|[-_.[])(?:pass|passwd|password|passphrase|passcode|pwd|pword|pw|secret|otp|totp|mfa[-_.]?code|2fa[-_.]?code|cvv|cvc|pin|apikey|api[-_.]?key|access[-_.]?token|auth[-_.]?token)(?:[-_.\]]|$)/i;

/**
 * Label text that says the field is a credential, in the words a human reader would see.
 *
 * Not English-only, because the job is visiting arbitrary sites: `Contraseña`, `Mot de passe`, `Passwort` and `パスワード` are the
 * *visible* label on a login form that arms 1 and 2 may not reach. The CJK and Cyrillic spellings sit
 * outside the `\b` group because `\b` is defined over ASCII word characters and would never match
 * beside them.
 */
const CREDENTIAL_LABEL_PATTERN =
	/(?:\b(?:password|passphrase|passcode|one[-\s]?time\s+code|security\s+code|contraseña|contrasena|mot\s+de\s+passe|passwort|kennwort|senha|wachtwoord|lösenord|losenord|salasana|adgangskode|hasło|haslo)\b|пароль|密码|パスワード|비밀번호)/i;

/**
 * Class tokens a reveal ("show password") widget puts on the input it toggles, or on its wrapper.
 *
 * The reveal toggle is the arm that matters most and is hardest to see: the widget flips
 * `input.type` from `password` to `text` in the DOM, so at the exact moment the value is on screen
 * in plain text every `type`-based predicate stops firing, and the value starts reaching the model.
 * Nothing in the DOM records what the type *was*, so the marks the widget leaves behind are what is
 * left to read.
 *
 * The character class is spelled `[\s_-]` with the dash last: `[\s-_]` is a range whose endpoint is a
 * class escape, which is Annex-B-only and throws under a `u` or `v` flag.
 */
const REVEAL_MARKER_PATTERN =
	/(?:^|[\s_-])(?:password|passwd|pwd|reveal|toggle)(?:[-_\s]*(?:password|passwd|pwd|visibility|toggle|input|field|wrapper))?(?:[\s_-]|$)/i;

/** The attributes a label heuristic may read. Never `value`. */
const LABEL_ATTRIBUTES: readonly string[] = ['aria-label', 'placeholder', 'title'];

/**
 * `autocomplete` tokens with which the page tells a password manager "fill a secret here".
 *
 * `cc-number` and `cc-csc` are in. A card number is not a password, but it is exactly the class of
 * value that must stay out of a transcript and a third-party model's context, and arm 3 already
 * scrubs the `cvv`/`cvc` *name* spelling.
 */
const CREDENTIAL_AUTOCOMPLETE: ReadonlySet<string> = new Set([
	'current-password',
	'new-password',
	'one-time-code',
	'cc-number',
	'cc-csc',
]);

/** Attributes a reveal widget marks. */
const REVEAL_MARKER_ATTRIBUTES: readonly string[] = ['class', 'data-testid', 'data-test', 'data-qa'];

/**
 * Input types that structurally cannot hold a typed credential.
 *
 * A **denylist**, deliberately: anything not named here — including an unrecognised `type` keyword,
 * which HTML renders as a text box, and `hidden`, which a server can re-render a credential into —
 * falls through to arms 2-5 rather than being waved past them.
 */
const NON_CREDENTIAL_INPUT_TYPES: ReadonlySet<string> = new Set([
	'button',
	'checkbox',
	'color',
	'date',
	'datetime-local',
	'file',
	'image',
	'month',
	'radio',
	'range',
	'reset',
	'submit',
	'time',
	'week',
]);

/**
 * The fields a secret was typed into, by CDP session id, then `backendNodeId`. This lives here rather
 * than in the embedding server because {@linkcode isPasswordField} is consulted inside this package — the attribute
 * serializer emits a text field's live AX value as `value=`, `getMeaningfulTextForLlm` reads the
 * `value` attribute (which React keeps in sync with the live value), and the `state_token` mint hashes
 * the value — and a server-side mask on only its own surfaces would leave those three emitting it. A
 * `<textarea>` or a text input none of the five arms recognises would otherwise be protected only by
 * exact-match redaction of the secret, which `maxlength` truncation, page reformatting, CRLF
 * normalisation, whitespace collapsing or the 100-character attribute cap all defeat.
 *
 * Keyed by `(sessionId, backendNodeId)` rather than by node object because every capture builds new
 * node objects; the pair names the field across captures. A reused `backendNodeId` in a later document
 * is then masked too — over-scrubbing, the predicate's stated bias. Bounded: past
 * {@linkcode SECRET_FILLED_CAP} entries the oldest CDP session's set is dropped first, which by then
 * names a target long gone.
 */
const SECRET_FILLED = new Map<string, Set<number>>();

/** The most `(sessionId, backendNodeId)` pairs {@linkcode markSecretFilled} holds at once. */
export const SECRET_FILLED_CAP = 4096;

let secretFilledCount = 0;

/**
 * Records that a secret was typed into the node `backendNodeId` of CDP session `sessionId`, so that
 * {@linkcode isPasswordField} treats it as a password field from now on. Call it
 * before the keystrokes are dispatched: a capture racing the dispatch then already masks the field.
 */
export function markSecretFilled(sessionId: string, backendNodeId: number): void {
	// A node with no session could never be matched again by `isSecretFilled`; recording it would only cost room.
	if (typeof sessionId !== 'string') return;
	let set = SECRET_FILLED.get(sessionId);
	if (set === undefined) {
		set = new Set();
		SECRET_FILLED.set(sessionId, set);
	}
	if (set.has(backendNodeId)) return;
	set.add(backendNodeId);
	secretFilledCount += 1;
	for (const [oldest, ids] of SECRET_FILLED) {
		if (secretFilledCount <= SECRET_FILLED_CAP || oldest === sessionId) break;
		SECRET_FILLED.delete(oldest);
		secretFilledCount -= ids.size;
	}
}

/** Whether {@linkcode markSecretFilled} recorded this node. Never throws (it guards emission paths). */
export function isSecretFilled(node: EnhancedDomTreeNode): boolean {
	const sessionId = node?.sessionId;
	if (typeof sessionId !== 'string') return false;
	return SECRET_FILLED.get(sessionId)?.has(node.backendNodeId) === true;
}

/**
 * Is this element a credential field?
 *
 * **The single definition of "is a password" in the tree**: two definitions drift apart. It guards the
 * anti-exfiltration path — it gates `value` out of the attribute string, out of
 * {@linkcode getMeaningfulTextForLlm}, out of `browser_get_state`'s element labels and out of the
 * `state_token` content half — so it is deliberately biased towards over-scrubbing: a
 * false positive costs a model one field's value, a false negative puts a credential in a transcript
 * and in a third-party model's context.
 *
 * Five arms, not two. `type="password"` and the `autocomplete` arm between them miss the two shapes a security review found on real login pages — a field the page names or labels
 * as a password without declaring either attribute, and a field a reveal toggle has switched to
 * `type="text"` while the value is visible. `<textarea>` and `<select>` are excluded because neither
 * can be a password input; every other element type is excluded because `value` means something else
 * on it.
 *
 * **And a field the embedding server itself typed a secret into**
 * ({@linkcode markSecretFilled}), whatever its shape — a `<textarea>` included. The five arms judge
 * the page's word for what a field is; a server that has just spent a credential on a field knows
 * better, and the field must then be scrubbed exactly as a password is.
 */
export function isPasswordField(node: EnhancedDomTreeNode): boolean {
	if (isSecretFilled(node)) return true;
	if (node.nodeName !== 'INPUT') return false;
	const attributes = node.attributes ?? {};
	const type = (attributes['type'] ?? '').trim().toLowerCase();
	// Arm 1 — the static case, and (because setting `el.type` reflects to the attribute) a field
	// switched *to* password after load, provided extraction re-read the attribute.
	if (type === 'password') return true;

	// A type that STRUCTURALLY cannot hold a typed credential is not one, whatever it is called:
	// `<input type="checkbox" name="save_password">` is a preference, and scrubbing it would cost a
	// model a control it can act on and protect nothing.
	//
	// A denylist, not an allowlist of scrubbable types: HTML's `input.type` IDL falls back to **text**
	// for any unrecognised keyword, so `<input type="passcode" name="password"
	// autocomplete="current-password">` renders as an ordinary text box and takes a credential. An
	// allowlist would let that one attribute, which a hostile page fully controls, skip arms 2-5.
	// Unknown keywords, and `hidden` (which a server can re-render a credential into), fall through.
	if (NON_CREDENTIAL_INPUT_TYPES.has(type)) return false;

	// Arm 2 — what password managers fill.
	const autocomplete = (attributes['autocomplete'] ?? '').trim().toLowerCase();
	if (CREDENTIAL_AUTOCOMPLETE.has(autocomplete)) return true;

	// Arm 3 — the page's own name for the field. `name` and `id` are authored, not rendered, so this
	// arm sees fields whose visible label lives in a `<label for=…>` this predicate cannot reach.
	for (const attribute of ['name', 'id']) {
		if (CREDENTIAL_NAME_PATTERN.test(attributes[attribute] ?? '')) return true;
	}

	// Arm 4 — what a human reading the page would call it. The accessible name is included because it
	// is the one place a `<label for=…>` reliably surfaces in the merged IR.
	for (const attribute of LABEL_ATTRIBUTES) {
		if (CREDENTIAL_LABEL_PATTERN.test(attributes[attribute] ?? '')) return true;
	}
	if (CREDENTIAL_LABEL_PATTERN.test(node.axNode?.name ?? '')) return true;

	// Arm 5 — the reveal toggle. See {@linkcode REVEAL_MARKER_PATTERN}. The marks are
	// read on the input AND on its two nearest ancestors, because the common Bootstrap/Tailwind reveal
	// pattern puts `password-toggle` on the wrapping `<div>` while the input itself carries only
	// `form-control` — read on the input alone this arm would almost never fire in practice.
	// `?? null` on both reads, not optional chaining alone: a security predicate must never throw. It
	// is called from `labelOf`, from the attribute builder and from the token mint, none of which has
	// a catch, and a thrown predicate on a partially-populated node would take out the whole state
	// read rather than scrubbing one field.
	let host: EnhancedDomTreeNode | null | undefined = node;
	for (let depth = 0; depth < 3 && host !== null && host !== undefined; depth += 1, host = host.parentNode) {
		const hostAttributes = host.attributes ?? {};
		for (const attribute of REVEAL_MARKER_ATTRIBUTES) {
			if (REVEAL_MARKER_PATTERN.test(hostAttributes[attribute] ?? '')) return true;
		}
	}
	return false;
}

/** Collapse every whitespace run to one space and trim. */
export function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** The derived contract as one object, for callers that prefer it over the free functions. */
export const domNodeDerived: DomNodeDerivedCore = {
	tagName,
	xpath,
	isActuallyScrollable,
	shouldShowScrollInfo,
	scrollInfo,
	getAllChildrenText,
	getMeaningfulTextForLlm,
};
