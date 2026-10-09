/**
 * The server-drawn highlight (B2.2; `report_architecture.md` §8.2) behind the live view's
 * `live.highlight`.
 *
 * Drawn by the DevTools overlay (`Overlay.highlightNode` / `highlightRect`, typed under E-46), which
 * paints **outside the document**: nothing is injected into the page, so a highlight cannot churn
 * `state_token`, cannot appear in `browser_get_state` or `browser_get_html`, and cannot be mistaken
 * for page content. One highlight per session — a second replaces the first — and every highlight
 * has a bounded life: it is hidden by a timer after `ttl_ms`, so a viewer that disconnected mid-way
 * does not leave an outline on the screen every other viewer watches.
 *
 * Best-effort by contract (degradation order rank 2): an overlay failure hides nothing and fails
 * nothing; the caller gets no reply either way, and a highlight that did not draw is a highlight that
 * did not draw.
 */
import type { TargetId } from '@tykotech/cdp';
import { ToolError } from './errors.ts';
import type { SessionRecord } from './registry.ts';
import { nodeAt } from './tools/shared.ts';

/** `ttl_ms` bounds and default (design §8.1). */
export const HIGHLIGHT_TTL_DEFAULT_MS = 2000;
export const HIGHLIGHT_TTL_MIN_MS = 100;
export const HIGHLIGHT_TTL_MAX_MS = 30_000;

/** The outline colour, chosen to be visible on light and dark pages alike. */
const OUTLINE = { r: 255, g: 92, b: 0, a: 1 };
const FILL = { r: 255, g: 160, b: 0, a: 0.25 };

/** Exactly one of `index` (an element of the held table) or `bounds` (top-document viewport CSS px). */
export interface HighlightTarget {
	readonly index?: number;
	readonly bounds?: { x: number; y: number; w: number; h: number };
}

/** What a highlight did, for the caller's own bookkeeping (the socket sends no reply). */
export interface HighlightOutcome {
	readonly ttlMs: number;
	/** The session the overlay was drawn in — the page's, or an OOPIF's own. */
	readonly sessionId: string;
}

/** Clamps a requested TTL into the contract's bounds; absent means the default. */
export function clampTtl(ttlMs: number | undefined): number {
	if (ttlMs === undefined || !Number.isFinite(ttlMs)) return HIGHLIGHT_TTL_DEFAULT_MS;
	return Math.min(HIGHLIGHT_TTL_MAX_MS, Math.max(HIGHLIGHT_TTL_MIN_MS, Math.round(ttlMs)));
}

/**
 * Draws the highlight and arms its expiry. Throws `ToolError` for a target that cannot be resolved
 * (an unknown index, a disconnected session); the caller decides whether that is worth reporting.
 */
export async function highlight(
	record: SessionRecord,
	target: HighlightTarget,
	ttlMs?: number,
): Promise<HighlightOutcome> {
	const session = record.session;
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	if ((target.index === undefined) === (target.bounds === undefined)) {
		throw new ToolError('invalid-arguments', 'exactly one of index or bounds is required');
	}
	const ttl = clampTtl(ttlMs);
	const page = await manager.getOrCreateCdpSession(focus, true);

	// A replacement hides the previous outline first, whichever session it was drawn in.
	await hideHighlight(record);

	let drawnIn = page.sessionId;
	const armed = async (sessionId: string): Promise<void> => {
		// Measured (U-7): the overlay refuses to draw until `Overlay.enable`, which itself refuses
		// until `DOM.enable` on the same session. Both are idempotent, and both are undone on hide.
		await client.send.DOM.enable({}, sessionId);
		await client.send.Overlay.enable(undefined, sessionId);
	};
	if (target.index !== undefined) {
		const node = nodeAt(session, target.index);
		// An OOPIF's node lives in its own session, and so does its overlay.
		if (node.targetId !== '' && node.targetId !== focus) {
			try {
				drawnIn = (await manager.getOrCreateCdpSession(node.targetId as TargetId, false)).sessionId;
			} catch {
				drawnIn = page.sessionId;
			}
		}
		await armed(drawnIn);
		await client.send.Overlay.highlightNode({
			highlightConfig: { contentColor: FILL, borderColor: OUTLINE, showInfo: false },
			backendNodeId: node.backendNodeId,
		}, drawnIn);
	} else {
		const bounds = target.bounds as { x: number; y: number; w: number; h: number };
		await armed(page.sessionId);
		await client.send.Overlay.highlightRect({
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(1, Math.round(bounds.w)),
			height: Math.max(1, Math.round(bounds.h)),
			color: FILL,
			outlineColor: OUTLINE,
		}, page.sessionId);
	}

	record.highlight = {
		sessionId: drawnIn,
		timer: setTimeout(() => void hideHighlight(record).catch(() => {}), ttl),
	};
	Deno.unrefTimer(record.highlight.timer);
	return { ttlMs: ttl, sessionId: drawnIn };
}

/** Hides the session's highlight, if any, and disarms its timer. Never throws. */
export async function hideHighlight(record: SessionRecord): Promise<void> {
	const current = record.highlight;
	if (current === undefined) return;
	record.highlight = undefined;
	clearTimeout(current.timer);
	const client = record.session.cdpClient;
	if (client === null) return;
	try {
		await client.send.Overlay.hideHighlight(undefined, current.sessionId);
		// Leave the session as it was found: an enabled overlay domain is a standing capability
		// nothing else in this process uses, and disabling it also hides anything still drawn.
		await client.send.Overlay.disable(undefined, current.sessionId);
	} catch {
		// The target may be gone; there is nothing left to hide.
	}
}
