/**
 * Element replay keys: the three hashes of DATA-MODEL §6.1 ("Derived members") and the five-level
 * `MatchLevel` cascade of §6.6.
 *
 * The hashes are the only handle a later step has on an element it touched earlier — `backendNodeId`
 * dies with its snapshot (§6.3 R6.3), so history replay (AGENT-RUNTIME §12) re-identifies the node by
 * content. Three keys, deliberately ordered by how much page churn each survives:
 *
 * | key | input | survives |
 * |---|---|---|
 * | `elementHash` | tag path \| sorted static attrs \| AX name | nothing but an identical element |
 * | `stableHash` | same, with dynamic CSS class tokens filtered | CSS-in-JS / build-hash class churn |
 * | `parentBranchHash` | tag path only | attribute and label churn |
 *
 * Digest: SHA-256 via WebCrypto (`crypto.subtle`, D-DEP1 rung (a)), hex, first 16 chars — 64 bits, a
 * ~1e-10 collision probability over a 1000-element page, which is the level of care an index-free
 * fallback path deserves and no more.
 */

import { encodeHex } from '@std/encoding/hex';
import { type DomInteractedElement, type EnhancedDomTreeNode, MatchLevel } from './types.ts';

const TEXT_ENCODER = new TextEncoder();

/** Hex characters kept from the SHA-256 digest (§6.1: "sha256[:16 hex]"). */
export const HASH_HEX_LENGTH = 16;

/** Field separator inside a hash preimage. Chosen because it cannot occur in a tag path. */
const FIELD_SEPARATOR = '|';

/**
 * Attributes excluded from the "static attrs" component of {@linkcode elementHash}: `style` is
 * rewritten by every animation frame and `on*` handlers are frequently rebound by frameworks.
 *
 * ERRATUM(M1-dom-serialize-6): §6.1 says "sorted static attrs" without defining *static*. Implemented
 * as "all attributes except `style` and `on*`"; `class` stays in (it is what separates
 * {@linkcode elementHash} from {@linkcode stableHash}).
 */
function isStaticAttribute(name: string): boolean {
	return name !== 'style' && !name.startsWith('on');
}

/**
 * Class tokens treated as machine-generated and therefore dropped from {@linkcode stableHash}.
 *
 * ERRATUM(M1-dom-serialize-7): §6.1/§6.6 say "dynamic CSS class tokens" without a rule. Implemented as
 * the four patterns below plus {@linkcode DYNAMIC_STATE_CLASSES}, deliberately narrow: a false
 * positive only weakens level-2 matching, a false negative makes `stableHash` no better than
 * `elementHash`.
 */
const DYNAMIC_CLASS_PATTERNS: readonly RegExp[] = [
	/^(?:css|sc|emotion|jss|makestyles|styled)[-_][a-z0-9]{3,}$/i, // CSS-in-JS runtime classes
	/[-_][0-9a-f]{6,}$/i, // CSS-modules / webpack content-hash suffix
	/^[0-9a-f]{8,}$/i, // bare content hash
	/^(?:is|has)-[a-z-]+$/i, // BEM-ish state flags
];

/** State classes toggled by interaction rather than by authorship. */
const DYNAMIC_STATE_CLASSES: ReadonlySet<string> = new Set([
	'active',
	'checked',
	'collapsed',
	'current',
	'disabled',
	'expanded',
	'focus',
	'focused',
	'hidden',
	'hover',
	'hovered',
	'loading',
	'open',
	'opened',
	'selected',
	'show',
	'shown',
	'visible',
]);

/** True when a single class token looks generated rather than authored. */
export function isDynamicClassToken(token: string): boolean {
	if (token.length === 0) return false;
	if (DYNAMIC_STATE_CLASSES.has(token.toLowerCase())) return true;
	return DYNAMIC_CLASS_PATTERNS.some((pattern) => pattern.test(token));
}

/** Drops dynamic tokens from a `class` attribute value, preserving the order of what survives. */
export function filterDynamicClasses(classValue: string): string {
	return classValue.split(/\s+/).filter((token) => token.length > 0 && !isDynamicClassToken(token)).join(' ');
}

/** Lowercase tag name; the local mirror of `DomNodeDerived.tagName`. */
function tagOf(node: EnhancedDomTreeNode): string {
	return node.nodeName.toLowerCase();
}

/**
 * Root-first `/`-joined lowercase tag path, node inclusive.
 *
 * Stops at an iframe boundary exactly like `DomNodeDerived.xpath` does, so a hash computed inside a
 * frame does not change when the embedding page is restructured. Non-element ancestors (documents,
 * shadow fragments) contribute no step — shadow boundaries are transparent, matching the xpath rule.
 */
export function tagPath(node: EnhancedDomTreeNode): string {
	const steps: string[] = [];
	let current: EnhancedDomTreeNode | null = node;
	while (current !== null) {
		if (current.nodeType === 1) {
			const tag = tagOf(current);
			if (current !== node && (tag === 'iframe' || tag === 'frame')) break;
			steps.push(tag);
		}
		current = current.parentNode;
	}
	return steps.reverse().join('/');
}

/** `k=v` pairs, key-sorted and comma-joined — the second field of the composite preimage. */
export function staticAttributeString(node: EnhancedDomTreeNode, options: { stable: boolean }): string {
	const pairs: string[] = [];
	for (const name of Object.keys(node.attributes).sort()) {
		if (!isStaticAttribute(name)) continue;
		const raw = node.attributes[name] ?? '';
		const value = options.stable && name === 'class' ? filterDynamicClasses(raw) : raw;
		pairs.push(`${name}=${value}`);
	}
	return pairs.join(',');
}

