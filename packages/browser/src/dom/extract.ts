/**
 * DOM extraction — the public face of the `DOMSnapshot` × `DOM` × `Accessibility` merge.
 *
 * Contract: SPECS/DATA-MODEL.md §6.1–§6.2 (the IR), SPECS/ARCHITECTURE.md §6.7 (DOMWatchdog budget:
 * ≤2 s pending-network probe with a 0.3 s stability pause, 20 s combined with the screenshot, a
 * minimal recovery state on failure instead of a throw), §8 (timeout hierarchy).
 *
 * Two entry points, deliberately separated:
 *
 * - {@linkcode captureDom} + {@linkcode mergeDomTrees} — I/O and pure transform, so the transform can
 *   be replayed from a recorded fixture with no browser in sight;
 * - {@linkcode extractDomTree} — both, under the budget, with the recovery contract.
 */

export type {
	CapturedDomNode,
	CapturedLayoutMetrics,
	CapturedSession,
	ChildSessionResolver,
	DomCapture,
	DomTargetSession,
	ListenerCensus,
	ListenerCensusFrame,
	NetworkStabilityOptions,
	NetworkStabilityResult,
} from './extract_capture.ts';
export {
	captureDom,
	CLICK_LISTENER_TYPES,
	createAttachingChildSessionResolver,
	DOM_BUILD_BUDGET_MS,
	findOopifFrameIds,
	isFrameElement,
	LISTENER_CENSUS_MAX_ELEMENTS,
	LISTENER_CENSUS_MAX_LISTENERS,
	listenerCensusExpression,
	MAX_CAPTURE_SESSIONS,
	NETWORK_PROBE_MAX_MS,
	NETWORK_STABILITY_MS,
	parseListenerCensus,
	waitForNetworkStability,
} from './extract_capture.ts';
export type { DecodedSnapshot, DecodedSnapshotDocument } from './extract_snapshot.ts';
export { decodeSnapshot, paintsAbove, SNAPSHOT_COMPUTED_STYLES } from './extract_snapshot.ts';
export type { DecodedAxTree } from './extract_ax.ts';
export { decodeAxTree, KNOWN_AX_PROPERTIES } from './extract_ax.ts';
export type { FrameRecord, MergedDomTree, MergeOptions } from './extract_merge.ts';
export {
	collectElementOrder,
	computeVisibility,
	foldAttributes,
	intersectsWithSlack,
	isFullyTransparent,
	mergeDomTrees,
	nodeKey,
	passesCssGate,
	VIEWPORT_VERTICAL_SLACK_PX,
	walkTree,
} from './extract_merge.ts';

import type { CdpClient } from '@tykotech/cdp';
import type { EnhancedDomTreeNode } from './types.ts';
import {
	captureDom,
	type CaptureDomOptions,
	type ChildSessionResolver,
	describeError,
	DOM_BUILD_BUDGET_MS,
	type DomCapture,
	type DomTargetSession,
	type NetworkStabilityResult,
	waitForNetworkStability,
} from './extract_capture.ts';
import { type FrameRecord, mergeDomTrees } from './extract_merge.ts';

/**
 * Failure inside the DOM pipeline.
 *
 * `@tykotech/browser`'s shared error taxonomy (DATA-MODEL §4.4 `BrowserError` and friends) lives in
 * `src/errors.ts`, which this builder does not own; this class is the DOM-local placeholder and SHOULD
 * be re-parented onto `BrowserError` once that file exists. Never a bare string (AGENTS.md §3).
 */
export class DomExtractionError extends Error {
	readonly phase: 'capture' | 'merge' | 'probe';

	constructor(message: string, phase: 'capture' | 'merge' | 'probe', options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'DomExtractionError';
		this.phase = phase;
	}
}

/** Options for {@linkcode extractDomTree}. */
export interface ExtractDomTreeOptions {
	readonly client: CdpClient;
	/** The page session to build from. SessionManager owns its lifecycle (ARCHITECTURE §7.3). */
	readonly root: DomTargetSession;
	readonly resolveChildSession?: ChildSessionResolver;
	/** Defaults to on; the census is the only source of `hasJsClickListener`. */
	readonly includeListenerCensus?: boolean;
	/**
	 * Run the pending-network probe before capturing. Default on. The probe never fails the build —
	 * it just stops waiting after {@linkcode NETWORK_PROBE_MAX_MS}.
	 */
	readonly waitForNetwork?: boolean;
	/**
	 * Wall-clock ceiling for probe + capture + merge. Defaults to {@linkcode DOM_BUILD_BUDGET_MS},
	 * which ARCHITECTURE §6.7 shares with the screenshot — a caller running both in parallel should
	 * pass the *remaining* budget, not the full one.
	 */
	readonly budgetMs?: number;
	readonly signal?: AbortSignal;
}

/**
 * The DOM pipeline's output.
 *
 * There is no failure channel: ARCHITECTURE §6.7 requires the DOMWatchdog to answer with a minimal
 * recovery state carrying `browserErrors` rather than to throw, so a failed build surfaces as
 * `root === null` with `recovered: true` and the reason in `browserErrors`. Callers assembling a
 * `BrowserStateSummary` (§5.3) copy `browserErrors` straight across.
 */
