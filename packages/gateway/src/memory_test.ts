/**
 * D-154: the agents' vector memory.
 *
 * Proven here, in an in-memory database and against a stub provider on loopback only: the built-in embedder is
 * deterministic, normalised and pinned (its id names its vector space); ranking puts the relevant item first; owners
 * never see one another's memory, through the store and through the MCP tools; a collection keeps the embedder it was
 * created with, and refuses when that embedder is gone; every bound refuses; saves upsert; deletes and drops remove
 * exactly what they say, the drop by cascade; the similarity refuses vectors of different lengths instead of scoring
 * them; the provider embedder sends the OpenAI shape with the key only as a bearer header, refuses redirects, and never
 * echoes a key or an upstream body; the control-plane helpers validate strictly.
 */
import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import {
	createToolExecutor,
	extensionTools,
	type Scope,
	SCOPES,
	SessionRegistry,
	type ToolResult,
} from '@tykotech/mcp';
import { Database } from './database.ts';
import {
	applyMemoryConfig,
	BUILTIN_EMBEDDER_ID,
	decodeVector,
	DOT_SQL,
	encodeVector,
	LEXICAL_DIMS,
	lexicalEmbed,
	MEMORY_COLLECTION_PATTERN,
	MEMORY_FILTER_KEY_PATTERN,
	MEMORY_ID_PATTERN,
	MEMORY_LIMITS,
	MemoryError,
	MemoryStore,
	memorySystemView,
	parseMemoryConfigBody,
} from './memory.ts';
import { memoryActions } from './memory_tools.ts';
import type { ModelProviderSettings } from './model_providers.ts';
import { HttpProblem } from './problem.ts';

const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';
/** Sixteen-plus characters, so it would be recognisable anywhere it leaked. */
const KEY = 'sk-memory-0123456789abcdefghijklmnop';

function norm(vector: Float32Array): number {
	return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

/** The non-zero buckets of a vector, rounded, as `[index, value]` pairs. */
function buckets(vector: Float32Array): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	vector.forEach((value, index) => {
		if (value !== 0) out.push([index, Math.round(value * 1e6) / 1e6]);
	});
	return out;
}

/** An OpenAI-compatible provider as the providers file would resolve it. */
function provider(
	baseUrl: string,
	apiKey: string | null,
	overrides: Partial<ModelProviderSettings> = {},
): ModelProviderSettings {
	return {
		id: 'local',
		kind: 'openai',
		label: 'Local',
		baseUrl,
		host: new URL(baseUrl).host,
		models: ['chat-model', 'embed-small'],
		defaultModel: 'chat-model',
		apiKey,
		keySource: apiKey === null ? 'none' : 'inline',
		headers: { 'x-team': 'memory' },
		allowHttp: false,
		maxTokensParam: 'max_tokens',
		maxSteps: 24,
		maxOutputTokens: 4096,
		tokenBudget: 400_000,
		...overrides,
	};
}

interface Seen {
	readonly path: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: { model?: string; input?: string[] };
}

/**
 * A stub embeddings endpoint on 127.0.0.1. `answer` decides each response; by default it answers a 3-dimensional
 * vector per input, in reverse order with `index` set, so the client must sort.
 */
function stubProvider(answer?: (seen: Seen) => Response | Promise<Response>) {
	const seen: Seen[] = [];
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		const body = await request.json().catch(() => ({}));
		const record: Seen = {
			path: new URL(request.url).pathname,
			method: request.method,
			headers: request.headers,
			body,
		};
		seen.push(record);
		if (answer !== undefined) return await answer(record);
		const input = body.input ?? [];
		const data = input.map((text: string, index: number) => ({
			index,
			embedding: [text.length, 1, text.includes('cat') ? 5 : 0],
		})).reverse();
		return Response.json({ object: 'list', data, model: body.model });
	});
	return { seen, url: `http://127.0.0.1:${server.addr.port}/v1`, close: () => server.shutdown() };
}

