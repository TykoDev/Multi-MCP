/**
 * @module
 * The WebRTC lockdown for `requestScope: 'all'`: ICE traffic never reaches `Fetch`, so the request scope alone cannot
 * keep WebRTC on the allowlist.
 *
 * `all` judges every HTTP(S) and WebSocket request over `Fetch` and refuses off-list names and IP literals in the
 * resolver layer the host composes (`--host-resolver-rules … MAP * ~NOTFOUND`). WebRTC is neither: its ICE traffic
 * leaves through the network service's P2P sockets, which `Fetch` never sees. Measured on Chromium 158 (Edge,
 * throwaway profiles, a TCP and a UDP recorder on an off-list `127.0.0.1`): with no control, a page's
 * `RTCPeerConnection` sent STUN over UDP to the off-list IP literal and opened a TURN/TCP connection to it.
 *
 * Three layers, so that no single one is load-bearing:
 *
 * 1. **The page cannot reach the API** — {@linkcode WEBRTC_LOCKDOWN_SOURCE}, registered with
 *    `Page.addScriptToEvaluateOnNewDocument` on every attached target that has a window (`SessionManager`). It replaces
 *    every `RTC*` / `webkitRTC*` global with a non-configurable, non-writable `undefined` before page script runs.
 *    Measured: Chromium runs such a script in the initial empty document of an `about:blank` iframe on synchronous
 *    access, in `srcdoc` and `javascript:` iframes, so a same-origin child frame does not hand back a pristine
 *    constructor. It does **not** run in the initial document of a `window.open('')` pop-up, which the opener can read
 *    synchronously before the pop-up's own target is attached — so the script wraps `window.open` and the three-argument
 *    `document.open`, and locks the window they return before handing it back. One path stays raced: a child frame the
 *    opener creates inside such a pop-up at once (`w[0]` cannot be intercepted). Without a pop-up attach it handed
 *    back a pristine constructor; in the product (the pop-up attached paused, this script sent `runImmediately`) it
 *    came back locked on Chromium 158 (`tests/e2e/webrtc_scope_e2e_test.ts`). Layers 2 and 3 are why that is not
 *    load-bearing.
 * 2. **No UDP at all** — the profile preference `webrtc.ip_handling_policy = disable_non_proxied_udp`
 *    (`LocalBrowserWatchdog`), which sets `PORTALLOCATOR_DISABLE_UDP | DISABLE_STUN | DISABLE_UDP_RELAY` in Blink's
 *    port allocator. Measured: no UDP packet, no host candidate. It leaves TCP: a TURN/TCP allocation to an off-list IP
 *    literal still connected directly when nothing else stood in the way. The switch
 *    `--force-webrtc-ip-handling-policy` is **not** used: measured inert on the branded build (UDP still sent); it is
 *    read by Chromium's content-level test harness, not by the browser's renderer preferences.
 * 3. **TCP meets the resolver layer** — WebRTC's TCP sockets (`P2PSocketTcp`) are made by the network service's
 *    proxy-resolving socket factory, which resolves through the same host resolver `--host-resolver-rules` maps, IP
 *    literals included. Measured: with layer 2, the off-list TURN/TCP allocation (by IP literal and by name) made no
 *    connection — so even a constructor that escaped layer 1 reaches nothing off the list.
 *
 * What is left is said in `docs/reference/environment-variables.md`: under a proxy (`TTK_BROWSER_ARGS`) TCP goes to
 * the proxy, which resolves names itself (as it does for WebSockets), and layer 1 alone stands there. (Changed from
 * upstream: the attached-browser case it also named is gone, since the gateway only launches browsers of its own.)
 */

/**
 * The globals the lockdown removes even when the build does not define them (so a page cannot define a polyfill of
 * that name later either). Every other own global whose name starts `RTC` or `webkitRTC` is removed too, so an
 * interface a later Chromium adds is covered without a change here. `documentPictureInPicture` opens a same-origin
 * window with an initial empty document, like `window.open('')`, and is removed rather than wrapped: an agent's
 * browser has no use for it. `MediaStreamTrackProcessor` and friends are not removed: they reach no network.
 */
