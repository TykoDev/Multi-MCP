/**
 * Environment access seam: env is read through a getter at use time, never snapshotted at import.
 */

import type { EnvSource } from './types.ts';

/**
 * Reads `Deno.env` defensively.
 *
 * Missing `--allow-env` for the requested variable raises `NotCapable`; a permission-less embedder
 * must degrade to "unset", not crash.
 *
 * Deno's `--allow-env` needs an explicit wildcard to cover a prefix (`--allow-env=TIMEOUT_*`); a
 * bare `TIMEOUT_` grants nothing, so no `TIMEOUT_<EventClassName>` override would take effect.
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
