/**
 * Every server-initiated egress path, enumerated once with a pinned count (owner item 6).
 *
 * Since SR-HEAD-REDIRECT (D-042) the list has two shapes of row: places this
 * server makes the **browser** go somewhere, and — new, and exactly one on a
 * caller-chosen URL — the place this **process** issues a request of its own
 * (`head.ts`). The `await fetch(` primitive is pinned across both packages so a
 * second server-side egress cannot appear without joining the table.
 *
 * `TTK_ALLOWED_DOMAINS` is sound as a predicate; the bypasses were *around* it —
 * a redirect the browser followed after the first hop was gated, a click on an
 * `href` nobody resolved, a download a script started. This file is the list
 * of every place this server makes the browser go somewhere, each with the gate
 * it carries, and the count is pinned: a new egress path must join the table
 * or fail here. The counts are taken from the source text so the table cannot
 * drift from the tree.
 *
 * What is **not** gated, and never was (D-020): navigation the page performs
 * on its own — a link the model clicks through `browser_click`, a
 * `location.href =` in page script, a meta refresh, a form submit. The allowlist
 * is an app-level control over what this server *asks* the browser to fetch;
 * the page's own traffic is bounded by the vendored security watchdog and, where
 * an operator needs hard egress control, by a proxy or firewall
 * (`SPECS/SECURITY-AUTH.md` §8). The one thing this server does about page-driven
 * egress is the download ledger gate, which cancels any download — however it
 * started — whose final URL is outside the list.
 */
import { assertEquals } from '@std/assert';
import { hrefOf } from './tools/files.ts';

/** One egress path: where it is, what makes the browser go, and what gates it. */
interface EgressPath {
	readonly file: string;
	/** The source token that performs the egress. */
	readonly primitive: string;
	/** How many times the file may contain it. */
	readonly count: number;
	readonly tool: string;
	readonly gate: string;
}

const EGRESS_PATHS: readonly EgressPath[] = [
	{
		file: 'packages/mcp/src/tools/navigation.ts',
		primitive: 'new NavigateToUrlEvent(',
		count: 1,
		tool: 'browser_navigate',
		gate: 'assertNavigable on the requested URL; the vendored session re-checks it with isUrlAllowed (E-3)',
	},
	{
		file: 'packages/mcp/src/tools/navigation.ts',
		primitive: 'new GoBackEvent(',
		count: 1,
		tool: 'browser_go_back',
		gate:
			'history: the entry it returns to was reached either by this server (gated then) or by the page itself (never gated, D-020)',
	},
	{
		file: 'packages/mcp/src/tools/files.ts',
		primitive: 'new NavigateToUrlEvent(',
		count: 1,
		tool: 'browser_download {url}',
		gate: 'assertNavigable on the requested URL, then the ledger gate on the final download URL',
	},
	{
		file: 'packages/mcp/src/tools/files.ts',
		primitive: 'new ClickElementEvent(',
		count: 1,
		tool: 'browser_download {index}',
		gate:
			'assertNavigable on the element href resolved against its frame URL, then the ledger gate on the final download URL',
	},
	{
		file: 'packages/mcp/src/head.ts',
		primitive: 'await doFetch(',
		count: 1,
		tool: 'browser_head (server-side, SR-HEAD-REDIRECT)',
		gate:
			'every hop: assertNavigable, then the literal-address deny (isForbiddenLiteralHost), then Deno.permissions.query for the exact host:port; cookie-less; hop cap; timeouts',
	},
	{
		file: 'packages/mcp/src/head.ts',
		primitive: 'await fetch(',
		count: 0,
		tool: 'browser_head (server-side, SR-HEAD-REDIRECT)',
		gate: 'the runtime fetch is reached only through the injectable doFetch above, so the literal never appears',
	},
	{
		file: 'packages/gateway/src/routing.ts',
		primitive: 'await fetch(',
		count: 1,
		tool: 'cluster forwarding (not caller-chosen: the target is the owning node from the cluster registry)',
		gate: 'the node URL comes from the cluster registry, never from a request',
	},
	{
		file: 'packages/gateway/src/liveview.ts',
		primitive: 'new NavigateToUrlEvent(',
		count: 1,
		tool: 'live-view navigate',
		gate: 'assertNavigable on the requested URL',
	},
	{
		file: 'packages/mcp/src/registry.ts',
		primitive: 'isHostAllowed(',
		count: 1,
		tool: 'the download ledger gate (every download, however started)',
		gate: 'isHostAllowed on the final URL; Browser.cancelDownload and navigation-blocked on the file record',
	},
	{
		file: 'packages/mcp/src/secrets.ts',
		// The context argument is pinned deliberately, not just the call. SEC-FH-23 was not a missing
		// check — the check was there, spelled `isUrlAllowed`, which is the NAVIGATION predicate and
		// permits `about:blank`, `data:`, `blob:` and plaintext `http:` before it consults any list. A
		// pin on the bare token would have gone on reading green through that entire defect.
		primitive: "urlMatch(url, pattern, 'secret')",
		count: 1,
		tool: 'the secrets domain check (not an egress: decides whether a secret may be typed at the current URL)',
		gate:
			"urlMatch in its 'secret' context over the secret's own domains list: https-only for a scheme-less pattern, fail-closed on a host-less, unparseable or new-tab URL",
	},
];

