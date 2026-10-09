/**
 * @module
 * `PopupsWatchdog` — automatic JavaScript-dialog handling (ARCHITECTURE.md §6.4).
 *
 * > auto-handles JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`): registers
 * > `Page.javascriptDialogOpening` per new tab, records `"[type] message"` into the session's
 * > closed-popup list (surfaced in `BrowserStateSummary`), then accepts (alert/confirm/beforeunload)
 * > or dismisses (prompt) with two 0.5 s-capped attempts.
 *
 * ## Why this one fails loudly
 *
 * An open JavaScript dialog **blocks the whole CDP channel** for that target: the renderer is
 * suspended inside `window.alert`, and every subsequent command on the session queues behind it until
 * the 60 s CDP request timeout. A missed dialog is therefore not a cosmetic miss, it is a hung agent.
 * So: two attempts, each capped hard at {@linkcode DIALOG_HANDLE_TIMEOUT_MS}, and an
 * `logger.error` when both fail — never a silent swallow.
 *
 * ## One registration, routed by sessionId (ERRATUM(M1-watchdogs-rest-5))
 *
 * §6.4 says "registers `Page.javascriptDialogOpening` **per new tab**", which describes the Python
 * cdp-use registry: single-slot per CDP method, so a per-target registration clobbers the previous
 * one and the design is forced. `@tykotech/cdp`'s registry is multi-listener (ARCHITECTURE.md §7.2), where
 * registering per tab would deliver N callbacks for one dialog and answer it N times. This watchdog
 * therefore keeps **one** global listener routed by `sessionId` — the same "one global handler routed
 * by sessionId" rule §7.2 makes normative for `SessionManager` — armed from the first
 * `TabCreatedEvent` (which §7.4 step 7 replays for tabs that predate the connection) and re-armed
 * when the client instance changes across a reconnect.
 *
 * ## Where the message surfaces (ERRATUM(M1-watchdogs-rest-6))
 *
 * §6.4 says "the session's closed-popup list". `BrowserSession` has no such list; the list that
 * reaches `BrowserStateSummary.closedPopupMessages` (DATA-MODEL.md §5.3) is `DOMWatchdog`'s, fed by
 * `DialogOpenedEvent`. So this watchdog dispatches `DialogOpenedEvent` (§5.1.7) — that is the
 * surfacing path — and additionally keeps its own copy, bounded and drainable, for embedders that
 * want the raw record without a state build.
 */

import type { HandlerContext } from '@tykotech/bus';
import type { CdpClient, CdpEventParams, SessionId, TargetId } from '@tykotech/cdp';
import { DialogOpenedEvent, TabCreatedEvent } from '../events.ts';
import { DIALOG_TYPES, type DialogType } from '../types.ts';
import { withTimeout } from '../browser/reconnect.ts';
import { BaseWatchdog } from './base.ts';

// ---------------------------------------------------------------------------
// constants (ARCHITECTURE.md §6.4 — load-bearing, DECISION-REGISTER rule §2.5)
// ---------------------------------------------------------------------------

/** Cap on one `Page.handleJavaScriptDialog` call ("two 0.5 s-capped attempts"). */
export const DIALOG_HANDLE_TIMEOUT_MS = 500;

/** Attempts including the first ("two 0.5 s-capped attempts"). */
export const DIALOG_HANDLE_ATTEMPTS = 2;

/**
 * Bound on the retained message list.
 *
 * ERRATUM(M1-watchdogs-rest-7): §6.4 states no bound, and nothing drains this watchdog's own copy in
 * the default wiring (`DOMWatchdog` drains its own). A page that alerts in a loop would otherwise
 * grow it without limit for the lifetime of the session. Oldest entries are dropped; the messages
 * that matter to the agent already left via `DialogOpenedEvent` at the moment they were handled.
 */
export const MAX_RETAINED_POPUP_MESSAGES = 100;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** The `"[type] message"` rendering of §6.4, shared with `BrowserStateSummary` (§5.3). */
export function formatPopupMessage(dialogType: DialogType, message: string): string {
	return `[${dialogType}] ${message}`;
}

/**
 * Accept alert/confirm/beforeunload, dismiss prompt (§6.4).
 *
 * An unrecognised type accepts: an unanswered dialog blocks the CDP channel, so the failure mode of
 * guessing wrong (a form submits) is strictly cheaper than the failure mode of not answering.
 */
export function shouldAcceptDialog(dialogType: DialogType): boolean {
	return dialogType !== 'prompt';
}

/** Chrome's dialog kind, narrowed to the §5.1.7 union; anything unknown reads as `alert`. */
export function normalizeDialogType(raw: string): DialogType {
	return (DIALOG_TYPES as readonly string[]).includes(raw) ? raw as DialogType : 'alert';
}

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

