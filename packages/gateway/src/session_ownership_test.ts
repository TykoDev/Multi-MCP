/**
 * R8 — per-principal session ownership at the gateway's own surfaces (design §2.16, D-128, AC28): the admin REST
 * session routes, the file route, the SSE event stream, the live-ticket mint, the recordings route (F26: with an
 * injected recorder whose encoder is not a real `ffmpeg`) and the configuration refusal. The MCP surfaces are covered
 * in `packages/mcp/src/ownership_test.ts`; the live-view upgrade, with a real browser, in
 * `tests/e2e/ownership_e2e_test.ts`.
 *
 * Every request runs against the app's own `fetch` with no bound port, as `eventstream_test.ts` does, so a stream body
 * this test opens is one it owns and cancels.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { type SessionOwnership, SessionRegistry } from '@tykotech/mcp';
import { createGatewayApp, sessionAccessOf } from './app.ts';
import { generateApiKey, type Principal, VerifierChain } from './auth.ts';
import { ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { type EncoderSpawn, Recorder } from './recorder.ts';
import type { TicketStore } from './tickets.ts';

const HOST = 'http://127.0.0.1:8787';
const ALICE_OWNER = 'api-key:alice';
const BOB_OWNER = 'api-key:bob';
const ROOT_OWNER = 'api-key:root';

/** A stand-in browser whose download ledger holds one completed file, `G1`, written under `dir`. */
async function launcher(dir: string) {
	await Deno.writeTextFile(`${dir}/G1`, 'file-bytes');
	return (_id: string) => {
		const record = {
			guid: 'G1',
			url: 'http://127.0.0.1:1/x',
			suggestedFilename: 'g1.txt',
			fileName: 'g1.txt',
			path: `${dir}/G1`,
			fileSize: 10,
			receivedBytes: 10,
			totalBytes: 10,
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
			lookup: (g: string) => g === 'G1' ? record : undefined,
		};
		const session = {
			tabs: [],
			cachedBrowserState: null,
			agentFocusTargetId: null,
			cdpClient: null,
			sessionManager: null,
			eventBus: new EventBus({ name: 'ownership-gateway' }),
			stop: () => Promise.resolve(),
			kill: () => Promise.resolve(),
		} as unknown as BrowserSession;
		return Promise.resolve({ session, downloads: ledger as never, downloadsDir: dir });
	};
}

/**
 * An encoder that is not `ffmpeg` (F26): it keeps what the recorder writes and, when stdin closes, writes it to the
 * output path the recorder named — so the route serves a real file without `--allow-run`.
 */
const fakeEncoder: EncoderSpawn = (_command, options) => {
	const path = options.args.at(-1)!;
	const chunks: Uint8Array[] = [];
	let settle: (status: Deno.CommandStatus) => void = () => {};
	const status = new Promise<Deno.CommandStatus>((resolve) => (settle = resolve));
	return {
		stdin: new WritableStream<Uint8Array>({
			write: (chunk) => void chunks.push(chunk),
			close: async () => {
				const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
				const bytes = new Uint8Array(total);
				let at = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, at);
					at += chunk.length;
				}
				await Deno.writeFile(path, bytes);
				settle({ success: true, code: 0, signal: null });
			},
		}),
		stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
		status,
		kill: () => settle({ success: false, code: 137, signal: 'SIGKILL' }),
	};
};

/** A one-pixel JPEG's bytes, base64, as the screencast would deliver a frame. */
const FRAME = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9));

interface Rig {
	request(path: string, token: string, init?: RequestInit): Promise<Response>;
	registry: SessionRegistry;
	recorder: Recorder;
	tickets: TicketStore;
	keys: { alice: string; bob: string; root: string };
	recordings: string;
	close(): Promise<void>;
}

