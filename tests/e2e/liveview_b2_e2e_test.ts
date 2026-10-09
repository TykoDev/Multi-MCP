/**
 * B2.3 on real Chromium: ticket options, `holder_name`, `frame_scale` measured against the JPEG's own
 * dimensions, `live.keyframe` (with the A-3 cold-capture cost measured), `live.quality`, and the
 * opt-in rule for the messages a 0.1.0 client never saw.
 *
 * Browser tier — requires `--allow-run=<resolved chromium>`.
 */
import { assert, assertEquals } from '@std/assert';
import { frameScaleFor, TICKET_TTL_MAX_CONTROL_MS } from '@tykotech/gateway';
import { harness, LiveSocket, skipUnlessBrowser } from '../support/harness.ts';

const ignore = skipUnlessBrowser('liveview B2 e2e');

/** The pixel size a JPEG declares in its SOF marker — the frame's own word on its dimensions. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) throw new Error(`no marker at ${i}`);
		const marker = bytes[i + 1] as number;
		if (marker === 0xff) {
			i += 1;
			continue;
		}
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			return {
				height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number),
				width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number),
			};
		}
		const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
		i += 2 + length;
	}
	throw new Error('no SOF marker');
}

/** Resizes the focused tab's viewport through CDP, as `browser_set_viewport` will (B2.6). */
async function resize(h: { gateway: { registry: { peek(id: string): unknown } } }, width: number, height: number) {
	const record = h.gateway.registry.peek('default') as {
		session: {
			cdpClient: { send: { Emulation: { setDeviceMetricsOverride(p: unknown, s: string): Promise<unknown> } } } | null;
			sessionManager: { getOrCreateCdpSession(t: unknown, f: boolean): Promise<{ sessionId: string }> } | null;
			agentFocusTargetId: string | null;
		};
	};
	const cdp = await record.session.sessionManager!.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
	await record.session.cdpClient!.send.Emulation.setDeviceMetricsOverride(
		{ width, height, deviceScaleFactor: 1, mobile: false },
		cdp.sessionId,
	);
}