export const WEBRTC_LOCKED_GLOBALS: readonly string[] = [
	'RTCPeerConnection',
	'webkitRTCPeerConnection',
	'RTCDataChannel',
	'RTCSessionDescription',
	'RTCIceCandidate',
	'RTCRtpSender',
	'RTCRtpReceiver',
	'RTCRtpTransceiver',
	'RTCDtlsTransport',
	'RTCIceTransport',
	'RTCSctpTransport',
	'RTCCertificate',
	'RTCEncodedAudioFrame',
	'RTCEncodedVideoFrame',
	'RTCRtpScriptTransform',
	'RTCDTMFSender',
	'RTCDataChannelEvent',
	'RTCPeerConnectionIceEvent',
	'RTCPeerConnectionIceErrorEvent',
	'RTCTrackEvent',
	'RTCError',
	'RTCErrorEvent',
	'RTCStatsReport',
	'documentPictureInPicture',
	'DocumentPictureInPicture',
	'DocumentPictureInPictureEvent',
];

/**
 * The script registered on every window-bearing target under `requestScope: 'all'`. Plain JavaScript (no
 * transpilation, no closure over module scope), evaluated in the page's main world before any page script.
 *
 * It captures the built-ins it uses (`Object.defineProperty`, `Reflect.apply`, `RegExp.prototype.test`, the
 * `WeakSet` methods) before page script can replace them, iterates with index loops (no array iterator a page could
 * patch), and never throws: a window it cannot touch — a cross-origin pop-up — is left to its own target's copy of
 * this script. The wrappers of `open` stay writable (a page assigning `window.open` keeps working) but cannot be
 * deleted, and there is no way back to the native `open`: the global holds the only reference.
 */
export const WEBRTC_LOCKDOWN_SOURCE = `(() => {
	'use strict';
	const defineProperty = Object.defineProperty;
	const getOwnPropertyNames = Object.getOwnPropertyNames;
	const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const apply = Reflect.apply;
	const test = RegExp.prototype.test;
	const weakHas = WeakSet.prototype.has;
	const weakAdd = WeakSet.prototype.add;
	const RTC = /^(?:webkit)?RTC/;
	const NAMES = ${JSON.stringify(WEBRTC_LOCKED_GLOBALS)};
	const wrappers = new WeakSet();
	const lock = (w, name) => {
		try {
			defineProperty(w, name, { value: undefined, writable: false, enumerable: false, configurable: false });
		} catch (_) { /* cross-origin, or already locked */ }
	};
	const wrapOpen = (holder, returnsWindow) => {
		let native;
		try {
			const descriptor = getOwnPropertyDescriptor(holder, 'open');
			native = descriptor === undefined ? undefined : descriptor.value;
		} catch (_) { return; }
		if (typeof native !== 'function' || apply(weakHas, wrappers, [native])) return;
		const wrapper = {
			open() {
				const opened = apply(native, this, arguments);
				if (returnsWindow(arguments.length) && opened !== null && typeof opened === 'object') neuter(opened);
				return opened;
			},
		}.open;
		apply(weakAdd, wrappers, [wrapper]);
		try {
			defineProperty(holder, 'open', { value: wrapper, writable: true, enumerable: true, configurable: false });
		} catch (_) { /* cross-origin */ }
	};
	const neuter = (w) => {
		let names = [];
		try { names = getOwnPropertyNames(w); } catch (_) { /* cross-origin */ }
		for (let i = 0; i < names.length; i++) {
			const name = names[i];
			if (typeof name === 'string' && apply(test, RTC, [name])) lock(w, name);
		}
		for (let i = 0; i < NAMES.length; i++) lock(w, NAMES[i]);
		wrapOpen(w, () => true);
		let documentPrototype;
		try { documentPrototype = w.Document && w.Document.prototype; } catch (_) { /* cross-origin */ }
		if (documentPrototype) wrapOpen(documentPrototype, (count) => count > 2);
	};
	neuter(globalThis);
})();`;
