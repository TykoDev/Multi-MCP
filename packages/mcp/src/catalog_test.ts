import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import * as z from 'zod';
import { annotationsFor, CATALOG, CATALOG_BY_NAME } from './catalog.ts';
import { missingFeature } from './dispatch.ts';
import { headRoutingRefusal } from './head.ts';
import { DEFAULT_SCOPES, EXPLICIT_SCOPES } from './scopes.ts';
import * as toolHandlers from './tools.ts';
import * as agentHandlers from './agent.ts';
import { FIELD_PRESETS } from './element_record.ts';

/**
 * Every module a catalog entry may take its handler from.
 *
 * The gate is equality in both directions, so adding a handler module here
 * without wiring its exports into the catalog fails — which is the point.
 */
const handlers: Record<string, unknown> = { ...toolHandlers, ...agentHandlers };

Deno.test('catalog: every definition maps to a distinct exported handler', () => {
	const exported = new Set(
		Object.entries(handlers)
			.filter(([name, value]) => typeof value === 'function' && name.startsWith('browser'))
			.map(([name]) => name),
	);
	const used = new Set<string>();
	for (const tool of CATALOG) {
		const match = Object.entries(handlers).find(([, fn]) => fn === tool.handler);
		assert(match !== undefined, `${tool.name} has a handler that is not exported from tools.ts`);
		assert(!used.has(match[0]), `${match[0]} is wired to more than one tool`);
		used.add(match[0]);
	}
	// Both directions: an exported handler nothing calls is dead wire.
	const unusedHandlers = [...exported].filter((name) => !used.has(name));
	assertEquals(unusedHandlers, [], `handlers exported but not in the catalog: ${unusedHandlers.join(', ')}`);
});

Deno.test('catalog: names are unique, snake_case, and browser-prefixed', () => {
	const seen = new Set<string>();
	for (const tool of CATALOG) {
		assert(!seen.has(tool.name), `duplicate tool name ${tool.name}`);
		seen.add(tool.name);
		assert(/^[a-z][a-z0-9_]*$/.test(tool.name), `${tool.name} is not snake_case`);
		assert(tool.name.startsWith('browser_'), `${tool.name} lacks the browser_ prefix`);
	}
	// 15 in the v1 specification, plus browser_extract_content (R1),
	// browser_run_task (R2), browser_storage_state (R3), browser_record (R7) and
	// the two session-file tools (E-33). A literal here is deliberate: growing the
	// catalog should be a decision someone took, not something that happened.
	// ...plus the four B1.6 perception tools: find, frames, locator candidates,
	// verify locator; B1.7's browser_wait_for — the third view of the event ring
	// and the only one that works on the stdio mount; and B1.12's two: a download
	// that names the file it started, and a head request that asks a server about
	// a URL without carrying its body back.
	// ...plus B2.1's browser_element_at, the hit test in the browser; B2.4's three pointer tools:
	// hover, double click and right click, each of which is browser_click's own cascade with one
	// argument changed rather than a second click implementation; and B2.5's seven: fill, scroll_to,
	// scroll_into_view, select_option, upload_file, drag and handle_dialog; and B2.6's three session
	// tools: get_session, set_viewport and set_session_options; B2.7's browser_evaluate, which is
	// the first and only holder of an EXPLICIT_SCOPES member and therefore the first catalog entry
	// most principals will never see in tools/list at all; and B2.8's browser_fill_secret and
	// browser_audit — the credential path and the ledger that records it was spent; and B2.9's
	// browser_file_policy, the limits a client can read instead of guess.
	// ...and B3.2's browser_health, the one tool an operator polls rather than a model calls.
	// ...and R4's three inspection tools (D-116): the network log, the console log and its HAR export.
	// ...and R9's (W7) browser_live_view and browser_live_ticket, the MCP Apps live view and its embed ticket.
	//
	// **The whole list by name, not a count.** A `CATALOG.length` assertion was
	// what this test carried until B3.2, and twice in this delivery a stale count
	// somewhere else in the tree hid a real change until a tier was run by hand:
	// a number cannot say *which* tool arrived or left, so a rename plus an
	// addition passes it. The literal below fails with a diff naming the tool.
	assertEquals(CATALOG.map((tool) => tool.name).sort(), [
		// W2 (R10/R11, design §2.3): browser_accessibility_snapshot, browser_file_link, browser_pdf, browser_performance.
		'browser_accessibility_snapshot',
		'browser_audit',
		'browser_click',
		'browser_close_all',
		'browser_close_session',
		'browser_close_tab',
		'browser_console_log',
		'browser_double_click',
		'browser_download',
		'browser_drag',
		'browser_element_at',
		'browser_evaluate',
		'browser_extract_content',
		'browser_file_link',
		'browser_file_policy',
		'browser_fill',
		'browser_fill_secret',
		'browser_find',
		'browser_get_file',
		'browser_get_frames',
		'browser_get_html',
		'browser_get_session',
		'browser_get_state',
		'browser_go_back',
		'browser_handle_dialog',
		'browser_har_export',
		'browser_head',
		'browser_health',
		'browser_hover',
		'browser_list_files',
		'browser_list_sessions',
		'browser_list_tabs',
		'browser_live_ticket',
		'browser_live_view',
		'browser_locator_candidates',
		'browser_navigate',
		'browser_network_log',
		'browser_pdf',
		'browser_performance',
		'browser_press_key',
		'browser_record',
		// mcp-recommendations W4 (R2, D-124): the human handoff, off unless TTK_HUMAN_HANDOFF.
		'browser_request_human',
		'browser_right_click',
		'browser_run_task',
		'browser_screenshot',
		'browser_scroll',
		'browser_scroll_into_view',
		'browser_scroll_to',
		'browser_select_option',
		'browser_set_session_options',
		'browser_set_viewport',
		'browser_storage_state',
		'browser_switch_tab',
		'browser_type',
		'browser_upload_file',
		'browser_verify_locator',
		'browser_wait_for',
	]);
});