Deno.test('memory: the built-in embedder is deterministic, normalised and pinned to its vector space', () => {
	const a = lexicalEmbed('The cat sat on the mat');
	assertEquals(a.length, LEXICAL_DIMS);
	assertEquals(buckets(a), buckets(lexicalEmbed('The cat sat on the mat')));
	assert(Math.abs(norm(a) - 1) < 1e-6);
	// Case, punctuation and Unicode normalisation do not change the features; a different word does.
	assertEquals(buckets(lexicalEmbed('THE CAT, sat on the mat!')), buckets(a));
	assertEquals(buckets(lexicalEmbed('école')), buckets(lexicalEmbed('école')));
	assert(buckets(lexicalEmbed('The dog sat on the mat')).join() !== buckets(a).join());
	// No letters or digits: a zero vector, which scores 0 against everything.
	assertEquals(buckets(lexicalEmbed('?! …')), []);
	// Pinned: `builtin:lexical-512` names exactly this hashing. If this fails, the hashing changed and every stored
	// vector would silently sit in another space — give the new algorithm a new id instead.
	assertEquals(buckets(lexicalEmbed('Hello, world')), [[110, -0.57735], [236, -0.57735], [313, 0.57735]]);
	assertEquals(buckets(lexicalEmbed('ÉCOLE école ｅｃｏｌｅ')), [
		[134, 0.69903],
		[205, -0.412859],
		[392, -0.412859],
		[487, 0.412859],
	]);
});

Deno.test('memory: vectors are stored as little-endian Float32 and read back exactly', () => {
	assertEquals([...encodeVector(new Float32Array([1, -2]))], [0, 0, 128, 63, 0, 0, 0, 192]);
	const vector = new Float32Array([0.25, -0.5, 3]);
	assertEquals([...decodeVector(encodeVector(vector))], [...vector]);
	// An unaligned view is copied, not misread.
	const padded = new Uint8Array(13);
	padded.set(encodeVector(vector), 1);
	assertEquals([...decodeVector(padded.subarray(1))], [...vector]);
	assertThrows(() => decodeVector(new Uint8Array(5)), Error, 'whole number of floats');
});

Deno.test('memory: a relevant item outranks an irrelevant one, best first, with a metadata filter', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		const saved = await store.save(ALICE, 'notes', [
			{ id: 'cat', text: 'The cat sat on the warm mat by the fire', metadata: { kind: 'pet', n: 1, ok: true } },
			{ id: 'tax', text: 'Quarterly tax filing is due at the end of March', metadata: { kind: 'admin', n: 2 } },
			{ id: 'dog', text: 'A dog barked at the mailman', metadata: { kind: 'pet', ok: false, z: null } },
		]);
		assertEquals(saved, {
			collection: 'notes',
			embedder: BUILTIN_EMBEDDER_ID,
			created: true,
			ids: ['cat', 'tax', 'dog'],
		});
		const { results, embedder } = await store.search(ALICE, 'notes', 'where did the cat sit?', 3);
		assertEquals(embedder, BUILTIN_EMBEDDER_ID);
		assertEquals(results[0]!.id, 'cat');
		assertEquals(results[0]!.metadata, { kind: 'pet', n: 1, ok: true });
		assert(results[0]!.score > results.find((hit) => hit.id === 'tax')!.score);
		assert(results.every((hit, i) => i === 0 || results[i - 1]!.score >= hit.score), 'best first');
		assertEquals((await store.search(ALICE, 'notes', 'cat', 1)).results.length, 1);

		// Filters compare by JSON type: `true` is not `1`, a missing key is not `null`.
		const ids = async (filter: Record<string, string | number | boolean | null>) =>
			(await store.search(ALICE, 'notes', 'cat', 20, filter)).results.map((hit) => hit.id).sort();
		assertEquals(await ids({ kind: 'pet' }), ['cat', 'dog']);
		assertEquals(await ids({ kind: 'pet', ok: true }), ['cat']);
		assertEquals(await ids({ n: 2 }), ['tax']);
		assertEquals(await ids({ ok: 1 }), []);
		assertEquals(await ids({ z: null }), ['dog']);
		assertEquals(await ids({ missing: null }), []);
	} finally {
		db.close();
	}
});

Deno.test('memory: owners never see, search or delete one another’s memory', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		await store.save(ALICE, 'notes', [{ id: 'a1', text: 'alice private fact about cats' }]);
		assertEquals(store.collections(BOB), []);
		const missing = await assertRejects(() => store.search(BOB, 'notes', 'cats'), MemoryError);
		assertEquals(missing.code, 'not-found');
		assertEquals(store.delete(BOB, 'notes', ['a1']), 0);
		assertEquals(store.delete(BOB, 'notes', 'all'), 0);
		assertEquals(store.drop(BOB, 'notes'), null);
		// Bob's own collection of the same name is a different collection.
		await store.save(BOB, 'notes', [{ id: 'a1', text: 'bob note about dogs' }]);
		assertEquals((await store.search(BOB, 'notes', 'cats')).results.map((hit) => hit.text), ['bob note about dogs']);
		assertEquals((await store.search(ALICE, 'notes', 'cats')).results.map((hit) => hit.text), [
			'alice private fact about cats',
		]);
		assertEquals(store.collections(ALICE).map((c) => [c.name, c.items]), [['notes', 1]]);
	} finally {
		db.close();
	}
});

