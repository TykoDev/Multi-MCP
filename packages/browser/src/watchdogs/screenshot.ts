/**
 * @module
 * `ScreenshotWatchdog` — handles `ScreenshotEvent` (ARCHITECTURE.md §6.6).
 *
 * "validates/repairs focus to a page target, removes JS highlights before capture,
 * `Page.captureScreenshot` (PNG, optional full-page/clip), returns base64 as the event result."
 * Result contract and 15 s budget: DATA-MODEL.md §5.1.1. Contract-test focus:
 * COMPLETIONS-CRITERIA.md §3.2 watchdog row 6 — "focus validation/repair, highlight removal, PNG
 * base64 result".
 *
 * ## Why focus is *repaired* rather than trusted
 *
 * The agent's focus pointer can name a target that has since been destroyed, or (after a crash and an
 * imperfect recovery) one that is not a page at all. SessionManager's detach-driven recovery normally
 * fixes that, but a screenshot is taken **every step** (invariant I-14) and is often the first thing
 * to touch the session after a tab died. Failing the capture would blind the agent at exactly the
 * moment it needs to see; so a focus that does not point at a live page target is moved to the most
 * recent one before capturing.
 *
 * ## Highlights
 *
 * The DOM layer paints interaction highlights into the page (`BrowserProfile.highlightElements` /
 * `domHighlightElements`, DATA-MODEL.md §5.2). They exist for humans watching a headful run and MUST
 * NOT reach the model: a screenshot with numbered boxes drawn over the UI is a screenshot of a
 * different page than the DOM text describes.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, SessionId } from '@tykotech/cdp';
import { ScreenshotEvent } from '../events.ts';
import { BrowserError } from '../errors.ts';
import { PAGE_TARGET_TYPE } from '../browser/session_manager.ts';
import type { ScreenshotClip } from '../types.ts';
import { BaseWatchdog } from './base.ts';

// ---------------------------------------------------------------------------
// the highlight marker contract
// ---------------------------------------------------------------------------

/**
 * Id of the overlay container the DOM layer injects highlights into.
 *
 * ERRATUM(M1-watchdogs-action-4): §6.6 requires highlight removal but no spec section defines how a
 * highlight is *marked*, so there is nothing to remove by name. This module declares the contract —
 * one container by id, plus an attribute for anything painted outside it — and exports both constants
 * so the injector (DOMWatchdog, §6.7) can align on them rather than the two guessing separately.
 * Removal is a no-op on a page with no highlights, which is the common case.
 */
export const HIGHLIGHT_CONTAINER_ID = 'bua-highlight-container';

/** Attribute marking a highlight element painted outside {@linkcode HIGHLIGHT_CONTAINER_ID}. */
export const HIGHLIGHT_ELEMENT_ATTRIBUTE = 'data-bua-highlight';

/** Removes every marked highlight and reports how many nodes went. Idempotent. */
export const REMOVE_HIGHLIGHTS_EXPRESSION = `(function () {
	let removed = 0;
	const container = document.getElementById(${JSON.stringify(HIGHLIGHT_CONTAINER_ID)});
	if (container !== null && container.parentNode !== null) { container.parentNode.removeChild(container); removed++; }
	const marked = document.querySelectorAll('[${HIGHLIGHT_ELEMENT_ATTRIBUTE}]');
	for (let index = 0; index < marked.length; index++) {
		const node = marked[index];
		if (node.parentNode !== null) { node.parentNode.removeChild(node); removed++; }
	}
	return removed;
})()`;

/**
 * Chrome's maximum texture dimension; a capture beyond it fails or returns a blank image.
 *
 * ERRATUM(M1-watchdogs-action-11): §6.6 offers `fullPage` with no bound. An infinite-scroll feed can
 * report a content height of tens of thousands of pixels, and asking Chrome for that either errors or
 * burns the whole 15 s budget producing an unusable PNG. The full-page clip is therefore capped at
 * this dimension — the capture is truncated, never failed.
 */
export const MAX_SCREENSHOT_DIMENSION_PX = 16_384;

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

