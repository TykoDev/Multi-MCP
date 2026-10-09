/**
 * `state_token` — the identity of the index table a client is addressing (report_design.md §4.1).
 *
 * An LLM index is only meaningful against the table that minted it. Before this module the product
 * had no way to say so: `nodeAt` resolved an index against whatever `#cachedBrowserState` happened
 * to hold, and a caller replaying an index against a page the browser had already left got an
 * element rather than a refusal. The token is the missing half of that contract.
 *
 * ## Two components, one string
 *
 * The wire form is `<identity>.<content>`, two 16-hex-character SHA-256 prefixes over two
 * preimages that share a version prefix:
 *
 * - the **identity** half covers what an index *addresses* — the top URL, the per-frame identity of
 *   every captured session, and `index | sessionId | backendNodeId | tag` per emitted element. Two
 *   states whose identity halves agree assign the same index to the same node, which is exactly the
 *   `indices_stable` predicate; it is computable from this half alone, which is why the token is
 *   split rather than opaque-and-single.
 * - the **content** half covers what an index *shows* — `index | rendered attribute string |
 *   AX name | value component`. It moves when the page's visible content moves under stable indices.
 *
 * ## What is deliberately excluded
 *
 * **Root scroll.** Including it would churn the token on every wheel event and destroy the diff
 * contract the token exists to serve.
 *
 * **Password values.** A password field contributes the literal `masked`, never a digest of its
 * value (DD-7). A `since_token` diff therefore cannot observe a password edit — that is the `input`
 * event's job, and the documentation says so. A digest would be a 64-bit oracle over a secret an
 * attacker can guess against offline; the literal is not.
 *
 * ## Determinism
 *
 * The element component is emitted in ascending index order and the frame component in ascending
 * `frameId` order, so the token does not depend on map iteration order or on the order Chrome
 * happened to attach OOPIF sessions. This is invariant I-1's testable half and is pinned over all 36
 * recorded captures in `state_token_test.ts` (U-1).
 */

import { crypto } from '@std/crypto';
import { encodeHex } from '@std/encoding/hex';
import type { EnhancedDomTreeNode } from './types.ts';
import { buildAttributeString } from './serialize_attrs.ts';
import { isPasswordField } from './derived.ts';
import { defaultDerived, type SerializerDerived } from './serialize_derived.ts';

/**
 * Preimage version prefix. Bump when the preimage composition changes, so a token minted by an older
 * build can never silently compare equal to one minted by a newer build.
 */
export const STATE_TOKEN_VERSION = 'stk1';

/** Hex characters kept per half, matching `hashes.ts` — 64 bits each, 128 bits over the pair. */
export const STATE_TOKEN_HEX_LENGTH = 16;

/** Field separator inside a component line. Cannot occur in an index, a session id or a tag. */
const FIELD = '|';

/**
 * Length-prefix a page-controlled field before it is joined into a preimage.
 *
 * ERRATUM(E-38, security review of E-36): `|` and newline are structural in these preimages, and
 * three inputs can contain both and are page-controlled — the top URL, an OOPIF's URL, and an
 * accessible name computed from page text. Chrome preserves an unencoded `|` in a URL query, so a
 * page could choose a URL or an AX name that shifted the field boundaries and made two materially
 * different states digest identically, collapsing the `indices_stable` / `stale-token` distinction
 * the module exists to provide. Length-prefixing makes the boundary structural rather than
 * conventional: no choice of content can move it.
 */
function field(value: string): string {
	return `${value.length}:${value}`;
}

/** The literal a password field contributes to the content half instead of its value (DD-7). */
export const MASKED_VALUE_COMPONENT = 'masked';

/** One captured frame's identity, as `CapturedSession` records it. */
export interface StateTokenFrame {
	readonly frameId: string;
	readonly url: string;
}

/** Inputs to {@linkcode mintStateToken}. */
export interface StateTokenInput {
	/** The top document's URL, as the state summary reports it. */
	readonly topUrl: string;
	/** Per captured session; order is irrelevant, the mint sorts by `frameId`. */
	readonly frames: readonly StateTokenFrame[];
	/** The serializer's index table — the exact set of indices the client may act with. */
	readonly selectorMap: ReadonlyMap<number, EnhancedDomTreeNode>;
	/** `AgentSettings.includeAttributes`, so the rendered attribute string matches what was emitted. */
	readonly includeAttributes?: readonly string[] | undefined;
	/** The same derived ops the render pass used, so the attribute string is the emitted one. */
	readonly derived?: SerializerDerived | undefined;
}

