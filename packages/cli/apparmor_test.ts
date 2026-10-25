/**
 * `setup`'s `apparmor` unit: the sandbox's AppArmor profile is installed and loaded through sudo exactly when the host
 * runs AppArmor and lacks it current, and every way that can fail is an outcome `setup` turns into manual commands.
 * The host is stood in for; nothing here runs sudo or reads /sys.
 */
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import {
	APPARMOR_GRANTS,
	type AppArmorHost,
	ensureSandboxProfile,
	profileCommands,
	SANDBOX_PROFILE,
	shellLine,
	SUDO,
} from './apparmor.ts';

const ROOT = new URL('../../', import.meta.url);

/** An AppArmor host kept in memory: its sudo "runs" `install` and `apparmor_parser` against it, or refuses. */
function host(start: { installed?: string | null; loaded?: boolean | null; refuse?: string } = {}) {
	const events: string[] = [];
	const calls: string[][] = [];
	let installed = start.installed ?? null;
	let loaded = start.loaded === undefined ? false : start.loaded; // `null` is a value here: "cannot tell"
	const fake: AppArmorHost = {
		enabled: () => Promise.resolve(true),
		installed: () => Promise.resolve(installed),
		loaded: () => Promise.resolve(loaded),
		async sudo(argv) {
			events.push(`sudo ${argv[0]}`);
			calls.push([...argv]);
			if (start.refuse !== undefined) return start.refuse;
			if (argv[0] === 'install') installed = await Deno.readTextFile(argv[3]!);
			if (argv[0] === 'apparmor_parser' && loaded !== null) loaded = true;
			return null;
		},
	};
	const announce = (line: string): void => void events.push(`announce ${line}`);
	return { fake, calls, events, announce };
}