export class ScreenshotWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [ScreenshotEvent];
	static override readonly EMITS = [];

	/** PNG bytes, base64, no `data:` prefix (DATA-MODEL.md §5.1.1). */
	async onScreenshotEvent(event: ScreenshotEvent, context?: HandlerContext): Promise<string> {
		const sessionId = await this.#focusedPageSession();
		const client = this.cdpFor(context);
		await this.#removeHighlights(client, sessionId);
		await this.#hideOverlay(client, sessionId);

		const clip = await this.#resolveClip(client, sessionId, event.fullPage, event.clip);
		const captured = await client.send.Page.captureScreenshot({
			format: 'png',
			captureBeyondViewport: event.fullPage || event.clip !== null,
			...(clip === null ? {} : { clip }),
		}, sessionId);
		return captured.data;
	}

	/**
	 * Validates the agent's focus and repairs it when it does not name a live page target.
	 *
	 * `getOrCreateCdpSession(targetId, true)` is the only sanctioned accessor (ARCHITECTURE.md §7.3);
	 * the validation happens *before* calling it with a focus flag, because that call throws for a
	 * non-page target rather than repairing it — which is the right behaviour there and the wrong one
	 * here.
	 */
	async #focusedPageSession(): Promise<SessionId> {
		const manager = this.sessions;
		const focus = manager.agentFocusTargetId;
		const record = focus === null ? undefined : manager.targets.get(focus);
		if (focus !== null && record !== undefined && record.type === PAGE_TARGET_TYPE) {
			return (await manager.getOrCreateCdpSession(focus, true)).sessionId;
		}

		const candidate = manager.mostRecentPageTarget();
		if (candidate === null) {
			throw new BrowserError('cannot capture a screenshot: the browser has no page target', {
				longTermMemory: 'Screenshot failed: no page was open',
			});
		}
		this.logger.warn('screenshot repaired the agent focus onto a live page target', {
			previous: focus,
			repaired: candidate.targetId,
		});
		await manager.setAgentFocus(candidate.targetId, { activate: true, announce: false });
		return (await manager.getOrCreateCdpSession(candidate.targetId, true)).sessionId;
	}

	/** Highlight removal is cosmetic: a page that refuses the script still gets photographed. */
	async #removeHighlights(client: CdpClient, sessionId: SessionId): Promise<void> {
		try {
			const outcome = await client.send.Runtime.evaluate({
				expression: REMOVE_HIGHLIGHTS_EXPRESSION,
				returnByValue: true,
			}, sessionId);
			const removed = typeof outcome.result.value === 'number' ? outcome.result.value : 0;
			if (removed > 0) this.logger.debug('removed highlights before capture', { removed });
		} catch (error) {
			this.logger.debug('highlight removal failed; capturing anyway', { error });
		}
	}

	/**
	 * ERRATUM(E-47). The live view's `live.highlight` (B2.2) draws through the DevTools overlay
	 * (`Overlay.highlightRect` / `highlightNode`, E-46), which never enters the DOM — so the strip
	 * above cannot see it, and U-7 measured that the overlay **does** appear in
	 * `Page.captureScreenshot` (`build/evidence/b2_2_u7_overlay_probe.log`: `screenshot_differs=true`
	 * with a highlight up, `false` after `hideHighlight`). The honesty rule in the module note applies
	 * to it exactly as to the DOM highlights: a screenshot with a server-drawn outline is a screenshot
	 * of a different page than the DOM text describes. One line, beside the existing strip, hides it
	 * before capture. Cosmetic, like the strip: a session whose overlay was never enabled answers an
	 * error here and is photographed anyway. A highlight interrupted by a screenshot is not restored;
	 * its owner's timer simply finds nothing to hide.
	 */
	async #hideOverlay(client: CdpClient, sessionId: SessionId): Promise<void> {
		try {
			await client.send.Overlay.hideHighlight(undefined, sessionId);
		} catch (error) {
			this.logger.debug('overlay hide skipped; capturing anyway', { error });
		}
	}

	/**
	 * The capture region.
	 *
	 * An explicit `clip` wins (it is the caller's stated intent). `fullPage` derives one from
	 * `Page.getLayoutMetrics`'s content size, capped at {@linkcode MAX_SCREENSHOT_DIMENSION_PX}.
	 * Neither means "the viewport", which needs no clip at all.
	 */
	async #resolveClip(
		client: CdpClient,
		sessionId: SessionId,
		fullPage: boolean,
		clip: ScreenshotClip | null,
	): Promise<{ x: number; y: number; width: number; height: number; scale: number } | null> {
		if (clip !== null) return { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
		if (!fullPage) return null;
		try {
			const metrics = await client.send.Page.getLayoutMetrics(undefined, sessionId);
			const content = metrics.cssContentSize ?? metrics.contentSize;
			return {
				x: 0,
				y: 0,
				width: Math.min(Math.ceil(content.width), MAX_SCREENSHOT_DIMENSION_PX),
				height: Math.min(Math.ceil(content.height), MAX_SCREENSHOT_DIMENSION_PX),
				scale: 1,
			};
		} catch (error) {
			// Without metrics `captureBeyondViewport` alone still produces a full-page image on
			// current Chrome; the clip is an optimisation, not a requirement.
			this.logger.debug('could not read layout metrics for a full-page capture', { error });
			return null;
		}
	}
}
