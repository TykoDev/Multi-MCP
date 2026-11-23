/**
 * One bubblewrap cage per command: `cageArgs` builds the command line (pure), `runCage` runs it and kills the whole
 * cage on a time limit, a cancel or a watchdog. A cage has every namespace new (`--unshare-all`), no capabilities,
 * its own session, dies with the service, a read-only root of `/usr`, a few `/etc` files, a fresh `/proc`, a minimal
 * `/dev` and only the mounts named; an empty environment plus a fixed set; loopback only (the proxy socket when asked
 * for); a seccomp filter against new user namespaces; a process limit. bwrap itself starts with an empty
 * environment too: its init keeps it, readable from /proc/1/environ.
 */
import { OutputCapture } from './output.ts';

export const WORKSPACE = '/workspace';
export const CAGE_HOME = '/home/sandbox';
export const PROXY_SOCKET = '/run/harbour/proxy.sock';
export const PROXY_PORT = 3128;
/** Where a command's standard input waits for it, inside the run's /tmp. */
export const STDIN_FILE = '/tmp/.harbour-stdin';
/**
 * A live session's input, in its own /tmp: the service appends, `tail -f` feeds the shell. A plain file, not a
 * FIFO, so neither the service nor the cage needs anything more.
 */
export const SESSION_INPUT = '/tmp/.harbour-session-input';
/** What the prelude says on stderr once the cage exists; its absence means bubblewrap failed. */
export const READY = 'harbour-cage-ready';

/** Every cage gets these; a request's own variables are added on top (see RESERVED_ENV). */
export const BASE_ENV: Readonly<Record<string, string>> = {
	PATH: '/usr/local/bin:/usr/bin:/bin',
	HOME: CAGE_HOME,
	USER: 'sandbox',
	LOGNAME: 'sandbox',
	SHELL: '/bin/sh',
	TMPDIR: '/tmp',
	LANG: 'C.UTF-8',
	TERM: 'dumb',
	CI: '1',
	NO_COLOR: '1',
	FORCE_COLOR: '0',
	DENO_NO_UPDATE_CHECK: '1',
	DENO_NO_PROMPT: '1',
	PIP_DISABLE_PIP_VERSION_CHECK: '1',
	PIP_NO_INPUT: '1',
	// /usr is read-only in a cage, so pip's guard for the system's own packages has nothing to guard;
	// without this `pip install` refuses even the per-user install it falls back to.
	PIP_BREAK_SYSTEM_PACKAGES: '1',
	// Keeps __pycache__ out of the checkout, and so out of the diff.
	PYTHONDONTWRITEBYTECODE: '1',
	npm_config_update_notifier: 'false',
	npm_config_fund: 'false',
	COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};

/** How programs find the registry proxy: every spelling the common package managers read. */
export function proxyEnv(): Record<string, string> {
	const url = `http://127.0.0.1:${PROXY_PORT}`;
	// Tests that start a server of their own talk to it directly, not through the proxy.
	const direct = 'localhost,127.0.0.1,::1';
	return {
		HTTPS_PROXY: url,
		https_proxy: url,
		HTTP_PROXY: url,
		http_proxy: url,
		NO_PROXY: direct,
		no_proxy: direct,
		npm_config_proxy: url,
		npm_config_https_proxy: url,
		npm_config_noproxy: direct,
		PIP_PROXY: url,
		CARGO_HTTP_PROXY: url,
		YARN_HTTP_PROXY: url,
		YARN_HTTPS_PROXY: url,
	};
}

/** The only image files under /etc a cage sees, read-only, when they exist. */
const SYSTEM_FILES = [
	'/etc/ssl',
	'/etc/ca-certificates',
	'/etc/alternatives',
	'/etc/ld.so.cache',
	'/etc/ld.so.conf',
	'/etc/ld.so.conf.d',
	'/etc/services',
	'/etc/protocols',
	'/etc/os-release',
];

/** The cage's own user, group, hosts and name service files, shipped in packages/sandbox/cage/etc. */
const CAGE_FILES = ['passwd', 'group', 'hosts', 'nsswitch.conf'];

export interface Mount {
	source: string;
	target: string;
	writable: boolean;
}

