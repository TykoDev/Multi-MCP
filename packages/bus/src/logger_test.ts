import { assertEquals, assertMatch } from '@std/assert';
// Nothing browser-, bus-, or transport-shaped is faked; §4.1.5 permits spies at in-package seams.
// mock-seam: console.error/warn — the logger's own output sink, a module seam inside @tykotech/bus.
import { stub } from '@std/testing/mock';
import { consoleBusLogger, silentBusLogger } from '../mod.ts';

function captureConsole(fn: () => void): { warns: string[]; errors: string[] } {
	const warns: string[] = [];
	const errors: string[] = [];
	// Stubbing `console` is a module-seam stub inside this package, which OBSERVABILITY §4.1.5 allows;
	// nothing about the bus itself is faked here.
	const warnStub = stub(console, 'warn', (...args: unknown[]) => warns.push(args.join(' ')));
	const errorStub = stub(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
	try {
		fn();
	} finally {
		warnStub.restore();
		errorStub.restore();
	}
	return { warns, errors };
}

Deno.test('logger: the console logger renders level, message and structured fields', () => {
	const { warns, errors } = captureConsole(() => {
		consoleBusLogger.debug('dropped', { a: 1 });
		consoleBusLogger.warn('dispatch after stop ignored', { bus: 'session', count: 2 });
		consoleBusLogger.error('dispatch failed');
	});
	assertEquals(warns.length, 1);
	assertEquals(errors.length, 1);
	assertMatch(warns[0] ?? '', /^\[bua\.bus\] WARN dispatch after stop ignored bus=session count=2$/);
	assertEquals(errors[0], '[bua.bus] ERROR dispatch failed');
});

Deno.test('logger: field rendering survives errors, undefined and circular values', () => {
	const circular: Record<string, unknown> = { name: 'loop' };
	circular.self = circular;
	const { warns } = captureConsole(() => {
		consoleBusLogger.warn('odd fields', {
			error: new TypeError('bad input'),
			// undefined-means: an actual undefined field value, which is what this case renders.
			missing: undefined,
			circular,
			empty: {},
		});
		consoleBusLogger.warn('no fields', {});
	});
	const line = warns[0] ?? '';
	assertMatch(line, /error=TypeError: bad input/);
	assertMatch(line, /missing=undefined/);
	assertMatch(line, /circular=\[object Object\]/);
	assertMatch(line, /empty=\{\}/);
	assertEquals(warns[1], '[bua.bus] WARN no fields');
});

Deno.test('logger: the silent logger writes nothing', () => {
	const { warns, errors } = captureConsole(() => {
		silentBusLogger.debug('x');
		silentBusLogger.warn('y');
		silentBusLogger.error('z');
	});
	assertEquals(warns, []);
	assertEquals(errors, []);
});