Deno.test('memory: saves upsert by id; deletes remove ids or every item; a drop cascades', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		await store.save(ALICE, 'notes', [{ id: 'x', text: 'first version', metadata: { v: 1 } }, { text: 'generated' }]);
		const again = await store.save(ALICE, 'notes', [{ id: 'x', text: 'second version', metadata: { v: 2 } }]);
		assertFalse(again.created);
		const generated = store.collections(ALICE)[0]!;
		assertEquals(generated.items, 2);
		const hit = (await store.search(ALICE, 'notes', 'second version', 1)).results[0]!;
		assertEquals([hit.id, hit.text, hit.metadata], ['x', 'second version', { v: 2 }]);
		const other = (await store.search(ALICE, 'notes', 'generated', 1)).results[0]!;
		assert(MEMORY_ID_PATTERN.test(other.id) && other.id.length === 26, 'a ULID is generated');

		assertEquals(store.delete(ALICE, 'notes', ['x', 'nope']), 1);
		assertEquals(store.delete(ALICE, 'notes', 'all'), 1);
		assertEquals(store.collections(ALICE).map((c) => [c.name, c.items]), [['notes', 0]], 'the collection stays');

		await store.save(ALICE, 'notes', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
		assertEquals(store.drop(ALICE, 'notes'), 3);
		assertEquals(Number(db.get('SELECT count(*) AS n FROM memory_items')?.n), 0, 'items cascade with the collection');
		assertEquals(store.collections(ALICE), []);
		assertEquals(store.drop(ALICE, 'notes'), null);
	} finally {
		db.close();
	}
});

Deno.test('memory: every bound refuses with invalid, and caps hold at their edge', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		const refuse = async (work: () => Promise<unknown>, phrase: string): Promise<void> => {
			const error = await assertRejects(work, MemoryError);
			assertEquals(error.code, 'invalid', phrase);
			assertStringIncludes(error.message, phrase);
		};
		await refuse(() => store.save(ALICE, 'Notes', [{ text: 'x' }]), 'collection');
		await refuse(() => store.save(ALICE, '-notes', [{ text: 'x' }]), 'collection');
		await refuse(() => store.save(ALICE, 'a'.repeat(65), [{ text: 'x' }]), 'collection');
		await refuse(() => store.save(ALICE, 'notes', []), 'items');
		await refuse(
			() => store.save(ALICE, 'notes', Array.from({ length: 33 }, () => ({ text: 'x' }))),
			'more than 32',
		);
		await refuse(() => store.save(ALICE, 'notes', [{ text: '   ' }]), 'empty');
		await refuse(() => store.save(ALICE, 'notes', [{ text: 'é'.repeat(8193) }]), 'longer than 16384 bytes');
		await refuse(
			() => store.save(ALICE, 'notes', [{ text: 'x', metadata: { pad: 'x'.repeat(4096) } }]),
			'longer than 4096 bytes',
		);
		await refuse(
			() => store.save(ALICE, 'notes', [{ text: 'x', metadata: [1] as unknown as Record<string, unknown> }]),
			'not a JSON object',
		);
		await refuse(() => store.save(ALICE, 'notes', [{ id: 'has space', text: 'x' }]), 'id');
		await refuse(() => store.save(ALICE, 'notes', [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]), 'repeated');
		assertEquals(store.collections(ALICE), [], 'a refused save creates nothing');

		await store.save(ALICE, 'notes', [{ text: 'é'.repeat(8192) }]);
		await refuse(() => store.search(ALICE, 'notes', 'x', 0), 'limit');
		await refuse(() => store.search(ALICE, 'notes', 'x', 21), 'limit');
		await refuse(() => store.search(ALICE, 'notes', 'x', 5, { 'a.b': 1 }), 'filter');
		await refuse(
			() => store.search(ALICE, 'notes', 'x', 5, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))),
			'more than 8',
		);
		assertThrows(() => store.delete(ALICE, 'notes', []), MemoryError, 'none given');
		assertThrows(() => store.delete(ALICE, 'notes', Array.from({ length: 101 }, (_, i) => `i${i}`)), MemoryError);

		// 64 collections per owner: the 64th is admitted, the 65th refused; another owner is unaffected.
		for (let i = 1; i < MEMORY_LIMITS.collectionsPerOwner; i++) await store.save(ALICE, `c${i}`, [{ text: 'x' }]);
		await refuse(() => store.save(ALICE, 'one-more', [{ text: 'x' }]), 'already have 64 collections');
		await store.save(ALICE, 'c1', [{ text: 'an existing collection still takes items' }]);
		await store.save(BOB, 'one-more', [{ text: 'x' }]);

		// 10 000 items per collection: filled directly, then the edge is probed through `save`.
		db.run(
			"INSERT INTO memory_collections (owner, name, embedder, dims, created_at) VALUES (?, 'full', ?, ?, '')",
			BOB,
			BUILTIN_EMBEDDER_ID,
			LEXICAL_DIMS,
		);
		const blob = encodeVector(lexicalEmbed('filler'));
		db.transaction(() => {
			for (let i = 0; i < MEMORY_LIMITS.itemsPerCollection - 1; i++) {
				db.run(
					'INSERT INTO memory_items (owner, collection, id, text, metadata, embedding, updated_at) ' +
						"VALUES (?, 'full', ?, 'filler', '{}', ?, '')",
					BOB,
					`f${i}`,
					blob,
				);
			}
		});
		await refuse(() => store.save(BOB, 'full', [{ text: 'a' }, { text: 'b' }]), 'more than 10000 items');
		await store.save(BOB, 'full', [{ id: 'last', text: 'the last one fits' }]);
		await refuse(() => store.save(BOB, 'full', [{ text: 'over' }]), 'more than 10000 items');
		// An upsert of a held id does not grow the collection, so it is admitted when full.
		await store.save(BOB, 'full', [{ id: 'f0', text: 'replaced' }]);
	} finally {
		db.close();
	}
});