Deno.test('catalog: read-only tools are annotated read-only and mutating ones are not; every hint is explicit', () => {
	for (const tool of CATALOG) {
		const annotations = annotationsFor(tool);
		// A7: openWorldHint is always stated — its MCP default (true) would otherwise claim the web for every tool.
		assertEquals(typeof annotations.openWorldHint, 'boolean', `${tool.name} leaves openWorldHint to the default`);
		if (tool.mutates) {
			assertEquals(annotations.readOnlyHint, undefined, `${tool.name} is mutating but hints read-only`);
			assertEquals(typeof annotations.destructiveHint, 'boolean', `${tool.name} leaves destructiveHint implicit`);
			assertEquals(typeof annotations.idempotentHint, 'boolean', `${tool.name} leaves idempotentHint implicit`);
		} else {
			assertEquals(annotations.readOnlyHint, true, `${tool.name} is read-only but does not hint it`);
			assertEquals(annotations.destructiveHint, undefined, `${tool.name} is read-only; destructive is meaningless`);
		}
	}
});

Deno.test('catalog: close tools are flagged destructive', () => {
	for (const name of ['browser_close_tab', 'browser_close_session', 'browser_close_all']) {
		const tool = CATALOG_BY_NAME.get(name);
		assert(tool !== undefined, `${name} missing from the catalog`);
		assertEquals(annotationsFor(tool).destructiveHint, true, `${name} should hint destructive`);
	}
});

Deno.test('catalog: exactly the three privileged tools carry an extra scope, plus the handoff its view scope', () => {
	const scoped = CATALOG.filter((tool) => tool.scope !== undefined).map((tool) => tool.name).sort();
	// mcp-recommendations W4 (R2, D-124) and W7 (R9, D-134): the handoff and the two MCP Apps tools carry the view
	// scope their live-view half needs. None is privileged: each is gated OFF by its deployment switch
	// (`TTK_HUMAN_HANDOFF`, `TTK_MCP_APPS`) instead, which the availability tests pin.
	assertEquals(scoped, [
		'browser_close_all',
		'browser_evaluate',
		'browser_live_ticket',
		'browser_live_view',
		'browser_request_human',
		'browser_run_task',
	]);
	assertEquals(CATALOG_BY_NAME.get('browser_request_human')?.scope, 'view:control');
	assertEquals(CATALOG_BY_NAME.get('browser_live_view')?.scope, 'view:watch');
	assertEquals(CATALOG_BY_NAME.get('browser_live_ticket')?.scope, 'view:watch');
	assertEquals(CATALOG_BY_NAME.get('browser_close_all')?.scope, 'admin');
	// The autonomous loop spends the caller's model and acts without a per-action
	// confirmation, so it is gated separately from ordinary tool use — and from
	// 0.2.0 it is gated **off** by default (SEC-01b): `task` is an EXPLICIT_SCOPES
	// member, so no principal holds it unless a deployment named it.
	assertEquals(CATALOG_BY_NAME.get('browser_run_task')?.scope, 'task');
	// B2.7 / SEC-01b. The holders of an EXPLICIT_SCOPES member — which is the difference between "gated" and "gated
	// by default off". C7 / D-098 moved `admin` there, so `browser_close_all` is gated off by default too.
	assertEquals(CATALOG_BY_NAME.get('browser_evaluate')?.scope, 'evaluate');
	assertEquals(
		CATALOG.filter((tool) => tool.scope !== undefined && (EXPLICIT_SCOPES as readonly string[]).includes(tool.scope))
			.map((tool) => tool.name).sort(),
		['browser_close_all', 'browser_evaluate', 'browser_run_task'],
	);
	// And none of the privileged three is reachable on the default grant, by name; the only default-scope tools are
	// the view-scoped handoff and MCP Apps pair, which their deployment switches withhold (R2, R9).
	assertEquals(
		CATALOG.filter((tool) => tool.scope !== undefined && (DEFAULT_SCOPES as readonly string[]).includes(tool.scope))
			.map((tool) => tool.name).sort(),
		['browser_live_ticket', 'browser_live_view', 'browser_request_human'],
	);
	assertEquals(
		CATALOG_BY_NAME.get('browser_request_human')?.available?.({ persistence: true, recording: true, egress: true }),
		false,
	);
});

