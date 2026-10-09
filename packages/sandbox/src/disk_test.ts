import { assert, assertEquals, assertRejects } from '@std/assert';
import { type DiskWatchDeps, DiskWatches, treeUsage, type WatchSpec } from './disk.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A volume whose free space and whose run's measured size the test sets by hand. */
function volume(over: Partial<DiskWatchDeps> = {}) {
	const state = { free: 100 * GiB, used: 10 * MiB, measured: 0, measuring: null as Promise<void> | null };
	const deps: DiskWatchDeps = {
		free: () => Promise.resolve(state.free),
		minFreeBytes: GiB,
		noiseBytes: 64 * MiB,
		triggerBytes: MiB,
		...over,
	};
	const spec = (limit: number, over: Partial<WatchSpec> = {}): WatchSpec => ({
		before: state.used,
		limit,
		measure: async () => {
			state.measured++;
			await state.measuring;
			return state.used;
		},
		...over,
	});
	return { state, watches: new DiskWatches(deps), spec };
}

/** Checks until a measurement the last check started has finished, as the poll loop would. */
async function settle(check: () => Promise<string | null>): Promise<string | null> {
	await check();
	await tick();
	return await check();
}

Deno.test('SB-1 disk: a cage alone that writes past its allowance is stopped without waiting for du', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(100 * MiB));
	state.free -= 80 * MiB;
	assertEquals(await settle(() => watch.check()), null);
	// What du sees (here: nothing, as with a locked directory) does not matter: the volume says it.
	state.free -= 100 * MiB;
	assertEquals(await watch.check(), 'disk');
	assertEquals(watch.verdict, 'budget');
	await watch.end();
	assertEquals(watches.active, 0);
});

Deno.test('SB-1 disk: past the allowance the files are measured, and a run past its limit is stopped', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(100 * MiB));
	state.free -= 95 * MiB;
	state.used += 95 * MiB;
	assertEquals(await settle(() => watch.check()), 'disk');
	assertEquals(state.measured, 1);
	await watch.end();
});

Deno.test('SB-1 disk: a measurement that finds the run within its limit moves the baseline on', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(100 * MiB));
	// The volume lost 95 MiB; du finds 60 MiB of it in the run, within its limit, and the rest is
	// other writers' share.
	state.free -= 95 * MiB;
	state.used += 60 * MiB;
	assertEquals(await settle(() => watch.check()), null);
	assertEquals(state.measured, 1);
	// No new measurement until the volume falls past what is left (30 MiB) again.
	state.free -= 20 * MiB;
	assertEquals(await settle(() => watch.check()), null);
	assertEquals(state.measured, 1);
	await watch.end();
});

Deno.test('SB-1 disk: alone, loss du cannot explain (deleted files held open) stops the cage', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(1000 * MiB));
	// Within the allowance, but du finds the run's files unchanged while the volume lost 995 MiB.
	state.free -= 995 * MiB;
	assertEquals(await settle(() => watch.check()), 'disk');
	await watch.end();
});

Deno.test('SB-1 disk: two cages at once are each held to what du says, never charged with the other', async () => {
	const { state, watches, spec } = volume();
	const busy = await watches.start(spec(1000 * MiB));
	const quiet = await watches.start(spec(20 * MiB));
	assertEquals([busy.shared, quiet.shared], [true, true]);
	// The busy cage writes 500 MiB, visible to du; the quiet one's files do not grow.
	state.free -= 500 * MiB;
	assertEquals(await settle(() => quiet.check()), null);
	state.used += 500 * MiB;
	assertEquals(await settle(() => busy.check()), null);
	await quiet.end();
	await busy.end();
	// A cage that starts after both ended has the volume to itself again.
	const alone = await watches.start(spec(1000 * MiB));
	assertEquals(alone.shared, false);
	await alone.end();
});

Deno.test('SB-1 disk: the free-space floor stops a cage whoever fills the disk', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(100 * MiB));
	state.free = GiB - 1;
	assertEquals(await watch.check(), 'disk');
	assertEquals(watch.verdict, 'floor');
	await watch.end();
});

Deno.test('SB-1 disk: a run that cannot be measured once it outgrew its allowance is stopped', async () => {
	const { state, watches, spec } = volume();
	const watch = await watches.start(spec(100 * MiB, { measure: () => Promise.reject(new Error('du failed')) }));
	state.free -= 95 * MiB;
	assertEquals(await settle(() => watch.check()), 'disk');
	await watch.end();
});

Deno.test('SB-1 disk: the floor is still read while a slow measurement runs, and end() stops it', async () => {
	const { state, watches, spec } = volume();
	let release!: () => void;
	state.measuring = new Promise((resolve) => release = resolve);
	let aborted = false;
	const watch = await watches.start(spec(100 * MiB, {
		measure: async (signal) => {
			signal.addEventListener('abort', () => aborted = true);
			await state.measuring;
			return state.used;
		},
	}));
	state.free -= 95 * MiB;
	assertEquals(await watch.check(), null);
	state.free = GiB / 2;
	assertEquals(await watch.check(), 'disk');
	const ending = watch.end();
	assertEquals(aborted, true);
	release();
	await ending;
});

