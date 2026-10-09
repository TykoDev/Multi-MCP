import { assert, assertEquals } from '@std/assert';
import { runCage } from '../../packages/sandbox/src/cage.ts';
Deno.test({
	name: 'cage: a time limit kills what is running and says so',
	async fn() {
		// Deno stands in for bubblewrap: the runner does not care what it starts.
		const result = await runCage({
			bwrap: Deno.execPath(),
			args: ['eval', "console.error('harbour-cage-ready'); setTimeout(() => {}, 60_000)"],
			input: null,
			timeoutMs: 300,
			onOutput: () => {},
		});
		assertEquals(result.killed, 'timeout');
		assertEquals(result.exitCode, null);
		assert(result.durationMs < 10_000, String(result.durationMs));
	},
});

Deno.test({
	name: 'cage: output is passed on as it comes, and stderr is only diagnostics',
	async fn() {
		let seen = '';
		const result = await runCage({
			bwrap: Deno.execPath(),
			args: ['eval', "console.error('harbour-cage-ready'); console.log('hello'); Deno.exit(3)"],
			input: new TextEncoder().encode('ignored'),
			timeoutMs: 30_000,
			onOutput: (chunk) => {
				seen += new TextDecoder().decode(chunk);
			},
		});
		assertEquals(seen, 'hello\n');
		assertEquals(result, { ...result, started: true, exitCode: 3, killed: null });
		assertEquals(result.diagnostics, '');
	},
});

Deno.test({
	name: 'cage: a runner that never announces the cage has not started it',
	async fn() {
		const result = await runCage({
			bwrap: Deno.execPath(),
			args: ['eval', "console.error('bwrap: Creating new namespace failed'); Deno.exit(1)"],
			input: null,
			timeoutMs: 30_000,
			onOutput: () => {},
		});
		assertEquals(result.started, false);
		assertEquals(result.diagnostics, 'bwrap: Creating new namespace failed');
	},
});

Deno.test({
	name: 'cage: a cancelled request stops the cage',
	async fn() {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const result = await runCage({
			bwrap: Deno.execPath(),
			args: ['eval', "console.error('harbour-cage-ready'); setTimeout(() => {}, 60_000)"],
			input: null,
			timeoutMs: 60_000,
			signal: controller.signal,
			onOutput: () => {},
		});
		assertEquals(result.killed, 'cancelled');
	},
});

