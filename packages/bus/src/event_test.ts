import { assert, assertEquals, assertMatch } from '@std/assert';
import { expect } from '@std/expect';
import { v7 } from '@std/uuid';
import {
	BaseEvent,
	type BusLogger,
	DEFAULT_EVENT_TIMEOUT_SEC,
	defaultEnvSource,
	denoEnvSource,
	eventStaticsOf,
	resolveEventTimeoutSec,
	setDefaultEnvSource,
	timeoutEnvVarName,
} from '../mod.ts';

class EvtPlainEvent extends BaseEvent<void> {}

class EvtTypedEvent extends BaseEvent<string> {
	static override timeoutSec = 12;
	constructor(readonly url: string, readonly attempt: number) {
		super();
	}
}

function recordingLogger(): { logger: BusLogger; warnings: string[] } {
	const warnings: string[] = [];
	return {
		warnings,
		logger: {
			debug: () => {},
			warn: (message) => warnings.push(message),
			error: () => {},
		},
	};
}

Deno.test('event: envelope carries a uuid v7 id, ISO-8601 creation time and the class name', () => {
	const event = new EvtTypedEvent('http://127.0.0.1/page', 1);
	assert(v7.validate(event.eventId), `${event.eventId} is not a uuid v7`);
	assertMatch(event.eventCreatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assertEquals(event.eventType, 'EvtTypedEvent');
	assertEquals(EvtTypedEvent.eventName, 'EvtTypedEvent');
	assertEquals(event.eventParentId, null);
});

Deno.test('event: uuid v7 ids are unique and monotonic enough to sort by creation', () => {
	const ids = new Set<string>();
	for (let i = 0; i < 100; i += 1) ids.add(new EvtPlainEvent().eventId);
	assertEquals(ids.size, 100);
});

Deno.test('event: timeoutSec falls back to the bus default and honours the class override', () => {
	assertEquals(EvtPlainEvent.timeoutSec, DEFAULT_EVENT_TIMEOUT_SEC);
	assertEquals(EvtTypedEvent.timeoutSec, 12);
	assertEquals(new EvtTypedEvent('u', 0).eventTimeout, 12);
	assertEquals(eventStaticsOf(new EvtTypedEvent('u', 0)).eventName, 'EvtTypedEvent');
});

Deno.test('event: TIMEOUT_<EventClassName> overrides the class default', () => {
	assertEquals(timeoutEnvVarName('EvtTypedEvent'), 'TIMEOUT_EvtTypedEvent');
	const env = new Map([['TIMEOUT_EvtTypedEvent', '45']]);
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, (name) => env.get(name)), 45);
});

Deno.test('event: the env override is read on every resolution, never snapshotted (D-CFG1)', () => {
	const env = new Map<string, string>();
	const source = (name: string) => env.get(name);
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, source), 12);
	env.set('TIMEOUT_EvtTypedEvent', '3');
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, source), 3);
	env.set('TIMEOUT_EvtTypedEvent', '7.5');
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, source), 7.5);
	env.delete('TIMEOUT_EvtTypedEvent');
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, source), 12);
});

Deno.test('event: an unparseable or negative env override warns and keeps the class default', () => {
	const { logger, warnings } = recordingLogger();
	for (const bad of ['not-a-number', '-1']) {
		const env = new Map([['TIMEOUT_EvtTypedEvent', bad]]);
		assertEquals(resolveEventTimeoutSec(EvtTypedEvent, (n) => env.get(n), logger), 12);
	}
	assertEquals(warnings.length, 2);
	// An empty value is "unset", not "invalid".
	const blank = new Map([['TIMEOUT_EvtTypedEvent', '  ']]);
	assertEquals(resolveEventTimeoutSec(EvtTypedEvent, (n) => blank.get(n), logger), 12);
	assertEquals(warnings.length, 2);
});

Deno.test('event: the default env source degrades to unset when --allow-env is missing', () => {
	// `--allow-env=TIMEOUT_` (no wildcard) grants nothing, so this exercises the NotCapable path in
	// most CI invocations and the plain "unset" path when the wildcard form is granted.
	assertEquals(denoEnvSource('TIMEOUT_EvtDefinitelyUnsetProbeEvent'), undefined);
	assertEquals(new EvtTypedEvent('u', 0).eventTimeout, 12);
});

Deno.test('event: setDefaultEnvSource swaps the process-wide getter and restores', () => {
	try {
		setDefaultEnvSource((name) => (name === 'TIMEOUT_EvtTypedEvent' ? '2' : undefined));
		assertEquals(new EvtTypedEvent('u', 0).eventTimeout, 2);
		assertEquals(defaultEnvSource()('TIMEOUT_EvtTypedEvent'), '2');
	} finally {
		setDefaultEnvSource(null);
	}
	assertEquals(defaultEnvSource(), denoEnvSource);
	assertEquals(new EvtTypedEvent('u', 0).eventTimeout, 12);
});

Deno.test('event: toJSON emits the envelope plus the payload fields', () => {
	const event = new EvtTypedEvent('http://127.0.0.1/page', 3);
	const json = event.toJSON();
	assertEquals(json.eventType, 'EvtTypedEvent');
	assertEquals(json.eventTimeout, 12);
	assertEquals(json.eventId, event.eventId);
	assertEquals(json.eventParentId, null);
	assertEquals(json.eventCreatedAt, event.eventCreatedAt);
	assertEquals(json.url, 'http://127.0.0.1/page');
	assertEquals(json.attempt, 3);
	expect(JSON.parse(JSON.stringify(event))).toEqual(json);
});
