import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import {
	BodyRefused,
	containerBody,
	type CreateFor,
	createFor,
	deploymentId,
	execBody,
	WRAPPER,
} from './docker_spec.ts';
import { BASE_ENV } from './cage.ts';
import { Engine, type EngineConn, type EngineDial, EngineError } from './engine.ts';
import { FakeEngine, memoryPipe } from './testing_engine.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const TARGET: CreateFor = await createFor({
	policy: { image: 'tykotech-sandbox-workspace:0.2.0', volume: 'ttk-code', sockVolume: 'ttk-sandbox-sock' },
	runId: RUN,
	owner: 'c'.repeat(64),
	git: false,
	deployment: await deploymentId('ttk-code'),
});

/** A daemon that answers each connection with `answer`, after reading the request head. */
function scripted(
	answer: (request: string, conn: EngineConn) => Promise<void>,
): { dial: EngineDial; dials: () => number } {
	let dials = 0;
	const pending = new Set<Promise<void>>();
	return {
		dials: () => dials,
		dial: () => {
			dials++;
			const [client, server] = memoryPipe();
			const serving = (async () => {
				let text = '';
				const chunk = new Uint8Array(4096);
				while (!text.includes('\r\n\r\n')) {
					const n = await server.read(chunk);
					if (n === null) return;
					text += decoder.decode(chunk.subarray(0, n));
				}
				// The request's body is read too, so what follows on the connection is only what came after it.
				const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? '0');
				while (text.length - text.indexOf('\r\n\r\n') - 4 < length) {
					const n = await server.read(chunk);
					if (n === null) return;
					text += decoder.decode(chunk.subarray(0, n));
				}
				await answer(text, server);
			})().catch(() => {});
			pending.add(serving);
			return Promise.resolve(client);
		},
	};
}

Deno.test('D-108 engine: JSON answers by length and chunked; paths carry the pinned API version', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const fake = new FakeEngine({ workDir: 'tests/.scratch' });
	const engine = new Engine(fake.dial);
	await engine.ping();
	assertEquals(await engine.volumeExists('ttk-code'), true);
	assertEquals(await engine.volumeExists('missing'), false);
	fake.plant('ttk-sandbox-x', { 'eu.tykotech.sandbox': '1', 'eu.tykotech.workspace': RUN }, true);
	// The fake sends the container list chunked, in two chunks.
	const listed = await engine.listContainers();
	assertEquals(listed.length, 1);
	assertEquals([listed[0]!.running, listed[0]!.volumes, listed[0]!.labels['eu.tykotech.workspace']], [true, [
		'ttk-code',
	], RUN]);
	assertEquals(fake.calls.map((c) => c.path.split('?')[0]), [
		'/v1.45/_ping',
		'/v1.45/volumes/ttk-code',
		'/v1.45/volumes/missing',
		'/v1.45/containers/json',
	]);
	assertStringIncludes(decodeURIComponent(fake.calls[3]!.path), 'filters={"label":["eu.tykotech.sandbox=1"]}');
	assertStringIncludes(fake.calls[3]!.path, 'all=true');
	await fake.settle();
});

Deno.test('R2-2 engine: pause and unpause by validated id; a paused container still counts as running', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const fake = new FakeEngine({ workDir: 'tests/.scratch' });
	const engine = new Engine(fake.dial);
	const planted = fake.plant('ttk-sandbox-x', { 'eu.tykotech.sandbox': '1' }, true);
	await engine.pauseContainer(planted.id);
	assertEquals(planted.paused, true);
	const inspected = (await engine.inspectContainer(planted.id))!;
	assertEquals([inspected.running, inspected.paused, inspected.imageId], [true, true, fake.imageOf('x:1')]);
	assertEquals((await engine.listContainers())[0]!.running, true, 'paused: it has processes, frozen');
	// Pausing twice is the daemon's conflict, not a silent success.
	assertEquals((await assertRejects(() => engine.pauseContainer(planted.id), EngineError)).status, 409);
	await engine.unpauseContainer(planted.id);
	assertEquals(planted.paused, false);
	assertEquals((await assertRejects(() => engine.unpauseContainer(planted.id), EngineError)).status, 409);
	assertEquals(fake.trail.filter((call) => /pause$/.test(call)), [
		`POST /containers/${planted.id}/pause`,
		`POST /containers/${planted.id}/pause`,
		`POST /containers/${planted.id}/unpause`,
		`POST /containers/${planted.id}/unpause`,
	]);
	for (const name of ['../x', 'a/b']) {
		await assertRejects(() => engine.pauseContainer(name), EngineError, 'not a Docker name');
		await assertRejects(() => engine.unpauseContainer(name), EngineError, 'not a Docker name');
	}
	await fake.settle();
});