Deno.test('memory: a vector of another length fails the search instead of being scored', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		await store.save(ALICE, 'notes', [{ id: 'ok', text: 'a normal item' }]);
		db.run(
			'INSERT INTO memory_items (owner, collection, id, text, metadata, embedding, updated_at) ' +
				"VALUES (?, 'notes', 'bad', 'x', '{}', ?, '')",
			ALICE,
			new Uint8Array(12),
		);
		// Whatever the limit, and although the good item would rank first, the bad row is seen and refused.
		const error = await assertRejects(() => store.search(ALICE, 'notes', 'a normal item', 1), MemoryError);
		assertEquals(error.code, 'unavailable');
		assertStringIncludes(error.message, 'another length');
		// The SQL function itself answers NULL, never a number, for a mismatch or a non-vector.
		const probe = (a: Uint8Array | number, b: Uint8Array) => db.get(`SELECT ${DOT_SQL}(?, ?) AS score`, a, b)?.score;
		assertEquals(probe(new Uint8Array(8), new Uint8Array(12)), null);
		assertEquals(probe(new Uint8Array(6), new Uint8Array(6)), null);
		assertEquals(probe(1, new Uint8Array(8)), null);
		assertEquals(probe(encodeVector(new Float32Array([0.5, 2])), encodeVector(new Float32Array([2, 1]))), 3);
	} finally {
		db.close();
	}
});

