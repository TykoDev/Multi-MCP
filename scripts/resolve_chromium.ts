/**
 * Resolves the browser the Tier 2 / Tier 4 suites drive.
 *
 * Two output modes, for two different consumers:
 *
 * - **default** — prints `BUA_TEST_CHROMIUM=<path>`, ready to append to `$GITHUB_ENV`
 *   (OBSERVABILITY-TESTING-CICD.md §7.3, SECURITY-AUTH.md §3.6). Exits 1 with the discovery report
 *   when nothing is found; CI treats that as "skip the browser leg", not as a green run.
 * - **`--grant`** — prints exactly one line, the value `deno task test:browser` substitutes into
 *   `--allow-run=`. **Never empty, and always exit 0.**
 * - **`--bench-grant`** — the second `--allow-run` slot of `bench:full`, the compiled binary N1
 *   spawns. Same well-formedness contract, different precondition: the binary is optional (the bench
 *   harness falls back to scanning `dist/` and announces a loud skip when there is nothing there), so
 *   this mode resolves through **`bench/_harness.ts`'s own `compiledArtifacts`** rather than a second
 *   copy of that logic — the grant and the query must name the same file, and two implementations of
 *   "which artifact" is how they stop doing so.
 * - **`--pin`** — the value the same task substitutes into `BUA_TEST_CHROMIUM`: the normalized path
 *   when one was found, and **an empty line when none was**. The two modes differ *only* in the
 *   not-found case, and that difference is load-bearing: a flag must be well-formed, but publishing a
 *   fake path as the pinned browser makes every suite believe it has one. Measured before the split —
 *   `packages/cdp/tests/_helpers.ts` resolves its own browser, took the sentinel as a pin, and **ran
 *   and failed 12 tests where it should have skipped**.
 *
 * `BUA_TEST_CHROMIUM` is the only value the test matrices pass to `--allow-run`, so this script's
 * output is what makes a scoped `--allow-run=<path>` possible — a bare grant would be an automatic
 * gate failure.
 *
 * ---
 *
 * ERRATUM(SKIP-9) — why `--grant` exists, and why its two invariants are what they are.
 *
 * `deno task test:browser` used to carry `--allow-run=$BUA_TEST_CHROMIUM`. With the variable unset
 * that expands to nothing and Deno refuses the flag outright:
 *
 * ```
 * $ deno task test:browser
 * error: Empty command name not allowed in --allow-run=...
 * ```
 *
 * The task therefore **aborted before a single test registered**, which made the entire loud-skip
 * design in `tests/support/browser_tier.ts` unreachable through the shipped invocation — the same
 * defect class that module's own ERRATUM(SKIP-1) exists to fix, one layer further out. `deno task
 * test` could not complete on a machine without the variable set at all.
 *
 * Hence: **never empty** (so the flag is always well-formed) and **always exit 0** (so a host with no
 * browser gets `browser_tier.ts`'s named skip, and under `BUA_REQUIRE_BROWSER` its named *failure*,
 * rather than a task abort that produces neither). The skip/fail decision stays in the one module
 * that owns it; this script only supplies a value.
 *
 * **Separators are normalized to `/`, and that is load-bearing rather than cosmetic.** Two properties
 * of `deno_task_shell` and of Deno's permission matcher force it, both probed on 2.9.5:
 *
 * 1. A command substitution **eats backslashes**: `"$(...)"` printing
 *    `C:\Program Files\…\chrome.exe` arrives as `C:Program Files…chrome.exe`. Forward slashes
 *    survive intact.
 * 2. `--allow-run` compares **spellings, not resolved paths**: granted `C:/…/chrome.exe`, a query for
 *    `C:\…\chrome.exe` answers `prompt`, not `granted`. (`--allow-read` behaves the same way.)
 *
 * Together those mean the grant and the suite's own `runGrantedFor` query must be the *identical
 * string*, so the task substitutes this output into **both** `--allow-run=` and `BUA_TEST_CHROMIUM`.
 * Normalizing a pinned path respells it; it never selects a different binary, so a CI pin is still
 * honoured exactly.
 *
 * **Resolved — `Program Files (x86)` *is* searched now (E-30).** The task used to build the discovery
 * roots by interpolating `$LOCALAPPDATA,$PROGRAMFILES,$USERPROFILE,$HOME` into the flag, and the x86
 * root could not be added to that: `deno_task_shell` expands only bare `$IDENT`, so
 * `$PROGRAMFILES(X86)` parses as `$PROGRAMFILES` followed by `(X86)`, and it supports no `${...}`
 * brace form (both probed on 2.9.5). `readRoots()` below computes the list inside this script
 * instead, so every root — x86 included — is available, and no unset variable can collapse into the
 * `,,` that Deno reads as an escaped comma.
 *
 * Whenever discovery does come up empty the failure direction stays safe: `--grant` returns the
 * sentinel and the tier emits its ordinary **loud skip** — never a silent pass, and never a wrong
 * browser. `BUA_TEST_CHROMIUM=<path>` still pins an install exactly, and `BUA_REQUIRE_BROWSER=1`
 * still turns the unmet precondition into a failure.
 *
 * Run — the read grant is now derived from this script rather than written per-OS, which is the
 * point of `--read`:
 *   deno task chromium:read      # the discovery roots this host actually has
 *   deno task resolve:chromium   # discovery, using exactly those roots
 */