export interface CageSpec {
	/** Beyond the system's own mounts, in order: a mount inside another comes after it. */
	mounts: Mount[];
	/** The working directory inside the cage. */
	chdir: string;
	/** Added to BASE_ENV, and winning over it. */
	env: Record<string, string>;
	/** The shell command line the prelude hands over to. */
	command: string;
	/** Start the forwarder from 127.0.0.1:3128 to the proxy socket, which must be mounted. */
	proxy: boolean;
	/** The command reads STDIN_FILE, which the caller has written into the run's /tmp. */
	stdin: boolean;
	/** A live session: the shell reads SESSION_INPUT and stays until the cage is stopped. */
	interactive?: boolean;
	/** Install the user namespace filter, which bubblewrap then reads from its standard input. */
	filter: boolean;
	/** The most processes and threads the cage may hold. */
	processes: number;
	/**
	 * Capabilities kept inside the cage's own user namespace: the measuring cage's CAP_DAC_READ_SEARCH, so a locked
	 * directory is still counted (root-owned image files stay unreadable).
	 */
	caps?: string[];
	/** Over budget: `ulimit -f 0`, so the run may only remove, move and truncate files. */
	noGrowth?: boolean;
}

/** Where the image keeps the cage's /etc files. */
export interface System {
	etc: string;
	/** Which of PROC_HIDDEN this kernel has: the paths each cage's /proc hides again. */
	proc: { files: string[]; dirs: string[]; readOnly: string[] };
}

/**
 * Moby's default masked and read-only /proc paths, hidden again in every cage. The container runs with
 * systempaths=unconfined (bwrap cannot mount a fresh /proc under Docker's masks), so each cage puts them back: files
 * under /dev/null, directories under an empty read-only tmpfs, tunables read-only — only the paths this kernel has.
 */
export const PROC_HIDDEN = {
	files: [
		'/proc/interrupts',
		'/proc/kcore',
		'/proc/keys',
		'/proc/latency_stats',
		'/proc/timer_list',
		'/proc/timer_stats',
		'/proc/sched_debug',
	],
	dirs: ['/proc/acpi', '/proc/asound', '/proc/scsi'],
	readOnly: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
} as const;

/** The PROC_HIDDEN paths `exists` says this kernel has. */
export function presentProcPaths(exists: (path: string) => boolean): System['proc'] {
	return {
		files: PROC_HIDDEN.files.filter(exists),
		dirs: PROC_HIDDEN.dirs.filter(exists),
		readOnly: PROC_HIDDEN.readOnly.filter(exists),
	};
}

/**
 * Which PROC_HIDDEN paths this kernel has, asked of bubblewrap (Deno will not stat under /proc without
 * --allow-all). Throws with what bubblewrap said when it fails.
 */
export async function probeProcPaths(bwrap: string): Promise<System['proc']> {
	const all = [...PROC_HIDDEN.files, ...PROC_HIDDEN.dirs, ...PROC_HIDDEN.readOnly];
	const out = await new Deno.Command(bwrap, {
		args: [
			'--unshare-all',
			'--die-with-parent',
			'--cap-drop',
			'ALL',
			'--clearenv',
			'--ro-bind',
			'/usr',
			'/usr',
			'--symlink',
			'usr/bin',
			'/bin',
			'--symlink',
			'usr/lib',
			'/lib',
			'--symlink',
			'usr/lib64',
			'/lib64',
			'--proc',
			'/proc',
			'--',
			'/bin/sh',
			'-c',
			'for p in "$@"; do if [ -e "$p" ]; then echo "$p"; fi; done',
			'harbour-sandbox',
			...all,
		],
		stdin: 'null',
		clearEnv: true,
		env: {},
	}).output();
	const said = new TextDecoder().decode(out.stderr).trim();
	if (!out.success) {
		// EACCES, not the EPERM a missing capability gives: the host's AppArmor, whose docker-default denies every mount.
		const hint = /Permission denied/.test(said)
			? ' (an AppArmor host runs the sandbox under docker/apparmor-sandbox, which deno task setup loads)'
			: '';
		throw new Error((said || `bubblewrap exited with ${out.code}`) + hint);
	}
	const present = new Set(new TextDecoder().decode(out.stdout).split('\n'));
	return presentProcPaths((path) => present.has(path));
}