async function rig(ownership: SessionOwnership): Promise<Rig> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'gw-ownership-' });
	const alice = await generateApiKey('alice', ['mcp:invoke', 'view:watch', 'view:control']);
	const bob = await generateApiKey('bob', ['mcp:invoke', 'view:watch', 'view:control']);
	const root = await generateApiKey('root', ['mcp:invoke', 'view:watch', 'view:control', 'admin']);
	const config = loadConfig({
		TTK_API_KEYS: JSON.stringify([alice.record, bob.record, root.record]),
		TTK_SESSION_OWNERSHIP: ownership,
		TTK_LOG_LEVEL: 'error',
	});
	assertEquals(config.sessionOwnership, ownership);
	const registry = new SessionRegistry({ reapIntervalMs: 0, ownership, launch: await launcher(dir) });
	const logger = createLogger({ level: 'error', write: () => {} });
	const recordings = `${dir}/recordings`;
	const recorder = new Recorder({
		registry,
		subscribe: (_sessionId, onFrame) => {
			queueMicrotask(() => onFrame(FRAME));
			return Promise.resolve(() => {});
		},
		dir: recordings,
		ffmpeg: 'not-ffmpeg',
		logger,
		spawn: fakeEncoder,
	});
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const gateway = createGatewayApp({ config, verifier, registry, version: 'ownership', logger, recorder });
	return {
		request: (path, token, init = {}) => {
			const headers = new Headers(init.headers);
			headers.set('host', '127.0.0.1:8787');
			headers.set('authorization', `Bearer ${token}`);
			return Promise.resolve(gateway.app.request(`${HOST}${path}`, { ...init, headers }));
		},
		registry,
		recorder,
		tickets: gateway.tickets,
		keys: { alice: alice.key, bob: bob.key, root: root.key },
		recordings,
		async close() {
			await recorder.stopAll();
			await gateway.close();
			await registry.shutdown();
			await Deno.remove(dir, { recursive: true }).catch(() => {});
		},
	};
}

const access = (owner: string, admin = false) => ({ owner, admin });

Deno.test('R8: sessionAccessOf is the realm-qualified owner and the admin scope', () => {
	const principal: Principal = { kind: 'oauth', id: 'sub-1', scopes: new Set(['mcp:invoke', 'admin']) };
	assertEquals(sessionAccessOf(principal), { owner: 'oauth:sub-1', admin: true });
	assertEquals(
		sessionAccessOf({ kind: 'anonymous-loopback', id: 'anonymous:127.0.0.1', scopes: new Set(['mcp:invoke']) }),
		{ owner: 'anonymous-loopback:local', admin: false },
	);
});

Deno.test('R8 (AC28): TTK_SESSION_OWNERSHIP parses shared|owner case-insensitively and refuses owner in a cluster', () => {
	assert((ENV_NAMES as readonly string[]).includes('TTK_SESSION_OWNERSHIP'), 'read by every processEnv caller');
	// D-150: unset is `owner` on a single node (an empty value is unset).
	assertEquals(loadConfig({}).sessionOwnership, 'owner');
	assertEquals(loadConfig({ TTK_SESSION_OWNERSHIP: '  ' }).sessionOwnership, 'owner');
	assertEquals(loadConfig({}).featureNotes.filter((note) => note.includes('TTK_SESSION_OWNERSHIP')), []);
	assertEquals(loadConfig({ TTK_SESSION_OWNERSHIP: ' OWNER ' }).sessionOwnership, 'owner');
	assertEquals(loadConfig({ TTK_SESSION_OWNERSHIP: 'Shared' }).sessionOwnership, 'shared');
	const bad = assertThrows(() => loadConfig({ TTK_SESSION_OWNERSHIP: 'private' }), ConfigError);
	assertStringIncludes(bad.message, 'TTK_SESSION_OWNERSHIP');
	const clustered = assertThrows(
		() => loadConfig({ TTK_SESSION_OWNERSHIP: 'owner', TTK_CLUSTER_KV: 'tests/.scratch/kv' }),
		ConfigError,
	);
	assertStringIncludes(clustered.message, 'TTK_SESSION_OWNERSHIP');
	assertStringIncludes(clustered.message, 'TTK_CLUSTER_KV');
	assertEquals(
		loadConfig({ TTK_SESSION_OWNERSHIP: 'shared', TTK_CLUSTER_KV: 'tests/.scratch/kv' }).sessionOwnership,
		'shared',
	);
	// D-150: unset in a cluster is `shared`, not a refusal, and one note says why; only a named `owner` refuses.
	const defaulted = loadConfig({ TTK_CLUSTER_KV: 'tests/.scratch/kv' });
	assertEquals(defaulted.sessionOwnership, 'shared');
	const notes = defaulted.featureNotes.filter((note) => note.includes('TTK_SESSION_OWNERSHIP'));
	assertEquals(notes.length, 1);
	assertStringIncludes(notes[0] ?? '', 'TTK_SESSION_OWNERSHIP is unset and resolves to shared');
	assertStringIncludes(notes[0] ?? '', 'TTK_CLUSTER_KV');
});

