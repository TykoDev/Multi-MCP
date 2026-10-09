/**
 * @module
 * Single-binary distribution (SPECS/ROADMAP.md R15).
 *
 * `deno compile` produces one executable with the runtime, the module graph and
 * the permission set baked in. That matters twice over here:
 *
 * - **for a local install**, an MCP host can point at one file instead of at a
 *   Deno installation plus a checkout plus a lockfile;
 * - **for the slim image** (R11), the runtime stage needs no Deno toolchain and
 *   no source tree at all, which is most of the surface the bundled image
 *   carries.
 *
 * ## Permissions are compiled in, so they are chosen here
 *
 * A compiled binary cannot be re-flagged at launch: whatever is passed here is
 * what it can do, forever. The matrix therefore matches
 * SPECS/ARCHITECTURE.md §9 exactly, with the same `--deny-ffi` first (a deny
 * outranks any later allow) and the same refusal to grant a bare `--allow-run`.
 * The Chromium path is the one variable a deployment genuinely changes, so it
 * is a compile-time argument rather than a wildcard grant.
 *
 * Usage:
 *   deno run -A scripts/compile.ts [--target <triple>] [--out dist] [--chromium <path>]
 *
 * Without `--chromium`, a Linux target bakes `/usr/bin/chromium` (the path the images install), a target for the
 * host's own OS bakes the browser this host's discovery finds, and any other target is refused with guidance — see
 * {@linkcode chromiumFor}.
 */
import { parseArgs } from '@std/cli/parse-args';
import { findBrowserExecutable } from '../packages/cdp/mod.ts';

/** Targets `deno compile` supports, for the matrix build. */
export const TARGETS = [
	'x86_64-unknown-linux-gnu',
	'aarch64-unknown-linux-gnu',
	'x86_64-pc-windows-msvc',
	'x86_64-apple-darwin',
	'aarch64-apple-darwin',
] as const;
export type Target = (typeof TARGETS)[number];

/** The binary's name for a target. */
export function binaryName(target: string | null): string {
	const suffix = target === null
		? (Deno.build.os === 'windows' ? '.exe' : '')
		: target.includes('windows')
		? '.exe'
		: '';
	return `tykotech-mcp${target === null ? '' : `-${target}`}${suffix}`;
}

/**
 * The compiled-in permission set.
 *
 * Deliberately the *server* matrix rather than a smaller stdio-only one: the
 * binary serves both `serve` and `stdio`, and a binary that could not run
 * `serve` would need a second build for no gain. Everything a deployment varies
 * — the bind address, the keys, the data directory — is configuration, not a
 * permission.
 *
 * D-143 / D-145: the bare `--allow-net` below also means the binary proves every model-provider host as reachable,
 * so `TTK_MODEL_PROVIDERS_FILE` is the only egress control for provider traffic on the slim image — the gateway
 * dials only the `base_url`s that file names (`redirect: 'error'`), where the bundled `CMD` lists an unelected host
 * as `reachable: false` and never dials it. `tests/container/verify_container.ts` asserts the two postures.
 */
export function permissions(chromium: string): string[] {
	return [
		// A deny outranks any later allow, and this process loads untrusted pages.
		'--deny-ffi',
		'--allow-net',
		// Never bare: the permission gate refuses `--allow-run` with no argument,
		// and a browser-driving server with unrestricted process spawning is the
		// exact shape of a sandbox escape.
		`--allow-run=${chromium},/usr/bin/ffmpeg`,
		'--allow-read',
		'--allow-write',
		'--allow-env',
		'--unstable-kv',
	];
}

/** The Chromium the Debian-based images install, and the default for every Linux target. */
export const LINUX_CHROMIUM = '/usr/bin/chromium';

/** The operating system a target triple runs — or the host's, for `null`. */
export function targetOs(target: string | null, host: string = Deno.build.os): 'linux' | 'windows' | 'darwin' {
	const os = target === null
		? host
		: target.includes('windows')
		? 'windows'
		: target.includes('apple')
		? 'darwin'
		: 'linux';
	return os === 'windows' || os === 'darwin' ? os : 'linux';
}

/**
 * The Chromium path to bake into `--allow-run` for one target.
 *
 * ERRATUM(E-82): the default used to be `/usr/bin/chromium` on every host, so `deno task compile` on Windows or macOS
 * produced a binary whose only run grant named a Linux path — it could never launch a browser, and nothing said so
 * until the first tool call. Now an explicit `--chromium` always wins; a Linux target keeps `/usr/bin/chromium`; a
 * target for the host's own OS takes the browser this host's discovery finds (the same `findBrowserExecutable` the
 * binary itself will run, so the grant and the spawn name the same file); and a foreign non-Linux target, whose
 * filesystem this host cannot see, is refused with the flag to pass.
 */
export async function chromiumFor(
	target: string | null,
	explicit: string | undefined,
	discover: () => Promise<string> = findBrowserExecutable,
	host: string = Deno.build.os,
): Promise<string> {
	if (explicit !== undefined && explicit !== '') return explicit;
	const os = targetOs(target, host);
	if (os === 'linux') return LINUX_CHROMIUM;
	const where = target ?? 'the host';
	if (os !== targetOs(null, host)) {
		throw new Error(
			`no Chromium path for ${where} (a ${os} target) can be found from this ${host} host; ` +
				`pass --chromium <absolute path of the browser on the target>`,
		);
	}
	try {
		return await discover();
	} catch (cause) {
		throw new Error(
			`no Chrome or Chromium found on this ${host} host to bake into ${where}'s --allow-run; install one, or pass ` +
				`--chromium <absolute path> (${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)})`,
		);
	}
}

export interface CompileOptions {
	readonly outDir: string;
	readonly target: Target | null;
	readonly chromium: string;
}

/** Compiles one binary. Returns its path. */
export async function compile(options: CompileOptions): Promise<string> {
	await Deno.mkdir(options.outDir, { recursive: true });
	const output = `${options.outDir}/${binaryName(options.target)}`;

	const args = [
		'compile',
		...permissions(options.chromium),
		// The SPA is read from disk at runtime, so it travels inside the binary.
		'--include',
		'packages/web/static',
		'--include',
		'packages/web/dist',
		'--output',
		output,
		...(options.target === null ? [] : ['--target', options.target]),
		'packages/cli/mod.ts',
	];

	const command = new Deno.Command(Deno.execPath(), { args, stdout: 'inherit', stderr: 'inherit' });
	const status = await command.output();
	if (!status.success) throw new Error(`deno compile failed for ${options.target ?? 'the host'}`);
	return output;
}

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		string: ['target', 'out', 'chromium'],
		boolean: ['all'],
		default: { out: 'dist' },
	});

	const targets: Array<Target | null> = args.all
		? [...TARGETS]
		: args.target === undefined
		? [null]
		: [args.target as Target];

	for (const target of targets) {
		if (target !== null && !(TARGETS as readonly string[]).includes(target)) {
			console.error(`unknown target ${target}; expected one of ${TARGETS.join(', ')}`);
			Deno.exit(1);
		}
		let chromium: string;
		try {
			chromium = await chromiumFor(target, args.chromium);
		} catch (cause) {
			console.error(cause instanceof Error ? cause.message : String(cause));
			Deno.exit(1);
		}
		const path = await compile({ outDir: args.out, target, chromium });
		const size = (await Deno.stat(path)).size;
		console.log(`${path}  ${(size / 1024 / 1024).toFixed(1)} MB  (--allow-run=${chromium},/usr/bin/ffmpeg)`);
	}
}
