/**
 * Perception handlers: the read-only tools that describe the page — state, HTML, screenshots.
 *
 * All of them stay usable while a human holds the session, because reading what the browser shows
 * is observation, not interference.
 */
import type { BrowserSession } from '@tykotech/browser';
import { ScreenshotEvent } from '@tykotech/browser';
import type { SessionId, TargetId } from '@tykotech/cdp';
import {
	buildElementRecord,
	type FieldName,
	type FieldOption,
	type ObservedElement,
	resolveFields,
} from '../element_record.ts';
import { ToolError } from '../errors.ts';
import { FIND_DEFAULT_LIMIT, type FindQuery, rankElements } from '../find.ts';
import { type HitTest, hitTest } from '../hit_test.ts';
import {
	bestLocator,
	buildDocumentIndex,
	countLocator,
	locatorCandidates,
	type LocatorKind,
	parseLocator,
	searchQueryOf,
} from '../locators.ts';
import { labelOf, observationPayload, observationStructured, observe } from '../observe.ts';
import { frameContext, frameDocumentHtml, liveFrameIdentity } from '../page_eval.ts';
import type { SessionRecord } from '../registry.ts';
import { image, json, projected, say, type ToolContext, type ToolResult } from '../types.ts';
import { dispatch, heldToken, nodeAt, target, untilAborted } from './shared.ts';

// --- B2.1: the hit test in the browser ----------------------------------------------------------

/** What the point-to-element read answers, shared by the tool and the live view's `live.hover`. */
export interface ElementAtPoint {
	readonly hit: HitTest;
	/** The element record, masked by the one password predicate; `null` when nothing interactive is there. */
	readonly element: ObservedElement | null;
	/** The token of the table the index is valid in, or `null` when none is held. */
	readonly stateToken: string | null;
}

/**
 * The element under a top-document viewport point, from the browser's own hit test (§1.5, §3).
 *
 * One implementation for both consumers so `browser_element_at` and `live.hover` cannot describe
 * the same point two different ways. The record is built by the same builder `browser_get_state`
 * uses, so every value-bearing field passes through the password predicate (I-14), and it is a
 * reply to one request rather than retained transcript — it is never written to the ring.
 */
export async function elementAtPoint(
	record: SessionRecord,
	x: number,
	y: number,
	fields: ReadonlySet<FieldName>,
): Promise<ElementAtPoint> {
	const hit = await hitTest(record, x, y);
	const state = record.session.cachedBrowserState;
	const stateToken = state?.stateToken ?? null;
	if (hit.index === null || hit.node === null || state === null || state === undefined) {
		return { hit, element: null, stateToken };
	}
	const wantsLocators = fields.has('locator') || fields.has('locators');
	const element = buildElementRecord(hit.index, hit.node, {
		fields,
		scroll: { x: state.pageInfo.scrollX, y: state.pageInfo.scrollY },
		locators: wantsLocators ? buildDocumentIndex(state.domState.root?.originalNode ?? null) : null,
		frameUrls: new Map(state.frames.map((frame) => [frame.frameId, frame.url])),
		labelOf,
	});
	return { hit, element, stateToken };
}

/**
 * `browser_element_at {x, y}` (§1.5): the topmost interactive element at a point, or `null`.
 *
 * `element: null` with `frame_id: null` is a success — "nothing interactive there" is an answer.
 * Read-only, so it stays usable while a human holds the session.
 */
export async function browserElementAt(
	args: { x: number; y: number; fields?: FieldOption[]; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	const answer = await elementAtPoint(record, args.x, args.y, resolveFields(args.fields));
	ctx.registry.touch(record.id);
	return json({
		session_id: record.id,
		state_token: answer.stateToken,
		x: args.x,
		y: args.y,
		element: answer.element,
		frame_id: answer.element === null ? null : answer.hit.frameId,
		resolution: answer.hit.resolution,
	});
}

const FROZEN_KEYS: ReadonlySet<string> = new Set(['index', 'tag', 'label', 'role', 'href']);

/** Projects a record to the frozen fields plus the requested ones, dropping what was read internally. */
function pick(element: ObservedElement, fields: ReadonlySet<FieldName>): ObservedElement {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(element)) {
		if (FROZEN_KEYS.has(key) || fields.has(key as FieldName)) out[key] = value;
	}
	return out as unknown as ObservedElement;
}

