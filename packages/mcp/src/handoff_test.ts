/**
 * R2 (D-124, AC19) and the handoff half of F3 (D-126, AC23): `browser_request_human` through the real HTTP entry.
 *
 * Off by default, and then on with a capture-backed session so the handler reads a real element table: the URL
 * elicitation a URL-capable 2026 client receives, both answers to it, the link every other client receives, and the
 * `requestState` it is sealed with — tampered, replayed by another principal, and replayed against another session.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { AuthInfo, ClientCapabilities } from '@modelcontextprotocol/server';
import { captureHarness } from '../fixtures/capture_session.ts';
import { HANDOFF_OUTPUT } from './catalog/handoff.ts';
import { createBuildServer, type McpDeps } from './server.ts';
import { HANDOFF_KEY } from './tools/handoff.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const PUBLIC = 'https://mcp.example.test';
const viewUrl = (id: string) => new URL(`/#/view/${encodeURIComponent(id)}`, PUBLIC).href;
const URL_CLIENT: ClientCapabilities = { elicitation: { url: {} } };
const REASON = 'Please solve the CAPTCHA on the sign-in page.';

function principal(clientId: string): AuthInfo {
	return { token: 't', clientId, scopes: ['mcp:invoke', 'view:watch', 'view:control'], extra: {} };
}

async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		for (const line of text.split('\n')) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text);
}

interface Call {
	era?: string;
	method?: string;
	args?: Record<string, unknown>;
	caps?: ClientCapabilities;
	responses?: Record<string, unknown>;
	state?: string;
	auth?: AuthInfo;
}

async function rpc(handler: ReturnType<typeof createMcpHandler>, c: Call = {}): Promise<Record<string, unknown>> {
	const era = c.era ?? MODERN;
	const method = c.method ?? 'tools/call';
	const params: Record<string, unknown> = method === 'tools/call'
		? { name: 'browser_request_human', arguments: c.args ?? { reason: REASON } }
		: {};
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: c.caps ?? {} };
		if (c.responses !== undefined) params.inputResponses = c.responses;
		if (c.state !== undefined) params.requestState = c.state;
		headers['mcp-method'] = method;
		if (method === 'tools/call') headers['mcp-name'] = 'browser_request_human';
	}
	const response = await handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 3, method, params }),
		}),
		{ authInfo: c.auth ?? principal('alice') },
	);
	return await readRpc(response);
}

async function served(handoff: boolean) {
	const h = await captureHarness('baseline_button');
	const deps: McpDeps = { registry: h.registry, version: '0.0.0-test', ...(handoff ? { viewUrl } : {}) };
	const handler = createMcpHandler(createBuildServer(deps), { legacy: 'stateless' });
	return {
		...h,
		handler,
		async [Symbol.asyncDispose]() {
			await handler.close();
			await h.registry.shutdown();
		},
	};
}

type Result = {
	resultType?: string;
	isError?: boolean;
	content?: Array<{ text?: string }>;
	structuredContent?: Record<string, unknown> & { error?: { code?: string; message?: string; feature?: string } };
	inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>;
	requestState?: string;
};

function resultOf(body: Record<string, unknown>): Result {
	assertEquals(body.error, undefined, `expected a result, got ${JSON.stringify(body.error)}`);
	return body.result as Result;
}

/** Asserts a success equals its own parse by the declared schema: no undeclared field, nothing stripped. */
function roundTrips(result: Result): Record<string, unknown> {
	const structured = result.structuredContent as Record<string, unknown>;
	assertEquals(HANDOFF_OUTPUT.browser_request_human.parse(structured) as Record<string, unknown>, structured);
	return structured;
}

// --- off --------------------------------------------------------------------------------------------------------

for (const era of [LEGACY, MODERN]) {
	Deno.test(`AC19 (${era}): off by default — absent from tools/list, and a call names TTK_HUMAN_HANDOFF`, async () => {
		await using s = await served(false);
		const listed = resultOf(await rpc(s.handler, { era, method: 'tools/list' })) as { tools?: Array<{ name: string }> };
		const names = (listed.tools ?? []).map((tool) => tool.name);
		assert(names.includes('browser_get_state'), 'the listing is the real catalog');
		assert(!names.includes('browser_request_human'), 'the handoff is listed while TTK_HUMAN_HANDOFF is off');

		const refused = resultOf(await rpc(s.handler, { era, caps: URL_CLIENT }));
		assertEquals(refused.isError, true);
		assertEquals(refused.structuredContent?.error?.code, 'feature-unavailable');
		assertStringIncludes(refused.structuredContent?.error?.message ?? '', 'TTK_HUMAN_HANDOFF');
		// An opt-in switch is not a `feature` (design §2.4): the closed extra stays persistence|recording|egress.
		assertEquals(refused.structuredContent?.error?.feature, undefined);
	});
}

// --- on ---------------------------------------------------------------------------------------------------------

Deno.test('AC19: a URL-capable 2026 client is asked to open <public>/#/view/<id>, with no query and no ticket', async () => {
	await using s = await served(true);
	const listed = resultOf(await rpc(s.handler, { method: 'tools/list' })) as { tools?: Array<{ name: string }> };
	assert((listed.tools ?? []).some((tool) => tool.name === 'browser_request_human'), 'not listed while on');

	const asked = resultOf(await rpc(s.handler, { caps: URL_CLIENT }));
	assertEquals(asked.resultType, 'input_required');
	const entry = asked.inputRequests?.[HANDOFF_KEY];
	assertEquals(entry?.method, 'elicitation/create');
	assertEquals(entry?.params.mode, 'url');
	assertEquals(entry?.params.message, REASON);
	assertEquals(entry?.params.url, `${PUBLIC}/#/view/default`);
	assertEquals(new URL(String(entry?.params.url)).search, '', 'the handoff URL carries a query');
	assertEquals(typeof asked.requestState, 'string');
	assert(!String(asked.requestState).includes('default'), 'the state is a sealed envelope, not the session id');
});