Deno.test({
	name: 'e2e live (B2.3): ticket options — ttl clamp and echo, view mode, origin binding, holder_name',
	ignore,
	async fn(t) {
		await using h = await harness({ label: 'ADM worker' });
		await h.callText('browser_navigate', { url: h.site.page('index') });

		const mint = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
			const response = await h.fetch('/api/v1/live/ticket', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() as Record<string, unknown> };
		};

		await t.step('ttl_seconds above the control ceiling is clamped and the granted value echoed', async () => {
			const { status, body } = await mint({ ttl_seconds: 500, origin: 'https://adm.example' });
			assertEquals(status, 201);
			assertEquals(body.mode, 'control');
			assertEquals(body.ttl_seconds, TICKET_TTL_MAX_CONTROL_MS / 1000);
			assert((body.expires_in as number) <= TICKET_TTL_MAX_CONTROL_MS / 1000);
			assertEquals(body.origin_bound, 'https://adm.example');
			assertEquals(body.holder_name, 'ADM worker');
		});

		await t.step('a ttl above the default without an origin is refused; an origin binds it', async () => {
			const refused = await mint({ ttl_seconds: 120 });
			assertEquals(refused.status, 400);
			assert(String(refused.body.type).includes('invalid-request'));
			// The header binds it when the page is one this deployment already admits — the gateway
			// origin-checks every REST request, so a foreign `Origin` is refused before this route is
			// reached, and a client on another origin names it in the body instead.
			const byHeader = await mint({ ttl_seconds: 120, mode: 'view' }, { origin: h.url });
			assertEquals(byHeader.status, 201);
			assertEquals(byHeader.body.mode, 'watch');
			assertEquals(byHeader.body.ttl_seconds, 120);
			assertEquals(byHeader.body.origin_bound, h.url);
			const byBody = await mint({ ttl_seconds: 120, origin: 'https://adm.example' });
			assertEquals(byBody.status, 201);
			assertEquals(byBody.body.origin_bound, 'https://adm.example');
			// A value that is not an origin is refused rather than stored as one.
			const bad = await mint({ ttl_seconds: 120, origin: 'https://adm.example/path' });
			assertEquals(bad.status, 400);
		});

		await t.step('an origin-bound ticket is refused from another origin and from none', async () => {
			const upgrade = (ticket: unknown, origin?: string) =>
				fetch(`${h.url}/live/default/ws?ticket=${ticket}`, {
					headers: { upgrade: 'websocket', connection: 'Upgrade', ...(origin === undefined ? {} : { origin }) },
				});
			// Bound to an origin this deployment is not itself served from, then presented **with no
			// Origin header at all**. That isolates the ticket's own binding from the gateway's origin
			// middleware, which would refuse a foreign `Origin` before this route is reached: the
			// refusal below can only be the redemption check.
			const bound = await mint({ ttl_seconds: 60, origin: 'https://adm.example' });
			assertEquals(bound.body.origin_bound, 'https://adm.example');
			const none = await upgrade(bound.body.ticket);
			assertEquals(none.status, 403);
			assert(
				String((await none.json() as { type: string }).type).includes('origin-forbidden'),
				'a missing Origin is not the bound origin',
			);
			// And presented from an origin the deployment does admit, but not the one it was bound to.
			const second = await mint({ ttl_seconds: 60, origin: 'https://adm.example' });
			const other = await upgrade(second.body.ticket, h.url);
			assertEquals(other.status, 403);
			assert(
				String((await other.json() as { type: string }).type).includes('origin-forbidden'),
				'an admitted but unbound origin is still not the bound one',
			);
		});

		await t.step('mode: "view" can never take control, even for a view:control principal', async () => {
			const { body } = await mint({ mode: 'view' });
			assertEquals(body.mode, 'watch');
			const socket = new LiveSocket(`${h.url.replace(/^http/, 'ws')}/live/default/ws?ticket=${body.ticket}`);
			const meta = await socket.ready();
			assertEquals(meta.mode, 'watch');
			const from = socket.messages.length;
			socket.send({ type: 'control.take' });
			const error = await socket.waitFor('error', () => true, from);
			assertEquals(error.code, 'not-holder', 'refused by the lock path, not merely by the client');
			await socket.close();
		});

		await t.step('holder_name reaches every viewer on the lock message', async () => {
			const first = await h.live();
			const second = await h.live();
			const meta = await first.ready();
			first.send({ type: 'control.take' });
			const seen = await second.waitFor('lock', (m) => m.lock !== null);
			assertEquals(seen.lock?.holder, meta.viewerId);
			assertEquals(seen.lock?.holderName, 'ADM worker');
			first.send({ type: 'control.release' });
			await second.waitFor('lock', (m) => m.lock === null);
			await first.close();
			await second.close();
		});
	},
});

