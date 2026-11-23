/**
 * One disk budget for the file share and the recordings, `TTK_DISK_BUDGET_MB` — parsed fail-fast, measured by a cached
 * bounded walk plus what this process admitted since, and enforced on every share write the library makes.
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { LibraryError, LibraryStore } from '@tykotech/mcp';
import { ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { DISK_BUDGET_CACHE_MS, DiskBudget } from './disk_budget.ts';

const MIB = 1024 * 1024;

async function scratch(): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	return await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'disk-budget-' });
}

/** A file of `bytes` logical size without writing them: the walk reads `lstat` sizes. */
async function sized(path: string, bytes: number): Promise<void> {
	const file = await Deno.open(path, { write: true, create: true });
	await file.truncate(bytes);
	file.close();
}

Deno.test('TTK_DISK_BUDGET_MB defaults to 2048 MiB, is read in MiB, and is bounded fail-fast', () => {
	const base = { TTK_HOST: '127.0.0.1' };
	assert((ENV_NAMES as readonly string[]).includes('TTK_DISK_BUDGET_MB'));
	assertEquals(loadConfig(base).limits.diskBudgetBytes, 2048 * MIB);
	assertEquals(loadConfig({ ...base, TTK_DISK_BUDGET_MB: ' ' }).limits.diskBudgetBytes, 2048 * MIB);
	assertEquals(loadConfig({ ...base, TTK_DISK_BUDGET_MB: '64' }).limits.diskBudgetBytes, 64 * MIB);
	assertEquals(loadConfig({ ...base, TTK_DISK_BUDGET_MB: '1048576' }).limits.diskBudgetBytes, 1_048_576 * MIB);
	for (const bad of ['63', '1048577', '0', '-1', '1.5', '2g', 'lots']) {
		assertThrows(() => loadConfig({ ...base, TTK_DISK_BUDGET_MB: bad }), ConfigError, 'TTK_DISK_BUDGET_MB');
	}
});

Deno.test('the budget counts both trees, refuses past the limit, and fails closed past its entry cap', async () => {
	const dir = await scratch();
	try {
		await Deno.mkdir(join(dir, 'share/sub'), { recursive: true });
		await Deno.mkdir(join(dir, 'recordings'));
		await sized(join(dir, 'share/sub/a.bin'), 3 * MIB);
		await sized(join(dir, 'recordings/r.webm'), 5 * MIB);
		const roots = [join(dir, 'share'), join(dir, 'recordings')];
		const budget = new DiskBudget({ limitBytes: 10 * MIB, roots });
		assertEquals(await budget.usage(), { bytes: 8 * MIB, capped: false });
		assertEquals(await budget.exhausted(), false);
		await budget.admit(2 * MIB, false); // exactly at the limit fits
		const refused = await assertRejects(() => budget.admit(2 * MIB + 1, false), LibraryError, 'disk budget of 10 MiB');
		assertEquals(refused.code, 'too-large');

		// A missing tree is empty, not an error.
		const empty = new DiskBudget({ limitBytes: MIB, roots: [join(dir, 'missing')] });
		assertEquals(await empty.usage(), { bytes: 0, capped: false });

		// Past the entry cap the walk is a floor, so nothing more is admitted and recording counts as spent.
		const capped = new DiskBudget({ limitBytes: 10 * MIB, roots, walkCap: 2 });
		await assertRejects(() => capped.admit(1, false), LibraryError, 'too many entries');
		assertEquals(await capped.exhausted(), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test({
	name: 'the walk neither follows nor counts a symbolic link',
	// `Deno.symlink` needs the unscoped read and write grants, and on Windows a privilege most accounts lack.
	ignore: Deno.permissions.querySync({ name: 'write' }).state !== 'granted' || Deno.build.os === 'windows',
	fn: async () => {
		const dir = await scratch();
		const outside = await scratch();
		try {
			await sized(join(outside, 'big.bin'), 4 * MIB);
			await Deno.writeTextFile(join(dir, 'own.txt'), 'ab');
			await Deno.symlink(await Deno.realPath(outside), join(dir, 'link'));
			assertEquals(await new DiskBudget({ limitBytes: MIB, roots: [dir] }).usage(), { bytes: 2, capped: false });
		} finally {
			await Deno.remove(dir, { recursive: true });
			await Deno.remove(outside, { recursive: true });
		}
	},
});

Deno.test('admitted bytes count until a walk sees them; the walk is cached between', async () => {
	const dir = await scratch();
	try {
		let clock = 0;
		const budget = new DiskBudget({ limitBytes: 4 * MIB, roots: [dir], now: () => clock });
		await budget.admit(3 * MIB, true);
		// Not yet on disk, and the cached walk says 0: the reservation alone keeps a burst under the limit.
		await assertRejects(() => budget.admit(2 * MIB, true), LibraryError);
		assertEquals((await budget.usage()).bytes, 3 * MIB);
		// The bytes land; within the cache window they are not counted twice.
		await sized(join(dir, 'landed.bin'), 3 * MIB);
		assertEquals((await budget.usage()).bytes, 3 * MIB);
		// The next walk sees the file and drops the reservation it covers.
		clock += DISK_BUDGET_CACHE_MS;
		assertEquals((await budget.usage()).bytes, 3 * MIB);
		await budget.admit(MIB, true);
		assertEquals(await budget.exhausted(), true, 'usage reaching the limit is spent');
		// A refused check never reserves.
		await assertRejects(() => budget.admit(1, true), LibraryError);
		assertEquals((await budget.usage()).bytes, 4 * MIB);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('every library write that adds bytes to the share is held to the budget', async () => {
	const dir = await scratch();
	try {
		const store = new LibraryStore({ dataDir: dir });
		await store.initialize();
		await Deno.mkdir(join(dir, 'recordings'));
		await sized(join(dir, 'recordings/old.webm'), MIB - 10);
		store.setWriteBudget(new DiskBudget({ limitBytes: MIB, roots: [store.share, join(dir, 'recordings')] }));

		// `file_write`'s path: the content counts whole.
		await store.writeBytes('fits.txt', new Uint8Array(4));
		await assertRejects(() => store.writeBytes('over.txt', new Uint8Array(16)), LibraryError, 'disk budget');
		await assertRejects(() => store.stat('over.txt'), LibraryError, 'no such path');

		// The streaming path (REST upload, `browser_save_to_share`): a declared length is checked up front...
		await assertRejects(() => store.uploadTarget('declared.bin', 64), LibraryError, 'disk budget');
		// ...and the real size before the rename, whatever was declared.
		const target = await store.uploadTarget('streamed.bin');
		await Deno.writeFile(target.temporary, new Uint8Array(32));
		await assertRejects(() => target.commit(), LibraryError, 'disk budget');
		await assertRejects(() => store.stat('streamed.bin'), LibraryError, 'no such path');
		await Deno.remove(target.temporary);

		// Directories add no bytes, and lifting the budget restores the per-call limits alone.
		await store.mkdir('folder');
		store.setWriteBudget(null);
		await store.writeBytes('over.txt', new Uint8Array(16));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