/** Runs readServiceToken in a process granted exactly `grants`, as the service's own CMD is. */
async function readTokenIn(grants: string[], token: string, keep: string) {
	const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
	const probe = `${dir}/probe.ts`;
	const module = new URL('../../packages/sandbox/src/token.ts', import.meta.url).href;
	await Deno.writeTextFile(
		probe,
		`import { readServiceToken } from '${module}';\n` +
			'const [token, keep] = Deno.args;\n' +
			'const value = await readServiceToken(token, [keep]);\n' +
			"let again = 'read';\n" +
			"try { await Deno.readTextFile(token); } catch { again = 'refused'; }\n" +
			"const kept = (await Deno.permissions.query({ name: 'read', path: keep })).state;\n" +
			'console.log(JSON.stringify({ length: value.length, again, kept }));\n',
	);
	try {
		const out = await new Deno.Command(Deno.execPath(), {
			args: ['run', '--no-prompt', '--no-config', `--allow-read=${grants.join(',')}`, probe, token, keep],
			clearEnv: true,
			env: { DENO_DIR: `${dir}/deno`, DENO_NO_UPDATE_CHECK: '1' },
		}).output();
		return {
			ok: out.success,
			stdout: new TextDecoder().decode(out.stdout),
			stderr: new TextDecoder().decode(out.stderr),
		};
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test({
	name: 'SB-5 token: read once, then the service cannot read the file again, and keeps its folders',
	async fn() {
		const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		try {
			const work = `${dir}/work`;
			await Deno.mkdir(work);
			const token = `${dir}/token`;
			await Deno.writeTextFile(token, `${'t'.repeat(40)}\n`);
			// Granted on its own, as /run/secrets/ttk_sandbox_token is in the image's CMD.
			const own = await readTokenIn([work, token], token, work);
			assert(own.ok, own.stderr);
			assertEquals(JSON.parse(own.stdout), { length: 40, again: 'refused', kept: 'granted' });
			// Kept inside a granted folder, revoking it would cost the service that folder: refused.
			const inside = `${work}/token`;
			await Deno.writeTextFile(inside, `${'t'.repeat(40)}\n`);
			const nested = await readTokenIn([work], inside, work);
			assertEquals(nested.ok, false);
			assert(nested.stderr.includes('Grant read access to the sandbox token file on its own'), nested.stderr);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});

/**
 * D-151: the compose path, in a process granted as the image's CMD grants it — read and write on the work folder and
 * on the token volume's folder — creates the token, reads it once, and gives up both token grants.
 */
Deno.test({
	name: 'D-151 token: generated on the first start, read once, then neither readable nor writable; the folder stays',
	async fn() {
		const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		try {
			const work = `${dir}/work`;
			const volume = `${dir}/volume`;
			const secret = `${dir}/secret`;
			await Deno.mkdir(work);
			await Deno.mkdir(volume, { mode: 0o700 });
			const probe = `${dir}/probe.ts`;
			const module = new URL('../../packages/sandbox/src/token.ts', import.meta.url).href;
			await Deno.writeTextFile(
				probe,
				`import { provisionServiceToken, readServiceToken, releaseTokenGrants } from '${module}';\n` +
					'const [work, volume, secret] = Deno.args;\n' +
					'const token = `${volume}/token`;\n' +
					'const created = await provisionServiceToken(token);\n' +
					'const value = await readServiceToken(token, [work]);\n' +
					'await releaseTokenGrants([work], { secretFile: secret, generatedDir: volume });\n' +
					"let read = 'read';\n" +
					"try { await Deno.readTextFile(token); } catch { read = 'refused'; }\n" +
					"let write = 'written';\n" +
					"try { await Deno.writeTextFile(token, 'x'); } catch { write = 'refused'; }\n" +
					"const kept = (await Deno.permissions.query({ name: 'write', path: work })).state;\n" +
					'console.log(JSON.stringify({ created, length: value.length, read, write, kept }));\n',
			);
			const runOnce = async () => {
				const out = await new Deno.Command(Deno.execPath(), {
					args: [
						'run',
						'--no-prompt',
						'--no-config',
						`--allow-read=${work},${secret},${volume}`,
						`--allow-write=${work},${volume}`,
						probe,
						work,
						volume,
						secret,
					],
					clearEnv: true,
					env: { DENO_DIR: `${dir}/deno`, DENO_NO_UPDATE_CHECK: '1' },
				}).output();
				assert(out.success, new TextDecoder().decode(out.stderr));
				return JSON.parse(new TextDecoder().decode(out.stdout));
			};
			assertEquals(await runOnce(), { created: true, length: 64, read: 'refused', write: 'refused', kept: 'granted' });
			const first = await Deno.readTextFile(`${volume}/token`);
			// A restart keeps the token the gateway already holds.
			assertEquals(await runOnce(), { created: false, length: 64, read: 'refused', write: 'refused', kept: 'granted' });
			assertEquals(await Deno.readTextFile(`${volume}/token`), first);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});

/**
 * R12 (D-132): loads the git remotes file in a process granted exactly `grants`, as the service's own CMD grants it,
 * then logs the credential through the service's logger, which must have been told to cut it out.
 */
async function loadRemotesIn(grants: string[], file: string, keep: string, token: string) {
	const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
	const probe = `${dir}/probe.ts`;
	const forwarder = new URL('../../packages/sandbox/src/git_forwarder.ts', import.meta.url).href;
	const logger = new URL('../../packages/sandbox/src/log.ts', import.meta.url).href;
	await Deno.writeTextFile(
		probe,
		`import { loadGitRemotes } from '${forwarder}';\n` +
			`import { log } from '${logger}';\n` +
			'const [file, keep, token] = Deno.args;\n' +
			'const remotes = await loadGitRemotes(file, [keep]);\n' +
			"let again = 'read';\n" +
			"try { await Deno.readTextFile(file); } catch { again = 'refused'; }\n" +
			"const kept = (await Deno.permissions.query({ name: 'read', path: keep })).state;\n" +
			"log('info', 'probe', { token, authorization: remotes[0].authorization, base: btoa('x-access-token:' + token) });\n" +
			'console.log(JSON.stringify({ ids: remotes.map((remote) => remote.id), again, kept }));\n',
	);
	try {
		const out = await new Deno.Command(Deno.execPath(), {
			args: ['run', '--no-prompt', '--no-config', `--allow-read=${grants.join(',')}`, probe, file, keep, token],
			clearEnv: true,
			env: { DENO_DIR: `${dir}/deno`, DENO_NO_UPDATE_CHECK: '1' },
		}).output();
		return {
			ok: out.success,
			stdout: new TextDecoder().decode(out.stdout),
			stderr: new TextDecoder().decode(out.stderr),
		};
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test({
	name: 'R12 remotes: read once, then the service cannot read the file again, and no log line holds a credential',
	async fn() {
		const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		try {
			const work = `${dir}/work`;
			await Deno.mkdir(work);
			const token = 'ghp_runner_tier_token_0123456789abcdef';
			const remotes = JSON.stringify([{ id: 'app', url: 'https://git.example.test/acme/app.git', token }]);
			const file = `${dir}/ttk_git_remotes`;
			await Deno.writeTextFile(file, remotes);
			// Granted on its own, as /run/secrets/ttk_git_remotes is in the image's CMD.
			const own = await loadRemotesIn([work, file], file, work, token);
			assert(own.ok, own.stderr);
			const lines = own.stdout.trim().split('\n');
			assertEquals(JSON.parse(lines.at(-1)!), { ids: ['app'], again: 'refused', kept: 'granted' });
			assert(!own.stdout.includes(token) && !own.stdout.includes(btoa(`x-access-token:${token}`)), own.stdout);
			assertEquals(JSON.parse(lines[0]!).token, '[redacted]');
			assertEquals(JSON.parse(lines[0]!).authorization, 'Basic [redacted]');
			// Kept inside a granted folder, revoking it would cost the service that folder: refused.
			const inside = `${work}/ttk_git_remotes`;
			await Deno.writeTextFile(inside, remotes);
			const nested = await loadRemotesIn([work], inside, work, token);
			assertEquals(nested.ok, false);
			assert(nested.stderr.includes('Grant read access to the git remotes file on its own'), nested.stderr);
			assert(!nested.stderr.includes(token), nested.stderr);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});
