/**
 * @module
 * `@tykotech/bus` — the typed async event bus (D-BUS1; ARCHITECTURE.md §4).
 *
 * Leaf infrastructure: it depends on nothing but the runtime and `@std`, and knows nothing about
 * browsers, CDP, or agents. Everything browser-shaped (the 44-event catalog, the 14 watchdogs, the
 * CDP connection policy) is built on top of this package in `@tykotech/browser`.
 *
 * ```ts
 * import { BaseEvent, EventBus, registerEvent } from '@tykotech/bus';
 *
 * class PingEvent extends BaseEvent<string> {
 * 	static override timeoutSec = 5; // env override: TIMEOUT_PingEvent
 * 	constructor(readonly payload: string) {
 * 		super();
 * 	}
 * }
 * registerEvent(PingEvent);
 *
 * const bus = new EventBus();
 * bus.on(PingEvent, (event) => `pong:${event.payload}`);
 * const handle = bus.dispatch(new PingEvent('hi'));
 * const result = await handle.eventResult({ raiseIfAny: true }); // 'pong:hi'
 * await bus.stop();
 * ```
 */

/** Workspace member identifier, kept for parity with the other `@bua/*` export surfaces. */
export const PACKAGE_NAME = '@tykotech/bus' as const;

export {
	BaseEvent,
	DEFAULT_EVENT_TIMEOUT_SEC,
	eventStaticsOf,
	resolveEventTimeoutSec,
	timeoutEnvVarName,
} from './src/event.ts';
export { EventNameRegistry, globalEventRegistry, registerEvent, registerEvents } from './src/registry.ts';
export {
	DEFAULT_HANDLER_ABANDON_GRACE_MS,
	DEFAULT_STOP_TIMEOUT_MS,
	EventBus,
	type EventBusOptions,
	type SubscribeOptions,
} from './src/bus.ts';
export { createEventHandle, createSettledHandle, firstRejected, meaningfulOutcomes } from './src/handle.ts';
export { DEFAULT_HISTORY_LIMIT, EventHistory } from './src/history.ts';
export { currentEvent, currentEventId, runInEventContext } from './src/lineage.ts';
export {
	RECONNECT_WAIT_TIMEOUT_MS,
	resilientHandler,
	type ResilientHandlerOptions,
	resilientWrapper,
} from './src/policy.ts';
export {
	type EventDeclarations,
	findHandlerMethods,
	type HandlerMethod,
	readDeclarations,
	registerHandlers,
	type RegisterHandlersOptions,
} from './src/auto_register.ts';
export { consoleBusLogger, silentBusLogger } from './src/logger.ts';
export { defaultEnvSource, denoEnvSource, setDefaultEnvSource } from './src/env.ts';
export {
	BusError,
	ConnectionError,
	DuplicateHandlerError,
	EventNameCollisionError,
	EventTimeoutError,
	HandlerDeclarationError,
	NoHandlerResultError,
} from './src/errors.ts';
export type {
	BusLogger,
	ConnectionPolicy,
	EnvSource,
	EventClass,
	EventHandle,
	EventHandler,
	EventResultOf,
	EventResultOptions,
	EventStatics,
	HandlerContext,
	HandlerMeta,
	HandlerOutcome,
	HandlerWrapper,
} from './src/types.ts';