Deno.test('memory: a collection keeps the embedder it was created with, and refuses once it is gone', async () => {
	const stub = stubProvider();
	const db = Database.memory();
	let providers: ModelProviderSettings[] = [provider(stub.url, KEY)];
	try {
		const store = new MemoryStore(db, { providers: () => providers });
		// Only OpenAI-compatible providers embed; one entry per listed model.
		providers = [...providers, provider('https://api.anthropic.com/v1', KEY, { id: 'claude', kind: 'anthropic' })];
		assertEquals(store.availableEmbedders().map((e) => [e.id, e.kind]), [
			[BUILTIN_EMBEDDER_ID, 'builtin'],
			['provider:local/chat-model', 'provider'],
			['provider:local/embed-small', 'provider'],
		]);
		assertEquals(store.embedderSetting(), 'builtin');

		await store.save(ALICE, 'lexical', [{ text: 'a cat' }]);
		assertEquals(store.setEmbedder('local/embed-small'), 'provider:local/embed-small');
		assertEquals(store.embedderSetting(), 'local/embed-small');
		assertEquals(store.defaultEmbedderId(), 'provider:local/embed-small');

		// The existing collection keeps the built-in embedder: no provider call is made for it.
		await store.save(ALICE, 'lexical', [{ text: 'another cat' }]);
		await store.search(ALICE, 'lexical', 'cat');
		assertEquals(stub.seen.length, 0);

		// A new collection binds to the provider, with the dimensions its first answer had.
		const created = await store.save(ALICE, 'semantic', [{ id: 'c', text: 'my cat' }, { id: 'd', text: 'a dog' }]);
		assertEquals(created.embedder, 'provider:local/embed-small');
		assertEquals(store.collections(ALICE).find((c) => c.name === 'semantic')?.dims, 3);
		const { results } = await store.search(ALICE, 'semantic', 'cat?');
		assertEquals(results[0]!.id, 'c');
		assertEquals(stub.seen.length, 2);

		// The provider is removed: its collection refuses with the fixed phrase; the built-in one still works.
		providers = [];
		const gone = await assertRejects(() => store.search(ALICE, 'semantic', 'cat'), MemoryError);
		assertEquals(gone.code, 'unavailable');
		assertStringIncludes(gone.message, 'no longer configured');
		await assertRejects(() => store.save(ALICE, 'semantic', [{ text: 'x' }]), MemoryError, 'no longer configured');
		assertEquals(store.collections(ALICE).map((c) => [c.name, c.available]), [['lexical', true], ['semantic', false]]);
		await store.search(ALICE, 'lexical', 'cat');
		// The default names the removed provider: a new collection is refused rather than bound to another embedder.
		const noDefault = await assertRejects(() => store.save(ALICE, 'fresh', [{ text: 'x' }]), MemoryError);
		assertEquals(noDefault.code, 'unavailable');
		assertStringIncludes(noDefault.message, 'default memory embedder is not available');
		// Dropped, the name can be reused with the embedder in force.
		assertEquals(store.drop(ALICE, 'semantic'), 2);
		assertThrows(() => store.setEmbedder('local/embed-small'), MemoryError, 'not one of the available embedders');
		assertEquals(store.setEmbedder(BUILTIN_EMBEDDER_ID), BUILTIN_EMBEDDER_ID);
		assertEquals(store.embedderSetting(), 'builtin');
		assertEquals((await store.save(ALICE, 'semantic', [{ text: 'x' }])).embedder, BUILTIN_EMBEDDER_ID);
	} finally {
		db.close();
		await stub.close();
	}
});

Deno.test('memory: a provider that changes dimensions under a collection is refused, never mixed', async () => {
	let width = 3;
	const stub = stubProvider(({ body }) =>
		Response.json({ data: (body.input ?? []).map((_, index) => ({ index, embedding: Array(width).fill(1) })) })
	);
	const db = Database.memory();
	try {
		const store = new MemoryStore(db, { providers: () => [provider(stub.url, KEY)] });
		store.setEmbedder('local/embed-small');
		await store.save(ALICE, 'notes', [{ text: 'x' }]);
		width = 4;
		const error = await assertRejects(() => store.search(ALICE, 'notes', 'x'), MemoryError);
		assertEquals(error.code, 'unavailable');
		assertStringIncludes(error.message, 'answered 4 dimensions where the collection holds 3');
		await assertRejects(() => store.save(ALICE, 'notes', [{ text: 'y' }]), MemoryError, 'dimensions');
	} finally {
		db.close();
		await stub.close();
	}
});

Deno.test('memory (E-120): a bare-origin provider embeds at /v1/embeddings, as the chat client calls /v1', async () => {
	const stub = stubProvider();
	const db = Database.memory();
	try {
		const store = new MemoryStore(db, { providers: () => [provider(new URL(stub.url).origin, KEY)] });
		store.setEmbedder('local/embed-small');
		await store.save(ALICE, 'notes', [{ id: 'cat', text: 'cat' }]);
		assertEquals(stub.seen.map((seen) => seen.path), ['/v1/embeddings']);
	} finally {
		db.close();
		await stub.close();
	}
});