export interface DomExtractionResult {
	readonly root: EnhancedDomTreeNode | null;
	/** `${sessionId}:${backendNodeId}` → node — the identity R6.2/R6.3 are defined over. */
	readonly byKey: ReadonlyMap<string, EnhancedDomTreeNode>;
	readonly nodeCount: number;
	/** Non-fatal observations (skipped OOPIFs, a dropped census, unmapped node types). */
	readonly warnings: readonly string[];
	/** DATA-MODEL §5.3 `browserErrors`. Empty on success. */
	readonly browserErrors: readonly string[];
	/** True when the budget ran out; implies `recovered`. */
	readonly timedOut: boolean;
	/** True when the result is the minimal recovery state rather than a real tree. */
	readonly recovered: boolean;
	readonly network: NetworkStabilityResult | null;
	readonly durationMs: number;
	/**
	 * ERRATUM(E-36): per-captured-session frame identity, carried so the serializer can mint the
	 * `state_token` identity half without a second capture. One entry per CDP session — the root page
	 * plus every OOPIF — not per same-process iframe: a same-process frame shares its host's session
	 * and its navigation moves the content half anyway.
	 */
	readonly frames: readonly { readonly frameId: string; readonly url: string }[];
	/** ERRATUM(E-40): every frame the merge walked, root first, with its composition marker. */
	readonly frameTree: readonly FrameRecord[];
	/** ERRATUM(E-40): true when the capture stopped at `MAX_CAPTURE_SESSIONS`. */
	readonly captureTruncated: boolean;
}

/** The empty tree returned when the build could not complete (ARCHITECTURE §6.7). */
export function recoveryState(
	browserErrors: readonly string[],
	options: {
		timedOut?: boolean;
		warnings?: readonly string[];
		durationMs?: number;
		network?: NetworkStabilityResult | null;
	} = {},
): DomExtractionResult {
	return {
		root: null,
		byKey: new Map(),
		nodeCount: 0,
		warnings: options.warnings ?? [],
		browserErrors,
		timedOut: options.timedOut ?? false,
		recovered: true,
		network: options.network ?? null,
		durationMs: options.durationMs ?? 0,
		frames: [],
		frameTree: [],
		captureTruncated: false,
	};
}

/**
 * Build the merged DOM tree for a page, under the §6.7 budget.
 *
 * Sequence: pending-network probe (≤{@linkcode NETWORK_PROBE_MAX_MS}, needing
 * {@linkcode NETWORK_STABILITY_MS} of quiet) → concurrent CDP capture of every session → pure merge.
 * Everything runs under one composite `AbortSignal` so a timeout at this level aborts the CDP sends
 * beneath it (ARCHITECTURE §8: "a timeout at level N MUST abort the pending work at level N+1").
 */
export async function extractDomTree(options: ExtractDomTreeOptions): Promise<DomExtractionResult> {
	const startedAt = performance.now();
	const budgetMs = options.budgetMs ?? DOM_BUILD_BUDGET_MS;
	const budget = new AbortController();
	const timer = setTimeout(
		() => budget.abort(new DomExtractionError(`DOM build exceeded its ${budgetMs} ms budget`, 'capture')),
		budgetMs,
	);
	const signals: AbortSignal[] = [budget.signal];
	if (options.signal !== undefined) signals.push(options.signal);
	const signal = AbortSignal.any(signals);

	let network: NetworkStabilityResult | null = null;
	try {
		if (options.waitForNetwork !== false) {
			network = await waitForNetworkStability({
				client: options.client,
				sessionId: options.root.sessionId,
				signal,
			});
		}

		const captureOptions: CaptureDomOptions = {
			client: options.client,
			root: options.root,
			signal,
			...(options.resolveChildSession === undefined ? {} : { resolveChildSession: options.resolveChildSession }),
			...(options.includeListenerCensus === undefined ? {} : { includeListenerCensus: options.includeListenerCensus }),
		};
		const capture = await captureDom(captureOptions);
		const merged = mergeDomTrees(capture);
		return {
			root: merged.root,
			byKey: merged.byKey,
			nodeCount: merged.nodeCount,
			warnings: merged.warnings,
			browserErrors: [],
			timedOut: false,
			recovered: false,
			network,
			durationMs: performance.now() - startedAt,
			frames: capture.sessions.map((session) => ({ frameId: session.frameId, url: session.url })),
			frameTree: merged.frames,
			captureTruncated: merged.captureTruncated,
		};
	} catch (error) {
		const timedOut = budget.signal.aborted;
		const reason = timedOut
			? `DOM build exceeded its ${budgetMs} ms budget (ARCHITECTURE §6.7)`
			: `DOM build failed: ${describeError(error)}`;
		return recoveryState([reason], {
			timedOut,
			durationMs: performance.now() - startedAt,
			network,
		});
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Merge a capture that was recorded earlier — the fixture path.
 *
 * A recorded CDP payload is data, not a mock (D-TEST1): this is the same code the browser path runs,
 * fed from `packages/core/fixtures/dom/`.
 */
export function extractFromCapture(capture: DomCapture): DomExtractionResult {
	const startedAt = performance.now();
	const merged = mergeDomTrees(capture);
	return {
		root: merged.root,
		byKey: merged.byKey,
		nodeCount: merged.nodeCount,
		warnings: merged.warnings,
		browserErrors: [],
		timedOut: false,
		recovered: false,
		network: null,
		durationMs: performance.now() - startedAt,
		frames: capture.sessions.map((session) => ({ frameId: session.frameId, url: session.url })),
		frameTree: merged.frames,
		captureTruncated: merged.captureTruncated,
	};
}
