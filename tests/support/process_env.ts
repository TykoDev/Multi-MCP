/**
 * @module
 * Exclusive, declared ownership of a **process-global** environment variable for the length of one
 * test body.
 *
 * ERRATUM(CLIFLAKE-2). `deno test --parallel` does *not* isolate the environment. **PROBED on Deno
 * 2.9.5 (x86_64-pc-windows-msvc):** two test files run under `--parallel` report the same
 * `Deno.pid`, and a file that writes `Deno.env.set('X', …)` is observed by a *different* file
 * reading `Deno.env.get('X')` on 400/400 samples. Test files get their own isolate (their own
 * module graph, their own module-level state) but share one OS process, and `Deno.env` is that
 * process's environment. So the standard save/set/restore pattern
 *
 * ```ts
 * const previous = Deno.env.get(name);
 * Deno.env.set(name, value);
 * try { await body(); } finally { … restore … }
 * ```
 *
 * is not a scoped override. It is an unsynchronised write to state every other test file in the run
 * can read, and its `finally` restores whatever value *this* file last saw — which may already be
 * another file's. The failure it produces is a plain assertion failure in an unrelated file, at a
 * rate set by how the scheduler happens to interleave two windows of a few tens of milliseconds.
 * That is not a debuggable defect; you get one red line and no way to find the writer.
 *
 * **The first fix is not to need this.** Production code should take its environment through an
 * injected reader (`EnvReader` in `@bua/cli`, the `env` option on `@tykotech/cdp`'s discovery), so a test
 * hands the value to the code under test instead of shouting it at the whole process. Every use of
 * this module is an admission that the code under test reads `Deno.env` directly *and that reading
 * it directly is the thing being tested*.
 *
 * When that is genuinely the case, the requirement gets stated rather than hidden: this takes a
 * cross-isolate exclusive lock so that at most one owner exists at a time, restores under the lock,
 * and names the variables it owns at the call site. It is a mutex, not a retry — a body that fails
 * under it fails deterministically.
 *
 * The lock is an advisory `flock`/`LockFileEx` on a file in `tests/.scratch`, which is the one
 * writable root in the §3.6 test matrix; every tier that runs these tests grants it. It is a single
 * lock covering all names rather than one lock per name, because a per-name lock lets two owners
 * that each want two names deadlock, and the windows involved are tens of milliseconds.
 */

import { fromFileUrl } from '@std/path';

/** The one writable root in the SECURITY-AUTH.md §3.6 test matrix. */
const SCRATCH_ROOT = fromFileUrl(new URL('../.scratch', import.meta.url));
const LOCK_PATH = fromFileUrl(new URL('../.scratch/process-env.lock', import.meta.url));

/**
 * Runs `body` as the sole owner of `entries` in the process environment.
 *
 * @param entries variable name to value; `null` means "own this name and leave it unset".
 * @param body the test body. Runs while the lock is held; it must not itself call this.
 *
 * Previous values are restored before the lock is released, so no other owner can observe the
 * window. A missing `--allow-write=tests/.scratch` throws with the grant named rather than silently
 * degrading to the unsynchronised behaviour this module exists to remove.
 */
export async function withOwnedProcessEnv(
	entries: Readonly<Record<string, string | null>>,
	body: () => Promise<void>,
): Promise<void> {
	const names = Object.keys(entries);
	if (names.length === 0) throw new Error('withOwnedProcessEnv: name at least one variable');

	await using lock = await acquire();
	const previous = new Map(names.map((name) => [name, Deno.env.get(name)] as const));
	for (const name of names) {
		const value = entries[name] ?? null;
		if (value === null) Deno.env.delete(name);
		else Deno.env.set(name, value);
	}
	try {
		await body();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) Deno.env.delete(name);
			else Deno.env.set(name, value);
		}
		void lock;
	}
}

async function acquire(): Promise<AsyncDisposable> {
	await Deno.mkdir(SCRATCH_ROOT, { recursive: true }).catch((error: unknown) => {
		if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
	});
	let file: Deno.FsFile;
	try {
		file = await Deno.open(LOCK_PATH, { read: true, write: true, create: true });
	} catch (error) {
		if (error instanceof Deno.errors.NotCapable) {
			throw new Deno.errors.NotCapable(
				`withOwnedProcessEnv needs --allow-write=tests/.scratch to hold its cross-isolate lock (${LOCK_PATH})`,
			);
		}
		throw error;
	}
	await file.lock(true);
	return {
		async [Symbol.asyncDispose](): Promise<void> {
			try {
				await file.unlock();
			} finally {
				file.close();
			}
		},
	};
}
