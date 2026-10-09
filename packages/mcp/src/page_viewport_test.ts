/**
 * Invariant I-16 and the viewport override (B2.6, AC-SEC-35).
 *
 * The load-bearing test in this file is the first one. `Emulation.setDeviceMetricsOverride` carries
 * both `deviceScaleFactor` (device pixel ratio — safe, and what `browser_set_viewport` maps
 * `device_scale` to) and `scale` (page scale — the parameter that makes the dormant
 * layout-versus-visual viewport divergence reachable on demand). SEC-24 stays Minor **because** this
 * delivery never sends the second one, and that is a claim about a dispatched object rather than
 * about a comment, so it is asserted on the object.
 */
import { assert, assertEquals } from '@std/assert';
import {
	DEVICE_SCALE_MAX,
	DEVICE_SCALE_MIN,
	deviceMetrics,
	VIEWPORT_MAX_PX,
	VIEWPORT_MIN_PX,
} from './page_viewport.ts';

Deno.test('I-16: the dispatched setDeviceMetricsOverride object has NO scale key (AC-SEC-35)', () => {
	const params = deviceMetrics({ width: 1280, height: 720, device_scale: 2 });
	// `in`, not `=== undefined`: a key present and undefined would still be serialised as a key by
	// some codecs, and the claim is about the object the CDP client is handed.
	assert(!('scale' in params), `page scale must never be dispatched: ${JSON.stringify(params)}`);
	assertEquals(Object.keys(params).sort(), ['deviceScaleFactor', 'height', 'mobile', 'width']);
	// `device_scale` is device pixel ratio, and nothing else.
	assertEquals(params.deviceScaleFactor, 2);
	assertEquals(params.width, 1280);
	assertEquals(params.height, 720);
	// The vendored `#applyViewport` sends `mobile: false`; a tool-set viewport must emulate the same
	// way a profile-set one does, or the two would produce different pages at the same size.
	assertEquals(params.mobile, false);
});

Deno.test('I-16: no input can introduce a scale key, including one that looks like one', () => {
	for (const device_scale of [1, 1.5, 4]) {
		const params = deviceMetrics({ width: 800, height: 600, device_scale });
		assert(!('scale' in params), `device_scale ${device_scale} produced a scale key`);
	}
	// Even handed an object that carries a `scale`, the builder emits only the four fields it names —
	// which is the property that survives someone later widening the caller's own type.
	const smuggled = { width: 800, height: 600, device_scale: 1, scale: 2 } as unknown as {
		width: number;
		height: number;
		device_scale: number;
	};
	assert(!('scale' in deviceMetrics(smuggled)));
});

Deno.test('B2.6: the viewport bounds are the schema’s own, declared once', () => {
	assertEquals([VIEWPORT_MIN_PX, VIEWPORT_MAX_PX], [200, 4096]);
	assertEquals([DEVICE_SCALE_MIN, DEVICE_SCALE_MAX], [1, 4]);
});