Deno.test('memory: the provider embedder sends the OpenAI shape, the key only as a bearer, and sorts by index', async () => {
	const stub = stubProvider();
	const db = Database.memory();
	const keylessDb = Database.memory();
	try {
		const store = new MemoryStore(db, { providers: () => [provider(stub.url, KEY)] });
		store.setEmbedder('local/embed-small');
		await store.save(ALICE, 'notes', [{ id: 'long', text: 'a much longer text' }, { id: 'cat', text: 'cat' }]);
		const [call] = stub.seen;
		assertEquals([call!.method, call!.path], ['POST', '/v1/embeddings']);
		assertEquals(call!.body, { model: 'embed-small', input: ['a much longer text', 'cat'] });
		assertEquals(call!.headers.get('authorization'), `Bearer ${KEY}`);
		assertEquals(call!.headers.get('content-type'), 'application/json');
		assertEquals(call!.headers.get('x-team'), 'memory');
		// The answer came back reversed; sorted by index, the cat vector stayed with the cat item.
		assertEquals((await store.search(ALICE, 'notes', 'cat', 1)).results[0]!.id, 'cat');

		// A provider without a key sends no authorization header at all.
		const keyless = new MemoryStore(keylessDb, { providers: () => [provider(stub.url, null)] });
		keyless.setEmbedder('local/embed-small');
		await keyless.save(ALICE, 'notes', [{ text: 'x' }]);
		assertEquals(stub.seen.at(-1)!.headers.get('authorization'), null);
	} finally {
		db.close();
		keylessDb.close();
		await stub.close();
	}
});

Deno.test('memory: provider failures are fixed phrases that never echo the key or the upstream body', async () => {
	let mode = 'ok';
	const stub = stubProvider(({ body }) => {
		switch (mode) {
			case '401':
				return new Response(`{"error":"invalid key ${KEY}"}`, {
					status: 401,
					headers: { 'content-type': 'application/json' },
				});
			case '500':
				return new Response(`upstream trace mentions ${KEY}`, { status: 500 });
			case 'redirect':
				return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/steal' } });
			case 'text':
				return new Response(`not json ${KEY}`, { headers: { 'content-type': 'text/plain' } });
			case 'count':
				return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
			case 'nan':
				return Response.json({ data: (body.input ?? []).map((_, index) => ({ index, embedding: ['x'] })) });
			default:
				return Response.json({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0] })) });
		}
	});
	const db = Database.memory();
	try {
		const store = new MemoryStore(db, { providers: () => [provider(stub.url, KEY)] });
		store.setEmbedder('local/embed-small');
		const expectations: Array<[string, string]> = [
			['401', 'refused the request (4xx)'],
			['500', 'failed (5xx)'],
			['redirect', 'could not be reached'],
			['text', 'unreadable response'],
			['count', 'unreadable response'],
			['nan', 'unreadable response'],
		];
		for (const [which, phrase] of expectations) {
			mode = which;
			const error = await assertRejects(() => store.save(ALICE, 'notes', [{ text: 'a' }, { text: 'b' }]), MemoryError);
			assertEquals(error.code, 'unavailable', which);
			assertStringIncludes(error.message, phrase, which);
			assertFalse(error.message.includes(KEY), `${which} echoed the key`);
			assertFalse(
				error.message.includes('upstream') || error.message.includes('invalid key'),
				`${which} echoed a body`,
			);
		}
		assertEquals(store.collections(ALICE), [], 'a failed embedding creates nothing');
		// The redirect was refused, never followed: only the stub was dialled.
		assert(stub.seen.every((seen) => seen.path === '/v1/embeddings'));
	} finally {
		db.close();
		await stub.close();
	}
});

Deno.test('memory: a provider that does not answer in time is a timeout, and the caller can cancel', async () => {
	const release: Array<() => void> = [];
	const stub = stubProvider(() => new Promise((resolve) => release.push(() => resolve(Response.json({ data: [] })))));
	const db = Database.memory();
	try {
		const store = new MemoryStore(db, {
			providers: () => [provider(stub.url, KEY)],
			provider: { callTimeoutMs: 50 },
		});
		store.setEmbedder('local/embed-small');
		await assertRejects(() => store.save(ALICE, 'notes', [{ text: 'a' }]), MemoryError, 'did not answer in time');
		const controller = new AbortController();
		const pending = store.save(ALICE, 'notes', [{ text: 'a' }], controller.signal);
		controller.abort(new Error('cancelled by caller'));
		await assertRejects(() => pending, Error, 'cancelled by caller');
	} finally {
		for (const done of release) done();
		db.close();
		await stub.close();
	}
});

