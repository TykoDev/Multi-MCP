/**
 * B1.9's `input` producer, against a page that is assumed hostile.
 *
 * Every field of an `input` record is server-derived, and each test here is one
 * forgery the page attempts and does not get: `source: 'human'`, an
 * `element_index` of its choosing, `value_masked: false` on a real password
 * field. The rest bound what a binding call may cost.
 *
 * The CDP client is a stub rather than a real one: what is being proved is what
 * this module does with a payload, and a real Chromium would prove that no
 * harder. U-6 — that the listener reaches an OOPIF and survives a navigation —
 * is a browser-tier question and is answered there.
 */
import { assert, assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { SessionEventRing } from './events.ts';
import type { SessionRecord } from './registry.ts';
import { INPUT_EVENT_KINDS, MAX_BINDING_PAYLOAD_BYTES, PageInputProducer } from './page_input.ts';

const SECRET = 'Hunter2-SENTINEL-b91f';

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

interface Stub {
	client: unknown;
	fire(event: string, params: Record<string, unknown>, sessionId?: string): void;
	sends: Array<{ method: string; params: unknown; sessionId?: string }>;
}

function stubClient(): Stub {
	const listeners = new Map<string, Set<Listener>>();
	const sends: Array<{ method: string; params: unknown; sessionId?: string }> = [];
	const record = (method: string) => (params: unknown, sessionId?: string) => {
		sends.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
		return Promise.resolve(method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script-1' } : {});
	};
	const client = {
		on(event: string, listener: Listener) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		send: {
			Runtime: {
				enable: record('Runtime.enable'),
				addBinding: record('Runtime.addBinding'),
				removeBinding: record('Runtime.removeBinding'),
			},
			Page: {
				addScriptToEvaluateOnNewDocument: record('Page.addScriptToEvaluateOnNewDocument'),
				removeScriptToEvaluateOnNewDocument: record('Page.removeScriptToEvaluateOnNewDocument'),
			},
		},
	};
	return {
		client,
		sends,
		fire(event, params, sessionId) {
			for (const listener of listeners.get(event) ?? []) listener(params, sessionId);
		},
	};
}

function inputNode(attributes: Record<string, string>, frameId: string): EnhancedDomTreeNode {
	return {
		nodeName: 'INPUT',
		attributes,
		frameId,
		axNode: { role: 'textbox', name: '', properties: [{ name: 'focused', value: true }] },
		childrenNodes: [],
		compoundChildren: [],
		snapshotNode: { inputValue: attributes.value ?? null },
	} as unknown as EnhancedDomTreeNode;
}

interface Rig {
	producer: PageInputProducer;
	stub: Stub;
	record: SessionRecord;
	records(): Array<{ kind: string; payload: Record<string, unknown> }>;
	setNow(ms: number): void;
}

function rig(options: { selectorMap?: Map<number, EnhancedDomTreeNode>; locked?: boolean } = {}): Rig {
	const stub = stubClient();
	let now = 1_000_000;
	const ring = new SessionEventRing({ now: () => now });
	const record = {
		id: 'sess-1',
		events: ring,
		lock: options.locked === true ? { holder: 'v1', principal: 'human', takenAt: now, holderName: null } : null,
		session: {
			cdpClient: stub.client,
			cachedBrowserState: options.selectorMap === undefined ? null : { domState: { selectorMap: options.selectorMap } },
			sessionManager: { sessions: new Map([['S1', { type: 'page' }]]), sessionTargets: new Map([['S1', 'T1']]) },
		},
	} as unknown as SessionRecord;
	const producer = PageInputProducer.attach({ record, now: () => now });
	assert(producer !== null);
	return {
		producer,
		stub,
		record,
		records: () =>
			ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }) as Array<
				{ kind: string; payload: Record<string, unknown> }
			>,
		setNow: (ms) => void (now = ms),
	};
}

/** One binding call, as the page would make it. */
function call(r: Rig, payload: unknown, sessionId = 'S1', name?: string): void {
	r.stub.fire('Runtime.bindingCalled', {
		name: name ?? r.producer.bindingName,
		payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
	}, sessionId);
}

// --- the three forgeries ----------------------------------------------------

Deno.test('input: a page cannot claim a human typed — source comes from the lock', async () => {
	const r = rig();
	call(r, { k: 'input', source: 'human' });
	const minted = r.records().filter((record) => record.kind === 'input');
	assertEquals(minted.length, 1);
	assertEquals(minted[0]?.payload.source, 'tool');
	await r.producer.dispose();
});

Deno.test('input: source is human exactly when a human holds the lock', async () => {
	const r = rig({ locked: true });
	call(r, { k: 'input' });
	assertEquals(r.records().find((record) => record.kind === 'input')?.payload.source, 'human');
	await r.producer.dispose();
});

