/**
 * @module
 * The browser tier's precondition, decided in one place (OBSERVABILITY-TESTING-CICD.md §4.3, §7.3).
 *
 * ERRATUM(SKIP-1). Every browser-backed suite has the same two-part precondition — **a resolved
 * Chromium path** and **`--allow-run` for that exact path** — and each file used to answer it
 * differently. One of those answers was unreachable:
 *
 * ```ts
 * const RUN_PERMISSION = (await Deno.permissions.query({ name: 'run' })).state === 'granted';
 * ```
 *
 * A *bare* category descriptor asks "is `--allow-run` granted for **everything**?". SECURITY-AUTH.md
 * §3.1 forbids exactly that grant, the task gate (`scripts/check_tasks.ts`, rule T3) refuses it in every
 * shipped task, and the browser tier grants only the resolved browser — so under this tier the answer is
 * structurally never `granted`. **PROBED on Deno 2.9.5:** under
 * `--allow-run=C:\…\notepad.exe`, `query({name:'run'})` reports `prompt` while
 * `query({name:'run', command:'C:\…\notepad.exe'})` reports `granted`. The guard was therefore false
 * under its own documented invocation, and the suite it guarded reported `ignored` forever, in CI,
 * green. A scoped query is not a nicety here; it is the only form that can ever return `granted`.
 *
 * The second half of the fix is that "skip" and "fail" are the right answer in different places:
 *
 * - a laptop with no Chromium should **skip** — a red suite there is noise, not information;
 * - CI must **fail**, because a leg that provisions a browser and then runs nothing is the exact
 *   failure this module exists to prevent (`scripts/resolve_chromium.ts` already reports a host with no
 *   browser on stderr instead of a path; this closes the same hole one step later).
 *
 * So the default is a skip that *says so on stderr*, and `BUA_REQUIRE_BROWSER=1` — set by the CI legs
 * that provision a browser, never defaulted — turns an unmet precondition into a registered, failing
 * test. Opt-out, not opt-in: a new CI leg that forgets the variable degrades to a loud skip rather
 * than to a silent one.
 */

/** Env var that inverts an unmet precondition from "skip loudly" to "fail". CI sets it. */
export const REQUIRE_BROWSER_ENV = 'BUA_REQUIRE_BROWSER';

/** Env var carrying the pinned browser path; the only value CI hands to `--allow-run` (§7.3). */
export const CHROMIUM_ENV = 'BUA_TEST_CHROMIUM';

/**
 * The stand-in `scripts/resolve_chromium.ts --grant` prints when discovery found no browser.
 *
 * ERRATUM(SKIP-9). This module's whole design — skip loudly, fail under
 * {@linkcode REQUIRE_BROWSER_ENV} — was **unreachable through the shipped task**, one level above
 * where ERRATUM(SKIP-1) fixed it. `deno task test:browser` carried `--allow-run=$BUA_TEST_CHROMIUM`,
 * and with the variable unset that expands to nothing:
 *
 * ```
 * error: Empty command name not allowed in --allow-run=...
 * ```
 *
 * The task aborts before a single test registers, so the laptop-without-Chromium case got an opaque
 * flag error instead of the skip written here, and `deno task test` could not complete at all. Same
 * defect class as SKIP-1, one layer out: a control that cannot fire.
 *
 * The resolver therefore always prints **something** — a real path, or this.
 *
 * **Why it is relative-with-a-separator rather than the obvious `/bua/...`.** The first spelling was
 * POSIX-absolute, and on Windows that is not inert: **MSYS/Git Bash rewrites a leading-slash argument
 * into a Windows path**. Measured — `/bua/no-chromium-resolved` arrived at Deno as
 * `C:/Program Files/Git/bua/no-chromium-resolved`, in the grant *and* in the environment, identically.
 * The two therefore still matched, `runGrantedFor` answered `granted`, and the cdp tier ran and failed
 * 12 tests instead of skipping. A form with no leading slash is left alone by MSYS; one containing a
 * separator is resolved by Deno relative to the cwd rather than looked up on `PATH`. So this value can
 * be neither rewritten nor accidentally executed.
 *
 * Belt and braces: the task publishes this into `--allow-run` but **never** into
 * {@linkcode CHROMIUM_ENV} — the resolver's `--pin` mode prints an empty line when nothing is found,
 * so every suite falls through to its own discovery and reaches its own skip. This constant is the
 * second line of defence, for the suites that route their precondition through
 * {@linkcode browserTierReason}; `packages/cdp/tests/_helpers.ts` resolves independently and is the
 * reason a second line of defence was needed at all.
 */
export const NO_BROWSER_SENTINEL = 'bua-tier/no-chromium-resolved';

/**
 * The same idea for `bench:full`'s second `--allow-run` slot, the compiled binary N1 spawns.
 *
 * It is a **different case** from the browser and is treated as one. The browser is the tier's
 * precondition — without it there is nothing to test. The compiled binary is optional by design:
 * `bench/_harness.ts` falls back to scanning `dist/`, and when there is nothing to scan it already
 * announces a loud skip and measures the other eight criteria. So this slot needs only what the
 * browser slot needed for *well-formedness* — a non-empty value — and not a precondition of its own.
 */
