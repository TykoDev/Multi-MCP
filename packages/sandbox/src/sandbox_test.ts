import { assertEquals, assertRejects } from '@std/assert';
import { GateError } from './gate.ts';
import { LIMITS } from './limits.ts';
import { Sandbox } from './sandbox.ts';

const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';

/**
 * A Sandbox whose cages are counted and never started: Deno.Command is replaced for the test, so
 * this runs on any machine, bubblewrap or not.
 */
async function counted(test: (sandbox: Sandbox, started: () => number, workDir: string) => Promise<void>) {
	const original = Object.getOwnPropertyDescriptor(Deno, 'Command')!;
	let started = 0;
	Object.defineProperty(Deno, 'Command', {
		configurable: true,
		value: class {
			constructor() {
				started++;
			}
			spawn(): never {
				throw new Error('no cages in this test');
			}
		},
	});
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const workDir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-unit-' });
	try {
		const sandbox = new Sandbox({
			workDir,
			runtimeDir: workDir,
			bwrap: '/usr/bin/bwrap',
			system: { etc: '/app/packages/sandbox/cage/etc', proc: { files: [], dirs: [], readOnly: [] } },
			filter: null,
		}, {
			log: () => {},
			proxy: { resolve: () => Promise.resolve([]), connect: () => Promise.reject(new Error('none')), log: () => {} },
			freeBytes: () => Promise.resolve(LIMITS.minFreeBytes * 100),
		});
		await test(sandbox, () => started, workDir);
	} finally {
		Object.defineProperty(Deno, 'Command', original);
		await Deno.remove(workDir, { recursive: true });
	}
}

Deno.test('SB-3 sandbox: health checks that arrive together share one probe cage, then its answer', async () => {
	await counted(async (sandbox, started) => {
		const answers = await Promise.all(Array.from({ length: 8 }, () => sandbox.health()));
		assertEquals(started(), 1);
		assertEquals(answers.every((answer) => answer.ok === false && answer.error !== null), true);
		await sandbox.health();
		assertEquals(started(), 1);
	});
});

Deno.test('SB-3 sandbox: a measurement for a request without a command slot waits for a housekeeping slot', async () => {
	await counted(async (sandbox, started, workDir) => {
		await Deno.mkdir(`${workDir}/${RUN}`);
		const held = await Promise.all(Array.from({ length: LIMITS.choreRunning }, () => sandbox.chores.enter()));
		const controller = new AbortController();
		const waiting = sandbox.diskUsage(RUN, controller.signal);
		const queued = sandbox.diskUsage(RUN);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assertEquals([sandbox.chores.waiting, started()], [2, 0]);
		// SB-10: one that is cancelled while it waits says so.
		controller.abort();
		const cancelled = await assertRejects(() => waiting, GateError);
		assertEquals(cancelled.code, 'cancelled');
		held[0]!();
		await assertRejects(() => queued);
		assertEquals(started(), 1);
		for (const release of held.slice(1)) release();
		assertEquals(sandbox.chores.running, 0);
	});
});