/**
 * Characters of one document `browser_get_html` carries back — **not** bytes, unchanged since 0.1.0
 * so an existing client's expectation holds, and applied inside the page since D-057.
 *
 * Exported because the cap is now a *contract* rather than a local slice: the true length comes back
 * beside the capped string, and a test that asserted truncation against a literal 200 000 would be
 * asserting its own arithmetic rather than the server's.
 */
export const HTML_LIMIT = 200_000;

export async function browserGetState(
	args: {
		include_screenshot?: boolean;
		fields?: FieldOption[];
		element_limit?: number;
		include_hidden?: boolean;
		frames?: 'all' | 'top' | string[];
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	const record = await target(ctx, args, false);
	const includeScreenshot = args.include_screenshot ?? false;
	// A10: the DOM build is the expensive part of this tool; a cancelled call stops waiting for it.
	const observation = await observe(record, {
		includeScreenshot,
		fields: resolveFields(args.fields),
		...(args.element_limit === undefined ? {} : { elementLimit: args.element_limit }),
		...(args.include_hidden === undefined ? {} : { includeHidden: args.include_hidden }),
		...(args.frames === undefined ? {} : { frames: args.frames }),
		signal: ctx.signal,
	});
	ctx.registry.touch(record.id);

	// D-3 / I-4: the text block is the frozen 0.1.0 payload, five fields per element, byte for byte
	// what a 0.1.0 client parses. The structured half is where every field added since lands, and
	// the growth is paid once. `available_secrets` predates the split and is in both.
	const textPayload = observationPayload(observation);
	const structured = observationStructured(observation);

	// R14: the *names* of the secrets usable on this page, so a model knows it
	// can write `<secret>name</secret>` instead of asking a human for a value.
	// Names only, and only the ones this origin permits.
	if (ctx.secrets !== undefined && !ctx.secrets.empty) {
		const usable = ctx.secrets.namesFor(observation.url);
		if (usable.length > 0) {
			textPayload.available_secrets = usable;
			structured.available_secrets = usable;
		}
	}

	if (observation.screenshot !== undefined) {
		// G-4: this success path carried no `structuredContent` at all, so it
		// became a hard failure the moment an `outputSchema` was declared.
		return image(structured, observation.screenshot, 'image/png', JSON.stringify(textPayload, null, 2));
	}
	return projected(structured, textPayload);
}

// --- B1.6: find, frames and the locator tools ---------------------------------------------------

/**
 * `browser_find`: ranks the current element table against a query (needed-browser-functions §1.3).
 *
 * The ranking is pure and in memory (`find.ts`); the observation is a fresh read, so the `state_token`
 * in the result names the table the matches' indices are valid in. `near` is top-document viewport CSS
 * px, the same space as `bounds`.
 */
export async function browserFind(
	args: {
		query: FindQuery & { css?: string };
		limit?: number;
		fields?: FieldOption[];
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	const query = args.query;
	if (Object.keys(query).length === 0) {
		throw new ToolError(
			'invalid-arguments',
			'query must name at least one of role, name, text, css, href_pattern, near',
		);
	}
	const requested = resolveFields(args.fields);
	// The predicates read `text`, `bounds` and `frame_id` whether or not the caller asked for them;
	// they are read internally and projected away below.
	const internal = new Set<FieldName>([
		...requested,
		'bounds',
		'frame_id',
		...(query.text === undefined ? [] : ['text' as const]),
	]);
	// A10: a full-table read (5000 elements) and then a browser-side search; cancellation ends either wait.
	const observation = await observe(record, { fields: internal, elementLimit: 5000, signal: ctx.signal });
	ctx.registry.touch(record.id);

	let candidates = observation.elements;
	if (query.css !== undefined) {
		ctx.signal?.throwIfAborted();
		// A CSS query is the browser's to evaluate: the matcher is Chromium's, through `DOM.performSearch`.
		const found = await searchIndices(
			record,
			query.css,
			query.frame_id ?? observation.frames[0]?.id ?? '',
			observation,
		);
		candidates = candidates.filter((element) => found.has(element.index));
	}
	ctx.signal?.throwIfAborted();
	const ranked = rankElements(candidates, query);
	const limit = args.limit ?? FIND_DEFAULT_LIMIT;
	return json({
		session_id: record.id,
		state_token: observation.stateToken,
		matches: ranked.slice(0, limit).map((match) => ({ ...pick(match.element, requested), score: match.score })),
		total: ranked.length,
		unique: ranked.length === 1,
		truncated: ranked.length > limit,
	});
}

/** `browser_get_frames`: the frame list with the two honesty markers, from a fresh read (§1.4). */
export async function browserGetFrames(args: { session_id?: string }, ctx: ToolContext): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	const observation = await observe(record, { fields: new Set(), elementLimit: 1 });
	ctx.registry.touch(record.id);
	return json({
		session_id: record.id,
		state_token: observation.stateToken,
		capture_truncated: observation.captureTruncated,
		frames: observation.frames,
	});
}

/**
 * `browser_locator_candidates` (§7): every candidate for one element of the table the caller holds,
 * counted in memory as of that capture. No fresh read: the index the caller names is resolved against
 * the held table exactly as an action would resolve it, `state_token` included.
 */
export async function browserLocatorCandidates(
	args: { index: number; state_token?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	const node = nodeAt(record.session, args.index, args.state_token);
	const state = record.session.cachedBrowserState;
	const root = state?.domState.root?.originalNode ?? null;
	const candidates = locatorCandidates(node, buildDocumentIndex(root));
	ctx.registry.touch(record.id);
	return json({
		session_id: record.id,
		state_token: state?.stateToken ?? null,
		index: args.index,
		frame_id: node.frameId,
		locators: candidates,
		best: bestLocator(candidates),
	});
}

/**
 * `browser_verify_locator` (§7): what the browser matches **today**.
 *
 * The selector kinds (`testid`, `id`, `name`, `css`) and `text` go to `DOM.performSearch` in the
 * frame's own CDP session, and every search is discarded before the tool returns — a leaked search
 * id is a Chromium-side allocation nobody frees. `aria` and `label` have no CDP search that matches
 * role plus accessible name, so they are counted over the frame's merged nodes from a fresh read.
 * `matches: 0` with `first: null` is a success: "this locator names nothing today" is the answer a
 * dry run exists to print.
 */
export async function browserVerifyLocator(
	args: {
		locator: { kind: LocatorKind; value: string };
		frame_id?: string;
		fields?: FieldOption[];
		session_id?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	const parsed = parseLocator(args.locator.kind, args.locator.value);
	const fields = resolveFields(args.fields);
	const observation = await observe(record, { fields: new Set([...fields, 'frame_id']), elementLimit: 5000 });
	ctx.registry.touch(record.id);
	const frameId = args.frame_id ?? observation.frames[0]?.id ?? '';
	if (!observation.frames.some((frame) => frame.id === frameId)) {
		throw new ToolError('invalid-arguments', `no frame with id ${frameId} on this page`);
	}
	const inFrame = observation.elements.filter((element) => element.frame_id === frameId);

	let matches: number;
	let first: ObservedElement | null = null;
	const state = record.session.cachedBrowserState;
	const root = state?.domState.root?.originalNode ?? null;
	if (parsed.kind === 'aria' || parsed.kind === 'label') {
		matches = countLocator(parsed, frameId, buildDocumentIndex(root));
		first = inFrame.find((element) =>
			locatorCandidates(nodeAt(record.session, element.index), buildDocumentIndex(root))
				.some((candidate) => candidate.kind === parsed.kind && candidate.value === args.locator.value)
		) ?? null;
	} else {
		const search = await performSearch(record, searchQueryOf(parsed), frameId, observation);
		matches = search.count;
		first = inFrame.find((element) => search.indices.has(element.index)) ?? null;
	}
	return json({
		session_id: record.id,
		state_token: observation.stateToken,
		frame_id: frameId,
		matches,
		unique: matches === 1,
		first: first === null ? null : pick(first, fields),
	});
}

/** The indices `DOM.performSearch` resolves to for a query, in the frame's own session. */
async function searchIndices(
	record: SessionRecord,
	query: string,
	frameId: string,
	observation: { frames: ReadonlyArray<{ id: string; is_oopif: boolean }> },
): Promise<ReadonlySet<number>> {
	return (await performSearch(record, query, frameId, observation)).indices;
}

/** How many of the browser's search results are described back to an index, at most. */
const SEARCH_DESCRIBE_LIMIT = 50;

/**
 * One `DOM.performSearch` in the session that owns `frameId`, always discarded.
 *
 * Exported for `browser_wait_for`, whose `selector` and `text` predicates are one
 * search per tick. A second search implementation would be a second answer to
 * "does this page contain X".
 *
 * An OOPIF is its own target and Chrome uses the frame id as the target id; a same-process frame is
 * searched through its host's session, whose tree includes it. The first `SEARCH_DESCRIBE_LIMIT`
 * results are described back to `backendNodeId`s and joined to the held index table through the
 * composite key the serializer uses, so an index in the answer is one the caller can act with.
 */
export async function performSearch(
	record: SessionRecord,
	query: string,
	frameId: string,
	observation: { frames: ReadonlyArray<{ id: string; is_oopif: boolean }> },
	options: { countOnly?: boolean } = {},
): Promise<{ count: number; indices: ReadonlySet<number> }> {
	const session: BrowserSession = record.session;
	const client = session.cdpClient;
	const manager = session.sessionManager;
	const focus = session.agentFocusTargetId;
	if (client === null || manager === null || focus === null) {
		throw new ToolError('browser-unavailable', 'the session is not connected');
	}
	const frame = observation.frames.find((entry) => entry.id === frameId);
	const cdp = frame?.is_oopif === true
		? await manager.getOrCreateCdpSession(frameId as TargetId, false)
		: await manager.getOrCreateCdpSession(focus, true);
	const sessionId: SessionId = cdp.sessionId;

	const reverse = new Map<string, number>();
	for (const [index, node] of session.cachedBrowserState?.domState.selectorMap ?? []) {
		reverse.set(`${node.sessionId}:${node.backendNodeId}`, index);
	}

	let searchId: string | null = null;
	try {
		const started = await client.send.DOM.performSearch({ query, includeUserAgentShadowDOM: false }, sessionId);
		searchId = started.searchId;
		const count = started.resultCount;
		const indices = new Set<number>();
		// `browser_wait_for` only needs to know *whether* the page matches, and the
		// describe loop below is up to 50 CDP round-trips per tick. Skipping it is
		// the difference between a poll that costs one call and one that costs
		// fifty-one, on a path a page can wake at its own rate.
		if (count > 0 && options.countOnly !== true) {
			const { nodeIds } = await client.send.DOM.getSearchResults(
				{ searchId, fromIndex: 0, toIndex: Math.min(count, SEARCH_DESCRIBE_LIMIT) },
				sessionId,
			);
			for (const nodeId of nodeIds) {
				const described = await client.send.DOM.describeNode({ nodeId }, sessionId).catch(() => null);
				const backendNodeId = described?.node.backendNodeId;
				if (backendNodeId === undefined) continue;
				const index = reverse.get(`${sessionId}:${backendNodeId}`);
				if (index !== undefined) indices.add(index);
			}
		}
		return { count, indices };
	} catch (cause) {
		if (cause instanceof ToolError) throw cause;
		throw new ToolError('browser-unavailable', cause instanceof Error ? cause.message : String(cause));
	} finally {
		// Never leaked, whatever happened above: the id is a Chromium-side allocation.
		if (searchId !== null) await client.send.DOM.discardSearchResults({ searchId }, sessionId).catch(() => {});
	}
}

/**
 * Whether a frame's document is in a different security origin from the top document — **D-056, the
 * sole authorization input for the frame read**, and since SEC-FH-23 the same input to
 * `browser_fill_secret`'s confinement refusal.
 *
 * It is exported for that second caller rather than copied into it: "are these two documents in the
 * same origin" must have one answer in this product, and the credential path had a second one
 * (`originOf`-equality) that called two *different* opaque origins the same.
 *
 * Two rulings the naive comparison gets wrong, both settled by the design and both load-bearing:
 *
 * 1. **Process-ness is never consulted.** Chromium's site isolation keys on scheme+site and ignores
 *    the port, so a cross-origin frame is routinely *same-process* — the corpus owns the
 *    counter-example, `iframe_same_site_port`, `127.0.0.1:38111` hosting `127.0.0.1:38112`, pierced
 *    in place in one session. A gate that read `FrameContext.isOopif` would hand an unscoped
 *    principal a cross-origin document (SEC-FH-1), so `isOopif` is deliberately not a parameter here.
 * 2. **An origin that cannot be named is cross-origin.** `about:blank`, `about:srcdoc`, a
 *    `javascript:` frame and an empty URL all reduce to `'null'` or `''`, and a naive `===` would
 *    report two of them same-origin. This is stricter than the web platform — a `srcdoc` frame
 *    genuinely inherits its parent's origin — and deliberately so: "I could not name the origin" and
 *    "it is the same origin" are different statements and only one of them is true, which is the
 *    sentence {@linkcode assertUnitViewportScale} already makes about the viewport scale.
 *
 * Both URLs come from `liveFrameIdentity`, read from the frame tree at the moment of the call, never
 * from `cachedBrowserState` — a cached URL compares a page against a memory of itself. The
 * comparison is scheme, host and port; never the path or the query (§8.3).
 */
export function isCrossOrigin(frameUrl: string, topUrl: string): boolean {
	const nameable = (url: string): string | null => {
		const parsed = URL.parse(url);
		if (parsed === null) return null;
		return parsed.origin === '' || parsed.origin === 'null' ? null : parsed.origin;
	};
	const frame = nameable(frameUrl);
	const top = nameable(topUrl);
	return frame === null || top === null || frame !== top;
}

/**
 * The raw outer HTML of one document of this session — the top one, or the frame the caller named.
 *
 * **`resolve -> authorize -> extract -> re-authorize`.** The first three are invariant I-FH-1 and a
 * *shape*, not a promise: every refusal below Gate B is thrown before an extraction call has been
 * constructed, so no refusal on the `frame_id` path can carry a byte of the top document. A reviewer
 * who reorders those statements breaks a test.
 *
 * **The fourth exists because the first three are not enough (SEC-FH-17).** Gate B reads the origin
 * from the frame tree; the extraction is five CDP round trips later and returns whatever the frame
 * holds *then*. A frame that navigates cross-origin in that window would answer a verdict computed
 * from the URL it used to have — cross-origin bytes to a principal without `evaluate`, and no ledger
 * row, because `cross` was false when it was computed. So the authorization input is taken **from
 * the read itself**: {@linkcode frameDocumentHtml} returns the origin the answering document
 * reported on the same receiver in the same round trip, and Gate B′ below decides from that. It is a
 * closed window rather than a smaller one — re-reading `Page.getFrameTree` after the extraction
 * would only have moved it.
 *
 * **The default path stays cheap (I-FH-6, C-12).** No `observe()`, no DOM tree, no touch of the
 * cached element table: exactly one `Page.getFrameTree` — which is what makes `url` and `frame_id`
 * *live* rather than remembered — and one `Runtime.evaluate`. The `Page.getFrameTree` is the whole
 * cost this tool gained, and it buys provenance a frameset makes ambiguous otherwise.
 *
 * **The size fields are the server's measurement, not the page's (SEC-FH-24).** D-057 moved the
 * 200 000-character cap into the page for the bandwidth, and for one revision that was also the only
 * thing bounding the answer — so a page whose `outerHTML` getter returned an object with its own
 * `length` and `slice` chose the payload, and the `length` / `truncated` / `returned_length` it was
 * reported under were the page's claims. {@linkcode frameDocumentHtml} now re-clamps server-side, and
 * every number below is derived from the string this process is holding rather than from a field the
 * page filled in. The in-page slice stays: it is still the reason an honest 40 MB document does not
 * cross the CDP channel, and it is no longer load-bearing for anything else.
 *
 * **Masking is deliberately absent and this is the documented exception to it** (DD-7,
 * `SPECS/CONNECTORS-MCP-A2A-A2UI.md` §3.3): the document comes back verbatim, a `value=` on a
 * password input included. What changed is *which* documents are reachable, which is why the
 * cross-origin ones are bound to the `evaluate` scope rather than masked — masking here would make
 * the tool's one documented property false and would control nothing, since `browser_evaluate` reads
 * the same bytes.
 */
export async function browserGetHtml(
	args: { frame_id?: string; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	const record = await target(ctx, args, false);
	// Gate A: membership, from this record's own cached state, zero CDP calls. An id this session
	// never held — including one minted by another session — is *absent* rather than probed.
	const frame = await frameContext(record, args.frame_id);
	// Gate B: attachment and live identity, one Page.getFrameTree shared with the provenance fields.
	const identity = await liveFrameIdentity(record, frame);
	// SEC-17: the message names the frame and never the scope — an error message is a probe result,
	// where the tool *description* is public documentation and does name it. `ctx.scopes` is absent
	// for every direct constructor, so a missing authorization fact fails closed. One spelling, used
	// by both gates, because two spellings of one denial is how they drift apart.
	const refuse = () => {
		throw new ToolError('scope-required', `this credential cannot read frame ${identity.frameId} of this page`);
	};
	const permitted = ctx.scopes?.has('evaluate') === true;
	// Gate B: the cheap refusal, on the URL the tree just reported. It is not the authorization of
	// record — Gate B′ is — but it keeps an obviously cross-origin read from costing five CDP round
	// trips, and it is what makes every refusal row spend nothing past `Page.getFrameTree`.
	//
	// `!frame.isTop` on both predicates: the focused document is trivially same-origin with itself and
	// must stay reachable on the grant every principal already holds — including when it is
	// `about:blank`, where the origin comparison would otherwise answer "cross" for a page compared
	// against itself (architecture §5.2).
	if (!frame.isTop && isCrossOrigin(identity.frameUrl, identity.topUrl) && !permitted) refuse();
	// ---- no extraction call exists above this line (I-FH-1) ----
	const out = await frameDocumentHtml(record, frame, HTML_LIMIT);
	// Gate B′ (SEC-FH-17): the authorization of record, taken from the origin the document that
	// ANSWERED reported — same receiver, same round trip, no window in between. `!frame.isTop` is
	// kept for the reason Gate B keeps it, and it is also what leaves the default path's decision
	// untouched: with no `frame_id` there is nothing here to re-check.
	const cross = !frame.isTop && isCrossOrigin(out.origin, identity.topUrl);
	// The bytes exist in this process and go no further: the throw happens before `payload` and
	// before `say`, so I-FH-1 / C-7 hold over the text block and `structuredContent` alike. No audit
	// row is written, deliberately — see the `if (cross)` block below.
	if (cross && !permitted) refuse();
	ctx.registry.touch(record.id);

	// SEC-FH-24: every size below is measured from the string THIS process is holding.
	// {@linkcode frameDocumentHtml} has already cut `out.html` to `HTML_LIMIT` on the server's own
	// authority and floored `out.length` with what actually arrived, so `returned_length` is the
	// length of the text block and cannot exceed the cap, and `truncated` is a relation between two
	// fields of this very payload rather than a comparison against a bound the page was trusted to
	// have applied. The old `out.length > HTML_LIMIT` said "the page told me it was big"; this says
	// "I am handing you less than there is", which is the sentence the field was always documented
	// to make — and it keeps `returned_length === length` true exactly when `truncated` is false.
	const returnedLength = out.html.length;
	const truncated = out.length > returnedLength;
	// I-3: the document stays in the text block alone. Copying 200 000 characters into
	// `structuredContent` would double the largest payload in the catalog, and no consumer asked for
	// the second copy. Every new field here is metadata about those bytes, never a second copy of them.
	const payload: Record<string, unknown> = {
		session_id: record.id,
		frame_id: identity.frameId,
		url: identity.frameUrl,
		// I-D3: the token of the table the server ALREADY holds. This tool mints none and observes
		// nothing, so `null` is a valid answer and is not a claim about the HTML's freshness.
		state_token: heldToken(record),
		// F-3: the document's TRUE length, which until 0.2.0 was replaced by the cap on truncation —
		// so a caller could not tell a 200 000-character document from a 40 MB one. Server-measured
		// since SEC-FH-24: a page that under-reports its own size has its claim replaced by the
		// number of characters that actually arrived, so this is never smaller than
		// `returned_length`.
		length: out.length,
		truncated,
		returned_length: returnedLength,
		media_type: 'text/html',
	};
	if (cross) {
		// Appended AFTER a successful read, so `result_bytes` is a fact rather than an intention, and
		// only then — a refusal writes no row, because nothing privileged happened. This differs
		// deliberately from `browser_evaluate`, which audits whether or not the expression threw:
		// there, "code ran here" is the fact worth recording. Never a document byte, prefix or digest
		// (I-FH-5, SEC-FH-6).
		//
		// **A Gate B′ refusal writes no row either, and that is a decision rather than an omission.**
		// The ledger's stated subject is "a cross-origin document reached the model" (§4.10 of the
		// security evidence, I-FH-5). On a Gate B′ refusal it did not: the bytes were discarded inside
		// this process and the caller received an error. Writing a row there would (a) record a
		// capability nobody gained — which is a true statement about a REFUSAL, where the bytes reached
		// nobody, and deliberately not the reason same-origin reads are silent: that one is the
		// ledger's subject (a cross-origin document reached the model), because an unscoped same-origin
		// frame read does extend what is reachable (RR-5, corrected at REV-2);
		// (b) make this the only refusal in the tool that writes one, so a reviewer could no longer
		// read "no row" as "no cross-origin read"; and (c) hand a principal a way to mint ledger rows
		// at will, by reading a frame it can make navigate. The race the row would have evidenced is
		// closed rather than logged — and `ok` therefore stays `true` for every row of this kind, as
		// C-9's frozen key set and `audit_test.ts` both assert.
		const entry = record.audit.append({
			session_id: record.id,
			principal: ctx.principal,
			kind: 'read-frame-html',
			frame_id: identity.frameId,
			// Scheme, host and port, from the document that ANSWERED rather than from the URL the tree
			// reported before the read — so the ledger names the document whose bytes were handed over
			// (SEC-FH-17). Never the path or the query, which is where a one-time code or a session
			// token appears (`SPECS/SECURITY-AUTH.md` §8.3), and `location.origin` carries neither.
			origin: out.origin,
			result_bytes: new TextEncoder().encode(out.html).length,
			ok: true,
		});
		payload.audit_id = entry.audit_id;
	}
	// I-4: the text block is byte for byte what 0.1.0 sent, the trailing notice included.
	return say(payload, truncated ? `${out.html}\n\n[truncated at ${HTML_LIMIT} characters]` : out.html);
}

export async function browserScreenshot(
	args: { full_page?: boolean; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	const record = await target(ctx, args, false);
	// A10: a full-page capture of a long document can take seconds; a cancelled call stops waiting for it (the
	// capture itself is the browser's and finishes on its own, unread).
	const base64 = await untilAborted(
		dispatch<string>(record.session, new ScreenshotEvent({ fullPage: args.full_page ?? false }), { raiseIfNone: true }),
		ctx.signal,
	);
	ctx.registry.touch(record.id);
	if (typeof base64 !== 'string' || base64.length === 0) {
		throw new ToolError('browser-unavailable', 'screenshot capture returned no image');
	}
	// The base64 stays in the image block; the structured half is metadata only.
	return image(
		{
			session_id: record.id,
			media_type: 'image/png',
			bytes: byteLengthOfBase64(base64),
			full_page: args.full_page ?? false,
		},
		base64,
		'image/png',
	);
}

/** Decoded byte count of a base64 string, without decoding it. */
function byteLengthOfBase64(data: string): number {
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return Math.floor(data.length / 4) * 3 - padding;
}
