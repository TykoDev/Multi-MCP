/**
 * DOM serialization — the merged IR rendered to the exact text the LLM reads, together with the
 * selector map, index assignment, new-element marking and the wall-clock fail-safe.
 *
 * This module is the output half of serialization parity: the string it returns *is* the product
 * surface, so every rule it applies is enumerated and pinned by a golden fixture rather than left to
 * the shape of the code. The pipeline is three passes, in order:
 *
 * 1. {@linkcode simplifyDomTree} — IR → `SimplifiedNode` tree, index assignment, new-element marking.
 * 2. {@linkcode renderSimplifiedTree} — `SimplifiedNode` tree → text (attribute rules inside).
 * 3. Hard truncation at `maxClickableElementsLength` (40 000 chars).
 *
 * The budget fail-safe is a *safety* property, not an error path: whenever the request cannot be
 * completed, the caller gets a state whose selector map is empty, so an LLM can never act on an index
 * that no longer resolves.
 */

import type { EnhancedDomTreeNode, SerializedDomState } from './types.ts';
import { defaultDerived, type SerializerDerived } from './serialize_derived.ts';
import { selectorKey, simplifyDomTree, type SimplifyOptions } from './serialize_simplify.ts';
import { renderSimplifiedTree } from './serialize_render.ts';
import { mintStateToken, type StateTokenFrame } from './state_token.ts';

export {
	defaultDerived,
	renderSimplifiedTree,
	selectorKey,
	type SerializerDerived,
	simplifyDomTree,
	type SimplifyOptions,
};
export { isDisabledControl, isInteractiveElement, isOffscreenOnly, type SimplifyResult } from './serialize_simplify.ts';
export {
	ATTRIBUTE_VALUE_CAP,
	buildAttributeMap,
	buildAttributeString,
	capValue,
	DEFAULT_DATEPICKER_FORMAT,
	DEFAULT_INCLUDE_ATTRIBUTES,
	isPasswordInputTag,
} from './serialize_attrs.ts';
export { MAX_HIDDEN_ELEMENT_HINTS, type RenderOptions } from './serialize_render.ts';
export {
	indicesStable,
	MASKED_VALUE_COMPONENT,
	mintStateToken,
	STATE_TOKEN_HEX_LENGTH,
	STATE_TOKEN_VERSION,
	type StateToken,
	type StateTokenFrame,
	type StateTokenInput,
} from './state_token.ts';

/** `AgentSettings.maxClickableElementsLength`. */
export const MAX_CLICKABLE_ELEMENTS_LENGTH = 40_000;

/** `stateError` text of the non-actionable fail-safe state. */
export const STATE_TIMEOUT_ERROR = 'DOM serialization exceeded its budget; selector map withheld';

/** Options for {@linkcode serializeDomState}. */
export interface SerializeOptions {
	/** Derived members. Defaults to {@linkcode defaultDerived}. */
	readonly derived?: SerializerDerived | undefined;
	/** The previous step's key set, from the previous result's `keys`. */
	readonly previousKeys?: ReadonlySet<string> | undefined;
	/** `AgentSettings.includeAttributes`. */
	readonly includeAttributes?: readonly string[] | undefined;
	/** Default {@linkcode MAX_CLICKABLE_ELEMENTS_LENGTH}. */
	readonly maxClickableElementsLength?: number | undefined;
	/** `BrowserProfile.paintOrderFiltering`, default `true`. */
	readonly paintOrderFiltering?: boolean | undefined;
	/** Interactivity override — see `serialize_simplify.ts`. */
	readonly isInteractive?: SimplifyOptions['isInteractive'] | undefined;
	/** Admit offscreen-but-rendered elements to the index (`include_hidden`). */
	readonly includeOffscreen?: boolean | undefined;
	/** Emits `[Start of page]` when `0`. */
	readonly pixelsAbove?: number | undefined;
	/** Emits `[End of page]` when `0`. */
	readonly pixelsBelow?: number | undefined;
	/** Cap on iframe hidden-element hints; default 10. */
	readonly maxHiddenElementHints?: number | undefined;
	/** Whole-request wall-clock budget in ms. */
	readonly budgetMs?: number | undefined;
	/** Clock injection point for the budget; defaults to {@linkcode Date.now}. */
	readonly now?: (() => number) | undefined;
	/** Top-document URL, minted into the `state_token` identity half. */
	readonly topUrl?: string | undefined;
	/** Per captured session, minted into the `state_token` identity half. */
	readonly frames?: readonly StateTokenFrame[] | undefined;
}