Deno.test('catalog: every browser tool accepts an optional session_id', () => {
	for (const tool of CATALOG) {
		// browser_list_sessions and browser_close_all are session-independent;
		// browser_close_session requires the id rather than defaulting it.
		// Since SR-HEAD-REDIRECT browser_head touches no browser at all — it is a
		// server-side request — so a session_id would be a lie about what it uses.
		// B2.9's browser_file_policy is the same shape of exemption: the limits are a *deployment*
		// fact, identical for every session, so accepting an id would invite a caller to believe the
		// answer could differ per session.
		// B3.2's browser_health joins them for the same reason browser_file_policy did, one step
		// stronger: it reports the whole registry, so a session id would suggest a per-session
		// answer exists. It also never resolves a session, which is what keeps a poll from
		// launching a browser.
		const sessionless = [
			'browser_list_sessions',
			'browser_close_all',
			'browser_head',
			'browser_file_policy',
			'browser_health',
		];
		if (sessionless.includes(tool.name)) continue;
		const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ??
			(tool.inputSchema as unknown as { _def?: { schema?: { shape?: Record<string, unknown> } } })._def?.schema?.shape;
		assert(shape !== undefined, `${tool.name} has no inspectable object shape`);
		assert('session_id' in shape, `${tool.name} does not accept session_id`);
	}
});

Deno.test('catalog: every pointer tool requires exactly index or a full coordinate pair', () => {
	// B2.4 shares one `POINTER_INPUT` between all four, and this is the assertion that the sharing is
	// real rather than three copies that happen to agree today.
	for (const name of ['browser_click', 'browser_double_click', 'browser_right_click', 'browser_hover']) {
		const schema = CATALOG_BY_NAME.get(name)!.inputSchema;
		assert(schema.safeParse({ index: 3 }).success, `${name}: index alone should parse`);
		assert(schema.safeParse({ coordinate_x: 1, coordinate_y: 2 }).success, `${name}: a coordinate pair should parse`);
		assert(!schema.safeParse({}).success, `${name}: neither index nor coordinates must fail`);
		assert(!schema.safeParse({ index: 1, coordinate_x: 1, coordinate_y: 2 }).success, `${name}: both must fail`);
		assert(!schema.safeParse({ coordinate_x: 1 }).success, `${name}: a half coordinate pair must fail`);
	}
});

Deno.test('catalog: B2.5 select_option takes exactly one selector, and drag takes two whole endpoints', () => {
	const select = CATALOG_BY_NAME.get('browser_select_option')!.inputSchema;
	assert(select.safeParse({ index: 3, value: 'b' }).success);
	assert(select.safeParse({ index: 3, label: 'Beta' }).success);
	assert(select.safeParse({ index: 3, index_in_list: 1 }).success);
	assert(!select.safeParse({ index: 3 }).success, 'no selector must fail');
	assert(!select.safeParse({ index: 3, value: 'b', label: 'Beta' }).success, 'two selectors must fail');
	// `index_in_list: 0` is a real option position, so the refinement must count presence rather than
	// truthiness — a falsy-valued selector that read as absent would silently select nothing.
	assert(select.safeParse({ index: 3, index_in_list: 0 }).success, 'option 0 is a valid selector');

	const drag = CATALOG_BY_NAME.get('browser_drag')!.inputSchema;
	assert(drag.safeParse({ from: { index: 1 }, to: { x: 2, y: 3 } }).success);
	assert(drag.safeParse({ from: { x: 1, y: 2 }, to: { index: 4 } }).success);
	assert(!drag.safeParse({ from: {}, to: { index: 4 } }).success, 'an empty endpoint must fail');
	assert(!drag.safeParse({ from: { x: 1 }, to: { index: 4 } }).success, 'a half coordinate pair must fail');
	assert(!drag.safeParse({ from: { index: 1, x: 1, y: 2 }, to: { index: 4 } }).success, 'both must fail');
	assert(!drag.safeParse({ from: { index: 1 } }).success, 'a missing endpoint must fail');
});