/** A profile file in a scratch folder, removed after `body`. */
async function profile(body: (source: string) => Promise<void>, text = 'profile tykotech-sandbox {}\n'): Promise<void> {
	const scratch = fromFileUrl(new URL('tests/.scratch/', ROOT));
	await Deno.mkdir(scratch, { recursive: true });
	const dir = await Deno.makeTempDir({ dir: scratch, prefix: 'apparmor-' });
	try {
		await Deno.writeTextFile(`${dir}/apparmor-sandbox`, text);
		await body(`${dir}/apparmor-sandbox`);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test('apparmor: a host without AppArmor is left alone, and its profile is never read', async () => {
	const { fake, calls, events, announce } = host();
	fake.enabled = () => Promise.resolve(false);
	const outcome = await ensureSandboxProfile('/nonexistent/apparmor-sandbox', fake, { force: true, announce });
	assertEquals(outcome, { status: 'no-apparmor' });
	assertEquals([calls, events], [[], []]);
});

Deno.test('apparmor: a missing profile is installed and loaded through sudo, announced before sudo can prompt', async () => {
	await profile(async (source) => {
		const { fake, calls, events, announce } = host();
		assertEquals(await ensureSandboxProfile(source, fake, { force: false, announce }), { status: 'installed' });
		assertEquals(calls, profileCommands(source));
		assertEquals(calls, [
			['install', '-m', '0644', source, '/etc/apparmor.d/tykotech-sandbox'],
			['apparmor_parser', '-r', '/etc/apparmor.d/tykotech-sandbox'],
		]);
		assertEquals(events.map((event) => event.split(' ')[0]), ['announce', 'sudo', 'sudo']);
		assert(events[0]!.includes('password'), 'the announcement says sudo may ask for a password');
	});
});

Deno.test('apparmor: current needs nothing, unloaded is only loaded, stale is reinstalled, force does both', async () => {
	await profile(async (source) => {
		const text = await Deno.readTextFile(source);
		const run = async (start: Parameters<typeof host>[0], force = false) => {
			const { fake, calls, announce } = host(start);
			return { outcome: (await ensureSandboxProfile(source, fake, { force, announce })).status, calls };
		};
		assertEquals(await run({ installed: text, loaded: true }), { outcome: 'current', calls: [] });
		// Boot loads /etc/apparmor.d, so a copy whose load this account cannot see is taken as loaded.
		assertEquals(await run({ installed: text, loaded: null }), { outcome: 'current', calls: [] });
		assertEquals(await run({ installed: text, loaded: false }), {
			outcome: 'installed',
			calls: [profileCommands(source)[1]],
		});
		assertEquals(await run({ installed: 'profile old {}\n', loaded: true }), {
			outcome: 'installed',
			calls: profileCommands(source),
		});
		assertEquals(await run({ installed: text, loaded: true }, true), {
			outcome: 'installed',
			calls: profileCommands(source),
		});
	});
});

Deno.test('apparmor: a refusal, a missing source, a profile still not listed, or a read error is failed, not a throw', async () => {
	await profile(async (source) => {
		const refused = host({ refuse: 'sudo install exited with 1' });
		assertEquals(await ensureSandboxProfile(source, refused.fake, { force: false, announce: refused.announce }), {
			status: 'failed',
			reason: 'sudo install exited with 1',
		});
		assertEquals(refused.calls.length, 1, 'nothing runs after the first refusal');

		const missing = host();
		assertEquals(
			await ensureSandboxProfile(`${source}.gone`, missing.fake, { force: false, announce: missing.announce }),
			{ status: 'failed', reason: `${source}.gone is missing` },
		);

		const unlisted = host();
		unlisted.fake.sudo = () => Promise.resolve(null); // succeeds, yet the kernel never lists the profile
		const outcome = await ensureSandboxProfile(source, unlisted.fake, { force: false, announce: unlisted.announce });
		assertEquals(outcome.status, 'failed');

		const ungranted = host();
		ungranted.fake.enabled = () => Promise.reject(new Deno.errors.NotCapable('Requires read access'));
		assertEquals(
			await ensureSandboxProfile(source, ungranted.fake, { force: false, announce: ungranted.announce }),
			{ status: 'failed', reason: 'Requires read access' },
		);
	});
});

Deno.test('apparmor: the printed commands survive a checkout path with spaces or quotes', () => {
	assertEquals(shellLine(['install', '-m', '0644', '/srv/a b/x', '/etc/y']), "install -m 0644 '/srv/a b/x' /etc/y");
	assertEquals(shellLine(["/srv/it's"]), `'/srv/it'\\''s'`);
	assertEquals(shellLine(profileCommands('/srv/mcp')[1]), 'apparmor_parser -r /etc/apparmor.d/tykotech-sandbox');
});

Deno.test('apparmor: the setup task grants exactly what the real host reads and runs', async () => {
	const tasks = JSON.parse(await Deno.readTextFile(new URL('deno.json', ROOT))).tasks as Record<
		string,
		{ command: string }
	>;
	const command = tasks.setup!.command;
	assertEquals(/--allow-read=(\S+)/.exec(command)?.[1]?.split(','), ['.', ...APPARMOR_GRANTS.read]);
	assertEquals(/--allow-run=(\S+)/.exec(command)?.[1]?.split(','), [...APPARMOR_GRANTS.run]);
	assert(APPARMOR_GRANTS.run.includes(SUDO), 'sudo is among them, by the path the host runs');
	// Deno refuses /sys to anything short of --allow-all, so no grant may name it: the tools ask instead.
	assert(!command.includes('/sys/'), 'no securityfs grant');
});

Deno.test('apparmor: the profile setup installs is the one docker-compose.yml asks for', async () => {
	const text = await Deno.readTextFile(new URL(SANDBOX_PROFILE.source, ROOT));
	assert(text.includes(`\nprofile ${SANDBOX_PROFILE.name} flags=`), `${SANDBOX_PROFILE.source} declares the name`);
	const compose = await Deno.readTextFile(new URL('docker-compose.yml', ROOT));
	assert(compose.includes(`      - apparmor=${SANDBOX_PROFILE.name}\n`), 'the sandbox service asks for it');
	assertEquals(SANDBOX_PROFILE.target, `/etc/apparmor.d/${SANDBOX_PROFILE.name}`);
});
