/**
 * The API-key reload, and the revocation it makes reachable (SR2-M3).
 *
 * The finding was that `EVENT_STREAM_REVALIDATE_MS` could not deny an API-key
 * principal: the store was built once and never changed, so `hasId` answered
 * "still present" forever and revoking a key meant a restart. The last test here
 * is the proof the finding asked for — a **live SSE stream terminated because its
 * principal's record disappeared from a reloaded file** — and it runs against a
 * real file on disk, a real `VerifierChain` and the real transport, so nothing in
 * the chain is stubbed except the clock.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import type { BrowserSession } from '@tykotech/browser';
import { EventBus } from '@tykotech/bus';
import { SessionRegistry } from '@tykotech/mcp';
import { ulid } from '@std/ulid';
import { ApiKeyFileWatcher } from './keyreload.ts';
import { ApiKeyStore, generateApiKey, VerifierChain } from './auth.ts';
import { type ApiKeyRecord, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { attachEventStream, EventStreamRegistry } from './eventstream.ts';
import type { AppVariables } from './app.ts';
import type { Principal } from './auth.ts';

/** A logger that keeps what it was told, so a warning can be asserted rather than assumed. */
function recorder(): { info(msg: string): void; warn(msg: string): void; lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		info: (msg: string) => lines.push(`info ${msg}`),
		warn: (msg: string) => lines.push(`warn ${msg}`),
	};
}

/** A scratch directory under the one path the unit tier may write to. */
async function scratch(): Promise<{ dir: string; file: string; write(text: string): Promise<void>; drop(): void }> {
	const dir = `tests/.scratch/keyreload-${ulid()}`;
	await Deno.mkdir(dir, { recursive: true });
	const file = `${dir}/ttk_api_keys.json`;
	return {
		dir,
		file,
		write: (text: string) => Deno.writeTextFile(file, text),
		drop: () => {
			try {
				Deno.removeSync(dir, { recursive: true });
			} catch {
				// A directory already gone is the state this wanted.
			}
		},
	};
}

function recordsOf(...ids: string[]): ApiKeyRecord[] {
	return ids.map((id, index) => ({ id, sha256: `${index}`.repeat(1).padStart(64, 'a') }));
}

// --- the store's own refusals -----------------------------------------------

Deno.test('keyreload: the store swaps its records and can then answer "gone"', () => {
	const store = new ApiKeyStore(recordsOf('worker-1', 'human-1'));
	assert(store.hasId('worker-1'));
	assertEquals(store.replace(recordsOf('human-1')), true);
	// The whole finding in one assertion: `hasId` can now say no.
	assertEquals(store.hasId('worker-1'), false);
	assertEquals(store.size, 1);
	assertEquals(store.records.map((record) => record.id), ['human-1']);
});

Deno.test('keyreload: the store refuses to reach zero records', () => {
	// An empty store makes `credentialed` false, and on a loopback bind that mints
	// an anonymous principal for every credential-less request — so emptying the
	// key file would grant access in the name of revoking it.
	const store = new ApiKeyStore(recordsOf('worker-1'));
	assertEquals(store.replace([]), false);
	assertEquals(store.size, 1);
	assert(store.hasId('worker-1'));
});

// --- the reload path ---------------------------------------------------------

Deno.test('keyreload: a changed file replaces the records, and the removed id is denied', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1', 'human-1'));
	const files = new Map<string, string>([['keys.json', JSON.stringify(recordsOf('human-1'))]]);
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		readFile: (path) => Promise.resolve(files.get(path)!),
	});

	assertEquals(await watcher.reload(), 'applied');
	assertEquals(store.hasId('worker-1'), false);
	assert(store.hasId('human-1'));
	// The count reaches the log; an id never does.
	assert(log.lines.some((line) => line === 'info API key records reloaded: 1 in force'));
	assert(!log.lines.some((line) => line.includes('human-1')));
	await watcher.close();
});