Deno.test('AC19: accept answers accepted with a fresh state token; decline and cancel answer user-declined', async () => {
	await using s = await served(true);
	const state = resultOf(await rpc(s.handler, { caps: URL_CLIENT })).requestState!;

	const done = resultOf(
		await rpc(s.handler, {
			caps: URL_CLIENT,
			responses: { [HANDOFF_KEY]: { action: 'accept' } },
			state,
		}),
	);
	assertEquals(done.isError, undefined, JSON.stringify(done));
	const payload = roundTrips(done);
	assertEquals(payload.outcome, 'accepted');
	assertEquals(payload.delivery, 'elicitation');
	assertEquals(payload.live_view_url, `${PUBLIC}/#/view/default`);
	assertEquals(payload.human_has_control, false);
	assertEquals(payload.state_token, s.record.session.cachedBrowserState?.stateToken, 'the table was not re-read');
	assert(typeof payload.state_token === 'string');

	for (const action of ['decline', 'cancel']) {
		const refused = resultOf(
			await rpc(s.handler, {
				caps: URL_CLIENT,
				responses: { [HANDOFF_KEY]: { action } },
				state,
			}),
		);
		assertEquals(refused.isError, true, action);
		assertEquals(refused.structuredContent?.error?.code, 'user-declined', action);
	}
});

Deno.test('AC19: a client without elicitation.url gets the live view URL as a result, on every era', async () => {
	await using s = await served(true);
	const shapes: Call[] = [
		{ era: MODERN, caps: {} },
		{ era: MODERN, caps: { elicitation: {} } },
		{ era: MODERN, caps: { elicitation: { form: {} } } },
		{ era: LEGACY },
	];
	for (const shape of shapes) {
		const linked = resultOf(await rpc(s.handler, shape));
		assertEquals(linked.resultType === 'input_required', false, JSON.stringify(shape));
		const payload = roundTrips(linked);
		assertEquals(payload.delivery, 'link', JSON.stringify(shape));
		assertEquals(payload.outcome, 'link-returned', JSON.stringify(shape));
		assertEquals(payload.live_view_url, `${PUBLIC}/#/view/default`, JSON.stringify(shape));
		assertStringIncludes(linked.content?.[0]?.text ?? '', `${PUBLIC}/#/view/default`);
	}
});

Deno.test('AC19: the tool never creates a session', async () => {
	await using s = await served(true);
	const refused = resultOf(await rpc(s.handler, { args: { reason: REASON, session_id: 'nobody' } }));
	assertEquals(refused.structuredContent?.error?.code, 'unknown-session');
	assertEquals(s.registry.peek('nobody'), undefined);
});

Deno.test('AC19/AC23: a tampered state and a state replayed by another principal are refused at the seam', async () => {
	await using s = await served(true);
	const state = resultOf(await rpc(s.handler, { caps: URL_CLIENT })).requestState!;
	const answer = { [HANDOFF_KEY]: { action: 'accept' } };

	const [head, body, mac] = state.split('.');
	const flipped = `${mac!.slice(0, -2)}${mac!.endsWith('AA') ? 'BB' : 'AA'}`;
	for (const forged of [`${head}.${body}.${flipped}`, 'not-a-state', `${head}.${body}`]) {
		const refused = await rpc(s.handler, { caps: URL_CLIENT, responses: answer, state: forged });
		assertEquals((refused.error as { code?: number } | undefined)?.code, -32602, `accepted a forged state ${forged}`);
	}

	// F3: the state is bound to the principal it was minted for; another one echoing it is refused before the
	// handler runs, with the same frozen error — it learns nothing about whose state it was.
	const replayed = await rpc(s.handler, { caps: URL_CLIENT, responses: answer, state, auth: principal('mallory') });
	assertEquals((replayed.error as { code?: number } | undefined)?.code, -32602);
	assertEquals((replayed.error as { message?: string } | undefined)?.message, 'Invalid or expired requestState');

	// And the principal it was minted for is still served.
	assertEquals(
		roundTrips(resultOf(await rpc(s.handler, { caps: URL_CLIENT, responses: answer, state }))).outcome,
		'accepted',
	);
});

Deno.test('AC19: a genuine state for another session, or none at all, does not complete this handoff', async () => {
	await using s = await served(true);
	const second = await s.registry.createNew('second');
	const other = resultOf(await rpc(s.handler, { caps: URL_CLIENT, args: { reason: REASON, session_id: second.id } }))
		.requestState!;
	const answer = { [HANDOFF_KEY]: { action: 'accept' } };

	const crossed = resultOf(await rpc(s.handler, { caps: URL_CLIENT, responses: answer, state: other }));
	assertEquals(crossed.structuredContent?.error?.code, 'invalid-arguments');
	const stateless = resultOf(await rpc(s.handler, { caps: URL_CLIENT, responses: answer }));
	assertEquals(stateless.structuredContent?.error?.code, 'invalid-arguments');
});