Deno.test('memory: the control-plane view and its PUT body are validated strictly', () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db, { providers: () => [provider('https://embed.example/v1', KEY)] });
		const view = memorySystemView(store);
		assertEquals(view.embedder, BUILTIN_EMBEDDER_ID);
		assertEquals(view.embedders.map((e) => e.id), [
			BUILTIN_EMBEDDER_ID,
			'provider:local/chat-model',
			'provider:local/embed-small',
		]);
		assertEquals(view.totals, []);
		assertEquals(parseMemoryConfigBody({ embedder: 'builtin' }), { embedder: 'builtin' });
		for (const body of [{ embedder: 'builtin', extra: 1 }, { embedder: '' }, {}, null, 'builtin']) {
			const problem = assertThrows(() => parseMemoryConfigBody(body), HttpProblem);
			assertEquals(problem.slug, 'invalid-request');
		}
		const refused = assertThrows(() => applyMemoryConfig(store, { embedder: 'local/not-listed' }), HttpProblem);
		assertEquals([refused.slug, refused.detail], ['invalid-request', 'embedder: not one of the available embedders']);
		assertEquals(
			applyMemoryConfig(store, { embedder: 'provider:local/embed-small' }).embedder,
			'provider:local/embed-small',
		);
		assertEquals(store.embedderSetting(), 'local/embed-small');
	} finally {
		db.close();
	}
});

Deno.test('memory: the admin summary counts collections and items per embedder across owners, nothing else', async () => {
	const db = Database.memory();
	try {
		const store = new MemoryStore(db);
		await store.save(ALICE, 'a', [{ text: 'one' }, { text: 'two' }]);
		await store.save(BOB, 'b', [{ text: 'three' }]);
		await store.save(BOB, 'empty', [{ id: 'gone', text: 'x' }]);
		store.delete(BOB, 'empty', ['gone']);
		assertEquals(store.summary(), [{ embedder: BUILTIN_EMBEDDER_ID, collections: 3, items: 3 }]);
	} finally {
		db.close();
	}
});

// --- the MCP tools, through the shared dispatcher ---------------------------------------------------------------------

/** The structured `{ result }` of a success, or the error's code and text. */
function outcome(result: ToolResult): { result?: Record<string, unknown>; code?: string; text?: string } {
	const call = result as {
		isError?: boolean;
		content: Array<{ text?: string }>;
		structuredContent?: { result?: Record<string, unknown>; error?: { code: string } };
	};
	if (call.isError === true) return { code: call.structuredContent?.error?.code, text: call.content[0]?.text };
	return { result: call.structuredContent?.result };
}

Deno.test('memory tools: four tools under the library scopes, enveloped, owner-scoped, with known error codes', async () => {
	const db = Database.memory();
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	try {
		const store = new MemoryStore(db);
		const extraTools = extensionTools(memoryActions(store));
		assertEquals(extraTools.map((tool) => [tool.name, tool.scope, tool.mutates]), [
			['memory_save', 'files:write', true],
			['memory_search', 'files:read', false],
			['memory_delete', 'files:write', true],
			['memory_list', 'files:read', false],
		]);
		assert(extraTools.every((tool) => tool.available === undefined), 'no service gate');
		const as = (owner: string, scopes: readonly Scope[] = SCOPES) =>
			createToolExecutor({ registry, version: 'test', extraTools }, owner, new Set(scopes));
		const alice = as(ALICE);

		const saved = outcome(
			await alice('memory_save', {
				collection: 'notes',
				items: [{ id: 'cat', text: 'the cat sat on the mat', metadata: { kind: 'pet' } }, { text: 'tax is due' }],
			}),
		);
		assertEquals(saved.result?.created, true);
		assertEquals((saved.result?.ids as string[])[0], 'cat');
		const found = outcome(await alice('memory_search', { collection: 'notes', query: 'cat mat', limit: 1 }));
		assertEquals((found.result?.results as Array<{ id: string }>).map((hit) => hit.id), ['cat']);
		assertEquals(outcome(await alice('memory_list', {})).result, {
			default_embedder: BUILTIN_EMBEDDER_ID,
			collections: [{
				name: 'notes',
				embedder: BUILTIN_EMBEDDER_ID,
				dims: LEXICAL_DIMS,
				items: 2,
				created_at: store.collections(ALICE)[0]!.created_at,
				available: true,
			}],
		});

		// Another owner sees nothing, and its misses are the codes clients already know.
		const bob = as(BOB);
		assertEquals(outcome(await bob('memory_list', {})).result?.collections, []);
		const missing = outcome(await bob('memory_search', { collection: 'notes', query: 'cat' }));
		assertEquals(missing.code, 'file-unavailable');
		assertStringIncludes(missing.text ?? '', 'no memory collection named notes');
		assertEquals(outcome(await bob('memory_delete', { collection: 'notes', all: true })).result, {
			collection: 'notes',
			deleted: 0,
			dropped: false,
		});
		assertEquals(store.collections(ALICE)[0]?.items, 2, 'bob deleted nothing of alice');

		// Schema and store refusals are invalid-arguments; reading needs files:read, changing files:write.
		assertEquals(outcome(await alice('memory_delete', { collection: 'notes' })).code, 'invalid-arguments');
		assertEquals(
			outcome(await alice('memory_save', { collection: 'notes', items: [{ text: '  ' }] })).code,
			'invalid-arguments',
		);
		const reader = as(ALICE, ['mcp:invoke', 'files:read']);
		assertEquals(
			outcome(await reader('memory_save', { collection: 'notes', items: [{ text: 'x' }] })).code,
			'scope-required',
		);
		assertEquals((outcome(await reader('memory_list', {})).result?.collections as unknown[]).length, 1);

		assertEquals(outcome(await alice('memory_delete', { collection: 'notes', ids: ['cat'] })).result?.deleted, 1);
		assertEquals(outcome(await alice('memory_delete', { collection: 'notes', all: true })).result, {
			collection: 'notes',
			deleted: 1,
			dropped: true,
		});
		assertEquals(store.collections(ALICE), []);
	} finally {
		await registry.shutdown();
		db.close();
	}
});

