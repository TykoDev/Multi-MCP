/**
 * The DOM fixture corpus — **one** corpus, `tests/fixtures/pages/`.
 *
 * It used to be two: 30 programmatic pages generated here, and the 25 static HTML pages the Python
 * reference was recorded against. Comparing our output on our bytes to the reference's output on its
 * bytes measures nothing, so the programmatic set is gone and this module now enumerates the shared
 * corpus. Pages that only our set covered were promoted to static HTML in the same directory
 * (`deep_nesting`, `same_tag_siblings`, `empty_page`, `iframe_same_site_port`,
 * `iframe_oopif_scrolled`, `iframe_hidden_elements`, `iframe_oopif_index_collision`); they have no
 * Python golden, which the parity report surfaces as `NO-GOLDEN` rather than as a pass.
 *
 * Recording conditions are pinned by `tests/fixtures/manifest.json → provenance` and reproduced by
 * `packages/core/tests/parity/live.ts`. Two of them are structural rather than stylistic:
 *
 * - **1280 × 900 viewport, `deviceScaleFactor` 1.** Visibility is a viewport test with ±1000 px of
 *   vertical slack, so the viewport decides which elements exist in the output at all.
 * - **Origins `http://127.0.0.1:38111` and `http://localhost:38112`.** A different *host*, not merely
 *   a different port: Chrome's site isolation keys on scheme+site and ignores the port, so the two
 *   spellings of loopback are what separates the `DOM.getDocument` pierce path (same site, in the
 *   host renderer) from the session-recursion path (cross site, its own renderer and its own
 *   `backendNodeId` space). `iframe_same_site_port` and `iframe_crossorigin` are exactly that pair.
 *
 * Captures are re-recorded by `deno task parity -- --record`, which writes
 * `packages/core/fixtures/dom/<page>.capture.json` from the same live run it reports on — so the
 * fixture and the reported result are one measurement, not two.
 */

import { fromFileUrl } from '@std/path';

/** One page of the corpus. */
export interface DomFixturePage {
	/** File stem: `<name>.html` in the corpus, `<name>.capture.json` here. */
	readonly name: string;
	/** What this page is in the corpus to prove; from the manifest for recorded pages. */
	readonly exercises: string;
	/** Pathname served by both fixture origins. */
	readonly path: string;
	/** True when the Python reference recorded a golden for this page. */
	readonly hasGolden: boolean;
}

/** The canonical HTML corpus directory. Both sides of the cleanroom wall serve these bytes. */
export const CANONICAL_PAGES_DIR: string = fromFileUrl(
	new URL('../../../../tests/fixtures/pages', import.meta.url),
);

/**
 * The recorded viewport (`manifest.json → provenance.viewport`).
 *
 * Not a preference: `scroll_page` puts a control 1620 px down a 900 px viewport and the reference
 * emits it, while the control at 2020 px is absent — which pins the ±1000 px slack to the pixel and
 * only holds at this viewport.
 */
export const DEFAULT_FIXTURE_VIEWPORT = { width: 1280, height: 900 } as const;

/** The two pinned origins (`manifest.json → provenance`). */
export const PRIMARY_ORIGIN = 'http://127.0.0.1:38111' as const;
export const SECONDARY_ORIGIN = 'http://localhost:38112' as const;

/** What each promoted page covers that the recorded 25 do not. */
const ADDED_PAGES: Readonly<Record<string, string>> = {
	deep_nesting: 'xpath through 40 levels of structural nesting',
	same_tag_siblings: '1-based same-tag sibling xpath indexing with interleaved tags, outside a table',
	empty_page: 'degenerate input: an empty body still yields a document root and no crash',
	iframe_same_site_port: 'cross-origin same-site frame: pierced in-process, different documentURL, one session',
	iframe_oopif_scrolled: 'out-of-process iframe whose inner document is scrolled: frame scrollOffset subtraction',
	iframe_hidden_elements: 'hiddenElementsInfo / hasHiddenContent: interactive frame content below the frame fold',
	iframe_oopif_index_collision: 'R6.1 synthetic index: an OOPIF whose backendNodeIds collide with the host session',
	live_value_vs_attribute: 'the live DOM property and the markup attribute disagree (§6.5 AX-value override)',
	visibility_collapse: 'visibility:collapse inside and outside a table, and a descendant that undoes it',
	scroll_page_prescrolled: 'a scrolled main document: page-absolute geometry vs the moved viewport band',
	iframe_hidden_far: 'frame content beyond the ±1000px slack, so hiddenElementsInfo actually fires',
};

interface ManifestPagesShape {
	readonly pages: readonly { readonly page: string; readonly exercises: string }[];
}

async function load(): Promise<readonly DomFixturePage[]> {
	const manifestPath = fromFileUrl(new URL('../../../../tests/fixtures/manifest.json', import.meta.url));
	const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as ManifestPagesShape;
	const recorded = new Map(manifest.pages.map((entry) => [entry.page.replace(/\.html$/, ''), entry.exercises]));

	const pages: DomFixturePage[] = [];
	for await (const entry of Deno.readDir(CANONICAL_PAGES_DIR)) {
		if (!entry.isFile || !entry.name.endsWith('.html')) continue;
		const name = entry.name.slice(0, -'.html'.length);
		const fromManifest = recorded.get(name);
		pages.push({
			name,
			exercises: fromManifest ?? ADDED_PAGES[name] ?? '',
			path: `/${entry.name}`,
			hasGolden: fromManifest !== undefined,
		});
	}
	pages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return pages;
}

/** Every page of the corpus, sorted by name. */
export const DOM_FIXTURE_PAGES: readonly DomFixturePage[] = await load();

/** Fixture lookup by name. */
export function fixturePage(name: string): DomFixturePage {
	const page = DOM_FIXTURE_PAGES.find((candidate) => candidate.name === name);
	if (page === undefined) throw new Error(`unknown DOM fixture page: ${name}`);
	return page;
}

/**
 * Read the whole corpus directory into a `pathname → body` route table.
 *
 * Both fixture origins serve the same table: `iframe_crossorigin.html` hard-codes
 * `http://localhost:38112/frames/frame_crossorigin_child.html`, so the secondary origin has to be
 * able to serve `frames/` too.
 */
export async function loadFixtureRoutes(): Promise<Record<string, string>> {
	const routes: Record<string, string> = {};
	for await (const entry of Deno.readDir(CANONICAL_PAGES_DIR)) {
		if (entry.isFile && entry.name.endsWith('.html')) {
			routes[`/${entry.name}`] = await Deno.readTextFile(`${CANONICAL_PAGES_DIR}/${entry.name}`);
		}
		if (!entry.isDirectory || entry.name !== 'frames') continue;
		for await (const fragment of Deno.readDir(`${CANONICAL_PAGES_DIR}/frames`)) {
			if (!fragment.isFile || !fragment.name.endsWith('.html')) continue;
			routes[`/frames/${fragment.name}`] = await Deno.readTextFile(
				`${CANONICAL_PAGES_DIR}/frames/${fragment.name}`,
			);
		}
	}
	return routes;
}