Deno.test('input: a page cannot choose element_index — it is null with no server table', async () => {
	const r = rig();
	call(r, { k: 'input', element_index: 42 });
	const payload = r.records().find((record) => record.kind === 'input')?.payload;
	assertEquals(payload?.element_index, null);
	// And the fact of typing still survives: the record mints, the pointer does not.
	assertEquals(payload?.kind, 'input');
	await r.producer.dispose();
});

Deno.test("input: element_index is the server's own focused node for the frame", async () => {
	const map = new Map<number, EnhancedDomTreeNode>([[7, inputNode({ type: 'text', value: 'London' }, 'T1')]]);
	const r = rig({ selectorMap: map });
	call(r, { k: 'input', element_index: 42 });
	const payload = r.records().find((record) => record.kind === 'input')?.payload;
	assertEquals(payload?.element_index, 7);
	assertEquals(payload?.value_masked, false);
	await r.producer.dispose();
});

Deno.test('input: value_masked is derived from the predicate and a page cannot set it false', async () => {
	const map = new Map<number, EnhancedDomTreeNode>([[3, inputNode({ type: 'password', value: SECRET }, 'T1')]]);
	const r = rig({ selectorMap: map });
	call(r, { k: 'input', value_masked: false });
	const payload = r.records().find((record) => record.kind === 'input')?.payload;
	assertEquals(payload?.value_masked, true);
	await r.producer.dispose();
});

Deno.test('input: value_masked fails closed when no node resolves', async () => {
	// `false` is the assertion that costs something — it tells a consumer the
	// field is ordinary, and therefore safe to read into a model transcript.
	const r = rig();
	call(r, { k: 'input' });
	assertEquals(r.records().find((record) => record.kind === 'input')?.payload.value_masked, true);
	await r.producer.dispose();
});

Deno.test('input: no record carries any part of a typed value, for any element', async () => {
	const map = new Map<number, EnhancedDomTreeNode>([
		[1, inputNode({ type: 'password', value: SECRET }, 'T1')],
	]);
	const r = rig({ selectorMap: map });
	call(r, { k: 'input', value: SECRET, length: SECRET.length, prefix: SECRET.slice(0, 3) });
	const emitted = JSON.stringify(r.records());
	assert(!emitted.includes(SECRET), emitted);
	assert(!emitted.includes(SECRET.slice(0, 4)), emitted);
	assert(!emitted.includes(String(SECRET.length)), 'a length is a password-strength oracle');
	await r.producer.dispose();
});

// --- the bounds -------------------------------------------------------------

Deno.test('input: kind is a closed enum, and an unknown value is mapped rather than echoed', async () => {
	const r = rig();
	call(r, { k: 'x'.repeat(4096).slice(0, 200) });
	const payload = r.records().find((record) => record.kind === 'input')?.payload;
	assertEquals(payload?.kind, 'other');
	assert((INPUT_EVENT_KINDS as readonly string[]).includes(payload?.kind as string));
	await r.producer.dispose();
});

Deno.test('input: an over-long payload is dropped before it is parsed', async () => {
	const r = rig();
	call(r, `{"k":"input","pad":"${'a'.repeat(MAX_BINDING_PAYLOAD_BYTES)}"}`);
	assertEquals(r.records().filter((record) => record.kind === 'input').length, 0);
	await r.producer.dispose();
});

Deno.test('input: malformed JSON is dropped silently, never logged per call', async () => {
	const warnings: string[] = [];
	const stub = stubClient();
	const ring = new SessionEventRing({});
	const record = {
		id: 's',
		events: ring,
		lock: null,
		session: { cdpClient: stub.client, cachedBrowserState: null, sessionManager: null },
	} as unknown as SessionRecord;
	const producer = PageInputProducer.attach({ record, logger: { warn: (m) => warnings.push(m) } });
	assert(producer !== null);
	for (let i = 0; i < 20; i++) {
		stub.fire('Runtime.bindingCalled', { name: producer.bindingName, payload: 'not json' });
	}
	assertEquals(warnings.length, 0, 'a per-call log turns the binding into a log amplifier');
	assertEquals(ring.size, 0);
	await producer.dispose();
});

Deno.test('input: a call under another binding name is ignored', async () => {
	const r = rig();
	call(r, { k: 'input' }, 'S1', 'someone_elses_binding');
	assertEquals(r.records().filter((record) => record.kind === 'input').length, 0);
	await r.producer.dispose();
});