/** What the DOM pipeline hands to `DOMWatchdog`. */
export interface DomSerializationResult {
	/** The seam type: simplified tree + `selectorMap`. */
	readonly state: SerializedDomState;
	/** The rendered text, already truncated. */
	readonly text: string;
	/** Cached reverse map, `sessionId:backendNodeId` → index. */
	readonly reverseMap: Map<string, number>;
	/** Pass as `previousKeys` on the next request. */
	readonly keys: Set<string>;
	/** Non-null exactly when the state is the non-actionable fallback (`stateError`). */
	readonly stateError: string | null;
	/** True when the hard cap clipped the text. */
	readonly truncated: boolean;
	/**
	 * The identity of the index table in `state`, or `null` when there is no table to address.
	 *
	 * `null` exactly when `selectorMap` is empty by fail-safe: a caller holding a token can then be
	 * told `no-state` rather than being silently resolved against a table that is not there.
	 */
	readonly stateToken: string | null;
}

/**
 * The non-actionable state.
 *
 * Empty `selectorMap`, empty text, `stateError` set. `DOMWatchdog` synthesizes this on a whole-event
 * timeout so that no stale index survives into the next prompt.
 */
export function failSafeDomState(reason: string = STATE_TIMEOUT_ERROR): DomSerializationResult {
	return {
		state: { root: null, selectorMap: new Map() },
		text: '',
		reverseMap: new Map(),
		keys: new Set(),
		stateError: reason,
		truncated: false,
		stateToken: null,
	};
}

/**
 * Recognizes the CDP "the id you held is gone" family.
 *
 * These mean "rebuild the state", never "crash": the map is rebuilt on every
 * `BrowserStateRequestEvent` anyway, so a stale id is an ordinary consequence of the page moving on.
 */
export function isStaleNodeIdError(error: unknown): boolean {
	const message = error instanceof Error
		? error.message
		: typeof error === 'string'
		? error
		: typeof error === 'object' && error !== null && 'message' in error
		? String((error as { message: unknown }).message)
		: '';
	return /no node (?:with )?(?:the )?given id/i.test(message) ||
		/could not find node/i.test(message) ||
		/node with given id does not belong/i.test(message);
}

/** Runs the three passes and returns everything `DOMWatchdog` needs. */
export function serializeDomState(
	root: EnhancedDomTreeNode | null,
	options: SerializeOptions = {},
): DomSerializationResult {
	const derived = options.derived ?? defaultDerived;
	const simplified = simplifyDomTree(root, {
		derived,
		previousKeys: options.previousKeys,
		paintOrderFiltering: options.paintOrderFiltering ?? true,
		isInteractive: options.isInteractive,
		includeOffscreen: options.includeOffscreen === true,
		budgetMs: options.budgetMs,
		now: options.now,
	});
	// A partial walk must never yield a partial map — the indices in it would out-live the tree
	// they were derived from.
	if (simplified.timedOut) return failSafeDomState();

	const rendered = renderSimplifiedTree(simplified.root, {
		derived,
		includeAttributes: options.includeAttributes,
		pixelsAbove: options.pixelsAbove,
		pixelsBelow: options.pixelsBelow,
		maxHiddenElementHints: options.maxHiddenElementHints,
	});
	// The 40 000-char cap is a PROMPT-LAYER concern, not a serializer one: the prompt layer embeds the
	// output under `Interactive elements:`, hard-truncated. The recorded corpus confirms it — the
	// reference's serialized output for `truncation_large` is 225 423 chars with its tail intact.
	// Capping here would silently discard ~185 000 chars of page content before the prompt layer ever
	// saw it, removing elements the reference makes available to the model. The cap is therefore
	// OPT-IN: a prompt assembler passes MAX_CLICKABLE_ELEMENTS_LENGTH explicitly.
	const cap = options.maxClickableElementsLength ?? Number.POSITIVE_INFINITY;
	const truncated = rendered.length > cap;

	// Minted from the table that was actually emitted, after the budget fail-safe has had its say, so a
	// token can never name a map the caller was not given.
	const minted = mintStateToken({
		topUrl: options.topUrl ?? '',
		frames: options.frames ?? [],
		selectorMap: simplified.selectorMap,
		derived,
		...(options.includeAttributes === undefined ? {} : { includeAttributes: options.includeAttributes }),
	});

	return {
		state: { root: simplified.root, selectorMap: simplified.selectorMap },
		// A hard truncation: no ellipsis or marker, so the cut is a plain slice and may land mid-line.
		text: truncated ? rendered.slice(0, cap) : rendered,
		reverseMap: simplified.reverseMap,
		keys: simplified.keys,
		stateError: null,
		truncated,
		stateToken: minted.token,
	};
}
