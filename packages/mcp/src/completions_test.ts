/**
 * R13 — `completion/complete` for the resource templates (design §2.17, D-129, AC29), through the real HTTP entry on
 * both eras: session ids, kinds, file ids, share paths and skill names, at most 100, never another owner's ids in
 * `owner` mode, and nothing for a principal without `files:read` on the library templates.
 */
import { assert, assertEquals } from '@std/assert';
import {
	CLIENT_CAPABILITIES_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { completeByPrefix, MAX_COMPLETIONS } from './completions.ts';
import { LibraryStore } from './library.ts';
import { type SessionAccess, type SessionOwnership, SessionRegistry } from './registry.ts';
import { createBuildServer, type McpDeps } from './server.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const SESSION_TEMPLATE = 'ttk://session/{sessionId}/{kind}';
const FILE_TEMPLATE = 'ttk://session/{sessionId}/files/{fileId}';
const SHARE_TEMPLATE = 'ttk://share/{+path}';
const SKILL_TEMPLATE = 'ttk://skill/{name}';

const ALICE: SessionAccess = { owner: 'api-key:alice', admin: false };
const BOB: SessionAccess = { owner: 'api-key:bob', admin: false };

function authOf(access: SessionAccess, scopes: readonly string[]): AuthInfo {
	return {
		token: 't',
		clientId: access.owner.slice('api-key:'.length),
		scopes: [...scopes],
		extra: { owner: access.owner },
	};
}

/** A stand-in browser whose download ledger holds one completed file per session. */
function launcher(dir: string) {
	let n = 0;
	return (id: string) => {
		n += 1;
		const guid = `F${n}-${id.slice(0, 4)}`;
		const record = {
			guid,
			url: 'http://127.0.0.1:1/x',
			suggestedFilename: `${guid}.txt`,
			fileName: `${guid}.txt`,
			path: `${dir}/${guid}`,
			fileSize: 1,
			receivedBytes: 1,
			totalBytes: 1,
			fileType: 'txt',
			mimeType: null,
			autoDownload: false,
			state: 'completed' as const,
			startedAt: 1,
			completedAt: 2,
			error: null,
		};
		const ledger = {
			downloads: [record],
			isRemoteBrowser: false,
			lookup: (g: string) => g === guid ? record : undefined,
		};
		const session = {
			tabs: [],
			cachedBrowserState: null,
			agentFocusTargetId: null,
			cdpClient: null,
			sessionManager: null,
			eventBus: new EventBus({ name: 'completions-test' }),
			stop: () => Promise.resolve(),
			kill: () => Promise.resolve(),
		} as unknown as BrowserSession;
		return Promise.resolve({ session, downloads: ledger as never, downloadsDir: dir });
	};
}

interface Fixture {
	sessions: SessionRegistry;
	library: LibraryStore;
	handler: ReturnType<typeof createMcpHandler>;
	dir: string;
	close(): Promise<void>;
}

async function fixture(ownership: SessionOwnership): Promise<Fixture> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'completions-' });
	const sessions = new SessionRegistry({ reapIntervalMs: 0, ownership, launch: launcher(dir) });
	const library = new LibraryStore({ dataDir: `${dir}/data` });
	await library.initialize();
	await library.writeBytes('reports/q3.md', new TextEncoder().encode('q3'));
	await library.writeBytes('reports/q4.md', new TextEncoder().encode('q4'));
	await library.writeBytes('readme.txt', new TextEncoder().encode('r'));
	await library.putSkill('review', { 'SKILL.md': '---\nname: review\ndescription: Review code\n---\nbody' });
	await library.putSkill('release', { 'SKILL.md': '---\nname: release\ndescription: Ship it\n---\nbody' });
	await library.refresh();
	const deps: McpDeps = { registry: sessions, version: '0', library };
	const handler = createMcpHandler(createBuildServer(deps), { legacy: 'stateless' });
	return {
		sessions,
		library,
		handler,
		dir,
		async close() {
			await handler.close();
			await sessions.shutdown();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

async function readRpc(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		for (const line of text.split('\n')) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
		throw new Error(`no data frame in SSE body: ${text}`);
	}
	return JSON.parse(text);
}

/** One `completion/complete` on the named era; the values, or the JSON-RPC error. */
async function complete(
	f: Fixture,
	era: string,
	authInfo: AuthInfo,
	uri: string,
	argument: { name: string; value: string },
	context?: Record<string, string>,
): Promise<{ values?: string[]; total?: number; error?: unknown }> {
	const params: Record<string, unknown> = {
		ref: { type: 'ref/resource', uri },
		argument,
		...(context === undefined ? {} : { context: { arguments: context } }),
	};
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	if (era === MODERN) {
		params._meta = { [PROTOCOL_VERSION_META_KEY]: MODERN, [CLIENT_CAPABILITIES_META_KEY]: {} };
		headers['mcp-method'] = 'completion/complete';
	}
	const response = await f.handler.fetch(
		new Request('http://127.0.0.1/mcp', {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'completion/complete', params }),
		}),
		{ authInfo },
	);
	const body = await readRpc(response);
	if (body.error !== undefined) return { error: body.error };
	const completion = (body.result as { completion: { values: string[]; total?: number } }).completion;
	return { values: completion.values, ...(completion.total === undefined ? {} : { total: completion.total }) };
}