/** The files the table covers. Any file outside this set containing an egress primitive fails below. */
const PRIMITIVES = ['new NavigateToUrlEvent(', 'new GoBackEvent(', 'await fetch(', 'await doFetch('];

function countOf(source: string, token: string): number {
	return source.split(token).length - 1;
}

async function sourcesUnder(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for await (const entry of Deno.readDir(dir)) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory) {
			for (const [nested, text] of await sourcesUnder(path)) out.set(nested, text);
			continue;
		}
		if (!entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		out.set(path, await Deno.readTextFile(path));
	}
	return out;
}

Deno.test('egress: every server-initiated egress path is in the table, with its gate, and the count is pinned', async () => {
	assertEquals(EGRESS_PATHS.length, 10, 'the table changed size: a path joined or left without this pin moving');
	for (const path of EGRESS_PATHS) {
		const source = await Deno.readTextFile(path.file);
		assertEquals(countOf(source, path.primitive), path.count, `${path.tool}: ${path.primitive} in ${path.file}`);
	}
	// And nothing outside the table performs an egress: every production file
	// under both packages is scanned for the primitives that make the browser go.
	const covered = new Set(EGRESS_PATHS.map((path) => path.file));
	for (const dir of ['packages/mcp/src', 'packages/gateway/src']) {
		for (const [file, source] of await sourcesUnder(dir)) {
			if (covered.has(file)) continue;
			for (const primitive of PRIMITIVES) {
				assertEquals(
					countOf(source, primitive),
					0,
					`${file} performs an egress (${primitive}) that is not in the table`,
				);
			}
		}
	}
});

Deno.test('egress: an element href resolves against its own frame, and only http(s) is gated before the click', () => {
	const state = {
		url: 'https://top.example/page',
		frames: [{ frameId: 'F2', url: 'https://child.example/dir/' }],
	};
	// Relative in the top document resolves against the top URL.
	assertEquals(hrefOf({ attributes: { href: '/export.csv' }, frameId: 'F1' }, state), 'https://top.example/export.csv');
	// Relative in a cross-origin frame resolves against *that* frame, not the top.
	assertEquals(
		hrefOf({ attributes: { href: 'file.bin' }, frameId: 'F2' }, state),
		'https://child.example/dir/file.bin',
	);
	// Absolute is taken as is.
	assertEquals(
		hrefOf({ attributes: { href: 'http://other.example/x' }, frameId: 'F1' }, state),
		'http://other.example/x',
	);
	// No href, an empty one, or a non-http(s) target: nothing to gate before the
	// click — the ledger gate is what catches what such a click starts.
	assertEquals(hrefOf({ attributes: {}, frameId: 'F1' }, state), null);
	assertEquals(hrefOf({ attributes: { href: '   ' }, frameId: 'F1' }, state), null);
	assertEquals(hrefOf({ attributes: { href: 'javascript:download()' }, frameId: 'F1' }, state), null);
	assertEquals(hrefOf({ attributes: { href: 'blob:https://top.example/uuid' }, frameId: 'F1' }, state), null);
	// No state at all: an absolute href still resolves, a relative one cannot.
	assertEquals(hrefOf({ attributes: { href: 'https://a.example/' } }, null), 'https://a.example/');
	assertEquals(hrefOf({ attributes: { href: '/rel' } }, null), null);
});
