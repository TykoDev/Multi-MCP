/**
 * Environment access seam (D-CFG1: env is read through a getter at use time, never snapshotted at
 * import).
 */

import type { EnvSource } from './types.ts';

/**
 * Reads `Deno.env` defensively.
 *
 * Missing `--allow-env` for the requested variable raises `NotCapable`; a permission-less embedder
 * must degrade to "unset", not crash.
 *
 * ERRATUM(M0-bus-4): Deno's `--allow-env` needs an explicit wildcard to cover a prefix
 * (`--allow-env=TIMEOUT_*`); the bare `TIMEOUT_` form used by the root `deno.json` test tasks and by
 * OBSERVABILITY-TESTING-CICD.md §4.6 grants nothing, so no `TIMEOUT_<EventClassName>` override can
 * take effect under `deno task test` until those flags gain a `*`.
 */
export const denoEnvSource: EnvSource = (name) => {
	try {
		return Deno.env.get(name);
	} catch {
		// NotCapable (or any host restriction) is indistinguishable from "unset" for our purposes.
		return undefined;
	}
};

let defaultSource: EnvSource = denoEnvSource;

/** The env source used when no bus-scoped override was supplied. */
export function defaultEnvSource(): EnvSource {
	return defaultSource;
}

/**
 * Swaps the process-wide env source. Intended for tests and for embedders that layer a config file
 * over the process environment. Passing `null` restores {@linkcode denoEnvSource}.
 */
export function setDefaultEnvSource(source: EnvSource | null): void {
	defaultSource = source ?? denoEnvSource;
}