Deno.test('catalog: schemas reject unknown-typed arguments', () => {
	const navigate = CATALOG_BY_NAME.get('browser_navigate')!.inputSchema;
	assert(!navigate.safeParse({ url: 'not-a-url' }).success);
	assert(navigate.safeParse({ url: 'https://example.com' }).success);

	const scroll = CATALOG_BY_NAME.get('browser_scroll')!.inputSchema;
	assert(!scroll.safeParse({ direction: 'sideways' }).success);
	assert(scroll.safeParse({ direction: 'down' }).success);
	assert(!scroll.safeParse({ direction: 'down', pages: 99 }).success, 'pages is capped at 10');
});

Deno.test('catalog: every schema emits JSON Schema for tools/list', () => {
	for (const tool of CATALOG) {
		const jsonSchema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
		assertEquals(typeof jsonSchema, 'object', `${tool.name} produced no JSON Schema`);
	}
});

// --- availability (R5) ------------------------------------------------------

Deno.test('catalog: the persistence tools are unavailable without a data directory', () => {
	const tool = CATALOG_BY_NAME.get('browser_storage_state');
	assert(tool?.available !== undefined, 'browser_storage_state should declare availability');
	assertEquals(tool.available({ persistence: false, recording: false, egress: false }), false);
	assertEquals(tool.available({ persistence: true, recording: false, egress: false }), true);
});

Deno.test('catalog: recording is offered only where it can be encoded', () => {
	const tool = CATALOG_BY_NAME.get('browser_record');
	assert(tool?.available !== undefined, 'browser_record should declare availability');
	assertEquals(tool.available({ persistence: true, recording: false, egress: false }), false);
	assertEquals(tool.available({ persistence: true, recording: true, egress: false }), true);
	// It only observes, so a human holding the browser is a reason to record it.
	assertEquals(tool.mutates, false);
});

/**
 * G-2, at its cause. Before B1.2 eight mutating tools carried
 * `available: (state) => !state.allSessionsLocked`, which meant that when
 * *every* session was human-held they were disabled — and the SDK answers a
 * disabled tool with a JSON-RPC error, which aborts the model's turn instead
 * of telling it to wait. The partial-lock case never had the defect, because
 * `SessionRegistry.assertUnlocked` answered it with a classifiable
 * `Error: human-has-control:` result. Now one mechanism answers both.
 *
 * The rule this replaces: `available` describes only what this *deployment*
 * can offer, so every predicate must be a static configuration fact and a
 * disabled tool must always name the feature it is waiting on.
 */
Deno.test('catalog: availability is deployment configuration only, never session state (G-2)', () => {
	const scoped = CATALOG.filter((tool) => tool.available !== undefined).map((tool) => tool.name).sort();
	// W2: browser_file_link is gated on TTK_SIGNED_LINKS (an opt-in switch, so it declares unavailableDetail).
	assertEquals(scoped, [
		'browser_file_link',
		'browser_head',
		'browser_live_ticket',
		'browser_live_view',
		'browser_record',
		'browser_request_human',
		'browser_storage_state',
	]);

	// And every one resolves to a named feature or explains itself, so `feature-unavailable` can never be emitted
	// with a bare `is not available on this deployment`. S0 (design §2.0 item 7): a tool gated on an opt-in switch
	// declares `unavailableDetail` naming its `TTK_*` switch instead of resolving to a feature.
	const none = { persistence: false, recording: false, egress: false };
	for (const tool of CATALOG) {
		if (tool.available === undefined) continue;
		assert(
			missingFeature(tool, none) !== undefined || tool.unavailableDetail !== undefined,
			`${tool.name} is disabled by something that is not persistence, recording or egress, and does not say why`,
		);
	}
});

// --- output schemas (D-A2) --------------------------------------------------

