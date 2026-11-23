/**
 * The WebRTC lockdown on real Chromium — `TTK_ALLOWED_DOMAINS_SCOPE=all` also covers WebRTC.
 *
 * An on-list page (`localhost`) runs one probe from a click (so `window.open` has a user gesture): it reads the RTC
 * globals in its own window, in an `about:blank` iframe (by `contentWindow` and by `frames[i]`), in a `srcdoc` iframe
 * and in a `window.open('')` pop-up, tries to restore `RTCPeerConnection`, and then — through whatever constructor it
 * could still find, the window's own or one fetched from a child frame of a fresh pop-up — gathers ICE against TURN/TCP
 * on an off-list IP literal (`127.0.0.1`, a raw TCP recorder that counts connections), the same on an off-list name,
 * and STUN on the literal. The page POSTs what it saw to its own server.
 *
 * - **`documents`** (control): the constructors are there, and the TURN/TCP allocation reaches the recorder — the
 *   measurement that the recorder is reachable, and that WebRTC is what `all` must stop.
 * - **`all`**: every one of those globals is `undefined` and cannot be restored, no ICE candidate is gathered, and the
 *   recorder sees **no connection**. A pop-up's child frame is the one place the script is raced (`webrtc_lockdown.ts`:
 *   outside the product, with no pop-up attach, it handed back a pristine constructor); measured on Chromium 158 in
 *   the product it came back locked too. It is logged, not asserted, because the preference (no UDP) and the resolver
 *   layer (no off-list TCP) are what stand behind it — and the candidates and the recorder are asserted either way.
 *
 * The tier's net grant is loopback by name and this file does not widen it; UDP is not recorded (no `--unstable-net`
 * in the tier), so "no UDP" is read from the candidates: no `host` and no `srflx` candidate is gathered.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals, assertGreater } from '@std/assert';
import { type Harness, harness, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('webrtc scope e2e');

/** A raw TCP listener on the off-list IP literal that counts every connection. */
function recorder(): { readonly port: number; connections(): number; close(): Promise<void> } {
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const open = new Set<Deno.Conn>();
	let connections = 0;
	const accepting = (async () => {
		for await (const conn of listener) {
			connections += 1;
			open.add(conn);
			setTimeout(() => {
				open.delete(conn);
				try {
					conn.close();
				} catch { /* already closed */ }
			}, 200);
		}
	})().catch(() => {});
	return {
		port: (listener.addr as Deno.NetAddr).port,
		connections: () => connections,
		async close() {
			listener.close();
			for (const conn of open) {
				try {
					conn.close();
				} catch { /* already closed */ }
			}
			await accepting;
		},
	};
}

/** What the probe page reports. */
interface Report {
	main: string;
	restore: string;
	blankIframe: string;
	framesIndex: string;
	srcdoc: string;
	popup: string;
	popupFrame: string;
	constructorFrom: string;
	candidates: string[];
	gathering: string;
	error?: string;
}

