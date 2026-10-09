/**
 * Shared Tier 2 harness for `@tykotech/cdp` (OBSERVABILITY-TESTING-CICD.md §4.3, §4.6).
 *
 * Rules this file exists to enforce:
 * - real headless Chromium, never a stub (D-TEST1);
 * - every page under test is served by a per-test `Deno.serve({ port: 0 })` fixture bound to
 *   127.0.0.1 — no remote URLs, ever (D-TEST1, AGENTS.md §4.3);
 * - per-test `timeout: 120_000` via {@linkcode browserTest} so a hang fails a *test*, not the job;
 * - sanitizers stay on: browsers, profile dirs, sockets and fixture servers are torn down in
 *   `finally`, including on failure.
 *
 * The file name has no `_test.ts` suffix, so the runner does not treat it as a suite.
 */

import { fromFileUrl } from '@std/path';
import {
	discoverBrowserExecutable,
	launchBrowser,
	type LaunchedBrowser,
	type LaunchOptions,
	readEnv,
} from '../src/launch.ts';
import { skipBrowserTier } from '../../../tests/support/browser_tier.ts';

/** Repo-root-relative scratch space; the test matrices grant `--allow-write=tests/.scratch`. */
const SCRATCH_ROOT = fromFileUrl(new URL('../../../tests/.scratch', import.meta.url));

/**
 * Chromium for the browser tier: `BUA_TEST_CHROMIUM` first (OBSERVABILITY-TESTING-CICD.md §7.3 makes
 * it the only `--allow-run` value CI hands out), else whatever discovery finds locally.
 *
 * Resolves to `null` when nothing is available, and the browser suites then report as `ignored`
 * rather than failing — a CI leg without Chromium should be honest, not red.
 */
async function resolveTestBrowser(): Promise<string | null> {
	const pinned = readEnv('BUA_TEST_CHROMIUM');
	try {
		const found = await discoverBrowserExecutable(
			pinned === undefined || pinned.length === 0 ? {} : { executablePath: pinned },
		);
		return found.path;
	} catch {
		return null;
	}
}

/** The resolved browser, or `null`. Computed once at module load so `ignore:` can be decided. */
export const TEST_BROWSER: string | null = await resolveTestBrowser();

/**
 * ERRATUM(SKIP-1): the tier's precondition is the resolved path **and** `--allow-run` for it. The
 * skip is announced on stderr instead of being inferred from a count, and `BUA_REQUIRE_BROWSER`
 * (set by the CI legs that provision a browser) makes an unmet precondition a failure.
 */
export const SKIP_BROWSER_TIER = skipBrowserTier('cdp/tier-2', TEST_BROWSER);

/** Context handed to every {@linkcode browserTest} body. */
export type BrowserTestContext = {
	/** Absolute path to the browser being driven. */
	readonly executablePath: string;
	/** Launches a headless browser on a fresh scratch profile; torn down automatically. */
	launch(overrides?: Partial<LaunchOptions>): Promise<LaunchedBrowser>;
	/** Creates a scratch dir removed at the end of the test. */
	scratchDir(prefix?: string): Promise<string>;
	/** Registers an extra teardown step, run LIFO in `finally`. */
	defer(fn: () => Promise<void> | void): void;
};

/**
 * `Deno.test` wrapper for the browser tier: 120 s per-test deadline, clean skip without a browser,
 * and guaranteed teardown of everything the test allocated.
 */
export function browserTest(name: string, fn: (ctx: BrowserTestContext) => Promise<void>): void {
	Deno.test({
		name,
		ignore: SKIP_BROWSER_TIER,
		timeout: 120_000,
		fn: async () => {
			const executablePath = TEST_BROWSER as string;
			const teardown: Array<() => Promise<void> | void> = [];
			const dirs: string[] = [];
			const ctx: BrowserTestContext = {
				executablePath,
				scratchDir: async (prefix = 'bua-tmp-') => {
					await Deno.mkdir(SCRATCH_ROOT, { recursive: true });
					const dir = await Deno.makeTempDir({ dir: SCRATCH_ROOT, prefix });
					dirs.push(dir);
					return dir;
				},
				launch: async (overrides = {}) => {
					const userDataDir = overrides.userDataDir ?? await ctx.scratchDir();
					const browser = await launchBrowser({
						executablePath,
						headless: true,
						tempProfileRoot: SCRATCH_ROOT,
						...overrides,
						userDataDir,
					});
					teardown.push(() => browser.close());
					return browser;
				},
				defer: (step) => {
					teardown.push(step);
				},
			};
			try {
				await fn(ctx);
			} finally {
				for (const step of teardown.reverse()) {
					try {
						await step();
					} catch (error) {
						console.error('teardown step failed:', error);
					}
				}
				for (const dir of dirs) {
					await removeQuietly(dir);
				}
			}
		},
	});
}

async function removeQuietly(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await Deno.remove(dir, { recursive: true });
			return;
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			// Windows releases browser profile handles a beat after the process exits.
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}

/** A running fixture server bound to loopback. */
export type FixtureServer = {
	readonly baseUrl: string;
	readonly requests: readonly string[];
	close(): Promise<void>;
};

/**
 * Serves `routes` from an ephemeral loopback port (OBSERVABILITY-TESTING-CICD.md §4.3).
 *
 * ERRATUM(M0-cdp-launch-ci-6): `hostname: '127.0.0.1'` is missing from the §4.3 snippet but is not
 * optional — `Deno.serve` defaults to `0.0.0.0`, which the `--allow-net=127.0.0.1,localhost` test
 * matrix (SECURITY-AUTH.md §3.6) rightly denies.
 */
export function startFixtureServer(
	routes: Record<string, (req: Request) => Response | Promise<Response>>,
): FixtureServer {
	const controller = new AbortController();
	const requests: string[] = [];
	const server = Deno.serve({
		hostname: '127.0.0.1',
		port: 0,
		signal: controller.signal,
		onListen: () => {},
	}, async (req) => {
		const path = new URL(req.url).pathname;
		requests.push(path);
		const route = routes[path];
		if (route === undefined) return new Response('not found', { status: 404 });
		return await route(req);
	});
	const addr = server.addr as Deno.NetAddr;
	return {
		baseUrl: `http://127.0.0.1:${addr.port}`,
		requests,
		close: async () => {
			controller.abort();
			await server.finished;
		},
	};
}

/** `text/html` response helper for fixture routes. */
export function html(body: string): Response {
	return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
