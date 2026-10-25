/**
 * `setup`'s `apparmor` unit: the coding sandbox's AppArmor profile, `docker/apparmor-sandbox` (the file explains the
 * profile itself), installed and loaded on a host that runs AppArmor.
 *
 * Docker's default AppArmor profile denies every mount, and bubblewrap builds each cage's root with mounts, so on an
 * AppArmor host (Ubuntu, Debian, SUSE) `tykotech-sandbox` must be loaded before `docker compose up`: until it is,
 * Docker refuses the sandbox's container ("unable to apply apparmor profile") and the gateway, which waits for the
 * sandbox, never starts. Loading a profile takes root, so `setup` runs two fixed commands through sudo, on the terminal
 * (where sudo asks for the password), and only when the installed copy differs from the checkout's or the kernel has
 * none loaded. On a host without AppArmor Docker ignores the option, and nothing is done.
 *
 * The host is asked through AppArmor's own unprivileged tools, not read from securityfs: Deno refuses every path under
 * /sys to anything short of `--allow-all`, whatever `--allow-read` names.
 */

/** The profile in the checkout, the name `docker-compose.yml` asks for, and where the host keeps it (boot loads it). */
export const SANDBOX_PROFILE = {
	source: 'docker/apparmor-sandbox',
	name: 'tykotech-sandbox',
	target: '/etc/apparmor.d/tykotech-sandbox',
} as const;

/** sudo by absolute path: the `setup` task grants `--allow-run` on exactly this. */
export const SUDO = '/usr/bin/sudo';

/**
 * AppArmor's tools, from the `apparmor` package that also holds `apparmor_parser` (Docker's packages recommend it, and
 * Docker needs the parser to load its own profile): `aa-enabled` is Docker's test, the module enabled and securityfs
 * mounted; `aa-exec -p <name>` starts a program under a profile, which only a loaded profile allows.
 */
const AA_ENABLED = '/usr/bin/aa-enabled';
const AA_EXEC = '/usr/bin/aa-exec';

/** What {@linkcode systemAppArmor} reads and runs: the `setup` task's grants beside the checkout. */
export const APPARMOR_GRANTS = { read: [SANDBOX_PROFILE.target], run: [AA_ENABLED, AA_EXEC, SUDO] } as const;

/** What the installer needs of the host. The unit tests stand in for it; {@linkcode systemAppArmor} is the real one. */
export interface AppArmorHost {
	/** Whether the kernel enforces AppArmor, by Docker's test, so the profile is needed exactly where Docker applies it. */
	enabled(): Promise<boolean>;
	/** The installed profile's text; `null` when there is none. */
	installed(): Promise<string | null>;
	/** Whether the kernel has the profile loaded; `null` when this account cannot tell. */
	loaded(): Promise<boolean | null>;
	/** Runs `argv` as root through sudo on this terminal: `null` when it succeeded, else why it did not. */
	sudo(argv: readonly string[]): Promise<string | null>;
}

/** What the unit did. */
export type ProfileOutcome =
	| { status: 'no-apparmor' }
	| { status: 'current' }
	| { status: 'installed' }
	| { status: 'failed'; reason: string };

/** The two commands that install the profile at `source` (an absolute path) and load it, as root. */
export function profileCommands(source: string): [install: string[], load: string[]] {
	return [
		['install', '-m', '0644', source, SANDBOX_PROFILE.target],
		['apparmor_parser', '-r', SANDBOX_PROFILE.target],
	];
}

/** `argv` as one line a POSIX shell reads back as the same words, for the commands `setup` prints to run by hand. */
export function shellLine(argv: readonly string[]): string {
	return argv.map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
}

/**
 * Installs and loads the profile at `source` when this host runs AppArmor and does not have it current; `force`
 * installs and loads it regardless. `announce` is told before sudo runs, since sudo may stop to ask for a password.
 * Never throws: every failure is a `failed` outcome, which `setup` turns into the manual commands.
 */
export async function ensureSandboxProfile(
	source: string,
	host: AppArmorHost,
	options: { force: boolean; announce: (line: string) => void },
): Promise<ProfileOutcome> {
	try {
		if (!await host.enabled()) return { status: 'no-apparmor' };
		let text: string;
		try {
			text = await Deno.readTextFile(source);
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) return { status: 'failed', reason: `${source} is missing` };
			throw cause;
		}
		const copy = options.force || await host.installed() !== text;
		// A copy that cannot be seen loaded (`null`) is taken as loaded: boot loads every profile in /etc/apparmor.d.
		if (!copy && await host.loaded() !== false) return { status: 'current' };
		options.announce(
			`this host runs AppArmor: ${copy ? 'installing' : 'loading'} the sandbox's profile ${SANDBOX_PROFILE.target} ` +
				'through sudo, which may ask for your password',
		);
		const [install, load] = profileCommands(source);
		for (const argv of copy ? [install, load] : [load]) {
			const failed = await host.sudo(argv);
			if (failed !== null) return { status: 'failed', reason: failed };
		}
		if (await host.loaded() === false) {
			return { status: 'failed', reason: `the kernel does not list ${SANDBOX_PROFILE.name} after loading it` };
		}
		return { status: 'installed' };
	} catch (cause) {
		return { status: 'failed', reason: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** The exit code of `program` run silently, or `null` when it is not installed. */
async function exitCode(program: string, args: string[]): Promise<number | null> {
	try {
		const { code } = await new Deno.Command(program, { args, stdin: 'null', stdout: 'null', stderr: 'null' }).output();
		return code;
	} catch (cause) {
		if (cause instanceof Deno.errors.NotFound) return null;
		throw cause;
	}
}

/** The real host, reading and running only what {@linkcode APPARMOR_GRANTS} names. */
export const systemAppArmor: AppArmorHost = {
	async enabled() {
		// Without the tool there is no apparmor_parser either, so Docker cannot load a profile and applies none.
		return Deno.build.os === 'linux' && await exitCode(AA_ENABLED, ['--quiet']) === 0;
	},
	async installed() {
		try {
			return await Deno.readTextFile(SANDBOX_PROFILE.target);
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) return null;
			throw cause;
		}
	},
	async loaded() {
		// `true` does nothing under the profile, which its `file` rule allows; aa-exec refuses a profile not loaded.
		const code = await exitCode(AA_EXEC, ['-p', SANDBOX_PROFILE.name, '--', 'true']);
		return code === null ? null : code === 0;
	},
	async sudo(argv) {
		try {
			const child = new Deno.Command(SUDO, { args: [...argv], stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
			const { code } = await child.spawn().status;
			return code === 0 ? null : `sudo ${argv[0]} exited with ${code}`;
		} catch (cause) {
			if (cause instanceof Deno.errors.NotFound) return `${SUDO} is not installed`;
			if (cause instanceof Deno.errors.NotCapable) return `this run may not start ${SUDO} (deno task setup grants it)`;
			throw cause;
		}
	},
};
