/**
 * stdio's file share is held to the same disk budget (`TTK_DISK_BUDGET_MB`) as the gateway's, the share and the
 * recordings together.
 */
import { assertEquals, assertRejects } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { LibraryError } from '@tykotech/mcp';
import { stdioLibrary } from './mod.ts';

async function scratch(): Promise<string> {
	const root = fromFileUrl(new URL('../../tests/.scratch/', import.meta.url));
	await Deno.mkdir(root, { recursive: true });
	return await Deno.makeTempDir({ dir: root, prefix: 'stdio-library-' });
}

Deno.test('stdio library: stdio has no share without a data directory', async () => {
	assertEquals(await stdioLibrary({ dataDir: null, limits: { diskBudgetBytes: 1024 } }), undefined);
});

Deno.test('stdio library: a stdio write past the disk budget is refused, recordings on the same volume counted', async () => {
	const dir = await scratch();
	try {
		await Deno.mkdir(`${dir}/recordings`);
		await Deno.writeFile(`${dir}/recordings/old.webm`, new Uint8Array(1000));
		const library = await stdioLibrary({ dataDir: dir, limits: { diskBudgetBytes: 1024 } });
		if (library === undefined) throw new Error('a data directory gives a share');
		await library.writeBytes('fits.txt', new Uint8Array(4));
		await assertRejects(() => library.writeBytes('over.txt', new Uint8Array(64)), LibraryError, 'disk budget');
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