/**
 * The shell that runs first in every cage: announces it, merges stderr into stdout, makes the cage the OOM
 * killer's first choice (not the service), limits processes, starts the proxy forwarder, then becomes the command.
 */
export function prelude(
	opts: { proxy: boolean; stdin: boolean; processes: number; noGrowth?: boolean; interactive?: boolean },
): string {
	const lines = [
		`echo ${READY} >&2`,
		opts.interactive ? 'exec 2>&1 </dev/null' : opts.stdin ? `exec 2>&1 <${STDIN_FILE}` : 'exec 2>&1 </dev/null',
		...(opts.stdin && !opts.interactive ? [`rm -f ${STDIN_FILE}`] : []),
		'echo 1000 >/proc/self/oom_score_adj',
		`ulimit -p ${opts.processes}`,
	];
	if (opts.proxy) {
		const port = PROXY_PORT.toString(16).toUpperCase().padStart(4, '0');
		lines.push(
			`socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${PROXY_SOCKET} </dev/null >/dev/null 2>&1 &`,
			// Waits until the forwarder listens, reading the kernel's socket table rather than
			// connecting, which would reach the proxy as an empty request.
			'n=0',
			`until grep -q '0100007F:${port} 00000000:0000 0A' /proc/net/tcp; do`,
			`  n=$((n + 1)); if [ "$n" -gt 500 ]; then echo 'harbour-sandbox: the registry proxy did not start'; exit 125; fi`,
			'  sleep 0.01',
			'done',
		);
	}
	if (opts.noGrowth) {
		// XFSZ ignored (and so for everything the command starts), a write past the limit fails
		// with "File too large" rather than killing the shell; no core file is written either.
		lines.push(`trap '' XFSZ`, 'ulimit -c 0', 'ulimit -f 0');
	}
	lines.push(
		opts.interactive ? `tail -n +1 -f -s 0.05 ${SESSION_INPUT} | /bin/sh -s` : `exec /bin/sh -c "$1"`,
	);
	return lines.join('\n');
}

export function cageArgs(spec: CageSpec, system: System): string[] {
	const args = [
		'--unshare-all',
		'--die-with-parent',
		'--new-session',
		'--cap-drop',
		'ALL',
		// After the drop: bubblewrap applies the two in order.
		...(spec.caps ?? []).flatMap((cap) => ['--cap-add', cap]),
		'--clearenv',
	];
	for (const [name, value] of Object.entries({ ...BASE_ENV, ...spec.env })) {
		args.push('--setenv', name, value);
	}
	args.push(
		'--ro-bind',
		'/usr',
		'/usr',
		'--symlink',
		'usr/bin',
		'/bin',
		'--symlink',
		'usr/sbin',
		'/sbin',
		'--symlink',
		'usr/lib',
		'/lib',
		'--symlink',
		'usr/lib64',
		'/lib64',
	);
	for (const path of SYSTEM_FILES) args.push('--ro-bind-try', path, path);
	for (const name of CAGE_FILES) args.push('--ro-bind', `${system.etc}/${name}`, `/etc/${name}`);
	// A /proc of the cage's own, with what Docker would hide hidden again (PROC_HIDDEN).
	args.push('--proc', '/proc');
	for (const path of system.proc.files) args.push('--ro-bind', '/dev/null', path);
	for (const path of system.proc.dirs) args.push('--tmpfs', path, '--remount-ro', path);
	for (const path of system.proc.readOnly) args.push('--ro-bind', path, path);
	// /dev gets the usual device nodes; shared memory is its own small tmpfs, and the rest of /dev
	// is then made read-only, so neither can be used to fill the container's memory.
	args.push(
		'--dev',
		'/dev',
		'--size',
		String(64 * 1024 * 1024),
		'--tmpfs',
		'/dev/shm',
		'--remount-ro',
		'/dev',
	);
	for (const m of spec.mounts) args.push(m.writable ? '--bind' : '--ro-bind', m.source, m.target);
	args.push('--remount-ro', '/', '--chdir', spec.chdir);
	if (spec.filter) args.push('--seccomp', '0');
	args.push('--', '/bin/sh', '-c', prelude(spec), 'harbour-sandbox', spec.command);
	return args;
}

