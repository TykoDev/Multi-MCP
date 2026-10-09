/**
 * Authoring form for the DOM-serializer goldens.
 *
 * `EnhancedDomTreeNode` (DATA-MODEL §6.1) is a cyclic graph with 25 fields, most of which are `null`
 * on any given node — unusable as a hand-written JSON fixture. This module defines a terse acyclic
 * JSON shape and inflates it into the real IR (parent links wired, defaults filled), so a fixture
 * states only what the rule under test needs and every unstated field takes its documented default.
 *
 * The inflated tree is a genuine `EnhancedDomTreeNode`: nothing here stubs or intercepts serializer
 * behaviour, it only builds input data.
 */

import type {
	EnhancedAxNode,
	EnhancedDomTreeNode,
	HiddenElementInfo,
	NodeType,
	RequiredComputedStyle,
	ShadowRootType,
} from '../../src/dom/types.ts';

/** `[x, y, width, height]`. */
export type FixtureRect = [number, number, number, number];

/** The terse authoring node. Exactly one of `tag` / `text` is given. */
export interface FixtureNode {
	/** Uppercase tag name for an element node. */
	readonly tag?: string;
	/** Text content for a TEXT_NODE. */
	readonly text?: string;
	/** `backendNodeId`; auto-assigned (skipping explicit ids) when omitted. */
	readonly id?: number;
	readonly session?: string;
	readonly frame?: string;
	readonly target?: string;
	readonly attrs?: Record<string, string>;
	/** `isVisible`; defaults to `true`. `null` means "unknown, inherit". */
	readonly visible?: boolean | null;
	readonly scrollable?: boolean;
	/** `absolutePosition`. */
	readonly rect?: FixtureRect;
	readonly paintOrder?: number;
	readonly clickable?: boolean;
	readonly jsClick?: boolean;
	readonly cursor?: string;
	readonly styles?: Record<string, string>;
	/** `snapshotNode.clientRects`. */
	readonly client?: FixtureRect;
	/** `snapshotNode.scrollRects`: x/y = offset, w/h = extent. */
	readonly scroll?: FixtureRect;
	readonly ax?: {
		readonly role?: string;
		readonly name?: string;
		readonly props?: Record<string, string | boolean | null>;
	};
	readonly shadow?: readonly { readonly type: ShadowRootType; readonly children: readonly FixtureNode[] }[];
	/** `contentDocument` for iframes/frames. */
	readonly document?: FixtureNode;
	readonly compound?: readonly Record<string, string>[];
	readonly hidden?: readonly { readonly tag: string; readonly text: string; readonly pages: number }[];
	readonly children?: readonly FixtureNode[];
}

/** A whole fixture file: the tree plus the serializer options it is rendered with. */
export interface FixtureFile {
	readonly name: string;
	/** What this pair pins, quoted into the test name. */
	readonly pins: string;
	readonly options?: {
		readonly pixelsAbove?: number;
		readonly pixelsBelow?: number;
		readonly paintOrderFiltering?: boolean;
		readonly includeAttributes?: string[];
		readonly maxHiddenElementHints?: number;
	};
	readonly tree: FixtureNode;
}

const DEFAULT_SESSION = 'session-main';

function rect(source: FixtureRect | undefined) {
	if (source === undefined) return null;
	const [x, y, width, height] = source;
	return { x, y, width, height };
}

function axNode(source: FixtureNode['ax']): EnhancedAxNode | null {
	if (source === undefined) return null;
	const properties = source.props === undefined
		? null
		: Object.entries(source.props).map(([name, value]) => ({ name, value }));
	return {
		axNodeId: `ax-${source.name ?? source.role ?? 'node'}`,
		ignored: false,
		role: source.role ?? null,
		name: source.name ?? null,
		description: null,
		properties,
		childIds: null,
	};
}

/** Collects every explicitly stated backend id so the auto-assigner never shadows one. */
function collectExplicitIds(node: FixtureNode, into: Set<number>): void {
	if (node.id !== undefined) into.add(node.id);
	for (const child of node.children ?? []) collectExplicitIds(child, into);
	for (const shadowRoot of node.shadow ?? []) {
		for (const child of shadowRoot.children) collectExplicitIds(child, into);
	}
	if (node.document !== undefined) collectExplicitIds(node.document, into);
}

/** Deterministic id source: explicit ids win, everything else takes the next unused integer. */
class IdAllocator {
	#next = 1;
	readonly #taken: Set<number>;

	constructor(taken: Set<number>) {
		this.#taken = taken;
	}