for (const era of [LEGACY, MODERN]) {
	Deno.test(`R13 (${era}): session ids, kinds and file ids complete, never another owner's`, async () => {
		const f = await fixture('owner');
		try {
			const a = await f.sessions.resolve(undefined, ALICE);
			const a2 = await f.sessions.createNew(undefined, undefined, ALICE);
			const b = await f.sessions.resolve(undefined, BOB);
			const alice = authOf(ALICE, ['mcp:invoke']);
			const bob = authOf(BOB, ['mcp:invoke']);

			const ids = await complete(f, era, alice, SESSION_TEMPLATE, { name: 'sessionId', value: '' });
			assertEquals(ids.error, undefined, JSON.stringify(ids.error));
			assertEquals(ids.values?.sort(), [a.id, a2.id].sort());
			assert(!ids.values?.includes(b.id), "bob's id never reaches alice");
			const prefixed = await complete(f, era, alice, SESSION_TEMPLATE, { name: 'sessionId', value: 'default-' });
			assertEquals(prefixed.values, [a.id]);
			const bobIds = await complete(f, era, bob, FILE_TEMPLATE, { name: 'sessionId', value: '' });
			assertEquals(bobIds.values, [b.id]);

			const kinds = await complete(f, era, alice, SESSION_TEMPLATE, { name: 'kind', value: 's' });
			assertEquals(kinds.values, ['state', 'screenshot']);

			const aFiles = a.files.list().map((file) => file.file_id);
			assertEquals(aFiles.length, 1);
			const own = await complete(f, era, alice, FILE_TEMPLATE, { name: 'fileId', value: '' }, { sessionId: a.id });
			assertEquals(own.values, aFiles);
			const defaulted = await complete(f, era, alice, FILE_TEMPLATE, { name: 'fileId', value: '' });
			assertEquals(defaulted.values, aFiles, "an omitted session is the caller's own default");
			const foreign = await complete(f, era, bob, FILE_TEMPLATE, { name: 'fileId', value: '' }, { sessionId: a.id });
			assertEquals(foreign.values, [], "alice's file ids never reach bob");
			const nobody = await complete(f, era, bob, FILE_TEMPLATE, { name: 'fileId', value: '' }, { sessionId: 'nope' });
			assertEquals(nobody.values, []);
			assertEquals(f.sessions.size, 3, 'completing never created a session');
		} finally {
			await f.close();
		}
	});

	Deno.test(`R13 (${era}): share paths and skill names complete for files:read, and nothing without it`, async () => {
		const f = await fixture('shared');
		try {
			const reader = authOf(ALICE, ['mcp:invoke', 'files:read']);
			const paths = await complete(f, era, reader, SHARE_TEMPLATE, { name: 'path', value: 'reports/' });
			assertEquals(paths.error, undefined, JSON.stringify(paths.error));
			assertEquals(paths.values?.sort(), ['reports/q3.md', 'reports/q4.md']);
			const skills = await complete(f, era, reader, SKILL_TEMPLATE, { name: 'name', value: 're' });
			assertEquals(skills.values?.sort(), ['release', 'review']);
			const one = await complete(f, era, reader, SKILL_TEMPLATE, { name: 'name', value: 'rev' });
			assertEquals(one.values, ['review']);

			// Without `files:read` the library templates are not registered at all: the request names a template that
			// does not exist for this caller, and nothing is offered.
			const plain = authOf(ALICE, ['mcp:invoke']);
			const refused = await complete(f, era, plain, SHARE_TEMPLATE, { name: 'path', value: '' });
			assertEquals(refused.values, undefined);
			assert(refused.error !== undefined);
			const skillRefused = await complete(f, era, plain, SKILL_TEMPLATE, { name: 'name', value: '' });
			assertEquals(skillRefused.values, undefined);
		} finally {
			await f.close();
		}
	});

	Deno.test(`R13 (${era}): a principal without mcp:invoke gets no session completion`, async () => {
		const f = await fixture('shared');
		try {
			await f.sessions.resolve(undefined);
			const viewer = authOf(ALICE, ['view:watch']);
			const result = await complete(f, era, viewer, SESSION_TEMPLATE, { name: 'sessionId', value: '' });
			assertEquals(result.values, undefined, 'the session templates do not exist for a viewer');
		} finally {
			await f.close();
		}
	});
}

Deno.test(`R13 (${LEGACY}): the completions capability is declared once a template has a completer`, async () => {
	const f = await fixture('shared');
	try {
		const response = await f.handler.fetch(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'c', version: '0' } },
				}),
			}),
			{ authInfo: authOf(ALICE, ['mcp:invoke']) },
		);
		const body = await readRpc(response);
		const capabilities = (body.result as { capabilities: Record<string, unknown> }).capabilities;
		assertEquals(capabilities.completions, {});
	} finally {
		await f.close();
	}
});

Deno.test('R13: at most 100 values, by prefix, without duplicates', () => {
	const many = Array.from({ length: 250 }, (_, i) => `s${String(i).padStart(3, '0')}`);
	assertEquals(completeByPrefix(many, 's').length, MAX_COMPLETIONS);
	assertEquals(completeByPrefix(many, 's00'), many.slice(0, 10));
	assertEquals(completeByPrefix(['a', 'a', 'ab'], 'a'), ['a', 'ab']);
	assertEquals(completeByPrefix(['x'], 'y'), []);
});