Deno.test('keyreload: a malformed file keeps the previous good records and warns', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const bad = new Map<string, string>([
		// Exactly what a half-finished editor save leaves behind.
		['keys.json', '[{"id":"worker-2","sha'],
	]);
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		readFile: (path) => Promise.resolve(bad.get(path)!),
	});

	assertEquals(await watcher.reload(), 'failed');
	assert(store.hasId('worker-1'), 'the previous records must stand');
	assertEquals(store.size, 1);
	const warned = log.lines.find((line) => line.startsWith('warn'));
	assert(warned !== undefined);
	assertStringIncludes(warned, 'the previous key records stand');
	await watcher.close();
});

Deno.test('keyreload: a file that has been emptied is refused, not applied', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		readFile: () => Promise.resolve('[]\n'),
	});

	assertEquals(await watcher.reload(), 'refused');
	assert(store.hasId('worker-1'));
	const warned = log.lines.find((line) => line.startsWith('warn'));
	assert(warned !== undefined);
	assertStringIncludes(warned, 'refusing to leave this server with no credentials');
	assertStringIncludes(warned, 'restart to remove the last credential');
	await watcher.close();
});

Deno.test('keyreload: an unreadable file keeps the records rather than throwing', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const watcher = new ApiKeyFileWatcher({
		path: 'gone.json',
		apply: (records) => store.replace(records),
		logger: log,
		readFile: () => Promise.reject(new Deno.errors.NotFound('no such file')),
	});

	assertEquals(await watcher.reload(), 'failed');
	assert(store.hasId('worker-1'));
	await watcher.close();
});

Deno.test('keyreload: a reloaded file cannot introduce a raw key (DD-7)', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const minted = await generateApiKey('worker-2');
	// An operator pasting the raw key beside the hash is exactly the mistake the
	// record schema exists to survive: the field is stripped at parse.
	const text = JSON.stringify([{ ...minted.record, key: minted.key, secret: minted.key }]);
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		readFile: () => Promise.resolve(text),
	});

	assertEquals(await watcher.reload(), 'applied');
	const held = store.records;
	assertEquals(held.length, 1);
	assertEquals(Object.keys(held[0]!).sort(), ['id', 'sha256']);
	assertEquals(JSON.stringify(held).includes(minted.key), false);
	// And the hash still verifies, so nothing was lost in stripping.
	assert(await store.verify(minted.key) !== null);
	await watcher.close();
});

Deno.test('keyreload: a label the parser refuses does not reach the store (SEC-15)', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		// `holder_name` reaches every viewer of every session, so a label carrying
		// markup is refused by the same parser startup uses, not sanitised here.
		readFile: () => Promise.resolve(JSON.stringify([{ id: 'worker-2', sha256: 'b'.repeat(64), label: '<img src=x>' }])),
	});

	assertEquals(await watcher.reload(), 'failed');
	assert(store.hasId('worker-1'));
	assertEquals(store.hasId('worker-2'), false);
	await watcher.close();
});

Deno.test('keyreload: a filesystem that cannot be watched warns and keeps serving', async () => {
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1'));
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: log,
		watch: () => {
			throw new Deno.errors.NotSupported('watching is not supported on this filesystem');
		},
	});

	watcher.start();
	assertEquals(watcher.watching, false);
	const warned = log.lines.find((line) => line.startsWith('warn'));
	assert(warned !== undefined);
	assertStringIncludes(warned, 'key records stand until this process restarts');
	await watcher.close();
});

// --- against a real file ------------------------------------------------------

