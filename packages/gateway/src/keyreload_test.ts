/** The API-key reload, and the revocation it makes reachable. */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import { SessionRegistry } from '@tykotech/mcp';
import { ulid } from '@std/ulid';
import { ApiKeyFileWatcher } from './keyreload.ts';
import { ApiKeyStore, generateApiKey, VerifierChain } from './auth.ts';
import { type ApiKeyRecord, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { attachEventStream, EventStreamRegistry } from './eventstream.ts';
import type { AppVariables } from './app.ts';
import type { Principal } from './auth.ts';
import { fakeSession } from './support_test.ts';

/** A scratch directory under the one path the unit tier may write to. */
async function scratch(): Promise<{ dir: string; file: string; write(text: string): Promise<void>; drop(): void }> {
	const dir = `tests/.scratch/keyreload-${ulid()}`;
	await Deno.mkdir(dir, { recursive: true });
	const file = `${dir}/ttk_api_keys.json`;
	return {
		dir,
		file,
		write: (text: string) => Deno.writeTextFile(file, text),
		drop: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
	};
}

function recordsOf(...ids: string[]): ApiKeyRecord[] {
	return ids.map((id, index) => ({ id, sha256: `${index}`.repeat(1).padStart(64, 'a') }));
}

/** A store holding `worker-1`, a watcher whose file reads as `readFile` says, and what the watcher logged. */
function watched(
	readFile: (path: string) => Promise<string>,
	extra: Partial<ConstructorParameters<typeof ApiKeyFileWatcher>[0]> = {},
) {
	const lines: string[] = [];
	const store = new ApiKeyStore(recordsOf('worker-1', 'human-1'));
	const watcher = new ApiKeyFileWatcher({
		path: 'keys.json',
		apply: (records) => store.replace(records),
		logger: { info: (msg: string) => lines.push(`info ${msg}`), warn: (msg: string) => lines.push(`warn ${msg}`) },
		readFile,
		...extra,
	});
	return { store, watcher, lines, warned: () => lines.find((line) => line.startsWith('warn')) ?? '' };
}

Deno.test('keyreload: a changed file swaps the records, so a removed id is denied; the store never reaches zero', async () => {
	const { store, watcher, lines } = watched(() => Promise.resolve(JSON.stringify(recordsOf('human-1'))));
	assertEquals(await watcher.reload(), 'applied');
	assertEquals([store.hasId('worker-1'), store.hasId('human-1'), store.size], [false, true, 1]);
	// The count reaches the log; an id never does.
	assert(lines.includes('info API key records reloaded: 1 in force'));
	assert(!lines.some((line) => line.includes('human-1')));
	await watcher.close();
	// An empty store makes `credentialed` false, which on loopback mints an anonymous principal: emptying is refused.
	assertEquals(store.replace([]), false);
	assertEquals(store.size, 1);
	const emptied = watched(() => Promise.resolve('[]\n'));
	assertEquals(await emptied.watcher.reload(), 'refused');
	assert(emptied.store.hasId('worker-1'));
	assertStringIncludes(emptied.warned(), 'refusing to leave this server with no credentials');
	assertStringIncludes(emptied.warned(), 'restart to remove the last credential');
	await emptied.watcher.close();
});

Deno.test('keyreload: a malformed, unreadable or refused file keeps the previous records; raw keys are stripped', async () => {
	for (
		const read of [
			// Exactly what a half-finished editor save leaves behind.
			() => Promise.resolve('[{"id":"worker-2","sha'),
			() => Promise.reject(new Deno.errors.NotFound('no such file')),
			// `holder_name` reaches every viewer, so markup in a label is refused by the startup parser, not sanitised.
			() => Promise.resolve(JSON.stringify([{ id: 'worker-2', sha256: 'b'.repeat(64), label: '<img src=x>' }])),
		]
	) {
		const { store, watcher, warned } = watched(read);
		assertEquals(await watcher.reload(), 'failed');
		assertEquals([store.hasId('worker-1'), store.hasId('worker-2'), store.size], [true, false, 2]);
		assertStringIncludes(warned(), 'the previous key records stand');
		await watcher.close();
	}
	// An operator pasting the raw key beside the hash: the field is stripped at parse, and the hash still verifies.
	const minted = await generateApiKey('worker-2');
	const { store, watcher } = watched(() =>
		Promise.resolve(JSON.stringify([{ ...minted.record, key: minted.key, secret: minted.key }]))
	);
	assertEquals(await watcher.reload(), 'applied');
	assertEquals(store.records.map((record) => Object.keys(record).sort()), [['id', 'sha256']]);
	assert(!JSON.stringify(store.records).includes(minted.key));
	assert(await store.verify(minted.key) !== null);
	await watcher.close();
});

Deno.test('keyreload: an unwatchable filesystem warns and keeps serving; a real edit on disk reloads', async () => {
	const unwatchable = watched(() => Promise.resolve('[]'), {
		watch: () => {
			throw new Deno.errors.NotSupported('watching is not supported on this filesystem');
		},
	});
	unwatchable.watcher.start();
	assertEquals(unwatchable.watcher.watching, false);
	assertStringIncludes(unwatchable.warned(), 'key records stand until this process restarts');
	await unwatchable.watcher.close();

	const files = await scratch();
	await files.write(JSON.stringify(recordsOf('worker-1', 'human-1')));
	const { store, watcher } = watched((path) => Deno.readTextFile(path), { path: files.file, debounceMs: 10 });
	try {
		watcher.start();
		assertEquals(watcher.watching, true);
		await files.write(JSON.stringify(recordsOf('human-1')));
		// A filesystem notification: a generous deadline, asserting the observed effect rather than a timer.
		const deadline = Date.now() + 10_000;
		while (store.hasId('worker-1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assertEquals([store.hasId('worker-1'), store.hasId('human-1')], [false, true]);
	} finally {
		await watcher.close();
		await files.drop();
	}
});

// --- the end-to-end proof: a live stream ends on revocation ------------------

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
	assert(verifier.currentScopes(principal) !== null);

	const log = {
		lines: [] as string[],
		info: (m: string) => void log.lines.push(m),
		warn: (m: string) => void log.lines.push(m),
	};
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
		scopesNow: (subject) => verifier.currentScopes(subject),
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
		while (verifier.currentScopes(principal) !== null && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assertEquals(
			verifier.currentScopes(principal),
			null,
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
		await files.drop();
	}
});
