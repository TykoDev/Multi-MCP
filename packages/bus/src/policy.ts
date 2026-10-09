/**
 * Handler resilience wrappers: the disconnect circuit breaker (ARCHITECTURE.md §4.6) and the
 * one-shot session repair hook (§4.7).
 *
 * `@tykotech/bus` knows nothing about CDP. Both behaviours are expressed against injected policies;
 * `@tykotech/browser` supplies the CDP-flavoured `ConnectionPolicy` and the focused-session `repair()` in M1.
 */

import { withDeadline } from './deadline.ts';
import { ConnectionError } from './errors.ts';
import type { BaseEvent } from './event.ts';
import { silentBusLogger } from './logger.ts';
import type { BusLogger, ConnectionPolicy, EventHandler, HandlerWrapper } from './types.ts';

/**
 * Longest a blocked handler waits for a reconnect: 3 attempts × 15 s cap + 1/2/4 s backoff
 * (ARCHITECTURE.md §7.4). Timing constants are load-bearing — DECISION-REGISTER §2.5.
 */
export const RECONNECT_WAIT_TIMEOUT_MS = 54_000;

/** Options for {@linkcode resilientHandler} / {@linkcode resilientWrapper}. */
export interface ResilientHandlerOptions {
	/** Connection-state provider. Omit to disable the circuit breaker. */
	connection?: ConnectionPolicy;
	/** Attempted once when the handler throws; its own failure never masks the original error. */
	repair?: () => unknown | Promise<unknown>;
	/** Structured logger; defaults to silent. */
	logger?: BusLogger;
	/** Reconnect wait budget; defaults to {@linkcode RECONNECT_WAIT_TIMEOUT_MS}. */
	reconnectWaitMs?: number;
}

/**
 * Wraps one handler with the circuit breaker and the repair hook.
 *
 * Breaker decision table for a non-lifecycle event:
 *
 * | connected | reconnecting | behaviour |
 * |---|---|---|
 * | yes | — | run |
 * | no | no | skip, return `undefined` |
 * | no | yes | wait ≤ budget → run on success, else throw {@linkcode ConnectionError} |
 *
 * Lifecycle events (`BrowserStart/Stop/Stopped/Launch/Error/Kill/Reconnecting/Reconnected`, as
 * classified by the injected policy) always run.
 */
export function resilientHandler<E extends BaseEvent<unknown>>(
	handler: EventHandler<E>,
	options: ResilientHandlerOptions = {},
): EventHandler<E> {
	const logger = options.logger ?? silentBusLogger;
	const waitMs = options.reconnectWaitMs ?? RECONNECT_WAIT_TIMEOUT_MS;

	return async (event, context) => {
		const connection = options.connection;
		if (connection !== undefined && !connection.isLifecycleEvent(event) && !connection.isConnected()) {
			if (connection.isReconnecting?.() !== true) {
				logger.warn('handler skipped while disconnected', {
					eventType: event.eventType,
					handler: context.handlerName,
				});
				return undefined;
			}
			const reconnected = await _awaitReconnect(connection, waitMs, logger, event, context.handlerName);
			if (!reconnected) throw new ConnectionError(event.eventType, waitMs);
		}

		try {
			return await handler(event, context);
		} catch (error) {
			if (options.repair !== undefined) {
				try {
					await options.repair();
					logger.debug('session repair attempted after handler failure', {
						eventType: event.eventType,
						handler: context.handlerName,
					});
				} catch (repairError) {
					// The repair's failure must never mask the handler's original error.
					logger.warn('session repair failed', {
						eventType: event.eventType,
						handler: context.handlerName,
						error: repairError,
					});
				}
			}
			throw error;
		}
	};
}

/** Bus-level form of {@linkcode resilientHandler}, for `new EventBus({ wrapHandler })`. */
export function resilientWrapper(options: ResilientHandlerOptions = {}): HandlerWrapper {
	return (handler) => resilientHandler(handler, options);
}

async function _awaitReconnect(
	connection: ConnectionPolicy,
	waitMs: number,
	logger: BusLogger,
	event: BaseEvent<unknown>,
	handlerName: string,
): Promise<boolean> {
	logger.debug('handler waiting for reconnect', { eventType: event.eventType, handler: handlerName, waitMs });
	try {
		// The budget is enforced here as well as passed down: a policy that ignores it must not be able
		// to hang a handler past its own event timeout.
		const { timedOut, value } = await withDeadline(Promise.resolve(connection.waitForReconnect(waitMs)), waitMs);
		if (timedOut) {
			logger.warn('reconnect wait budget exhausted', { eventType: event.eventType, handler: handlerName, waitMs });
			return false;
		}
		return value === true;
	} catch (error) {
		logger.warn('reconnect wait failed', { eventType: event.eventType, handler: handlerName, error });
		return false;
	}
}
