/** The `input` producer, against a page that is assumed hostile. */
import { assert, assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { SessionEventRing } from './events.ts';
import type { SessionRecord } from './registry.ts';
import {
	consoleLevelOf,
	ConsoleProducer,
	DOM_SETTLE_QUIET_MS,
	DomSettleProducer,
	INPUT_EVENT_KINDS,
	MAX_BINDING_PAYLOAD_BYTES,
	MAX_CONSOLE_TEXT,
	PageInputProducer,
} from './page_producers.ts';
import { FakeTime } from '@std/testing/time';

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
	const lengths = source.match(/\.length/g) ?? [];
	assertEquals(lengths.length, 1, 'the only .length is the mutation-batch count');
	assert(source.includes('records.length'), 'the one length read is the MutationRecord batch size');
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
	r.stub.fire('Target.attachedToTarget', { sessionId: 'S3', targetInfo: { type: 'service_worker' } });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assertEquals(r.producer.injectedSessions, before + 1);
	r.stub.fire('Target.detachedFromTarget', { sessionId: 'S2' });
	assertEquals(r.producer.injectedSessions, before);
	await r.producer.dispose();
});

// --- The `console` producer: armed by the ring's refcount, minting one record per `Runtime.consoleAPICalled` / `exceptionThrown`, and never a handle, url or source position. ---

type ConsoleListener = (params: Record<string, unknown>) => void;

function stub(): {
	client: unknown;
	fire(event: string, params: Record<string, unknown>): void;
	listeners: Map<string, Set<ConsoleListener>>;
} {
	const listeners = new Map<string, Set<ConsoleListener>>();
	const client = {
		on(event: string, listener: ConsoleListener) {
			const set = listeners.get(event) ?? new Set<ConsoleListener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
	};
	return {
		client,
		listeners,
		fire(event, params) {
			for (const listener of listeners.get(event) ?? []) listener(params);
		},
	};
}

function consoleRig() {
	const s = stub();
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	const record = { id: 'sess', events: ring, lock: null, session: { cdpClient: s.client } } as unknown as SessionRecord;
	const producer = ConsoleProducer.attach(record)!;
	assert(producer !== null);
	ring.setConsoleArmed(producer.setArmed);
	return {
		producer,
		stub: s,
		ring,
		records: () => ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }),
	};
}

Deno.test('console: nothing is minted before a subscriber arms the kind', () => {
	const r = consoleRig();
	r.stub.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'before' }] });
	assertEquals(r.records().filter((entry) => entry.kind === 'console').length, 0);
});

Deno.test('console: an armed subscriber receives a record with a mapped level and joined text', () => {
	const r = consoleRig();
	r.ring.armConsole();
	assertEquals(r.producer.armed, true);
	r.stub.fire('Runtime.consoleAPICalled', {
		type: 'warning',
		args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }],
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload, { level: 'warn', text: 'hello 42', truncated: false });
});