Deno.test('SB-7 disk: a run over its budget, watched with no room at all, is stopped as it grows', async () => {
	const { state, watches, spec } = volume();
	state.used = 500 * MiB;
	// Cleanup mode: the limit is what the run already has.
	const watch = await watches.start(spec(state.used));
	state.free += 300 * MiB;
	state.used -= 300 * MiB;
	assertEquals(await settle(() => watch.check()), null);
	assertEquals(state.measured, 0);
	state.free -= 302 * MiB;
	state.used += 302 * MiB;
	assertEquals(await settle(() => watch.check()), 'disk');
	await watch.end();
});

// --- treeUsage: the Docker backend's measurer (review R2-2) -------------------------------------------------------

const posix = Deno.build.os !== 'windows';

async function tree(): Promise<{ root: string; done: () => Promise<void> }> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'usage-' });
	return { root, done: () => Deno.remove(root, { recursive: true }).catch(() => {}) };
}

/** What the walk should find for one file: its allocated blocks where the platform has them, else its size. */
async function allocated(path: string): Promise<number> {
	const info = await Deno.lstat(path);
	return info.blocks !== null ? info.blocks * 512 : info.size;
}

Deno.test('R2-2 usage: every entry of every root counts once; a missing root counts nothing; links are not followed', async () => {
	const { root, done } = await tree();
	try {
		await Deno.mkdir(`${root}/work/a/b`, { recursive: true });
		await Deno.mkdir(`${root}/home`);
		await Deno.mkdir(`${root}/outside`);
		await Deno.writeFile(`${root}/work/a/b/one.bin`, new Uint8Array(40_000).fill(1));
		await Deno.writeFile(`${root}/home/two.bin`, new Uint8Array(70_000).fill(2));
		await Deno.writeFile(`${root}/outside/big.bin`, new Uint8Array(500_000).fill(3));
		let expected = 0;
		for (const path of ['work', 'work/a', 'work/a/b', 'work/a/b/one.bin', 'home', 'home/two.bin']) {
			expected += await allocated(`${root}/${path}`);
		}
		if (posix) {
			// A link into a folder outside counts as the link itself, never as what it points at.
			await Deno.symlink(`${root}/outside`, `${root}/work/escape`);
			expected += await allocated(`${root}/work/escape`);
			// A hard link is the same file: counted once, as du does.
			await Deno.link(`${root}/home/two.bin`, `${root}/work/a/again.bin`);
		}
		const roots = [`${root}/work`, `${root}/home`, `${root}/nowhere`];
		assertEquals(await treeUsage(roots, { timeoutMs: 10_000 }), expected);
		assert(expected >= 110_000 && expected < 500_000, String(expected));
	} finally {
		await done();
	}
});

Deno.test({
	name: 'R2-2 usage: a directory a command locked is opened and counted, never skipped',
	ignore: !posix,
	fn: async () => {
		const { root, done } = await tree();
		try {
			await Deno.mkdir(`${root}/work/locked`, { recursive: true });
			await Deno.writeFile(`${root}/work/locked/blob.bin`, new Uint8Array(300_000).fill(4));
			const blob = await allocated(`${root}/work/locked/blob.bin`);
			await Deno.chmod(`${root}/work/locked`, 0o000);
			// Without repair the walk cannot read it, and fails rather than answer without it (unless the test runs with
			// the right to read anything anyway, as root does).
			const privileged = await (async () => {
				for await (const _ of Deno.readDir(`${root}/work/locked`)) return true;
				return true;
			})().catch(() => false);
			if (!privileged) {
				await assertRejects(() => treeUsage([`${root}/work`], { timeoutMs: 10_000 }), Deno.errors.PermissionDenied);
			}
			const total = await treeUsage([`${root}/work`], { timeoutMs: 10_000, repair: true });
			assert(total >= blob, `${total} < ${blob}`);
			assertEquals((await Deno.lstat(`${root}/work/locked`)).mode! & 0o500, 0o500);
		} finally {
			await Deno.chmod(`${root}/work/locked`, 0o700).catch(() => {});
			await done();
		}
	},
});

Deno.test('R2-2 usage: a walk past its deadline, or cancelled, fails instead of answering with what it saw', async () => {
	const { root, done } = await tree();
	try {
		for (let i = 0; i < 3; i++) await Deno.mkdir(`${root}/work/d${i}`, { recursive: true });
		await assertRejects(() => treeUsage([`${root}/work`], { timeoutMs: -1 }), Error, 'ran out of time');
		await assertRejects(
			() => treeUsage([`${root}/work`], { timeoutMs: 10_000, signal: AbortSignal.abort() }),
			DOMException,
		);
	} finally {
		await done();
	}
});