Deno.test('memory tools: the schema bounds a model reads are the store’s own', () => {
	const db = Database.memory();
	const tools = new Map(extensionTools(memoryActions(new MemoryStore(db))).map((tool) => [tool.name, tool]));
	db.close();
	const accepts = (name: string, args: unknown): boolean => tools.get(name)!.inputSchema.safeParse(args).success;
	for (const name of ['notes', 'a', '0-x_y', 'a'.repeat(64), 'a'.repeat(65), 'Notes', '-a', '_a', 'a.b', 'é', '']) {
		assertEquals(accepts('memory_delete', { collection: name, all: true }), MEMORY_COLLECTION_PATTERN.test(name), name);
	}
	for (const id of ['a', 'A.b:c-d_e', 'x'.repeat(128), 'x'.repeat(129), 'has space', 'a/b', '']) {
		assertEquals(accepts('memory_delete', { collection: 'c', ids: [id] }), MEMORY_ID_PATTERN.test(id), id);
	}
	for (const key of ['kind', 'a-b_c', 'k'.repeat(64), 'k'.repeat(65), 'a.b', 'a"b', '']) {
		assertEquals(
			accepts('memory_search', { collection: 'c', query: 'q', filter: { [key]: 1 } }),
			MEMORY_FILTER_KEY_PATTERN.test(key),
			key,
		);
	}
	const items = (n: number) => Array.from({ length: n }, () => ({ text: 'x' }));
	assert(accepts('memory_save', { collection: 'c', items: items(MEMORY_LIMITS.saveBatch) }));
	assertFalse(accepts('memory_save', { collection: 'c', items: items(MEMORY_LIMITS.saveBatch + 1) }));
	assert(accepts('memory_save', { collection: 'c', items: [{ text: 'x'.repeat(MEMORY_LIMITS.textBytes) }] }));
	assertFalse(accepts('memory_save', { collection: 'c', items: [{ text: 'x'.repeat(MEMORY_LIMITS.textBytes + 1) }] }));
	assert(accepts('memory_search', { collection: 'c', query: 'q', limit: MEMORY_LIMITS.searchLimitMax }));
	assertFalse(accepts('memory_search', { collection: 'c', query: 'q', limit: MEMORY_LIMITS.searchLimitMax + 1 }));
	const filter = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
	assert(accepts('memory_search', { collection: 'c', query: 'q', filter: filter(MEMORY_LIMITS.filterKeys) }));
	assertFalse(accepts('memory_search', { collection: 'c', query: 'q', filter: filter(MEMORY_LIMITS.filterKeys + 1) }));
	const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
	assert(accepts('memory_delete', { collection: 'c', ids: ids(MEMORY_LIMITS.deleteBatch) }));
	assertFalse(accepts('memory_delete', { collection: 'c', ids: ids(MEMORY_LIMITS.deleteBatch + 1) }));
});
