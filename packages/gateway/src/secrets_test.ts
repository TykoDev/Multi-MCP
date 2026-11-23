/** The sandbox token is an ordinary secret file, read through the one reader every `*_FILE` uses. */
import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { join, resolve } from '@std/path';
import { ConfigError, loadConfig } from './config.ts';
import { resolveSecrets } from './secrets.ts';
import { scratch } from './support_test.ts';

Deno.test('secrets: the sandbox token is read from its file, one trailing newline stripped', async () => {
	const dir = await scratch('sandbox-token-');
	try {
		const token = join(dir, 'ttk_sandbox_token');
		// What `deno task setup` writes: 64 hex characters and one newline.
		await Deno.writeTextFile(token, `${'c'.repeat(64)}\n`);
		const resolved = await resolveSecrets({ env: { TTK_SANDBOX_TOKEN_FILE: token, TTK_ADMIN_USER: 'inline' } });
		assertEquals(resolved.TTK_SANDBOX_TOKEN, 'c'.repeat(64));
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('secrets: a TTK_DB_KEY_FILE inside TTK_DATA_DIR refuses startup, by any spelling; outside it is accepted', async () => {
	const dir = await scratch('db-key-place-');
	try {
		const data = join(dir, 'data');
		await Deno.mkdir(data);
		const inside = join(data, 'ttk_db_key');
		await Deno.writeTextFile(inside, 'k\n');
		const outside = join(dir, 'ttk_db_key');
		await Deno.writeTextFile(outside, 'k\n');
		for (
			const [dataDir, keyFile] of [
				[data, inside],
				[`${data}/`, inside],
				[data, join(data, 'sub', '..', 'ttk_db_key')],
				// A data directory that does not exist yet still contains what is spelled under it.
				[join(dir, 'later'), join(dir, 'later', 'k')],
			]
		) {
			const error = assertThrows(
				() => loadConfig({ TTK_DATA_DIR: dataDir!, TTK_DB_KEY_FILE: keyFile! }),
				ConfigError,
			);
			assertStringIncludes(error.message, 'TTK_DB_KEY_FILE');
			assertStringIncludes(error.message, 'inside TTK_DATA_DIR');
		}
		// A sibling whose name merely starts with the data directory's is not inside it.
		assertEquals(loadConfig({ TTK_DATA_DIR: data, TTK_DB_KEY_FILE: `${data}-keys/k` }).dataDir, data);
		assertEquals(loadConfig({ TTK_DATA_DIR: data, TTK_DB_KEY_FILE: outside }).dataDir, data);
		assertEquals(loadConfig({ TTK_DB_KEY_FILE: inside }).dataDir, null);

		// A link to the data directory hides nothing: the key's real path is compared.
		const alias = join(dir, 'alias');
		let linked = false;
		try {
			// An absolute target: a relative one resolves from the link's own folder and would dangle.
			await Deno.symlink(resolve(data), alias, { type: 'dir' });
			linked = true;
		} catch { /* no symlink privilege on this host */ }
		if (linked) {
			assertThrows(
				() => loadConfig({ TTK_DATA_DIR: data, TTK_DB_KEY_FILE: join(alias, 'ttk_db_key') }),
				ConfigError,
				'inside TTK_DATA_DIR',
			);
		}
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});