/**
 * Invariant I-5. A non-object root makes `projectCallToolResult` wrap the
 * payload as `{result: …}` on the 2025 codec while the 2026 codec's
 * projection is the identity, so the wire shape would differ between the two
 * eras this server serves for the same handler — and
 * `appendTextFallbackForNonObject` would inject a text block at position 0,
 * colliding with the `Error: <code>: ` first-block convention.
 *
 * Both halves are asserted: the Zod type, and the JSON Schema actually
 * emitted, because the conversion is where a root can stop being an object.
 */
Deno.test('catalog: every outputSchema has an object root (I-5)', () => {
	for (const tool of CATALOG) {
		assert(tool.outputSchema instanceof z.ZodObject, `${tool.name}'s outputSchema is not a ZodObject`);
		const emitted = z.toJSONSchema(tool.outputSchema, { io: 'output' }) as { type?: string };
		assertEquals(emitted.type, 'object', `${tool.name}'s emitted output JSON Schema is not object-rooted`);
	}
});

Deno.test('catalog: every tool declares an outputSchema, and it is its own', () => {
	const seen = new Map<z.ZodType, string>();
	for (const tool of CATALOG) {
		assert(tool.outputSchema !== undefined, `${tool.name} declares no outputSchema`);
		// A schema shared between two tools is almost always a copy-paste in a
		// 400-line literal rather than a deliberate reuse.
		const other = seen.get(tool.outputSchema);
		assertEquals(other, undefined, `${tool.name} shares an outputSchema with ${other}`);
		seen.set(tool.outputSchema, tool.name);
	}
});

Deno.test('catalog: browser_head needs the grant AND a routing it can follow (SR3-M2)', () => {
	// Two static deployment facts with one owner — the predicate — so a later
	// reader cannot restore the tool by editing whichever half is nearer to hand.
	const tool = CATALOG_BY_NAME.get('browser_head');
	assert(tool?.available !== undefined && tool.unavailableDetail !== undefined);
	const base = { persistence: true, recording: true, egress: true, headRouting: null };
	assertEquals(tool.available(base), true);
	assertEquals(tool.available({ ...base, egress: false }), false, 'no proven outbound grant, no tool');
	const diverging = { ...base, headRouting: headRoutingRefusal(['--proxy-server=http://p:3128']) };
	assertEquals(tool.available(diverging), false, 'a diverging browser route withholds it');
	// And the refusal explains itself rather than naming a feature: the generic
	// "needs egress on this deployment" message told an operator nothing they
	// could act on, which the runtime smoke measured.
	const detail = tool.unavailableDetail(diverging);
	assert(detail !== undefined);
	assertStringIncludes(detail, '--proxy-server');
	assertEquals(tool.unavailableDetail(base), undefined, 'a healthy deployment adds no detail');
	assertEquals(tool.unavailableDetail({ ...base, egress: false }), undefined, 'nor does a missing grant');
});

/**
 * R-1: `tools/list` told every client that `core` includes `locator`; D-035 had moved it out.
 * The docs and `capabilities.tykotech.fields` were correct — only the wire text was stale, and
 * nothing asserted any tool description in either direction.
 *
 * The pin derives the claim from {@linkcode FIELD_PRESETS} rather than restating it, so a preset
 * edited without the description fails here, and it reads the description off the emitted JSON
 * Schema rather than off the Zod object, because the emitted schema is what a client receives.
 */
Deno.test('catalog: the fields description states the presets FIELD_PRESETS actually emits (R-1)', () => {
	const core = [...FIELD_PRESETS.core];
	const fullExtras = FIELD_PRESETS.full.filter((f) => !FIELD_PRESETS.core.includes(f));
	let checked = 0;
	for (const tool of CATALOG) {
		const emitted = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as {
			properties?: Record<string, { description?: string }>;
		};
		const description = emitted.properties?.fields?.description;
		if (description === undefined) continue;
		checked++;
		const coreClaim = /core \(default: minimal plus ([^)]+)\)/.exec(description);
		assert(coreClaim !== null, `${tool.name}: the fields description makes no parseable core claim`);
		assertEquals(
			coreClaim[1]?.split(', '),
			core,
			`${tool.name}: the wire says core emits fields it does not`,
		);
		const fullClaim = /full \(core plus ([^)]+)\)/.exec(description);
		assert(fullClaim !== null, `${tool.name}: the fields description makes no parseable full claim`);
		assertEquals(
			fullClaim[1]?.split(', '),
			fullExtras,
			`${tool.name}: the wire says full adds fields it does not, or omits ones it does`,
		);
	}
	// Non-vacuity: the four perception tools take `fields`. A refactor that stops
	// emitting the description would otherwise pass this test by checking nothing.
	assertEquals(checked, 4, 'the fields argument reached a different number of tools than expected');
});
