/**
 * @module
 * The browser tier's precondition, decided in one place: a resolved Chromium and `--allow-run` for that exact path.
 * A host without one skips loudly on stderr; under `BUA_REQUIRE_BROWSER=1` (CI legs that provision a browser) an
 * unmet precondition is a failing test instead, so a leg that ran nothing is never green.
 */

/** Env var carrying the pinned browser path; the only value the tier hands to `--allow-run`. */
export const CHROMIUM_ENV = 'BUA_TEST_CHROMIUM';

/**
 * What `scripts/resolve_chromium.ts --grant` prints when it found no browser: an empty `--allow-run=` aborts the
 * task. No leading slash (MSYS rewrites one into a real Windows path) and a separator (never looked up on `PATH`).
 */
export const NO_BROWSER_SENTINEL = 'bua-tier/no-chromium-resolved';

/** `Deno.env.get` that tolerates a narrower `--allow-env`; empty counts as absent (`VAR="$(… || echo)"`). */
export function readEnv(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.trim() === '' ? undefined : value;
	} catch {
		return undefined;
	}
}

/** Why the tier cannot run here, or `null`. The run query is scoped: a bare `{ name: 'run' }` is never granted. */
function browserTierReason(executablePath: string | null | undefined): string | null {
	if (executablePath === null || executablePath === undefined || executablePath === '') {
		return `no Chromium was resolved — set ${CHROMIUM_ENV}=<absolute path> or install Chrome/Chromium`;
	}
	if (executablePath === NO_BROWSER_SENTINEL) {
		return `no Chromium was resolved — \`scripts/resolve_chromium.ts --grant\` found none on this host; ` +
			`set ${CHROMIUM_ENV}=<absolute path> or install Chrome/Chromium`;
	}
	let granted = false;
	try {
		granted = Deno.permissions.querySync({ name: 'run', command: executablePath }).state === 'granted';
	} catch { /* no permissions API: ungranted */ }
	return granted ? null : `--allow-run=${executablePath} was not granted to this invocation ` +
		'(a scoped grant is required; `deno task test:unit` grants none by design)';
}

/** The `ignore:` value for one suite; announces a skip, or registers a failing test under `BUA_REQUIRE_BROWSER`. */
export function skipBrowserTier(suite: string, executablePath: string | null | undefined): boolean {
	const reason = browserTierReason(executablePath);
	if (reason === null) return false;
	const flag = readEnv('BUA_REQUIRE_BROWSER')?.trim().toLowerCase();
	const required = flag !== undefined && !['0', 'false', 'no'].includes(flag);
	const headline = required
		? `browser tier: ${suite} is REQUIRED here (BUA_REQUIRE_BROWSER is set) but cannot run — ${reason}`
		: `browser tier: skipping ${suite} — ${reason}`;
	console.error(headline);
	if (required) {
		Deno.test(`${suite}: browser-tier precondition (BUA_REQUIRE_BROWSER)`, () => {
			throw new Error(headline);
		});
	}
	return true;
}

/** A skip notice for a precondition no shipped matrix satisfies, which `BUA_REQUIRE_BROWSER` must not turn red. */
export function announceSkip(suite: string, reason: string): boolean {
	console.error(`test tier: skipping ${suite} — ${reason}`);
	return true;
}