Deno.test('input: the call rate is capped per window and the loss is reported once', async () => {
	const r = rig();
	for (let i = 0; i < 200; i++) call(r, { k: 'input' });
	const minted = r.records().filter((record) => record.kind === 'input');
	assert(minted.length <= 50, `${minted.length} records admitted in one window`);
	// The drop is reported on the next window rather than per call.
	r.setNow(1_002_000);
	call(r, { k: 'input' });
	const capped = r.records().filter((record) => record.payload.event === 'rate-capped');
	assertEquals(capped.length, 1);
	assertEquals(capped[0]?.payload.kind, 'input');
	assert((capped[0]?.payload.dropped as number) > 0);
	await r.producer.dispose();
});

// --- the injection and its removal ------------------------------------------

Deno.test('input: the binding and world names are per session and never constants', async () => {
	const a = rig();
	const b = rig();
	assert(a.producer.bindingName !== b.producer.bindingName);
	assert(a.producer.worldName !== b.producer.worldName);
	assert(a.producer.bindingName.length > 16);
	await a.producer.dispose();
	await b.producer.dispose();
});

Deno.test('input: the listener is installed into a named isolated world, never the page world', async () => {
	const r = rig();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const binding = r.stub.sends.find((send) => send.method === 'Runtime.addBinding');
	assert(binding !== undefined, 'no binding was added');
	assertEquals((binding.params as { executionContextName?: string }).executionContextName, r.producer.worldName);
	const script = r.stub.sends.find((send) => send.method === 'Page.addScriptToEvaluateOnNewDocument');
	assert(script !== undefined, 'no script was injected');
	const params = script.params as { worldName?: string; source: string; includeCommandLineAPI?: boolean };
	assertEquals(params.worldName, r.producer.worldName);
	assertEquals(params.includeCommandLineAPI, undefined);
	await r.producer.dispose();
});

Deno.test('input: the injected script reads nothing from the page', async () => {
	const r = rig();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const script = r.stub.sends.find((send) => send.method === 'Page.addScriptToEvaluateOnNewDocument');
	const source = (script?.params as { source: string }).source;
	// A cross-frame oracle clause as much as a disclosure one: the binding is a
	// server-side channel out of every cross-origin subframe, so anything the
	// script reads whose value differs by frame origin becomes a side channel the
	// page could not otherwise obtain.
	for (
		const forbidden of [
			'.value',
			'textContent',
			'innerText',
			'cookie',
			'localStorage',
			'sessionStorage',
			'selectionStart',
			'referrer',
			'location',
			'document.domain',
			'window.top',
			'.value.length',
			'textContent.length',
		]
	) {
		assert(!source.includes(forbidden), `the injected script reads ${forbidden}`);
	}
	// The **only** length the script reads is the MutationObserver batch size —
	// the sanctioned `dom.settled` mutation count (D-8), which carries no content
	// and no value length. Every other `.length` would be an oracle.
	const lengths = source.match(/\.length/g) ?? [];
	assertEquals(lengths.length, 1, 'the only .length is the mutation-batch count');
	assert(source.includes('records.length'), 'the one length read is the MutationRecord batch size');
	// And it drops an event the page synthesised.
	assert(source.includes('isTrusted'), 'a synthesised event must not be reported');
	await r.producer.dispose();
});

Deno.test('input: dispose removes the script and the binding, and is idempotent', async () => {
	const r = rig();
	await new Promise((resolve) => setTimeout(resolve, 5));
	await r.producer.dispose();
	await r.producer.dispose();
	const removals = r.stub.sends.filter((send) => send.method === 'Page.removeScriptToEvaluateOnNewDocument');
	const unbinds = r.stub.sends.filter((send) => send.method === 'Runtime.removeBinding');
	assertEquals(removals.length, 1);
	assertEquals(unbinds.length, 1);
	// And nothing mints after disposal.
	call(r, { k: 'input' });
	assertEquals(r.records().filter((record) => record.kind === 'input').length, 0);
});

Deno.test('input: a newly attached frame is injected once, and a detached one is forgotten', async () => {
	const r = rig();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const before = r.producer.injectedSessions;
	r.stub.fire('Target.attachedToTarget', { sessionId: 'S2', targetInfo: { type: 'iframe' } });
	r.stub.fire('Target.attachedToTarget', { sessionId: 'S2', targetInfo: { type: 'iframe' } });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assertEquals(r.producer.injectedSessions, before + 1);
	// A worker has no DOM to type into and is not injected.
	r.stub.fire('Target.attachedToTarget', { sessionId: 'S3', targetInfo: { type: 'service_worker' } });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assertEquals(r.producer.injectedSessions, before + 1);
	r.stub.fire('Target.detachedFromTarget', { sessionId: 'S2' });
	assertEquals(r.producer.injectedSessions, before);
	await r.producer.dispose();
});
