/**
 * `BaseEvent` — the envelope every bus event carries.
 */

import { v7 } from '@std/uuid';
import { defaultEnvSource } from './env.ts';
import { currentEventId } from './lineage.ts';
import type { BusLogger, EnvSource, EventStatics } from './types.ts';

/**
 * Fallback per-handler timeout for event classes that do not declare one. Sits inside the 3–60 s
 * band the declared bus-event timeouts use.
 */
export const DEFAULT_EVENT_TIMEOUT_SEC = 30;

/** Env var that overrides a class's default timeout, in seconds. */
export function timeoutEnvVarName(eventName: string): string {
	return `TIMEOUT_${eventName}`;
}

/**
 * Resolves the effective per-handler timeout in seconds.
 *
 * Read through the {@linkcode EnvSource} getter on every call — never cached — so a process that
 * mutates `TIMEOUT_<EventClassName>` at runtime takes effect on the next dispatch.
 * A value of `0` (or negative) disables the timeout; unparseable values are ignored with a warning.
 */
export function resolveEventTimeoutSec(
	cls: EventStatics,
	env: EnvSource = defaultEnvSource(),
	logger?: BusLogger,
): number {
	const raw = env(timeoutEnvVarName(cls.eventName));
	if (raw === undefined || raw.trim() === '') return cls.timeoutSec;
	const parsed = Number(raw.trim());
	if (!Number.isFinite(parsed) || parsed < 0) {
		logger?.warn('ignoring invalid timeout override', {
			envVar: timeoutEnvVarName(cls.eventName),
			value: raw,
			fallbackSec: cls.timeoutSec,
		});
		return cls.timeoutSec;
	}
	return parsed;
}

/**
 * Base class for every bus event.
 *
 * `TResult` is the type a handler may return and that `eventResult()` yields; it is carried by a
 * phantom declaration so that `BaseEvent<string>` and `BaseEvent<void>` are not interchangeable.
 */
export abstract class BaseEvent<TResult = void> {
	/** Default per-handler timeout in seconds; override per class, override again via env. */
	static timeoutSec: number = DEFAULT_EVENT_TIMEOUT_SEC;

	/** The class name. Inherited getter, so subclasses report their own name without boilerplate. */
	static get eventName(): string {
		return this.name;
	}

	/** Phantom carrier for `TResult`; erased at runtime. */
	declare readonly __eventResult: TResult;

	/** uuid v7, so ids sort by creation time. */
	readonly eventId: string = v7.generate();

	/**
	 * Id of the event whose handler created this one, or `null` at the top level. Always present
	 * (`string | null`, never optional), so a serialized envelope has a fixed shape.
	 */
	readonly eventParentId: string | null = currentEventId();

	/** ISO-8601 creation timestamp. */
	readonly eventCreatedAt: string = new Date().toISOString();

	/** The class name; globally unique and non-substring-overlapping across the registry. */
	get eventType(): string {
		return (this.constructor as unknown as EventStatics).eventName;
	}

	/** Effective timeout in seconds, resolved fresh (class default ∘ `TIMEOUT_<EventClassName>`). */
	get eventTimeout(): number {
		return resolveEventTimeoutSec(this.constructor as unknown as EventStatics);
	}

	/**
	 * Explicit emitter: persisted documents are never dumped by reflection.
	 * Own enumerable payload fields plus the computed envelope members.
	 */
	toJSON(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(this)) out[key] = value;
		out.eventType = this.eventType;
		out.eventTimeout = this.eventTimeout;
		return out;
	}
}

/** The static side of an event instance's class. */
export function eventStaticsOf(event: BaseEvent<unknown>): EventStatics {
	return event.constructor as unknown as EventStatics;
}

/**
 * Fills in `eventParentId` at dispatch time when the event was constructed outside any handler.
 * Set-once: an already-attributed event keeps its original parent.
 */
export function linkToParent(event: BaseEvent<unknown>, parentId: string): void {
	if (event.eventParentId !== null) return;
	(event as { -readonly [K in 'eventParentId']: string | null }).eventParentId = parentId;
}