/** The minted token, split so callers can compare either half without re-parsing the wire string. */
export interface StateToken {
	/** The wire form: `<identity>.<content>`. */
	readonly token: string;
	/** The index-identity half alone — the `indices_stable` predicate's input. */
	readonly identity: string;
	/** The content half alone. */
	readonly content: string;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * SHA-256, hex, truncated — the same digest shape `hashes.ts` uses (D-DEP1 rung (a)).
 *
 * `@std/crypto`'s `digestSync` rather than WebCrypto's async `digest`: the serializer is synchronous
 * and minting the token must not turn `serializeDomState` into a promise, which would ripple through
 * `DOMWatchdog` and every caller of it for no behavioural gain.
 */
function sha(preimage: string): string {
	const digest = crypto.subtle.digestSync('SHA-256', TEXT_ENCODER.encode(preimage));
	return encodeHex(new Uint8Array(digest)).slice(0, STATE_TOKEN_HEX_LENGTH);
}

/**
 * The value component of the content half.
 *
 * Reads only the `value` **attribute**, which is what the serializer itself renders; the live typed
 * property is not reflected into it and is not available here. A password field never contributes
 * its value — see the module header.
 */
function valueComponent(node: EnhancedDomTreeNode): string {
	if (isPasswordField(node)) return MASKED_VALUE_COMPONENT;
	return node.attributes['value'] ?? '';
}

/**
 * Mint a `state_token` over an emitted index table.
 *
 * Pure and synchronous: it is a by-product of the render walk, not a second pass over the page, and
 * the serializer calls it on the path that already holds every input.
 */
export function mintStateToken(input: StateTokenInput): StateToken {
	const identityLines: string[] = [`${STATE_TOKEN_VERSION}${FIELD}${field(input.topUrl)}`];
	const contentLines: string[] = [STATE_TOKEN_VERSION];

	// Sorted by `frameId`: OOPIF sessions attach in whatever order Chrome chose, and the token must
	// not depend on that. Frame URL sits in the identity half because a frame that navigated is a
	// different address space for the indices inside it, even when the rendered text is unchanged.
	const frames = [...input.frames].sort((a, b) => (a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0));
	for (const frame of frames) identityLines.push(`F${FIELD}${field(frame.frameId)}${FIELD}${field(frame.url)}`);

	const derived = input.derived ?? defaultDerived;
	const indices = [...input.selectorMap.keys()].sort((a, b) => a - b);
	for (const index of indices) {
		const node = input.selectorMap.get(index);
		if (node === undefined) continue;
		const tag = derived.tagName(node);
		identityLines.push(
			`E${FIELD}${index}${FIELD}${field(node.sessionId)}${FIELD}${node.backendNodeId}${FIELD}${field(tag)}`,
		);
		const attrs = buildAttributeString(node, {
			derived,
			...(input.includeAttributes === undefined ? {} : { includeAttributes: input.includeAttributes }),
		});
		const axName = node.axNode?.name ?? '';
		contentLines.push(
			`C${FIELD}${index}${FIELD}${field(attrs)}${FIELD}${field(axName)}${FIELD}${field(valueComponent(node))}`,
		);
	}

	const identity = sha(identityLines.join('\n'));
	const content = sha(contentLines.join('\n'));
	return { token: `${identity}.${content}`, identity, content };
}

/**
 * True when two tokens assign the same indices to the same nodes, whatever their content did.
 *
 * The `indices_stable` predicate. A malformed token (no separator) is never stable against anything,
 * including itself, because a client that sent one has told us nothing we can rely on.
 */
export function indicesStable(a: string, b: string): boolean {
	const left = a.split('.')[0] ?? '';
	const right = b.split('.')[0] ?? '';
	if (left === '' || right === '' || !a.includes('.') || !b.includes('.')) return false;
	return left === right;
}