Deno.test("R8 (AC28): bob reaches none of alice's session through the file route or the event stream", async () => {
	const r = await rig('owner');
	try {
		const a = await r.registry.resolve(undefined, access(ALICE_OWNER));
		for (const path of [`/api/v1/sessions/${a.id}/files/G1`, `/api/v1/sessions/${a.id}/events`]) {
			const refused = await r.request(path, r.keys.bob);
			assertEquals(refused.status, 404, path);
			assertStringIncludes(await refused.text(), 'unknown-session');
		}
		// `default` is bob's own default, which does not exist: nothing of alice's answers to it either.
		const viaDefault = await r.request('/api/v1/sessions/default/files/G1', r.keys.bob);
		assertEquals(viaDefault.status, 404);
		await viaDefault.body?.cancel();

		const own = await r.request(`/api/v1/sessions/${a.id}/files/G1`, r.keys.alice);
		assertEquals(own.status, 200);
		assertEquals(await own.text(), 'file-bytes');
		const ownDefault = await r.request('/api/v1/sessions/default/files/G1', r.keys.alice);
		assertEquals(ownDefault.status, 200, "alice's `default` is her own default session");
		await ownDefault.body?.cancel();
		const admin = await r.request(`/api/v1/sessions/${a.id}/files/G1`, r.keys.root);
		assertEquals(admin.status, 200, 'admin reaches it');
		await admin.body?.cancel();

		const stream = await r.request(`/api/v1/sessions/${a.id}/events`, r.keys.alice);
		assertEquals(stream.status, 200);
		await stream.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test("R8 (AC28): a live ticket for another owner's session is unknown-session; the ticket carries the access", async () => {
	const r = await rig('owner');
	try {
		const a = await r.registry.resolve(undefined, access(ALICE_OWNER));
		const mint = (token: string, body: Record<string, unknown>) =>
			r.request('/api/v1/live/ticket', token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		const foreign = await mint(r.keys.bob, { session_id: a.id });
		assertEquals(foreign.status, 404);
		assertStringIncludes(await foreign.text(), 'unknown-session');
		const own = await mint(r.keys.alice, { session_id: a.id });
		assertEquals(own.status, 201, await own.clone().text());
		const ticket = (await own.json()) as { ticket: string; session_id: string };
		assertEquals(ticket.session_id, a.id);
		// The upgrade resolves the session with the access the ticket recorded at mint.
		const redeemed = r.tickets.redeem(ticket.ticket, a.id, null);
		assert(redeemed.ok);
		assertEquals(redeemed.record.access, { owner: ALICE_OWNER, admin: false });
		// `default` mints for anyone — it resolves to the redeemer's own default at the upgrade (e2e).
		const mine = await mint(r.keys.bob, {});
		assertEquals(mine.status, 201);
		assertEquals(((await mine.json()) as { session_id: string }).session_id, 'default');
		const admin = await mint(r.keys.root, { session_id: a.id });
		assertEquals(admin.status, 201);
		await admin.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('R8 / F4 (AC28): the admin REST session routes look sessions up as the admin; non-admins stay refused', async () => {
	const r = await rig('owner');
	try {
		const a = await r.registry.resolve(undefined, access(ALICE_OWNER));
		const b = await r.registry.createNew('bob', undefined, access(BOB_OWNER));

		const refused = await r.request('/api/v1/sessions', r.keys.alice);
		assertEquals(refused.status, 403);
		await refused.body?.cancel();

		const listed = await r.request('/api/v1/sessions', r.keys.root);
		const ids = ((await listed.json()) as { sessions: Array<{ session_id: string }> }).sessions.map((s) =>
			s.session_id
		);
		assertEquals(ids.sort(), [a.id, b.id].sort(), 'admin lists every owner’s sessions');

		const created = await r.request('/api/v1/sessions', r.keys.root, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ label: 'ops' }),
		});
		assertEquals(created.status, 201);
		const createdId = ((await created.json()) as { session_id: string }).session_id;
		assertEquals(r.registry.peek(createdId)?.owner, ROOT_OWNER, 'a session the admin creates is the admin’s');

		const defaulted = await r.request('/api/v1/sessions', r.keys.root, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ session_id: 'default' }),
		});
		const defaultId = ((await defaulted.json()) as { session_id: string }).session_id;
		assert(
			defaultId.startsWith('default-') && defaultId !== a.id,
			`the admin's own default, not alice's: ${defaultId}`,
		);
		assertEquals(r.registry.peek(defaultId)?.owner, ROOT_OWNER);

		const deleted = await r.request(`/api/v1/sessions/${a.id}`, r.keys.root, { method: 'DELETE' });
		assertEquals(deleted.status, 204, 'admin reaches every session');
		assertEquals(r.registry.peek(a.id), undefined);
		const gone = await r.request(`/api/v1/sessions/${a.id}`, r.keys.root, { method: 'DELETE' });
		assertEquals(gone.status, 404);
		assertStringIncludes(await gone.text(), 'unknown-session');
	} finally {
		await r.close();
	}
});

Deno.test('RV-7: in owner mode the admin session list names each session’s owner; shared mode names none', async () => {
	const owned = await rig('owner');
	try {
		const a = await owned.registry.resolve(undefined, access(ALICE_OWNER));
		const b = await owned.registry.createNew('bob', undefined, access(BOB_OWNER));
		const listed = await owned.request('/api/v1/sessions', owned.keys.root);
		assertEquals(listed.status, 200);
		const sessions = ((await listed.json()) as { sessions: Array<{ session_id: string; owner?: string }> }).sessions;
		const owners = Object.fromEntries(sessions.map((s) => [s.session_id, s.owner]));
		assertEquals(owners, { [a.id]: ALICE_OWNER, [b.id]: BOB_OWNER }, 'an admin sees whose each session is');
	} finally {
		await owned.close();
	}
	const shared = await rig('shared');
	try {
		await shared.registry.resolve(undefined, access(ALICE_OWNER));
		const listed = await shared.request('/api/v1/sessions', shared.keys.root);
		const sessions = ((await listed.json()) as { sessions: Array<Record<string, unknown>> }).sessions;
		assertEquals(sessions.length, 1);
		assert(!('owner' in sessions[0]!), 'shared mode records no owner, so the list names none');
	} finally {
		await shared.close();
	}
});

Deno.test("R8 / F26 (AC28): a recording is its starter's — others are not found, admin reads all", async () => {
	const r = await rig('owner');
	try {
		const a = await r.registry.resolve(undefined, access(ALICE_OWNER));
		const b = await r.registry.resolve(undefined, access(BOB_OWNER));
		await r.recorder.start(a.id, 'alice-rec', ALICE_OWNER);
		const stopped = await r.recorder.stop(a.id);
		assert((stopped.bytes ?? 0) > 0, 'the stand-in encoder wrote the file');

		const foreign = await r.request('/api/v1/recordings/alice-rec', r.keys.bob);
		assertEquals(foreign.status, 404, 'another owner’s recording reads as absent');
		await foreign.body?.cancel();
		const own = await r.request('/api/v1/recordings/alice-rec', r.keys.alice);
		assertEquals(own.status, 200);
		assertEquals(own.headers.get('content-type'), 'video/webm');
		await own.body?.cancel();
		const admin = await r.request('/api/v1/recordings/alice-rec', r.keys.root);
		assertEquals(admin.status, 200);
		await admin.body?.cancel();

		// Bob cannot take the name over: writing it would replace alice's file.
		let error: unknown = null;
		try {
			await r.recorder.start(b.id, 'alice-rec', BOB_OWNER);
		} catch (cause) {
			error = cause;
		}
		assertStringIncludes(String(error), 'in use');
		assert(!String(error).includes(ALICE_OWNER), 'the refusal names no owner');

		// A recording from before this process started has no known owner: admin only.
		await Deno.writeTextFile(`${r.recordings}/earlier.webm`, 'old');
		const earlier = await r.request('/api/v1/recordings/earlier', r.keys.alice);
		assertEquals(earlier.status, 404);
		await earlier.body?.cancel();
		const earlierAdmin = await r.request('/api/v1/recordings/earlier', r.keys.root);
		assertEquals(earlierAdmin.status, 200);
		await earlierAdmin.body?.cancel();
	} finally {
		await r.close();
	}
});

Deno.test('R8 (AC27): shared mode serves every route to every holder of its scope, as before', async () => {
	const r = await rig('shared');
	try {
		const a = await r.registry.resolve(undefined, access(ALICE_OWNER));
		assertEquals(a.id, 'default');
		await r.recorder.start(a.id, 'shared-rec', ALICE_OWNER);
		await r.recorder.stop(a.id);
		for (const path of [`/api/v1/sessions/${a.id}/files/G1`, '/api/v1/recordings/shared-rec']) {
			const response = await r.request(path, r.keys.bob);
			assertEquals(response.status, 200, path);
			await response.body?.cancel();
		}
		const stream = await r.request('/api/v1/sessions/default/events', r.keys.bob);
		assertEquals(stream.status, 200);
		await stream.body?.cancel();
		const ticket = await r.request('/api/v1/live/ticket', r.keys.bob, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ session_id: 'default' }),
		});
		assertEquals(ticket.status, 201);
		await ticket.body?.cancel();
		// Reusing a name in shared mode overwrites, as it always did.
		await r.recorder.start(a.id, 'shared-rec', BOB_OWNER);
		await r.recorder.stop(a.id);
	} finally {
		await r.close();
	}
});
