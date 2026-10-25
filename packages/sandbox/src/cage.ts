/**
 * One bubblewrap cage per command. `cageArgs` builds the command line (pure, so the tests can read
 * it); `runCage` starts it, feeds and drains it, and kills the whole cage on a time limit, a
 * cancelled request, or whatever else the caller watches for.
 *
 * What a cage is:
 *
 * - New user, pid, ipc, uts, mount, network and cgroup namespaces (`--unshare-all`), no
 *   capabilities, its own session, and it dies with the service (`--die-with-parent`).
 * - A root filesystem made of the image's `/usr` (read-only), the few files under `/etc` that
 *   programs need to run and to trust certificates, a fresh `/proc`, a minimal `/dev`, and the
 *   mounts the caller names. The root itself is then made read-only. Nothing else of the container
 *   is there: not `/work` beyond the run's own folders, not `/run`, not the service's files.
 * - An environment that starts empty (`--clearenv`) and gets a fixed set of variables.
 * - Only a loopback interface. The one way out is the registry proxy's socket, when it is asked for.
 * - A seccomp filter against new user namespaces (see filter.ts), and a limit on processes.
 * - The command runs as the cage's second process under bubblewrap's own init; when it exits, the
 *   namespace goes and takes anything it left running with it.
 *
 * bubblewrap itself is started with an empty environment: its init process inside the cage keeps
 * the environment it was started with, and a command can read that from /proc/1/environ.
 */
import { OutputCapture } from './output.ts';

export const WORKSPACE = '/workspace';
export const CAGE_HOME = '/home/sandbox';
export const PROXY_SOCKET = '/run/harbour/proxy.sock';
export const PROXY_PORT = 3128;
/** Where a command's standard input waits for it, inside the run's /tmp. */
export const STDIN_FILE = '/tmp/.harbour-stdin';
/**
 * D-076: the file a live session's shell reads its input from, inside the session's own /tmp. The service
 * appends to it; `tail -f` inside the cage feeds the shell. A plain file rather than a FIFO so the service
 * needs no extra executable grant and the cage no device: what the shell has consumed stays on the volume
 * until the session's tmp is removed with it.
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

/**
 * Files from the image a cage sees, read-only, when they exist: certificates, the library cache,
 * the alternatives links behind commands such as `awk`, and the tables that name services and
 * protocols. Everything else of the image's /etc stays out.
 */
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
	/**
	 * D-076: a live session. The shell reads SESSION_INPUT (a file in the session's /tmp the service appends to)
	 * through `tail -f`, and stays until the cage is stopped rather than running one command line.
	 */
	interactive?: boolean;
	/** Install the user namespace filter, which bubblewrap then reads from its standard input. */
	filter: boolean;
	/** The most processes and threads the cage may hold. */
	processes: number;
	/**
	 * Capabilities the cage keeps, inside its own user namespace only: SB-1 gives the measuring cage
	 * CAP_DAC_READ_SEARCH, so a directory a command locked (chmod 000) is still counted. It applies
	 * to files the service's own user owns; the image's root-owned files stay as unreadable as ever.
	 */
	caps?: string[];
	/**
	 * SB-7: no process in the cage may write file data (`ulimit -f 0`, which it cannot raise): a run
	 * over its budget may still remove, move and truncate files, and nothing else.
	 */
	noGrowth?: boolean;
}

/** Where the image keeps the cage's /etc files. */
export interface System {
	etc: string;
	/** Which of PROC_HIDDEN this kernel has: the paths each cage's /proc hides again. */
	proc: { files: string[]; dirs: string[]; readOnly: string[] };
}

/**
 * What Docker hides in a container's /proc (moby's default masked and read-only paths), hidden
 * again in every cage.
 *
 * The sandbox container runs without Docker's masks (systempaths=unconfined in the compose file):
 * the kernel lets bubblewrap mount a fresh /proc for a cage only where the container's own /proc is
 * fully visible, and with the masks in place every cage failed with "Can't mount proc". So each cage
 * puts them back over its own /proc: files under /dev/null (which a cage cannot even open, since
 * bubblewrap mounts it without device access, where Docker's read as empty), directories under an
 * empty read-only tmpfs, and the kernel's tunables read-only. Only the paths this kernel has, found
 * at start-up, since bubblewrap cannot mount over a path that is not there (/proc/sched_debug left
 * for debugfs in Linux 5.13, /proc/timer_stats is long gone).
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
 * Which PROC_HIDDEN paths this kernel has, asked of bubblewrap: Deno will not so much as stat a
 * path under /proc without --allow-all. The probe gets a fresh /proc the way a cage does, and runs
 * nothing but the shell's `test -e` in it. Throws when bubblewrap fails, with what it said.
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
 * The shell that runs first in every cage: it announces the cage, puts stderr with stdout so the
 * reply keeps their order, makes the cage the out-of-memory killer's first choice (so a runaway
 * test is what dies, not the service), limits processes, starts the proxy forwarder when there is
 * one, and then becomes the command.
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
		// SB-7: XFSZ ignored (and so for everything the command starts), a write past the limit fails
		// with "File too large" rather than killing the shell; no core file is written either.
		lines.push(`trap '' XFSZ`, 'ulimit -c 0', 'ulimit -f 0');
	}
	// A session's shell reads what the service appends to the input file, line by line, for as long as the cage
	// lives; without a terminal it prints no prompt of its own, which suits a reader that marks its own turns.
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