Deno.test('console: an exception mints an error record from text and description', () => {
	const r = consoleRig();
	r.ring.armConsole();
	r.stub.fire('Runtime.exceptionThrown', {
		exceptionDetails: {
			text: 'Uncaught',
			exception: { description: 'TypeError: x is not a function' },
			url: 'https://secret.example/token',
		},
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload.level, 'error');
	assertEquals(record.payload.text, 'Uncaught TypeError: x is not a function');
	assertEquals(JSON.stringify(record.payload).includes('secret.example'), false);
});

Deno.test('console: no object handle reaches the record', () => {
	const r = consoleRig();
	r.ring.armConsole();
	r.stub.fire('Runtime.consoleAPICalled', {
		type: 'log',
		args: [{ type: 'object', objectId: 'obj-123-live-handle', description: 'Object' }],
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload.text, 'Object');
	assertEquals(JSON.stringify(record.payload).includes('obj-123'), false, 'no live handle reaches the wire');
});

Deno.test('console: disarming on the last subscriber stops the listener', () => {
	const r = consoleRig();
	r.ring.armConsole();
	r.ring.disarmConsole();
	assertEquals(r.producer.armed, false);
	r.stub.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after' }] });
	assertEquals(r.records().filter((entry) => entry.kind === 'console').length, 0);
});

Deno.test('console: the level map is closed', () => {
	assertEquals(consoleLevelOf('error'), 'error');
	assertEquals(consoleLevelOf('assert'), 'error');
	assertEquals(consoleLevelOf('warning'), 'warn');
	assertEquals(consoleLevelOf('debug'), 'debug');
	assertEquals(consoleLevelOf('info'), 'info');
	assertEquals(consoleLevelOf('table'), 'log', 'an unmapped type falls to log, never echoed');
});

Deno.test('a console line is redacted before its cap, so a secret straddling it leaves no prefix', () => {
	const s = stub();
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	const record = { id: 'sess', events: ring, lock: null, session: { cdpClient: s.client } } as unknown as SessionRecord;
	const secret = 'Zq8-CONSOLE-SECRET';
	const producer = ConsoleProducer.attach(record, (text) => text.replaceAll(secret, '[secret]'))!;
	ring.setConsoleArmed(producer.setArmed);
	ring.armConsole();
	const line = `${'a'.repeat(MAX_CONSOLE_TEXT - 3)}${secret}`;
	s.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: line }] });
	s.fire('Runtime.exceptionThrown', { exceptionDetails: { text: line } });
	const texts = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((entry) => entry.kind === 'console')
		.map((entry) => String(entry.payload.text));
	assertEquals(texts.length, 2);
	for (const text of texts) {
		assert(text.length <= MAX_CONSOLE_TEXT);
		assert(!text.endsWith('Zq8'), text.slice(-6));
	}
});

// --- The `dom.settled` producer: debounces mutation batches into one record per quiet transition, carries the state token, and reads nothing while no subscriber wants the kind. ---

function settleRig(options: { token?: string | null; onRead?: () => void } = {}) {
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	let reads = 0;
	const record = {
		id: 'sess',
		events: ring,
		session: {
			getBrowserStateSummary: () => {
				reads += 1;
				options.onRead?.();
				return Promise.resolve({ stateToken: options.token ?? 'stk1:abc:def' });
			},
		},
	} as unknown as SessionRecord;
	const producer = new DomSettleProducer({ record });
	return {
		producer,
		ring,
		reads: () => reads,
		records: () => ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }),
	};
}

Deno.test('dom.settled: no subscriber, no read — mutations are observed for free', async () => {
	using time = new FakeTime();
	const r = settleRig();
	r.producer.onMutation(3);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(r.reads(), 0, 'an unwatched session must do no state read');
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0);
});

Deno.test('dom.settled: an armed subscriber gets one record after the quiet window, carrying the token', async () => {
	using time = new FakeTime();
	const r = settleRig({ token: 'stk1:aaaa:bbbb' });
	r.ring.armDomSettled();
	r.producer.onMutation(2);
	r.producer.onMutation(5);
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0, 'not before the window elapses');
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	const record = r.records().find((entry) => entry.kind === 'dom.settled');
	assert(record !== undefined);
	assertEquals(record.payload, { token: 'stk1:aaaa:bbbb', mutations: 7, quiet_ms: DOM_SETTLE_QUIET_MS });
});

Deno.test('dom.settled: a mutation before the window elapses restarts it — a busy page never settles', async () => {
	using time = new FakeTime();
	const r = settleRig();
	r.ring.armDomSettled();
	for (let i = 0; i < 5; i += 1) {
		r.producer.onMutation(1);
		await time.tickAsync(DOM_SETTLE_QUIET_MS - 100); // never a full quiet window
	}
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0, 'the window kept restarting');
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(
		r.records().filter((entry) => entry.kind === 'dom.settled').length,
		1,
		'one settle once it finally goes quiet',
	);
});

Deno.test('dom.settled: the mutation count resets after each settle', async () => {
	using time = new FakeTime();
	const r = settleRig();
	r.ring.armDomSettled();
	r.producer.onMutation(4);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	r.producer.onMutation(1);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	const settled = r.records().filter((entry) => entry.kind === 'dom.settled');
	assertEquals(settled.map((entry) => entry.payload.mutations), [4, 1]);
});

Deno.test('dom.settled: dispose stops any pending settle', async () => {
	using time = new FakeTime();
	const r = settleRig();
	r.ring.armDomSettled();
	r.producer.onMutation(3);
	r.producer.dispose();
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(r.reads(), 0);
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0);
});
