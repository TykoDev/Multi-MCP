/**
 * `Recorder.start` reserves its session (and, in `owner` mode, its recording name) before its first `await`, so two
 * concurrent starts cannot both spawn an encoder, and two owners cannot both claim one free name.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { type SessionRegistry, ToolError } from '@tykotech/mcp';
import { createLogger } from './logger.ts';
import { type EncoderSpawn, Recorder, type RecorderDeps } from './recorder.ts';

const FRAME = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));

interface Counted {
	readonly spawn: EncoderSpawn;
	spawned: number;
	live: number;
}

/** An encoder that finishes when stdin closes or it is killed, counting both. */
function countingEncoder(): Counted {
	const counted: Counted = {
		spawned: 0,
		live: 0,
		spawn: () => {
			counted.spawned += 1;
			counted.live += 1;
			let settle: (status: Deno.CommandStatus) => void = () => {};
			let done = false;
			const status = new Promise<Deno.CommandStatus>((resolve) => (settle = resolve));
			const finish = (value: Deno.CommandStatus): void => {
				if (done) return;
				done = true;
				counted.live -= 1;
				settle(value);
			};
			return {
				stdin: new WritableStream<Uint8Array>({
					close: () => finish({ success: true, code: 0, signal: null }),
					abort: () => finish({ success: false, code: 1, signal: null }),
				}),
				stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
				status,
				kill: () => finish({ success: false, code: 137, signal: 'SIGKILL' }),
			};
		},
	};
	return counted;
}

async function recorderRig(
	ownership: 'owner' | 'shared',
	subscribe?: (sessionId: string, onFrame: (jpeg: string) => void) => Promise<() => void>,
	extra: Pick<RecorderDeps, 'budget' | 'budgetCheckMs'> = {},
) {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'recorder-' });
	const encoder = countingEncoder();
	// Only what `start` reads: every session exists, and the ownership mode.
	const registry = { ownership, peek: () => ({}) } as unknown as SessionRegistry;
	const recorder = new Recorder({
		registry,
		subscribe: subscribe ?? ((_id, onFrame) => {
			queueMicrotask(() => onFrame(FRAME));
			return Promise.resolve(() => {});
		}),
		dir: `${dir}/recordings`,
		ffmpeg: 'not-ffmpeg',
		logger: createLogger({ level: 'error', write: () => {} }),
		spawn: encoder.spawn,
		...extra,
	});
	return {
		recorder,
		encoder,
		async [Symbol.asyncDispose]() {
			await recorder.stopAll();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

Deno.test('recorder: two concurrent starts on one session spawn one encoder; the other is refused', async () => {
	await using rig = await recorderRig('shared');
	const results = await Promise.allSettled([
		rig.recorder.start('s1', 'one'),
		rig.recorder.start('s1', 'two'),
	]);
	assertEquals(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
	const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
	assert(String(refused.reason).includes('already recording'), String(refused.reason));
	assertEquals(rig.encoder.spawned, 1, 'no orphaned encoder');
	assertEquals(rig.recorder.list().length, 1);
	await rig.recorder.stop('s1');
	assertEquals(rig.encoder.live, 0, 'every encoder that ran was stopped');
	// The reservation is released: the session can record again.
	await rig.recorder.start('s1', 'three');
	assertEquals(rig.encoder.spawned, 2);
});

Deno.test('recorder: in owner mode two owners racing for one free name: one wins, the other is refused', async () => {
	await using rig = await recorderRig('owner');
	const results = await Promise.allSettled([
		rig.recorder.start('s1', 'shared-name', 'api-key:alice'),
		rig.recorder.start('s2', 'shared-name', 'api-key:bob'),
	]);
	assertEquals(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
	const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
	assert(String(refused.reason).includes('is in use'), String(refused.reason));
	assertEquals(rig.encoder.spawned, 1);
});

Deno.test('recorder: a failed subscribe releases the reservation and leaves no encoder running', async () => {
	let fail = true;
	await using rig = await recorderRig('owner', (_id, onFrame) => {
		if (fail) return Promise.reject(new Error('no screencast'));
		queueMicrotask(() => onFrame(FRAME));
		return Promise.resolve(() => {});
	});
	await assertRejects(() => rig.recorder.start('s1', 'rec', 'api-key:alice'), Error, 'no screencast');
	assertEquals([rig.encoder.spawned, rig.encoder.live], [1, 0]);
	fail = false;
	// Neither the session nor the name stays reserved by the failed start.
	await rig.recorder.start('s1', 'rec', 'api-key:alice');
	assertEquals(rig.recorder.status('s1')?.name, 'rec');
});

Deno.test('recorder: a start is refused while the disk budget is spent, and spawns no encoder', async () => {
	let spent = true;
	await using rig = await recorderRig('shared', undefined, { budget: { exhausted: () => Promise.resolve(spent) } });
	const refused = await assertRejects(() => rig.recorder.start('s1', 'rec'), ToolError);
	assertEquals(refused.code, 'file-unavailable');
	assert(refused.message.includes('TTK_DISK_BUDGET_MB'), refused.message);
	assertEquals(rig.encoder.spawned, 0);
	// The reservation is released with the refusal: once there is room, the session records.
	spent = false;
	await rig.recorder.start('s1', 'rec');
	assertEquals(rig.encoder.spawned, 1);
});

Deno.test('recorder: a running recording is stopped and finalised once the disk budget is reached', async () => {
	let spent = false;
	let asked = 0;
	const budget = {
		exhausted: () => {
			asked += 1;
			return Promise.resolve(spent);
		},
	};
	// Checked on every repeater tick here; the production interval is a few seconds.
	await using rig = await recorderRig('shared', undefined, { budget, budgetCheckMs: 0 });
	await rig.recorder.start('s1', 'rec');
	const before = asked;
	spent = true;
	for (let waited = 0; rig.recorder.status('s1') !== null && waited < 5_000; waited += 50) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assertEquals(rig.recorder.status('s1'), null, 'the recording stopped');
	assert(asked > before, 'the budget was asked while recording');
	// Stopped through `stop`, which closes the encoder's stdin: nothing is left running.
	assertEquals(rig.encoder.live, 0);
});