/**
 * How long a dialog is held open for a caller to answer while manual handling is armed —
 * ERRATUM(E-53).
 *
 * Bounded, and the bound is not a nicety. An unanswered JavaScript dialog blocks the **whole CDP
 * channel for that target**: every screencast frame, every state read and every other action on that
 * tab stops until it is answered. So the hold expires and the automatic policy runs, with the record
 * marked `autoFallback`, rather than a caller who went away wedging the session for its lifetime.
 * 20 s is a model round trip plus slack, and well inside the 30 s bus default every command event
 * already lives under.
 */
export const DIALOG_MANUAL_TIMEOUT_MS = 20_000;

/** A dialog held open for a caller to answer — ERRATUM(E-53). */
export interface PendingDialog {
	readonly dialogId: string;
	readonly dialogType: DialogType;
	readonly message: string;
	readonly url: string;
	readonly targetId: TargetId | null;
	/** Epoch ms at which the hold expires and the automatic policy takes over. */
	readonly expiresAt: number;
}

/** One auto-handled dialog. */
export interface HandledDialog {
	readonly dialogType: DialogType;
	readonly message: string;
	readonly url: string;
	readonly targetId: TargetId | null;
	readonly accepted: boolean;
	/** `false` when both attempts failed — the CDP channel for that target is probably wedged. */
	readonly handled: boolean;
	readonly attempts: number;
	/** ERRATUM(E-53): the id this dialog was announced under; `''` on the automatic path. */
	readonly dialogId?: string;
	/** ERRATUM(E-53): true when a manual hold expired and the automatic policy answered instead. */
	readonly autoFallback?: boolean;
	/** ERRATUM(E-53): true when a caller answered it through {@linkcode PopupsWatchdog.answerDialog}. */
	readonly answeredByCaller?: boolean;
}

export class PopupsWatchdog extends BaseWatchdog {
	static override readonly LISTENS_TO = [TabCreatedEvent];
	static override readonly EMITS = [DialogOpenedEvent];