Deno.test('D-108 engine: a daemon failure keeps its status and only cleaned words; bounds and bad answers refuse', async () => {
	const failing = scripted(async (_, conn) => {
		const body = JSON.stringify({ message: 'no such image:\u0007 x\n' });
		await conn.write(encoder.encode(`HTTP/1.1 404 Not Found\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
		conn.close();
	});
	const error = await assertRejects(() => new Engine(failing.dial).startContainer('abc'), EngineError);
	assertEquals(error.status, 404);
	assertEquals(error.message, 'no such image:  x');
	const huge = scripted(async (_, conn) => {
		await conn.write(encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n${'x'.repeat(4096)}`));
		conn.close();
	});
	const tooLarge = await assertRejects(() => new Engine(huge.dial, { maxResponseBytes: 1024 }).ping(), EngineError);
	assertEquals(tooLarge.status, 502);
	const notHttp = scripted(async (_, conn) => {
		await conn.write(encoder.encode('SSH-2.0-OpenSSH\r\n\r\n'));
		conn.close();
	});
	assertEquals((await assertRejects(() => new Engine(notHttp.dial).ping(), EngineError)).status, 502);
	const badChunk = scripted(async (_, conn) => {
		await conn.write(encoder.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nx\r\n0\r\n\r\n'));
		conn.close();
	});
	assertEquals((await assertRejects(() => new Engine(badChunk.dial).ping(), EngineError)).status, 502);
});

Deno.test('D-108 engine: a daemon that never answers costs one call, ended at the deadline', async () => {
	let held: EngineConn | null = null;
	const silent = scripted((_, conn) => {
		held = conn;
		return Promise.resolve();
	});
	const started = performance.now();
	const error = await assertRejects(() => new Engine(silent.dial, { timeoutMs: 50 }).ping(), EngineError);
	assertEquals(error.status, 504);
	assert(performance.now() - started < 5_000);
	(held as EngineConn | null)?.close();
});

Deno.test('D-108 engine: a refused body or a bad name never opens a connection', async () => {
	const daemon = scripted(() => Promise.reject(new Error('must not be reached')));
	const engine = new Engine(daemon.dial);
	const body = containerBody(TARGET) as unknown as Record<string, Record<string, unknown>>;
	body.HostConfig!.Privileged = true;
	await assertRejects(() => engine.createContainer('ttk-sandbox-x', body, TARGET), BodyRefused, 'Privileged');
	const binds = containerBody(TARGET) as unknown as Record<string, Record<string, unknown>>;
	binds.HostConfig!.Binds = ['/:/host'];
	await assertRejects(() => engine.createContainer('ttk-sandbox-x', binds, TARGET), BodyRefused, 'Binds');
	const exec = execBody({
		cmd: [WRAPPER, 'harbour-sandbox', 'not the inner script'],
		env: { ...BASE_ENV },
		workdir: '/',
		stdin: false,
	});
	await assertRejects(() => engine.createExec('abc', exec), BodyRefused, 'Cmd');
	for (const name of ['../containers/x', 'a/b', '', 'x?force=true']) {
		await assertRejects(() => engine.inspectContainer(name), EngineError, 'not a Docker name');
	}
	await assertRejects(() => engine.inspectExec('../../x'), EngineError, 'not an exec id');
	assertEquals(daemon.dials(), 0);
});

Deno.test('D-108 engine: an attached exec is demultiplexed across reads; input is written raw and then closed', async () => {
	const execId = 'e'.repeat(64);
	let input = '';
	const daemon = scripted(async (request, conn) => {
		assertStringIncludes(request, `POST /v1.45/exec/${execId}/start HTTP/1.1`);
		assertStringIncludes(request, 'Upgrade: tcp');
		const frame = (stream: number, text: string) => {
			const data = encoder.encode(text);
			const out = new Uint8Array(8 + data.length);
			out[0] = stream;
			new DataView(out.buffer).setUint32(4, data.length);
			out.set(data, 8);
			return out;
		};
		const all = new Uint8Array([...frame(2, 'harbour-cage-ready 7 9\n'), ...frame(1, 'hello '), ...frame(1, 'world')]);
		await conn.write(encoder.encode('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'));
		// Split mid-header and mid-payload, as a socket may deliver it.
		for (const at of [0, 5, 13, 30, all.length]) {
			const next = [0, 5, 13, 30, all.length].find((n) => n > at) ?? all.length;
			if (next > at) await conn.write(all.subarray(at, next));
		}
		const chunk = new Uint8Array(1024);
		for (;;) {
			const n = await conn.read(chunk);
			if (n === null) break;
			input += decoder.decode(chunk.subarray(0, n));
		}
		conn.close();
	});
	const stream = await new Engine(daemon.dial).startExec(execId);
	await stream.write(encoder.encode('line one\n'));
	await stream.closeWrite();
	const frames: string[] = [];
	for (;;) {
		const frame = await stream.next();
		if (frame === null) break;
		frames.push(`${frame.stream}:${decoder.decode(frame.data)}`);
	}
	stream.close();
	assertEquals(frames, ['2:harbour-cage-ready 7 9\n', '1:hello ', '1:world']);
	assertEquals(input, 'line one\n');
});