export const NO_BENCH_BINARY_SENTINEL = 'bua-tier/no-bench-binary';

/**
 * Every inert placeholder a task may hand to `--allow-run`, in one place.
 *
 * `scripts/check_tier_grant.ts` reads this as its oracle: a fallback that is not one of these is
 * either a typo or a real path someone hardcoded, and both are worth failing on. Declaring the set
 * rather than the members is what lets that gate stay correct when a sixth task appears.
 */
export const GRANT_SENTINELS: readonly string[] = [NO_BROWSER_SENTINEL, NO_BENCH_BINARY_SENTINEL];

/**
 * `Deno.env.get` that tolerates a narrower `--allow-env` instead of throwing.
 *
 * ERRATUM(E-27). An **empty** value counts as absent. This is not tidiness: the
 * tier tasks pin their discoveries with `VAR="$(… || echo)"`, so an empty string
 * is precisely how a task says "nothing found here". `Deno.env.get` returns that
 * empty string, `?? null` does not catch it, and a caller that wrote
 * `readEnv('TTK_FFMPEG') ?? null` therefore saw "ffmpeg is configured" on every
 * host that has no ffmpeg. `browserTierReason` had the `=== ''` check and the
 * recording suite did not, so the two disagreed about the same convention —
 * which is the argument for the empty case living here, once.
 */
export function readEnv(name: string): string | undefined {
	try {
		const value = Deno.env.get(name);
		return value === undefined || value.trim() === '' ? undefined : value;
	} catch {
		return undefined;
	}
}

/**
 * True when `--allow-run` covers **this exact executable**.
 *
 * Always scoped. A bare `{ name: 'run' }` query answers a question no shipped invocation can make
 * true (SECURITY-AUTH.md §3.1) and so can only ever produce a dead branch.
 */
export function runGrantedFor(executablePath: string): boolean {
	try {
		return Deno.permissions.querySync({ name: 'run', command: executablePath }).state === 'granted';
	} catch {
		// A host with no permissions API at all: treat as ungranted rather than assume.
		return false;
	}
}

/** Why the browser tier cannot run here, or `null` when it can. */
export function browserTierReason(executablePath: string | null | undefined): string | null {
	if (executablePath === NO_BROWSER_SENTINEL) {
		return `no Chromium was resolved — \`scripts/resolve_chromium.ts --grant\` found none on this host; ` +
			`set ${CHROMIUM_ENV}=<absolute path> or install Chrome/Chromium`;
	}
	if (executablePath === null || executablePath === undefined || executablePath === '') {
		return `no Chromium was resolved — set ${CHROMIUM_ENV}=<absolute path> or install Chrome/Chromium`;
	}
	if (!runGrantedFor(executablePath)) {
		return `--allow-run=${executablePath} was not granted to this invocation ` +
			'(a scoped grant is required; `deno task test:unit` grants none by design)';
	}
	return null;
}

/** True when CI asked for an unmet precondition to be a failure rather than a skip. */
export function browserTierRequired(): boolean {
	const raw = readEnv(REQUIRE_BROWSER_ENV);
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	return value !== '' && value !== '0' && value !== 'false' && value !== 'no';
}

/**
 * The whole decision for one suite: returns the value to hand to `Deno.test`'s `ignore:`.
 *
 * Side effects, both deliberate:
 *  - one line on stderr naming the suite and the missing half, so a skipped tier is never inferred
 *    from a count;
 *  - under `BUA_REQUIRE_BROWSER`, a registered test that fails with that same line, so a CI leg which
 *    provisioned a browser and then ran nothing is red rather than green.
 */
export function skipBrowserTier(suite: string, executablePath: string | null | undefined): boolean {
	const reason = browserTierReason(executablePath);
	if (reason === null) return false;
	const required = browserTierRequired();
	const headline = required
		? `browser tier: ${suite} is REQUIRED here (${REQUIRE_BROWSER_ENV} is set) but cannot run — ${reason}`
		: `browser tier: skipping ${suite} — ${reason}`;
	console.error(headline);
	if (required) {
		Deno.test(`${suite}: browser-tier precondition (${REQUIRE_BROWSER_ENV})`, () => {
			throw new Error(headline);
		});
	}
	return true;
}

/**
 * The notice half alone, for tiers whose precondition **no shipped matrix can satisfy** and which
 * `BUA_REQUIRE_BROWSER` therefore must not turn red — a suite needing `--allow-run=<deno>`, which
 * SECURITY-AUTH.md §3.2 forbids by name, is skipped by policy rather than by circumstance. Always
 * returns `true`, so it reads as `ignore: !CAN_X && announceSkip(…)`-free plain prose at the call
 * site: `if (!CAN_X) announceSkip(suite, reason);`.
 */
export function announceSkip(suite: string, reason: string): boolean {
	console.error(`test tier: skipping ${suite} — ${reason}`);
	return true;
}