	readonly #messages: string[] = [];
	readonly #dialogs: HandledDialog[] = [];
	readonly #pending = new Set<Promise<unknown>>();
	#unsubscribe: (() => void) | null = null;
	#armedClient: CdpClient | null = null;
	/** ERRATUM(E-53). Manual handling is off unless a consumer of `dialog` events armed it. */
	#manual = false;
	#holdMs: number = DIALOG_MANUAL_TIMEOUT_MS;
	#dialogSeq = 0;
	/** Dialogs currently held open, by id — ERRATUM(E-53). */
	readonly #held = new Map<string, {
		readonly info: PendingDialog;
		readonly answer: (answer: { accept: boolean; promptText?: string } | null) => void;
	}>();

	// -- public surface ----------------------------------------------------------------------------

	/** `true` once the global `Page.javascriptDialogOpening` listener is registered. */
	get armed(): boolean {
		return this.#unsubscribe !== null;
	}

	/**
	 * Auto-handled dialogs as `"[type] message"`, oldest first, capped at
	 * {@linkcode MAX_RETAINED_POPUP_MESSAGES}.
	 *
	 * This is a *copy* of what already went out as `DialogOpenedEvent`; reading it does not consume
	 * it, and the state summary does not read it (see the module note).
	 */
	get closedPopupMessages(): readonly string[] {
		return this.#messages;
	}

	/** Full records, for tests and diagnostics. */
	get dialogs(): readonly HandledDialog[] {
		return this.#dialogs;
	}

	/**
	 * Arms or disarms manual dialog handling — ERRATUM(E-53).
	 *
	 * Off by default, and off is byte-for-byte the pre-erratum behaviour: every dialog is answered
	 * immediately by {@linkcode shouldAcceptDialog}'s policy and nothing is ever held. It is armed
	 * only while something is actually listening for `dialog` events, because a hold with no listener
	 * is a session that stops for 20 s for nobody.
	 *
	 * Disarming releases every dialog currently held, to the automatic policy: the alternative is a
	 * page frozen behind a dialog whose only possible answerer has just gone.
	 *
	 * `holdMs` overrides {@linkcode DIALOG_MANUAL_TIMEOUT_MS} for the holds taken after this call. It
	 * exists so the expiry itself is testable in real time rather than by faking the clock around a
	 * live CDP fixture — the fallback is the safety property that makes arming safe at all, so it is
	 * proven by letting it happen, not by asserting the constant it uses.
	 */
	setManualHandling(enabled: boolean, holdMs: number = DIALOG_MANUAL_TIMEOUT_MS): void {
		this.#holdMs = Math.max(1, Math.round(holdMs));
		if (this.#manual === enabled) return;
		this.#manual = enabled;
		if (enabled) return;
		for (const [, entry] of [...this.#held]) entry.answer(null);
	}

	/** True while dialogs are held for a caller rather than answered by policy (E-53). */
	get manualHandling(): boolean {
		return this.#manual;
	}

	/** Dialogs currently held open and awaiting an answer, oldest first (E-53). */
	get pendingDialogs(): readonly PendingDialog[] {
		return [...this.#held.values()].map((entry) => entry.info);
	}

	/**
	 * Answers one held dialog — ERRATUM(E-53), the `browser_handle_dialog` entry point.
	 *
	 * Returns `false` when no dialog is held under that id, which is the ordinary race rather than a
	 * fault: the hold may have expired, the page may have gone, or another caller may have answered
	 * first. The caller decides what to say about it; this returns a fact.
	 */
	answerDialog(dialogId: string, answer: { accept: boolean; promptText?: string }): boolean {
		const entry = this.#held.get(dialogId);
		if (entry === undefined) return false;
		entry.answer(answer);
		return true;
	}

	/** Reads and clears. For an embedder wiring this list into `DomWatchdogOptions`. */
	drainClosedPopupMessages(): string[] {
		return this.#messages.splice(0, this.#messages.length);
	}

	/** Resolves when every in-flight dialog response has settled. Tests await this, never a sleep. */
	async whenIdle(): Promise<void> {
		for (let guard = 0; guard < 10 && this.#pending.size > 0; guard++) {
			await Promise.allSettled([...this.#pending]);
		}
	}

	// -- handlers ----------------------------------------------------------------------------------

	/**
	 * Arms the listener. Idempotent per client instance, so the replayed `TabCreatedEvent`s of §7.4
	 * step 7 and every later tab all land on the same single registration.
	 */
	onTabCreatedEvent(_event: TabCreatedEvent, _context?: HandlerContext): void {
		this.arm();
	}

	protected override beforeDetach(): void {
		this.disarm();
	}

	// -- arming ------------------------------------------------------------------------------------

	/** Registers the one global dialog listener against the current client. */
	arm(): void {
		const client = this.host.cdpClient;
		if (client === null || client.state !== 'open') return;
		if (this.#armedClient === client && this.#unsubscribe !== null) return;
		this.disarm();
		this.#armedClient = client;
		this.#unsubscribe = client.on('Page.javascriptDialogOpening', (params, sessionId) => {
			this.#track(this.#handleDialog(params, sessionId));
		});
	}

	/** Removes the listener. Timers cannot outlive this: each attempt clears its own in `finally`. */
	disarm(): void {
		const off = this.#unsubscribe;
		this.#unsubscribe = null;
		this.#armedClient = null;
		off?.();
	}

	// -- internals ---------------------------------------------------------------------------------

	async #handleDialog(
		params: CdpEventParams['Page.javascriptDialogOpening'],
		sessionId: SessionId | undefined,
	): Promise<void> {
		const dialogType = normalizeDialogType(params.type);
		const policy = shouldAcceptDialog(dialogType);
		const targetId = sessionId === undefined ? null : this.host.sessionManager?.sessionTargets.get(sessionId) ?? null;
		// ERRATUM(E-53). The id is minted before the announcement, because the announcement is what
		// makes the dialog addressable; a consumer that receives the event and immediately answers
		// must find the hold already registered.
		const dialogId = this.#manual ? `d${++this.#dialogSeq}` : '';

		this.#record(formatPopupMessage(dialogType, params.message));
		const held = this.#manual
			? this.#hold(dialogId, { dialogType, message: params.message, url: params.url, targetId })
			: null;
		await this.bus
			.dispatch(
				new DialogOpenedEvent({
					dialogType,
					message: params.message,
					url: params.url,
					// `Page.javascriptDialogOpening` carries no frameId; §5.1.7 marks the field optional.
					frameId: null,
					dialogId,
				}),
			)
			.catch((error: unknown) => this.logger.debug('a DialogOpenedEvent consumer failed', { error }));

		// `null` means nobody answered inside the hold, so the automatic policy runs. That fallback is
		// the reason the hold is safe to arm at all: an unanswered dialog blocks the CDP channel for
		// the whole target, so "wait forever for a caller" is not an option this watchdog may take.
		const answer = held === null ? null : await held;
		const accept = answer?.accept ?? policy;
		const promptText = answer?.promptText;
		const outcome = await this.#respond(accept, sessionId, promptText);
		this.#dialogs.push({
			dialogType,
			message: params.message,
			url: params.url,
			targetId,
			accepted: accept,
			handled: outcome.handled,
			attempts: outcome.attempts,
			...(dialogId === '' ? {} : { dialogId }),
			...(held === null ? {} : { autoFallback: answer === null, answeredByCaller: answer !== null }),
		});
		if (outcome.handled) {
			this.logger.debug('auto-handled a JavaScript dialog', { dialogType, accept, targetId });
			return;
		}
		this.logger.error(
			'a JavaScript dialog could not be answered; the CDP channel for that target is blocked until it is',
			{ dialogType, accept, targetId, attempts: outcome.attempts },
		);
	}

	/**
	 * Registers one held dialog and returns the promise its answer (or its expiry) settles —
	 * ERRATUM(E-53).
	 *
	 * The timer is cleared on every exit, so a test under `sanitizeOps` never sees a pending op, and
	 * the map entry is removed before the promise settles so a second `answerDialog` for the same id
	 * answers `false` rather than resolving a settled promise.
	 */
	#hold(
		dialogId: string,
		about: { dialogType: DialogType; message: string; url: string; targetId: TargetId | null },
	): Promise<{ accept: boolean; promptText?: string } | null> {
		return new Promise<{ accept: boolean; promptText?: string } | null>((resolve) => {
			const holdMs = this.#holdMs;
			const timer = setTimeout(() => {
				this.#held.delete(dialogId);
				this.logger.warn('a held dialog expired and was answered by policy', {
					dialogId,
					dialogType: about.dialogType,
					capMs: holdMs,
				});
				resolve(null);
			}, holdMs);
			this.#held.set(dialogId, {
				info: { dialogId, expiresAt: Date.now() + holdMs, ...about },
				answer: (answer) => {
					clearTimeout(timer);
					this.#held.delete(dialogId);
					resolve(answer);
				},
			});
		});
	}

	/** Two attempts, each capped at 0.5 s. Returns whether Chrome acknowledged one of them. */
	async #respond(
		accept: boolean,
		sessionId: SessionId | undefined,
		promptText?: string,
	): Promise<{ handled: boolean; attempts: number }> {
		for (let attempt = 1; attempt <= DIALOG_HANDLE_ATTEMPTS; attempt++) {
			// Mapped to a non-rejecting promise before the race: `withTimeout` leaves the loser running,
			// and a CDP call rejecting after its cap expired would be an unhandled rejection.
			let settled: Promise<unknown>;
			try {
				// Bare `this.cdp` on purpose (ERRATUM(E-52) allowlist): this runs from Chrome's
				// `Page.javascriptDialogOpening` listener, which has no dispatch and no context to bind — and an
				// unanswered dialog blocks the whole CDP channel for that target, so it must not be skippable.
				// `promptText` is only meaningful on an accepted `prompt`; Chromium ignores it otherwise.
				// It is the caller's own text and is never recorded here or announced anywhere (SEC-08).
				settled = this.cdp.send.Page.handleJavaScriptDialog(
					promptText === undefined ? { accept } : { accept, promptText },
					sessionId,
				)
					.then(() => null, (error: unknown) => error ?? new Error('handleJavaScriptDialog failed'));
			} catch (error) {
				// The transport is gone; there is no dialog to answer any more either.
				this.logger.warn('cannot answer a dialog without a CDP connection', { error });
				return { handled: false, attempts: attempt };
			}
			const outcome = await withTimeout(settled, DIALOG_HANDLE_TIMEOUT_MS);
			if (!outcome.timedOut && (outcome.value === null || outcome.value === undefined)) {
				return { handled: true, attempts: attempt };
			}
			this.logger.warn('dialog response attempt failed', {
				attempt,
				of: DIALOG_HANDLE_ATTEMPTS,
				capMs: DIALOG_HANDLE_TIMEOUT_MS,
				timedOut: outcome.timedOut,
				...(outcome.value === undefined ? {} : { error: outcome.value }),
			});
		}
		return { handled: false, attempts: DIALOG_HANDLE_ATTEMPTS };
	}

	#record(message: string): void {
		this.#messages.push(message);
		if (this.#messages.length > MAX_RETAINED_POPUP_MESSAGES) {
			this.#messages.splice(0, this.#messages.length - MAX_RETAINED_POPUP_MESSAGES);
		}
		if (this.#dialogs.length > MAX_RETAINED_POPUP_MESSAGES) {
			this.#dialogs.splice(0, this.#dialogs.length - MAX_RETAINED_POPUP_MESSAGES);
		}
	}

	#track(promise: Promise<unknown>): void {
		this.#pending.add(promise);
		promise
			.then(() => {}, (error: unknown) => this.logger.warn('dialog handling failed', { error }))
			.finally(() => this.#pending.delete(promise));
	}
}