	take(explicit: number | undefined): number {
		if (explicit !== undefined) return explicit;
		while (this.#taken.has(this.#next)) this.#next += 1;
		const id = this.#next;
		this.#next += 1;
		return id;
	}
}

interface BuildContext {
	readonly ids: IdAllocator;
	readonly session: string;
	readonly frame: string;
	readonly target: string;
}

function buildNode(
	source: FixtureNode,
	parent: EnhancedDomTreeNode | null,
	context: BuildContext,
	overrideType?: NodeType,
	shadowRootType?: ShadowRootType,
): EnhancedDomTreeNode {
	const isText = source.text !== undefined;
	const nodeType: NodeType = overrideType ?? (isText ? 3 : 1);
	const backendNodeId = context.ids.take(source.id);
	const session = source.session ?? context.session;
	const frame = source.frame ?? context.frame;
	const target = source.target ?? context.target;
	const hasSnapshot = source.rect !== undefined || source.paintOrder !== undefined ||
		source.clickable !== undefined || source.cursor !== undefined || source.styles !== undefined ||
		source.client !== undefined || source.scroll !== undefined;

	const hiddenElementsInfo: HiddenElementInfo[] = (source.hidden ?? []).map((entry) => ({
		tagName: entry.tag,
		text: entry.text,
		pagesAway: entry.pages,
	}));

	const node: EnhancedDomTreeNode = {
		nodeId: backendNodeId,
		backendNodeId,
		nodeType,
		nodeName: isText ? '#text' : (source.tag ?? 'DIV').toUpperCase(),
		nodeValue: source.text ?? '',
		attributes: { ...source.attrs },
		isScrollable: source.scrollable ?? null,
		isVisible: source.visible === undefined ? true : source.visible,
		absolutePosition: rect(source.rect),
		targetId: target,
		frameId: frame,
		sessionId: session,
		contentDocument: null,
		shadowRootType: shadowRootType ?? null,
		shadowRoots: null,
		parentNode: parent,
		childrenNodes: [],
		axNode: axNode(source.ax),
		snapshotNode: hasSnapshot
			? {
				bounds: rect(source.rect),
				computedStyles: (source.styles ?? null) as Partial<Record<RequiredComputedStyle, string>> | null,
				cursorStyle: source.cursor ?? null,
				paintOrder: source.paintOrder ?? null,
				clientRects: rect(source.client),
				scrollRects: rect(source.scroll),
				stackingContexts: null,
				isClickable: source.clickable ?? false,
				inputValue: null,
				inputChecked: null,
				optionSelected: null,
				textValue: null,
			}
			: null,
		compoundChildren: (source.compound ?? []).map((entry) => ({ ...entry })),
		hasJsClickListener: source.jsClick ?? false,
		hiddenElementsInfo,
		hasHiddenContent: hiddenElementsInfo.length > 0,
		uuid: `00000000-0000-7000-8000-${String(backendNodeId).padStart(12, '0')}`,
	};

	const childContext: BuildContext = { ids: context.ids, session, frame, target };
	node.childrenNodes = (source.children ?? []).map((child) => buildNode(child, node, childContext));

	if (source.shadow !== undefined && source.shadow.length > 0) {
		node.shadowRoots = source.shadow.map((shadowRoot) =>
			buildNode({ tag: '#document-fragment', children: shadowRoot.children }, node, childContext, 11, shadowRoot.type)
		);
	}
	if (source.document !== undefined) {
		node.contentDocument = buildNode(source.document, node, childContext, 9);
	}
	return node;
}

/** Inflates the authoring form into a real, parent-wired {@linkcode EnhancedDomTreeNode}. */
export function buildIr(tree: FixtureNode): EnhancedDomTreeNode {
	const taken = new Set<number>();
	collectExplicitIds(tree, taken);
	return buildNode(tree, null, {
		ids: new IdAllocator(taken),
		session: tree.session ?? DEFAULT_SESSION,
		frame: tree.frame ?? 'frame-main',
		target: tree.target ?? 'target-main',
	});
}

/** Reads `<name>.json` from this directory and inflates its tree. */
export async function loadFixture(name: string): Promise<{ file: FixtureFile; ir: EnhancedDomTreeNode }> {
	const text = await Deno.readTextFile(new URL(`./${name}.json`, import.meta.url));
	const file = JSON.parse(text) as FixtureFile;
	return { file, ir: buildIr(file.tree) };
}

/** Reads the expected `<name>.txt` golden verbatim. */
export function loadGolden(name: string): Promise<string> {
	return Deno.readTextFile(new URL(`./${name}.txt`, import.meta.url));
}