import { BrowserNotFoundError, findBrowserExecutable } from '../packages/cdp/mod.ts';
// ERRATUM(E-07): the donor's `--bench-grant` mode resolved a compiled binary
// through `bench/_harness.ts`. This project vendored no bench suite, so the
// mode and its import are removed rather than left dangling; `--grant` and
// `--pin` (the modes the test tasks actually use) are unchanged.
import { CHROMIUM_ENV, NO_BROWSER_SENTINEL } from '../tests/support/browser_tier.ts';

/**
 * `\` → `/`. See the module note: the substitution that carries this value destroys backslashes, and
 * the permission matcher compares spellings.
 */
export function normalizeSeparators(path: string): string {
	return path.replaceAll('\\', '/');
}

/**
 * The directories discovery needs to read, as `--allow-read` spells them.
 *
 * ERRATUM(E-30). The task used to build this list by interpolating the variables straight into the
 * flag — `--allow-read=.,$LOCALAPPDATA,$PROGRAMFILES,$USERPROFILE,$HOME,/usr/bin,…` — which is the
 * construction E-19 banned and `scripts/tier_paths.ts` exists to prevent. Three of those four are
 * unset on Linux and macOS, and the failure is worse than an ignored entry: **Deno reads `,,` as an
 * escaped comma**, so the neighbours of an empty entry are silently *welded into one path*. Measured
 * on 2.9.5 inside this project's own Linux image, the declared grant became the effective grant
 * `{".,,/home/deno", "/usr/bin", "/usr/local/bin", "/opt", "/snap/bin", "/Applications"}` — the repo
 * and the home directory both ungranted, and a path that cannot exist granted in their place. A
 * browser installed under `$HOME` was therefore undiscoverable on every non-Windows host, and
 * nothing said so.
 *
 * Computed here instead: unset variables drop out, so no empty entry can occur.
 */
export function readRoots(): string[] {
	const fromEnv = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERPROFILE', 'HOME']
		.map(readEnv)
		.filter((value): value is string => value !== undefined && value.trim() !== '');

	const wellKnown = ['/usr/bin', '/usr/local/bin', '/opt', '/snap/bin', '/var/lib/flatpak', '/Applications'];

	// Separators normalized for the same reason the resolved path is: the value crosses a command
	// substitution, and the permission matcher compares spellings rather than resolved paths.
	const all = ['.', ...fromEnv, ...wellKnown].map(normalizeSeparators);
	const unique: string[] = [];
	for (const path of all) {
		// A path containing a comma cannot be expressed in a permission list at all — `,,` is the
		// escape and a lone `,` is the separator — so it is dropped rather than allowed to corrupt
		// the entries beside it.
		if (path === '' || path.includes(',') || unique.includes(path)) continue;
		unique.push(path);
	}
	return unique;
}

/**
 * The single line `--grant` prints.
 *
 * `resolved` is the pinned path, or the discovered one, or `null` when neither exists. The `null`
 * case is the whole point: it yields a value that is well-formed, absolute (so never resolved via
 * `PATH`), and non-existent (so the grant it produces cannot spawn anything).
 */
export function grantValue(resolved: string | null): string {
	if (resolved === null || resolved.length === 0) return NO_BROWSER_SENTINEL;
	return normalizeSeparators(resolved);
}