Deno.test({
	name:
		"e2e live (B2.3): frame_scale is the frame's own arithmetic on two viewports, keyframe answers from the cache, quality changes the next frame",
	ignore,
	async fn(t) {
		await using h = await harness();
		await h.callText('browser_navigate', { url: h.site.page('long') });
		const socket = await h.live();
		const meta = await socket.ready();
		socket.send({ type: 'events.subscribe' });
		await socket.waitFor('event', (m) => m.event.kind === 'control');

		await t.step(
			"meta.frame_scale and every frame's scale equal min(1280/w, 720/h), and the JPEG is that size",
			async () => {
				const frame = await socket.waitForFrames(1);
				const expected = frameScaleFor(frame.meta.w, frame.meta.h);
				assertEquals(frame.meta.scale, expected);
				assertEquals(meta.frame_scale, frameScaleFor(meta.viewport.w, meta.viewport.h));
				const size = jpegSize(frame.jpeg);
				console.log(
					`B2.3 frame_scale: viewport=${frame.meta.w}x${frame.meta.h} scale=${expected} jpeg=${size.width}x${size.height}`,
				);
				assert(
					Math.abs(size.width - frame.meta.w * expected) <= 1,
					`jpeg width ${size.width} vs ${frame.meta.w * expected}`,
				);
				assert(Math.abs(size.height - frame.meta.h * expected) <= 1);
				const announced = await socket.waitFor('viewport');
				assertEquals(announced.frame_scale, expected);
			},
		);

		await t.step('a second viewport: 1920x993 gives 0.6667 and a 1280-wide frame (AC-P0-38)', async () => {
			const seen = socket.frames.length;
			await resize(h, 1920, 993);
			const frame = await socket.until(
				() => {
					const latest = socket.frames[socket.frames.length - 1];
					return socket.frames.length > seen && latest?.meta.w === 1920 ? latest : undefined;
				},
				'a 1920-wide frame',
				async () => {
					await h.callText('browser_scroll', { direction: 'down', pages: 0.1 });
				},
			);
			assertEquals(Math.round((frame.meta.scale ?? 0) * 10_000) / 10_000, 0.6667);
			const size = jpegSize(frame.jpeg);
			console.log(
				`B2.3 frame_scale after resize: viewport=${frame.meta.w}x${frame.meta.h} scale=${frame.meta.scale} jpeg=${size.width}x${size.height}`,
			);
			assertEquals(size.width, 1280);
			const announced = await socket.waitFor('viewport', (m) => m.w === 1920);
			assertEquals(Math.round(announced.frame_scale * 10_000) / 10_000, 0.6667);
		});

		await t.step(
			'live.keyframe answers from the cache without a page change; the capture cost it avoids is measured (A-3)',
			async () => {
				// Warm: the page is idle, nothing paints, and the frame still arrives.
				const timings: number[] = [];
				for (let i = 0; i < 5; i++) {
					const seen = socket.frames.length;
					const started = performance.now();
					socket.send({ type: 'live.keyframe' });
					await socket.waitForFrames(seen + 1);
					timings.push(performance.now() - started);
				}
				// And the cost of the capture fallback the design contemplated, measured directly on this
				// heavy page so the decision to drop it rests on a number rather than on an expectation.
				const record = h.gateway.registry.peek('default')!;
				const client = record.session.cdpClient!;
				const cdp = await record.session.sessionManager!.getOrCreateCdpSession(record.session.agentFocusTargetId, true);
				const captures: number[] = [];
				for (let i = 0; i < 5; i++) {
					const started = performance.now();
					await client.send.Page.captureScreenshot({
						format: 'jpeg',
						quality: 60,
						optimizeForSpeed: true,
						clip: { x: 0, y: 0, width: 1920, height: 993, scale: 0.6667 },
					}, cdp.sessionId);
					captures.push(performance.now() - started);
				}
				const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
				console.log(
					`A-3 keyframe: cached round trip avg ${avg(timings)} ms (${
						timings.map(Math.round).join(',')
					}); cold Page.captureScreenshot avg ${avg(captures)} ms (${captures.map(Math.round).join(',')})`,
				);
				assert(avg(timings) < avg(captures), 'the cache is the cheap path, which is why it is the only path');
			},
		);

		await t.step(
			'live.quality is bounded at the wire, echoed as granted, and the next frame is at the new bound',
			async () => {
				// Out of range is a schema refusal, not a silent clamp: the wire is the first bound, and a
				// client learns its request was wrong rather than receiving something it did not ask for.
				const badFrom = socket.messages.length;
				socket.sendRaw(JSON.stringify({ type: 'live.quality', jpeg_quality: 500 }));
				const refused = await socket.waitFor('error', () => true, badFrom);
				assertEquals(refused.code, 'bad-message');
				assertEquals(refused.reason, 'schema');

				const from = socket.messages.length;
				const seen = socket.frames.length;
				socket.send({ type: 'live.quality', scale: 0.5, jpeg_quality: 100, max_fps: 10 });
				const reply = await socket.waitFor('quality', () => true, from);
				assertEquals(reply, { type: 'quality', scale: 0.5, jpeg_quality: 100, max_fps: 10 });

				// The page must paint for a frame to arrive, and an idle page does not; scroll until one
				// does rather than assuming a single gesture lands inside the restart window.
				const frame = await socket.until(
					() => {
						const latest = socket.frames[socket.frames.length - 1];
						return socket.frames.length > seen && latest?.meta.scale !== undefined && latest.meta.scale < 0.6
							? latest
							: undefined;
					},
					'a half-bound frame',
					async () => {
						await h.callText('browser_scroll', { direction: 'down', pages: 0.1 });
					},
				);
				const size = jpegSize(frame.jpeg);
				console.log(`B2.3 quality: scale=${frame.meta.scale} jpeg=${size.width}x${size.height}`);
				assertEquals(size.width, 640);
				assertEquals(frame.meta.scale, frameScaleFor(frame.meta.w, frame.meta.h, 640, 360));
			},
		);

		await t.step('a socket that never subscribed receives no quality or viewport message', async () => {
			const quiet = await h.live();
			await quiet.ready();
			const from = socket.messages.length;
			socket.send({ type: 'live.quality', scale: 1 });
			await socket.waitFor('quality', () => true, from);
			await quiet.waitForFrames(1);
			assert(
				quiet.messages.every((m) => m.type !== 'quality' && m.type !== 'viewport'),
				JSON.stringify(quiet.messages.map((m) => m.type)),
			);
			await quiet.close();
		});

		await socket.close();
	},
});