export interface CageRun {
	bwrap: string;
	args: string[];
	/** What bubblewrap reads on its standard input: the filter, when there is one. */
	input: Uint8Array | null;
	timeoutMs: number;
	/** Aborted when the request is cancelled: the client went away, or the run was removed. */
	signal?: AbortSignal;
	/** Asked every `everyMs`; a reason it returns stops the cage. */
	watchdog?: { everyMs: number; check(): Promise<string | null> };
	/** Each piece of output as it arrives; returning false stops the cage. */
	onOutput(chunk: Uint8Array): boolean | void;
}

export interface CageResult {
	/** False when bubblewrap never got as far as starting the command. */
	started: boolean;
	/** The command's exit status; null when the sandbox stopped it. */
	exitCode: number | null;
	/** Why the sandbox stopped it: "timeout", "cancelled", or a reason from the watchdog. */
	killed: string | null;
	durationMs: number;
	/** What bubblewrap itself said, for the log and for a failed start. */
	diagnostics: string;
}

/** Most of bubblewrap's own stderr kept: its errors are one line. */
const DIAGNOSTICS_BYTES = 16 * 1024;
/** How long to wait for the pipes to close once the cage is gone. */
const DRAIN_GRACE_MS = 5_000;

export async function runCage(run: CageRun): Promise<CageResult> {
	const began = performance.now();
	const child = new Deno.Command(run.bwrap, {
		args: run.args,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped',
		clearEnv: true,
		env: {},
	}).spawn();

	let killed: string | null = null;
	const stop = (why: string) => {
		if (killed !== null) return;
		killed = why;
		try {
			// bubblewrap's child has SIGKILL as its parent-death signal, and when the cage's init dies
			// the kernel ends every process in its pid namespace.
			child.kill('SIGKILL');
		} catch {
			// Already gone.
		}
	};
	const timer = setTimeout(() => stop('timeout'), run.timeoutMs);
	const onAbort = () => stop('cancelled');
	run.signal?.addEventListener('abort', onAbort, { once: true });
	if (run.signal?.aborted) onAbort();
	let polling = false;
	const poll = run.watchdog
		? setInterval(() => {
			if (polling) return;
			polling = true;
			run.watchdog!.check().then((why) => why && stop(why)).catch(() => {}).finally(() => {
				polling = false;
			});
		}, run.watchdog.everyMs)
		: undefined;

	const feed = (async () => {
		const writer = child.stdin.getWriter();
		try {
			if (run.input) await writer.write(run.input);
			await writer.close();
		} catch {
			// bubblewrap exited before reading; its status says why.
		}
	})();
	const stdout = child.stdout.getReader();
	const out = (async () => {
		for (;;) {
			const { value, done } = await stdout.read();
			if (done) return;
			if (run.onOutput(value) === false) stop('output');
		}
	})().catch(() => {});
	const diagnostics = new OutputCapture(DIAGNOSTICS_BYTES);
	const stderr = child.stderr.getReader();
	const err = (async () => {
		for (;;) {
			const { value, done } = await stderr.read();
			if (done) return;
			diagnostics.push(value);
		}
	})().catch(() => {});

	const status = await child.status;
	clearTimeout(timer);
	if (poll !== undefined) clearInterval(poll);
	run.signal?.removeEventListener('abort', onAbort);
	let grace: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all([out, err, feed]),
		new Promise<void>((resolve) => grace = setTimeout(resolve, DRAIN_GRACE_MS)),
	]);
	clearTimeout(grace);
	await Promise.all([stdout.cancel().catch(() => {}), stderr.cancel().catch(() => {})]);

	const said = diagnostics.result().output;
	return {
		started: said.includes(READY),
		exitCode: killed === null ? status.code : null,
		killed,
		durationMs: Math.round(performance.now() - began),
		diagnostics: said.split('\n').filter((line) => line !== READY && line.trim() !== '').join(
			'\n',
		),
	};
}
