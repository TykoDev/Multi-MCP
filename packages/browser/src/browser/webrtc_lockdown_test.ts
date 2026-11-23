/**
 * {@linkcode WEBRTC_LOCKDOWN_SOURCE} evaluated against fake globals — the exact
 * string `SessionManager` registers, run with `globalThis` bound to a stand-in window. Real Chromium is the browser
 * tier's (`tests/e2e/webrtc_scope_e2e_test.ts`).
 */

import { assert, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { WEBRTC_LOCKDOWN_SOURCE, WEBRTC_LOCKED_GLOBALS } from './webrtc_lockdown.ts';

type FakeWindow = Record<string, unknown>;

/** A stand-in window: WebIDL-shaped globals (configurable, writable, non-enumerable), `open` and `Document`. */
function fakeWindow(opens: () => unknown = () => fakeWindow()): FakeWindow {
	const w: FakeWindow = {};
	const idl = (name: string, value: unknown): void => {
		Object.defineProperty(w, name, { value, writable: true, enumerable: false, configurable: true });
	};
	for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate']) {
		idl(name, function Native() {});
	}
	idl('RTCSomethingChromeAddsLater', function Later() {});
	idl('MediaStreamTrackProcessor', function Processor() {});
	idl('fetch', () => 'fetched');
	const documentPrototype: Record<string, unknown> = {};
	Object.defineProperty(documentPrototype, 'open', {
		value: function open(...args: unknown[]): unknown {
			return args.length > 2 ? opens() : 'the document';
		},
		writable: true,
		enumerable: true,
		configurable: true,
	});
	idl('Document', { prototype: documentPrototype });
	Object.defineProperty(w, 'open', {
		value: function open(): unknown {
			return opens();
		},
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return w;
}

/** Runs the lockdown with `globalThis` bound to `w`, as Chromium runs it in that window's main world. */
function lockDown(w: FakeWindow): void {
	new Function('globalThis', WEBRTC_LOCKDOWN_SOURCE)(w);
}

/** Every RTC global of `w` is an own, non-configurable, non-writable `undefined`. */
function assertLocked(w: FakeWindow, label: string): void {
	for (const name of [...WEBRTC_LOCKED_GLOBALS, 'RTCSomethingChromeAddsLater']) {
		const descriptor = Object.getOwnPropertyDescriptor(w, name);
		assertEquals(
			descriptor,
			{ value: undefined, writable: false, enumerable: false, configurable: false },
			`${label}: ${name}`,
		);
	}
}

Deno.test('webrtc lockdown: the lockdown replaces every RTC global non-configurably, the absent ones included', () => {
	const w = fakeWindow();
	lockDown(w);
	assertLocked(w, 'window');
	// What reaches no network is left alone.
	assertEquals(typeof w.MediaStreamTrackProcessor, 'function');
	assertEquals((w.fetch as () => string)(), 'fetched');
	for (const name of ['RTCPeerConnection', 'RTCDataChannel', 'RTCSctpTransport', 'documentPictureInPicture']) {
		assert(WEBRTC_LOCKED_GLOBALS.includes(name), name);
	}
});

Deno.test('webrtc lockdown: page script cannot restore a locked constructor', () => {
	const w = fakeWindow();
	lockDown(w);
	assertThrows(() => Object.defineProperty(w, 'RTCPeerConnection', { value: function Pristine() {} }), TypeError);
	assertThrows(() => {
		'use strict';
		w.RTCPeerConnection = function Pristine() {};
	}, TypeError);
	assertEquals(Reflect.deleteProperty(w, 'RTCPeerConnection'), false);
	assertStrictEquals(w.RTCPeerConnection, undefined);
});

Deno.test('webrtc lockdown: window.open and a three-argument document.open hand back a locked window', () => {
	const children: FakeWindow[] = [];
	const w = fakeWindow(() => {
		const child = fakeWindow();
		children.push(child);
		return child;
	});
	lockDown(w);
	const popup = (w.open as () => FakeWindow)();
	assertStrictEquals(popup, children[0], 'the same window comes back');
	assertLocked(popup, 'window.open result');
	// The pop-up's own `open` is wrapped too, so a window it opens is locked as well.
	const grandchild = (popup.open as () => FakeWindow)();
	assertLocked(grandchild, 'the pop-up’s own window.open result');

	const documentOpen = (w.Document as { prototype: { open: (...args: unknown[]) => unknown } }).prototype.open;
	assertEquals(documentOpen(), 'the document', 'a plain document.open is untouched');
	const viaDocument = documentOpen('', 'name', '') as FakeWindow;
	assertLocked(viaDocument, 'document.open(url, name, features) result');
	// The wrapper cannot be deleted, and there is no way back to the native one.
	assertEquals(Reflect.deleteProperty(w, 'open'), false);
	assertEquals(Object.getOwnPropertyDescriptor(w, 'open')?.configurable, false);
});

Deno.test('webrtc lockdown: built-ins a page replaces later do not unlock the next pop-up', () => {
	// Built before the tampering, so the stand-in itself is whole.
	const child = fakeWindow();
	const w = fakeWindow(() => child);
	lockDown(w);
	const saved = {
		defineProperty: Object.defineProperty,
		getOwnPropertyNames: Object.getOwnPropertyNames,
		test: RegExp.prototype.test,
		has: WeakSet.prototype.has,
		apply: Reflect.apply,
	};
	try {
		Object.defineProperty = (<T>(o: T) => o) as typeof Object.defineProperty;
		Object.getOwnPropertyNames = () => [];
		RegExp.prototype.test = () => false;
		WeakSet.prototype.has = () => true;
		Reflect.apply = (() => null) as typeof Reflect.apply;
		const popup = (w.open as () => FakeWindow)();
		Object.defineProperty = saved.defineProperty;
		Object.getOwnPropertyNames = saved.getOwnPropertyNames;
		Reflect.apply = saved.apply;
		assertStrictEquals(popup, child);
		assertLocked(popup, 'a pop-up opened after the page tampered');
	} finally {
		Object.defineProperty = saved.defineProperty;
		Object.getOwnPropertyNames = saved.getOwnPropertyNames;
		RegExp.prototype.test = saved.test;
		WeakSet.prototype.has = saved.has;
		Reflect.apply = saved.apply;
	}
});

Deno.test('webrtc lockdown: a window the lockdown cannot touch (cross-origin) is handed back as it is, and nothing throws', () => {
	const crossOrigin = new Proxy({}, {
		ownKeys: () => {
			throw new DOMException('Blocked a frame', 'SecurityError');
		},
		defineProperty: () => {
			throw new DOMException('Blocked a frame', 'SecurityError');
		},
		getOwnPropertyDescriptor: () => {
			throw new DOMException('Blocked a frame', 'SecurityError');
		},
		get: () => {
			throw new DOMException('Blocked a frame', 'SecurityError');
		},
	});
	const w = fakeWindow(() => crossOrigin);
	lockDown(w);
	assertStrictEquals((w.open as () => unknown)(), crossOrigin);
	const nothing = fakeWindow(() => null);
	lockDown(nothing);
	assertStrictEquals((nothing.open as () => unknown)(), null, 'a refused pop-up (noopener, blocked) is null');
});

Deno.test('webrtc lockdown: running the lockdown twice (a pop-up’s own target, runImmediately) is harmless', () => {
	const w = fakeWindow();
	lockDown(w);
	lockDown(w);
	assertLocked(w, 'twice');
	assertLocked((w.open as () => FakeWindow)(), 'a pop-up after the second run');
});