Deno.test({
	name: 'e2e live (B2.3): a cold cast answers live.keyframe with not-ready, never an unbounded capture (A-3)',
	ignore,
	async fn() {
		await using h = await harness();
		// The cold window the design names is the one right after a **retarget**: the cast drops its
		// cached frame when focus moves to another tab, and the new tab has not painted into it yet.
		// (A never-navigated session would also be cold, but its about:blank animation leaves timers
		// running that have nothing to do with this contract.)
		await h.callText('browser_navigate', { url: h.site.page('tabs') });
		const socket = await h.live();
		await socket.ready();
		await socket.waitForFrames(1);
		const state = await h.callJson<{ interactive_elements: Array<{ index: number; tag: string }> }>(
			'browser_get_state',
			{},
		);
		const opener = state.interactive_elements.find((element) => element.tag === 'button');
		assert(opener !== undefined);
		const from = socket.messages.length;
		await h.callText('browser_click', { index: opener.index });
		socket.send({ type: 'live.keyframe' });
		// One waiter over both buffers rather than a race: a losing `Promise.race` branch keeps its own
		// poll timer rescheduling for the life of the process, which the leak detector rightly reports.
		const answer = await socket.until(() => {
			const refusal = socket.messages.slice(from).find((m) => m.type === 'error');
			if (refusal !== undefined) return `error:${(refusal as { code: string }).code}`;
			return socket.frames.length > 0 ? 'frame' : undefined;
		}, 'a keyframe answer');
		console.log(`B2.3 keyframe right after a retarget: ${answer}`);
		// Either is correct and which one it is depends on whether the tab painted first; what must
		// never happen is silence, or a capture. `not-ready` is the documented cold answer (A-3).
		assert(answer === 'error:not-ready' || answer === 'frame', answer);
		await socket.close();
	},
});

Deno.test({
	name: 'e2e live (B2.3): a watch-only viewer cannot change the shared stream quality',
	ignore,
	async fn() {
		await using h = await harness({ scopes: ['mcp:invoke', 'view:watch'] });
		await h.callText('browser_navigate', { url: h.site.page('index') });
		const socket = await h.live();
		const from = socket.messages.length;
		socket.send({ type: 'live.quality', scale: 0.5 });
		const error = await socket.waitFor('error', () => true, from);
		assertEquals(error.code, 'not-holder');
		// But it may ask for the frame it is already entitled to see: a keyframe needs no mode at all,
		// and answers with the cached frame or the documented cold code.
		const before = socket.messages.length;
		const seen = socket.frames.length;
		socket.send({ type: 'live.keyframe' });
		const answer = await socket.until(() => {
			const refusal = socket.messages.slice(before).find((m) => m.type === 'error');
			if (refusal !== undefined) return (refusal as { code: string }).code;
			return socket.frames.length > seen ? 'frame' : undefined;
		}, 'a keyframe answer');
		assert(answer === 'frame' || answer === 'not-ready', answer);
		await socket.close();
	},
});