Deno.test('keyreload: a real edit on disk reloads without any write grant of its own', async () => {
	const files = await scratch();
	const log = recorder();
	const store = new ApiKeyStore(recordsOf('worker-1', 'human-1'));
	await files.write(JSON.stringify(recordsOf('worker-1', 'human-1')));
	const watcher = new ApiKeyFileWatcher({
		path: files.file,
		apply: (records) => store.replace(records),
		logger: log,
		debounceMs: 10,
	});
	try {
		watcher.start();
		assertEquals(watcher.watching, true);
		await files.write(JSON.stringify(recordsOf('human-1')));
		// The watch is a filesystem notification, so the deadline is generous and
		// the assertion is on the observed effect rather than on a timer.
		const deadline = Date.now() + 10_000;
		while (store.hasId('worker-1') && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assertEquals(store.hasId('worker-1'), false, 'the watch did not deliver the change within 10 s');
		assert(store.hasId('human-1'));
	} finally {
		await watcher.close();
		files.drop();
	}
});

// --- the proof the finding asked for -------------------------------------------

function fakeSession(): BrowserSession {
	return {
		tabs: [],
		cachedBrowserState: null,
		agentFocusTargetId: null,
		cdpClient: null,
		sessionManager: null,
		eventBus: new EventBus({ name: 'keyreload-test' }),
		stop: () => Promise.resolve(),
		kill: () => Promise.resolve(),
	} as unknown as BrowserSession;
}

Deno.test('keyreload: a live stream ends when its principal disappears from a reloaded key file', async () => {
	const files = await scratch();
	const worker = await generateApiKey('worker-1', ['mcp:invoke']);
	const human = await generateApiKey('human-1', ['view:watch']);
	await files.write(JSON.stringify([worker.record, human.record]));

	// A real chain over the real records, exactly as `startGateway` builds it.
	const config = loadConfig({ TTK_LOG_LEVEL: 'error', TTK_API_KEYS: JSON.stringify([worker.record, human.record]) });
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const principal = await verifier.resolve(worker.key);
	assert(principal !== null);
	assertEquals(verifier.stillAuthorized(principal), true);

	const log = recorder();
	const watcher = new ApiKeyFileWatcher({
		path: files.file,
		apply: (records) => verifier.replaceApiKeys(records),
		logger: log,
		debounceMs: 10,
	});

	let now = 1_760_000_000_000;
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.resolve(fakeSession()) });
	const streams = new EventStreamRegistry();
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (c, next) => {
		c.set('requestId', 'req-keyreload');
		c.set('principal', principal as Principal);
		await next();
	});
	attachEventStream({
		app,
		registry,
		streams,
		logger: createLogger({ level: 'error', write: () => {} }),
		config,
		now: () => now,
		keepAliveMs: 20,
		revalidateMs: 1,
		// The production wiring, verbatim (`app.ts`).
		revalidate: (subject) => verifier.stillAuthorized(subject),
	});

	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	try {
		watcher.start();
		await registry.resolve(undefined);
		const response = await app.fetch(new Request('http://gateway.test/api/v1/sessions/default/events'));
		assertEquals(response.status, 200);
		reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		const pump = async (limit: number): Promise<void> => {
			for (let i = 0; i < limit && !text.includes('stream-expired'); i++) {
				const { value, done } = await reader!.read();
				if (value !== undefined) text += decoder.decode(value, { stream: true });
				if (done) return;
			}
		};
		await pump(4);
		assertStringIncludes(text, 'stream-open');

		// Revocation: the operator removes the worker's record from the key file.
		await files.write(JSON.stringify([human.record]));
		const deadline = Date.now() + 10_000;
		while (verifier.stillAuthorized(principal) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assertEquals(
			verifier.stillAuthorized(principal),
			false,
			'the reload did not remove the principal within 10 s',
		);

		// The stream re-earns its decision on the next check and is terminated.
		now += 10_000;
		await pump(40);
		assertStringIncludes(text, 'event: bye');
		assertStringIncludes(text, '"reason":"stream-expired"');
		// The key never left the process, and the log never named the principal.
		assertEquals(log.lines.some((line) => line.includes(worker.key)), false);
	} finally {
		await reader?.cancel().catch(() => {});
		await watcher.close();
		await registry.shutdown('server-shutdown');
		files.drop();
	}
});
