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
	name: 'a token file: read once, then the service cannot read the file again, and keeps its folders',
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
 * An operator's own token path, in a process granted as a `command:` override would grant it — the image's secret
 * location still among the grants — reads the token once and gives up both read grants; the work folder stays.
 */
Deno.test({
	name: 'another token path: read once, then neither it nor the image default is readable; the folder stays',
	async fn() {
		const dir = await Deno.makeTempDir({ dir: Deno.env.get('TTK_SANDBOX_TEST_DIR') });
		try {
			const work = `${dir}/work`;
			const token = `${dir}/token`;
			const secret = `${dir}/secret`;
			await Deno.mkdir(work);
			await Deno.writeTextFile(token, `${'t'.repeat(64)}\n`);
			await Deno.writeTextFile(secret, `${'s'.repeat(64)}\n`);
			const probe = `${dir}/probe.ts`;
			const module = new URL('../../packages/sandbox/src/token.ts', import.meta.url).href;
			await Deno.writeTextFile(
				probe,
				`import { readServiceToken, releaseTokenGrant } from '${module}';\n` +
					'const [work, token, secret] = Deno.args;\n' +
					'const value = await readServiceToken(token, [work]);\n' +
					'await releaseTokenGrant(secret);\n' +
					"let read = 'read';\n" +
					"try { await Deno.readTextFile(token); } catch { read = 'refused'; }\n" +
					"let other = 'read';\n" +
					"try { await Deno.readTextFile(secret); } catch { other = 'refused'; }\n" +
					"const kept = (await Deno.permissions.query({ name: 'read', path: work })).state;\n" +
					'console.log(JSON.stringify({ length: value.length, read, other, kept }));\n',
			);
			const out = await new Deno.Command(Deno.execPath(), {
				args: [
					'run',
					'--no-prompt',
					'--no-config',
					`--allow-read=${work},${secret},${token}`,
					probe,
					work,
					token,
					secret,
				],
				clearEnv: true,
				env: { DENO_DIR: `${dir}/deno`, DENO_NO_UPDATE_CHECK: '1' },
			}).output();
			assert(out.success, new TextDecoder().decode(out.stderr));
			assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), {
				length: 64,
				read: 'refused',
				other: 'refused',
				kept: 'granted',
			});
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
});

/**
 * Loads the git remotes file in a process granted exactly `grants`, as the service's own CMD grants it,
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
	name:
		'the git remotes file: read once, then the service cannot read the file again, and no log line holds a credential',
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