/** `Deno.env.get` that treats a narrower `--allow-env` as "unset" rather than throwing. */
function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * What discovery produced. The failure arm carries the real `BrowserNotFoundError` report rather
 * than a reconstructed one — the searched paths and per-path reasons are the whole value of that
 * message, and a rebuilt copy would print an empty search space that never happened.
 */
export type BrowserResolution =
	| { readonly path: string; readonly source: 'pinned' | 'discovered' }
	| { readonly path: null; readonly report: string };

/**
 * The variable that pins the browser for the server tasks (`--serve`): the one the server itself reads.
 *
 * ERRATUM(E-82): `dev`, `stdio` and `serve:cluster` carried no `--allow-run`, so a browser launch depended on an
 * interactive permission prompt — which `stdio`, started by an MCP client with the protocol on stdin, can never answer.
 * They now take their grant from this script exactly as the browser tier does, and pin `TTK_BROWSER_PATH` to the same
 * value, so the binary granted and the binary launched are one file even where the server's narrower `--allow-env`
 * would have let its own discovery find a different one. They also run with `--no-prompt`, as the images do
 * (`DENO_NO_PROMPT=1`): measured on Windows with Deno 2.9.7, a defensive `Deno.env.get` of a name outside the grant
 * (`TIMEOUT_<Event>`, `DISPLAY`, …) *blocked on a permission prompt* even with stdin and stderr piped, so the browser
 * layer's "unreadable means unset" never applied and every launch timed out after 30 s. With `--no-prompt` the same
 * read answers `NotCapable` at once, and the launch completes in about two seconds.
 */
export const SERVE_ENV = 'TTK_BROWSER_PATH';

/** The pinned path, the discovered one, or the not-found report. A pin is never second-guessed. */
export async function resolveBrowser(pinVariable: string = CHROMIUM_ENV): Promise<BrowserResolution> {
	const pinned = readEnv(pinVariable);
	if (pinned !== undefined && pinned.length > 0) return { path: pinned, source: 'pinned' };
	try {
		return { path: await findBrowserExecutable(), source: 'discovered' };
	} catch (error) {
		if (error instanceof BrowserNotFoundError) return { path: null, report: error.message };
		throw error;
	}
}

// deno-coverage-ignore-start -- CI glue; the pure helpers above carry the logic and their tests
if (import.meta.main) {
	const grantMode = Deno.args.includes('--grant');
	const pinMode = Deno.args.includes('--pin');
	// `--serve` resolves for the server tasks rather than the test tier: the pin is `TTK_BROWSER_PATH`.
	const serveMode = Deno.args.includes('--serve');

	// Answered before discovery runs, and without needing any read permission of its own: this mode
	// exists to *build* the read grant the other modes are given (E-30).
	if (Deno.args.includes('--read')) {
		console.log(readRoots().join(','));
		Deno.exit(0);
	}

	const resolution = await resolveBrowser(serveMode ? SERVE_ENV : CHROMIUM_ENV);

	if (pinMode) {
		// Empty when nothing was found: the suites then run their own discovery and reach their own
		// skip, instead of trying to launch a path that exists only to keep a flag well-formed.
		console.log(resolution.path === null ? '' : normalizeSeparators(resolution.path));
		Deno.exit(0);
	}

	if (grantMode) {
		if (resolution.path === null) {
			// Loud, on stderr, so a substituted-into-a-flag value never hides the reason. stdout stays
			// exactly one line because the caller is a shell substitution.
			console.error(
				serveMode
					? `resolve-chromium: no Chrome/Chromium/Edge/Brave found on this host — the server starts, and its ` +
						`browser tools fail until one is installed or ${SERVE_ENV}=<absolute path> names one.`
					: `resolve-chromium: no Chrome/Chromium/Edge/Brave found on this host — the browser tier will ` +
						`skip. Set ${CHROMIUM_ENV}=<absolute path> to pin one, or BUA_REQUIRE_BROWSER=1 to make the ` +
						`unmet precondition a failure instead (tests/support/browser_tier.ts).`,
			);
		}
		console.log(grantValue(resolution.path));
		Deno.exit(0);
	}

	if (resolution.path === null) {
		console.error(resolution.report);
		Deno.exit(1);
	}
	console.log(`${CHROMIUM_ENV}=${resolution.path}`);
}
// deno-coverage-ignore-stop