/** The probe: runs on a click, POSTs a {@linkcode Report} to `/report`. */
function probePage(recorderPort: number): string {
	const turn = (host: string) =>
		`{ urls: 'turn:${host}:${recorderPort}?transport=tcp', username: 'u', credential: 'p' }`;
	const script = `
const kinds = (w) => ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription',
  'RTCIceCandidate', 'RTCRtpTransceiver'].map((n) => typeof w[n]).join('/');
async function probe() {
  const r = { candidates: [] };
  try {
    r.main = kinds(window);
    const own = window.RTCPeerConnection;
    try { Object.defineProperty(window, 'RTCPeerConnection', { value: function () {} }); r.restore = 'restored'; }
    catch (e) { r.restore = 'refused'; }
    const blank = document.createElement('iframe'); document.body.appendChild(blank);
    r.blankIframe = typeof blank.contentWindow.RTCPeerConnection;
    r.framesIndex = typeof frames[frames.length - 1].RTCPeerConnection;
    r.srcdoc = await new Promise((resolve) => { const f = document.createElement('iframe'); f.srcdoc = '<p>x';
      f.onload = () => resolve(typeof f.contentWindow.RTCPeerConnection); document.body.appendChild(f); });
    const popup = window.open('');
    r.popup = popup === null ? 'null' : typeof popup.RTCPeerConnection;
    let pristine;
    if (popup !== null) {
      const inner = popup.document.createElement('iframe'); popup.document.body.appendChild(inner);
      pristine = popup[0] && popup[0].RTCPeerConnection;
    }
    r.popupFrame = popup === null || popup[0] === undefined ? 'no frame' : typeof pristine;
    const PC = typeof own === 'function' ? own : pristine;
    r.constructorFrom = typeof own === 'function' ? 'window' : typeof PC === 'function' ? 'popup frame' : 'none';
    if (typeof PC === 'function') {
      const pc = new PC({ iceServers: [${turn('127.0.0.1')}, ${turn('ttk-off.test')},
        { urls: 'stun:127.0.0.1:${recorderPort}' }] });
      pc.onicecandidate = (e) => { if (e.candidate) r.candidates.push(e.candidate.candidate); };
      pc.createDataChannel('exfil');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 5000));
      r.gathering = pc.iceGatheringState;
      pc.close();
    } else {
      r.gathering = 'no constructor';
    }
  } catch (e) { r.error = String(e); }
  await fetch('/report', { method: 'POST', body: JSON.stringify(r) });
}`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>rtc</title></head><body>` +
		`<button id="go" type="button" onclick="probe()">probe</button><script>${script}</script></body></html>`;
}

/** The on-list site: the probe page and the report sink. */
function site(recorderPort: number): { origin: string; reports: Report[]; close(): Promise<void> } {
	const reports: Report[] = [];
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		const url = new URL(request.url);
		if (url.pathname === '/report' && request.method === 'POST') {
			reports.push(JSON.parse(await request.text()) as Report);
			return new Response('ok');
		}
		return new Response(probePage(recorderPort), {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		});
	});
	return {
		origin: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
		reports,
		close: () => server.shutdown(),
	};
}

async function clickGo(h: Harness): Promise<void> {
	const state = await h.call('browser_get_state', { fields: ['core', 'attrs'] });
	assert(state.isError !== true, JSON.stringify(state.content));
	const elements = (state.structuredContent as { interactive_elements: { index: number; attrs?: { id?: string } }[] })
		.interactive_elements;
	const go = elements.find((element) => element.attrs?.id === 'go');
	assert(go !== undefined, JSON.stringify(elements));
	await h.call('browser_click', { index: go.index });
}

async function probeUnder(scope: 'documents' | 'all'): Promise<{ report: Report; connections: number }> {
	const rec = recorder();
	const s = site(rec.port);
	try {
		await using h = await harness({
			env: { TTK_ALLOWED_DOMAINS: 'localhost', TTK_ALLOWED_DOMAINS_SCOPE: scope },
		});
		await h.callText('browser_navigate', { url: `${s.origin}/rtc.html` });
		await clickGo(h);
		const deadline = Date.now() + 20_000;
		while (s.reports.length === 0) {
			if (Date.now() > deadline) throw new Error('the probe never reported');
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		const report = s.reports[0] as Report;
		return { report, connections: rec.connections() };
	} finally {
		await s.close();
		await rec.close();
	}
}

Deno.test({
	name: 'e2e WebRTC: documents — the constructors are there and TURN/TCP reaches the off-list literal',
	ignore,
	async fn() {
		const { report, connections } = await probeUnder('documents');
		assertEquals(report.error, undefined);
		assertEquals(report.main, 'function/function/function/function/function/function');
		assertEquals(report.constructorFrom, 'window');
		assertGreater(connections, 0, 'the control: without the lockdown WebRTC reaches the off-list host');
	},
});

Deno.test({
	name: 'e2e WebRTC: all — no RTC API in any window, no candidate, no off-list connection',
	ignore,
	async fn() {
		const { report, connections } = await probeUnder('all');
		assertEquals(report.error, undefined);
		// Layer 1: the lockdown script, in the page and in every child it can reach.
		assertEquals(report.main, 'undefined/undefined/undefined/undefined/undefined/undefined');
		assertEquals(report.restore, 'refused');
		assertEquals(report.blankIframe, 'undefined', 'about:blank iframe, by contentWindow');
		assertEquals(report.framesIndex, 'undefined', 'about:blank iframe, by frames[i]');
		assertEquals(report.srcdoc, 'undefined', 'srcdoc iframe');
		assertEquals(report.popup, 'undefined', 'window.open pop-up');
		// Layers 2 and 3 behind it: whatever constructor survived gathers nothing and reaches nothing off the list.
		assertEquals(report.candidates, [], 'no host, srflx or relay candidate');
		assertEquals(connections, 0, 'no WebRTC connection reached the off-list IP literal');
	},
});
