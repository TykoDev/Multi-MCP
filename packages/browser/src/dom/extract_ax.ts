/**
 * `Accessibility.getFullAXTree` decoding — the semantics third of the merge.
 *
 * Contract: SPECS/DATA-MODEL.md §6.2 (`EnhancedAxNode`, "unknown property names are dropped at merge
 * time"), §6.5 (which AX property names the serializer may emit).
 */

import type { CdpResult } from '@tykotech/cdp';
import type { EnhancedAxNode } from './types.ts';

/** One `Accessibility.AXNode` as it arrives on the wire. */
export type CapturedAxNode = CdpResult['Accessibility.getFullAXTree']['nodes'][number];

/** `Accessibility.AXValue`. */
type CapturedAxValue = NonNullable<CapturedAxNode['role']>;

/**
 * AX property names that survive the merge (DATA-MODEL §6.2 "unknown property names dropped").
 *
 * ERRATUM(M1-dom-extract-4): §6.2 never enumerates "known". The list below is
 * `§6.5`'s emission whitelist (`checked … live`) — the only normative list of AX property names in
 * the spec set — **plus** the scalar state properties Chrome emits that a serializer needs to reason
 * about interactivity (`focusable`, `editable`, `settable`, `readonly`, `multiline`, `hidden`,
 * `hiddenRoot`, `modal`, `autocomplete`, `orientation`, `roledescription`, `url`, `atomic`,
 * `relevant`, `root`, `focused`). Relation-valued names (`controls`, `describedby`, `flowto`,
 * `labelledby`, `owns`, `activedescendant`, `details`, `errormessage`) are dropped: their value is a
 * node list, which the seam's `string | boolean | null` cannot represent without inventing an
 * encoding.
 *
 * Spelling is **CDP's**, not §6.5's: CDP emits `hasPopup`, §6.5 spells the emitted attribute
 * `haspopup`. The IR keeps the wire spelling; case-folding for emission belongs to the serializer.
 */
export const KNOWN_AX_PROPERTIES: ReadonlySet<string> = new Set([
	// §6.5 emission whitelist
	'checked',
	'selected',
	'expanded',
	'pressed',
	'disabled',
	'invalid',
	'valuemin',
	'valuemax',
	'valuenow',
	'keyshortcuts',
	'hasPopup',
	'haspopup',
	'multiselectable',
	'required',
	'valuetext',
	'level',
	'busy',
	'live',
	// scalar state/relevance properties Chrome emits
	'focusable',
	'focused',
	'editable',
	'settable',
	'readonly',
	'multiline',
	'hidden',
	'hiddenRoot',
	'modal',
	'autocomplete',
	'orientation',
	'roledescription',
	'atomic',
	'relevant',
	'root',
	'url',
]);

/** AX value types whose payload is a node reference rather than a scalar. */
const RELATION_VALUE_TYPES: ReadonlySet<string> = new Set([
	'idref',
	'idrefList',
	'node',
	'nodeList',
	'valueUndefined',
]);

/** The decoded AX tree, keyed the way the merge joins it. */
export interface DecodedAxTree {
	readonly byBackendNodeId: ReadonlyMap<number, EnhancedAxNode>;
	readonly byAxNodeId: ReadonlyMap<string, EnhancedAxNode>;
	/** AX nodes with no `backendDOMNodeId` — they cannot be joined and are counted, not kept. */
	readonly unjoinedCount: number;
}

/** `AXValue` → `string | null`. Only genuinely-string payloads survive. */
export function axValueToString(value: CapturedAxValue | undefined): string | null {
	if (value === undefined) return null;
	const raw = value.value;
	if (typeof raw === 'string') return raw;
	return null;
}

/** `AXValue` → the seam's `string | boolean | null` property payload. */
export function axPropertyValue(value: CapturedAxValue | undefined): string | boolean | null {
	if (value === undefined) return null;
	if (RELATION_VALUE_TYPES.has(value.type)) return null;
	const raw = value.value;
	if (raw === undefined || raw === null) return null;
	if (typeof raw === 'boolean') return raw;
	if (typeof raw === 'string') return raw;
	if (typeof raw === 'number') return String(raw);
	return null;
}

/**
 * Decode a full AX tree into `backendNodeId → EnhancedAxNode`.
 *
 * When several AX nodes claim the same `backendDOMNodeId` (Chrome does this for nodes that are both
 * ignored and exposed under a different role) the **first non-ignored** one wins; an ignored node is
 * only kept when nothing better turns up. Losing the exposed node would silently strip the accessible
 * name, which is exactly the kind of invisible drift R1 is about.
 */
export function decodeAxTree(nodes: readonly CapturedAxNode[]): DecodedAxTree {
	const byBackendNodeId = new Map<number, EnhancedAxNode>();
	const byAxNodeId = new Map<string, EnhancedAxNode>();
	let unjoinedCount = 0;

	for (const raw of nodes) {
		const decoded: EnhancedAxNode = {
			axNodeId: raw.nodeId,
			ignored: raw.ignored,
			role: axValueToString(raw.role),
			name: axValueToString(raw.name),
			description: axValueToString(raw.description),
			properties: decodeProperties(raw.properties),
			childIds: raw.childIds === undefined ? null : [...raw.childIds],
		};
		byAxNodeId.set(decoded.axNodeId, decoded);

		const backendNodeId = raw.backendDOMNodeId;
		if (backendNodeId === undefined) {
			unjoinedCount += 1;
			continue;
		}
		const existing = byBackendNodeId.get(backendNodeId);
		if (existing === undefined || (existing.ignored && !decoded.ignored)) {
			byBackendNodeId.set(backendNodeId, decoded);
		}
	}

	return { byBackendNodeId, byAxNodeId, unjoinedCount };
}

function decodeProperties(
	properties: CapturedAxNode['properties'],
): { name: string; value: string | boolean | null }[] | null {
	if (properties === undefined) return null;
	const out: { name: string; value: string | boolean | null }[] = [];
	for (const property of properties) {
		if (!KNOWN_AX_PROPERTIES.has(property.name)) continue;
		if (RELATION_VALUE_TYPES.has(property.value.type)) continue;
		out.push({ name: property.name, value: axPropertyValue(property.value) });
	}
	return out;
}
