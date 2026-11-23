/** Perception handlers: the read-only tools that describe the page — state, HTML, screenshots. */
import { type BrowserSession, ScreenshotEvent } from '@tykotech/browser';
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
import { type HitTest, hitTest } from '../hittest.ts';
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

// --- the hit test in the browser ----------------------------------------------------------------

/** What the point-to-element read answers, shared by the tool and the live view's `live.hover`. */
interface ElementAtPoint {
	readonly hit: HitTest;
	/** The element record, masked by the one password predicate; `null` when nothing interactive is there. */
	readonly element: ObservedElement | null;
	/** The token of the table the index is valid in, or `null` when none is held. */
	readonly stateToken: string | null;
}

/** The element under a top-document viewport point, from the browser's own hit test. */
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

/** `browser_element_at {x, y}`: the topmost interactive element at a point, or `null`. */
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
 * Characters of one document `browser_get_html` carries back — **not** bytes, so an existing client's expectation
 * holds. The page applies it too, so a huge document never crosses CDP.
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
	// The DOM build is the expensive part of this tool; a cancelled call stops waiting for it.
	const observation = await observe(record, {
		includeScreenshot,
		fields: resolveFields(args.fields),
		...(args.element_limit === undefined ? {} : { elementLimit: args.element_limit }),
		...(args.include_hidden === undefined ? {} : { includeHidden: args.include_hidden }),
		...(args.frames === undefined ? {} : { frames: args.frames }),
		signal: ctx.signal,
	});
	ctx.registry.touch(record.id);

	// The text block is the frozen payload, five fields per element, byte for byte what an existing
	// client parses. The structured half is where every additional field lands, so the growth is
	// paid once. `available_secrets` is in both.
	const textPayload = observationPayload(observation);
	const structured = observationStructured(observation);

	// The *names* of the secrets usable on this page, so a model knows it can write `<secret>name</secret>` instead
	// of asking a human for a value. Names only, and only the ones this origin permits.
	if (ctx.secrets !== undefined && !ctx.secrets.empty) {
		const usable = ctx.secrets.namesFor(observation.url);
		if (usable.length > 0) {
			textPayload.available_secrets = usable;
			structured.available_secrets = usable;
		}
	}

	if (observation.screenshot !== undefined) {
		// The screenshot path carries `structuredContent` too: the tool declares an `outputSchema`,
		// and a success without it is a hard failure.
		return image(structured, observation.screenshot, 'image/png', JSON.stringify(textPayload, null, 2));
	}
	return projected(structured, textPayload);
}

// --- find, frames and the locator tools ---------------------------------------------------------

/** `browser_find`: ranks the current element table against a query. */
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
	// A full-table read (5000 elements) and then a browser-side search; cancellation ends either wait.
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

/** `browser_get_frames`: the frame list with the two honesty markers, from a fresh read. */
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
 * `browser_locator_candidates`: every candidate for one element of the table the caller holds, counted in memory as
 * of that capture.
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

/** `browser_verify_locator`: what the browser matches **today**. */
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

/** One `DOM.performSearch` in the session that owns `frameId`, always discarded. */
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
		// Chromium's DOM agent searches only a document it has been asked for: on a page no tool has read since it
		// loaded, `performSearch` finds nothing, so `browser_wait_for`'s `selector` and `text` would time out against
		// a page that matches (and `getSearchResults` has no nodeIds to hand back).
		await client.send.DOM.getDocument({ depth: 0 }, sessionId);
		const started = await client.send.DOM.performSearch({ query, includeUserAgentShadowDOM: false }, sessionId);
		searchId = started.searchId;
		const count = started.resultCount;
		const indices = new Set<number>();
		// `browser_wait_for` only needs to know *whether* the page matches, and the describe loop below is up to 50
		// CDP round-trips per tick.
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
 * Whether a frame's document is in a different security origin from the top document — **the sole authorization input
 * for the frame read**, and the same input to `browser_fill_secret`'s confinement refusal.
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

/** The raw outer HTML of one document of this session — the top one, or the frame the caller named. */
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
	// The message names the frame and never the scope — an error message is a probe result, where the tool
	// *description* is public documentation and does name it.
	const refuse = () => {
		throw new ToolError('scope-required', `this credential cannot read frame ${identity.frameId} of this page`);
	};
	const permitted = ctx.scopes?.has('evaluate') === true;
	// Gate B: the cheap refusal, on the URL the tree just reported.
	if (!frame.isTop && isCrossOrigin(identity.frameUrl, identity.topUrl) && !permitted) refuse();
	// ---- no extraction call exists above this line ----
	const out = await frameDocumentHtml(record, frame, HTML_LIMIT);
	// Gate B′: the authorization of record, taken from the origin the document that ANSWERED reported — same
	// receiver, same round trip, no window in between.
	const cross = !frame.isTop && isCrossOrigin(out.origin, identity.topUrl);
	// The bytes exist in this process and go no further: the throw happens before `payload` and before `say`, so no
	// byte reaches the text block or `structuredContent`.
	if (cross && !permitted) refuse();
	ctx.registry.touch(record.id);

	// Every size below is measured from the string THIS process is holding. {@linkcode frameDocumentHtml} has already
	// cut `out.html` to `HTML_LIMIT` on the server's own authority and floored
	// `out.length` with what actually arrived, so `returned_length` is the length of the text block and cannot exceed
	// the cap, and `truncated` is a relation between two fields of this very payload rather than a comparison against
	// a bound the page was trusted to have applied.
	const returnedLength = out.html.length;
	const truncated = out.length > returnedLength;
	// The document stays in the text block alone. Copying 200 000 characters into `structuredContent` would double
	// the largest payload in the catalog, and no consumer asked for the second copy.
	const payload: Record<string, unknown> = {
		session_id: record.id,
		frame_id: identity.frameId,
		url: identity.frameUrl,
		// The token of the table the server ALREADY holds. This tool mints none and observes
		// nothing, so `null` is a valid answer and is not a claim about the HTML's freshness.
		state_token: heldToken(record),
		// The document's TRUE length, not the cap, so a caller can tell a 200 000-character document from a 40 MB
		// one.
		length: out.length,
		truncated,
		returned_length: returnedLength,
		media_type: 'text/html',
	};
	if (cross) {
		// Appended AFTER a successful read, so `result_bytes` is a fact rather than an intention, and only then — a
		// refusal writes no row, because nothing privileged happened.
		const entry = record.audit.append({
			session_id: record.id,
			principal: ctx.principal,
			kind: 'read-frame-html',
			frame_id: identity.frameId,
			// Scheme, host and port, from the document that ANSWERED rather than from the URL the tree
			// reported before the read — so the ledger names the document whose bytes were handed over
			// Never the path or the query, which is where a one-time code or a session token appears,
			// and `location.origin` carries neither.
			origin: out.origin,
			result_bytes: new TextEncoder().encode(out.html).length,
			ok: true,
		});
		payload.audit_id = entry.audit_id;
	}
	// The text block is frozen byte for byte, the trailing notice included.
	return say(payload, truncated ? `${out.html}\n\n[truncated at ${HTML_LIMIT} characters]` : out.html);
}

export async function browserScreenshot(
	args: { full_page?: boolean; session_id?: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	ctx.signal?.throwIfAborted();
	const record = await target(ctx, args, false);
	// A full-page capture of a long document can take seconds; a cancelled call stops waiting for it (the
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