/** SHA-256 of `input`, hex, truncated to `length` characters. */
export async function sha256Prefix(input: string, length: number = HASH_HEX_LENGTH): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(input));
	return encodeHex(new Uint8Array(digest)).slice(0, length);
}

/** The preimage both composite hashes share, differing only in class filtering. */
function compositePreimage(node: EnhancedDomTreeNode, stable: boolean): string {
	return [
		tagPath(node),
		staticAttributeString(node, { stable }),
		node.axNode?.name ?? '',
	].join(FIELD_SEPARATOR);
}

/** §6.1 — sha256[:16 hex] over parent-tag-path | sorted static attrs | AX name. */
export function elementHash(node: EnhancedDomTreeNode): Promise<string> {
	return sha256Prefix(compositePreimage(node, false));
}

/** §6.1 — {@linkcode elementHash} with dynamic CSS class tokens filtered out. */
export function stableHash(node: EnhancedDomTreeNode): Promise<string> {
	return sha256Prefix(compositePreimage(node, true));
}

/** §6.1 — tag path only. */
export function parentBranchHash(node: EnhancedDomTreeNode): Promise<string> {
	return sha256Prefix(tagPath(node));
}

/** Attributes §6.6 requires on a persisted `DomInteractedElement` "at minimum". */
export const REPLAY_ATTRIBUTES = ['name', 'id', 'aria-label'] as const;

/**
 * Builds the §6.6 record persisted per executed action.
 *
 * `xPath` is supplied by the caller rather than derived here: the xpath contract belongs to
 * `DomNodeDerived` (types.ts §6.1), which the extraction half owns.
 */
export async function buildInteractedElement(
	node: EnhancedDomTreeNode,
	xPath: string,
): Promise<DomInteractedElement> {
	const attributes: Record<string, string> = {};
	for (const name of REPLAY_ATTRIBUTES) {
		const value = node.attributes[name];
		if (value !== undefined) attributes[name] = value;
	}
	const [exact, stable] = await Promise.all([elementHash(node), stableHash(node)]);
	return {
		elementHash: exact,
		stableHash: stable,
		xPath,
		axName: node.axNode?.name ?? null,
		attributes,
		frameId: node.frameId === '' ? null : node.frameId,
	};
}

/** A node offered to the replay cascade, with its xpath already derived. */
export interface ReplayCandidate {
	readonly node: EnhancedDomTreeNode;
	readonly xPath: string;
}

/** Where in the §6.6 cascade a candidate was re-found. */
export interface ReplayMatch {
	readonly node: EnhancedDomTreeNode;
	readonly level: MatchLevel;
}

/** The cascade order — ascending numeric value, as §6.6 requires. */
export const MATCH_LEVEL_ORDER: readonly MatchLevel[] = [
	MatchLevel.EXACT,
	MatchLevel.STABLE,
	MatchLevel.XPATH,
	MatchLevel.AX_NAME,
	MatchLevel.ATTRIBUTE,
];

/** Human label for a level; used in logs and test names. */
export function matchLevelName(level: MatchLevel): string {
	const entry = Object.entries(MatchLevel).find(([, value]) => value === level);
	return entry?.[0] ?? 'UNKNOWN';
}

/** True when every non-empty replay attribute of `target` is present and equal on `node`. */
function attributesMatch(target: DomInteractedElement, node: EnhancedDomTreeNode): boolean {
	const wanted = Object.entries(target.attributes).filter(([, value]) => value !== '');
	if (wanted.length === 0) return false;
	return wanted.every(([name, value]) => node.attributes[name] === value);
}

/**
 * §6.6 replay cascade: EXACT → STABLE → XPATH → AX_NAME → ATTRIBUTE, tried in ascending numeric
 * order, first level that matches wins.
 *
 * Levels 1–4 take the first candidate in the supplied (document) order when several match — an
 * ambiguous hash still identifies the *kind* of element the agent meant. Level 5 requires a **unique**
 * match, because §6.6 spells that requirement out only for ATTRIBUTE and because attribute matching is
 * the loosest key in the set.
 *
 * When `target.frameId` is set and any candidate carries it, the search is restricted to that frame;
 * otherwise every candidate is considered (frame ids are not stable across reloads, so this is a
 * narrowing hint, never a hard filter).
 */
export async function matchInteractedElement(
	target: DomInteractedElement,
	candidates: readonly ReplayCandidate[],
): Promise<ReplayMatch | null> {
	const sameFrame = target.frameId === null
		? []
		: candidates.filter((candidate) => candidate.node.frameId === target.frameId);
	const pool = sameFrame.length > 0 ? sameFrame : candidates;
	if (pool.length === 0) return null;

	const hashes = await Promise.all(
		pool.map(async (candidate) => ({
			exact: await elementHash(candidate.node),
			stable: await stableHash(candidate.node),
		})),
	);

	for (const level of MATCH_LEVEL_ORDER) {
		if (level === MatchLevel.ATTRIBUTE) {
			const matches = pool.filter((candidate) => attributesMatch(target, candidate.node));
			if (matches.length === 1 && matches[0] !== undefined) return { node: matches[0].node, level };
			continue;
		}
		for (let index = 0; index < pool.length; index++) {
			const candidate = pool[index];
			if (candidate === undefined) continue;
			const digest = hashes[index];
			const hit = level === MatchLevel.EXACT
				? digest?.exact === target.elementHash
				: level === MatchLevel.STABLE
				? digest?.stable === target.stableHash
				: level === MatchLevel.XPATH
				? target.xPath !== '' && candidate.xPath === target.xPath
				: target.axName !== null && target.axName !== '' && candidate.node.axNode?.name === target.axName;
			if (hit) return { node: candidate.node, level };
		}
	}
	return null;
}
