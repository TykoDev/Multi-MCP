/**
 * Resolves the browser the browser tier, `dev` and `stdio` launch.
 *
 * - `--read`: the discovery roots, as the `--allow-read` list the other modes run under (`chromium:read`).
 * - `--grant`: one line for `--allow-run=`: never empty, always exit 0 (an empty grant aborts the task before
 *   `tests/support/browser_tier.ts` can skip or fail loudly), the inert sentinel when nothing is found.
 * - `--pin`: the same path for `BUA_TEST_CHROMIUM` / `TTK_BROWSER_PATH`, or an empty line when none was found, so
 *   a suite skips instead of launching the sentinel.
 * - default: `BUA_TEST_CHROMIUM=<path>`, or the discovery report and exit 1.
 * - `--serve`: pinned by `TTK_BROWSER_PATH`, the variable the server reads, so the binary granted and launched are
 *   one file.
 *
 * Separators are normalized to `/`: a task-shell substitution eats backslashes, and `--allow-run` compares
 * spellings, so the grant and the pin must be the identical string. The roots are computed here rather than
 * interpolated into the task: unset variables would leave `,,`, which Deno reads as an escaped comma.
 */
import { BrowserNotFoundError, findBrowserExecutable } from '../packages/cdp/mod.ts';
import { CHROMIUM_ENV, NO_BROWSER_SENTINEL } from '../tests/support/browser_tier.ts';

const SERVE_ENV = 'TTK_BROWSER_PATH';

/** `Deno.env.get` that treats a narrower `--allow-env` as unset. */
function readEnv(name: string): string | undefined {
	try {
		return Deno.env.get(name) || undefined;
	} catch {
		return undefined;
	}
}

const slashes = (path: string): string => path.replaceAll('\\', '/');

/** The directories discovery reads; a path holding a comma cannot be spelled in a permission list and is dropped. */
function readRoots(): string[] {
	const fromEnv = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERPROFILE', 'HOME']
		.map(readEnv)
		.filter((value): value is string => value !== undefined && value.trim() !== '');
	const wellKnown = ['/usr/bin', '/usr/local/bin', '/opt', '/snap/bin', '/var/lib/flatpak', '/Applications'];
	return [...new Set(['.', ...fromEnv, ...wellKnown].map(slashes))].filter((path) => !path.includes(','));
}

if (import.meta.main) {
	if (Deno.args.includes('--read')) {
		console.log(readRoots().join(','));
		Deno.exit(0);
	}
	const serve = Deno.args.includes('--serve');
	let path = readEnv(serve ? SERVE_ENV : CHROMIUM_ENV) ?? null; // a pin is never second-guessed
	let report = '';
	if (path === null) {
		try {
			path = await findBrowserExecutable();
		} catch (error) {
			if (!(error instanceof BrowserNotFoundError)) throw error;
			report = error.message;
		}
	}
	if (Deno.args.includes('--pin')) {
		console.log(path === null ? '' : slashes(path));
	} else if (Deno.args.includes('--grant')) {
		if (path === null) {
			console.error(
				serve
					? `resolve-chromium: no Chrome/Chromium/Edge/Brave found on this host — the server starts, and its ` +
						`browser tools fail until one is installed or ${SERVE_ENV}=<absolute path> names one.`
					: `resolve-chromium: no Chrome/Chromium/Edge/Brave found on this host — the browser tier will ` +
						`skip. Set ${CHROMIUM_ENV}=<absolute path> to pin one, or BUA_REQUIRE_BROWSER=1 to make the ` +
						`unmet precondition a failure instead (tests/support/browser_tier.ts).`,
			);
		}
		console.log(path === null ? NO_BROWSER_SENTINEL : slashes(path));
	} else if (path === null) {
		console.error(report);
		Deno.exit(1);
	} else {
		console.log(`${CHROMIUM_ENV}=${path}`);
	}
}
