import { assertEquals } from '@std/assert';
import { BrowserMemoryCache, dumpBrowser, type DumpClient, footprintOf, parseMemorySize } from './browser_memory.ts';

const event = (pid: number, footprint: string) => ({
	ph: 'v',
	pid,
	args: { dumps: { process_totals: { private_footprint_bytes: footprint } } },
});

Deno.test('browser memory: the dump’s process totals are summed per process, the last dump of each winning', () => {
	assertEquals(footprintOf([event(1, '100000'), event(2, '200000'), event(1, '300000'), { ph: 'X', pid: 3 }]), {
		private_bytes: 0x300000 + 0x200000,
		processes: 2,
	});
	assertEquals(footprintOf([{ ph: 'v', pid: 1, args: {} }]), null);
	assertEquals(footprintOf([]), null);
});

/** A CDP stand-in: answers the three Tracing commands, then reports `events` and completes. */
function fakeClient(events: unknown[], options: { refuse?: boolean } = {}): DumpClient & { calls: string[] } {
	const listeners = new Map<string, (params: unknown) => void>();
	const calls: string[] = [];
	return {
		calls,
		sendRaw<T>(method: string): Promise<T> {
			calls.push(method);
			if (method === 'Tracing.start' && options.refuse) return Promise.reject(new Error('Tracing is already started'));
			if (method === 'Tracing.end') {
				queueMicrotask(() => {
					listeners.get('Tracing.dataCollected')?.({ value: events });
					listeners.get('Tracing.tracingComplete')?.({});
				});
			}
			return Promise.resolve((method === 'Tracing.requestMemoryDump' ? { success: true } : {}) as T);
		},
		on: ((event: string, listener: (params: unknown) => void) => {
			listeners.set(event, listener);
			return () => listeners.delete(event);
		}) as never,
	};
}

Deno.test('browser memory: one memory-infra trace, a dump, the end; a browser already tracing reads as not measured', async () => {
	const client = fakeClient([event(10, 'a00000'), event(11, '100000')]);
	assertEquals(await dumpBrowser(client), { private_bytes: 0xa00000 + 0x100000, processes: 2 });
	assertEquals(client.calls, ['Tracing.start', 'Tracing.requestMemoryDump', 'Tracing.end']);
	assertEquals(await dumpBrowser(fakeClient([], { refuse: true })), null);
});

Deno.test('browser memory: figures are cached per session, one dump in flight, a slow dump answers with the last one', async () => {
	let now = 0;
	let dumps = 0;
	let release!: () => void;
	let slow = false;
	const cache = new BrowserMemoryCache(async () => {
		dumps++;
		if (slow) await new Promise<void>((resolve) => release = resolve);
		return { private_bytes: dumps * 100, processes: 1 };
	}, () => now);
	const client = {} as DumpClient;
	assertEquals((await cache.get('a', client))?.private_bytes, 100);
	assertEquals((await cache.get('a', client))?.private_bytes, 100, 'fresh: no second dump');
	assertEquals(dumps, 1);
	now = 20_000;
	slow = true;
	assertEquals((await cache.get('a', client, 10))?.private_bytes, 100, 'a slow dump answers with the last figure');
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assertEquals((await cache.get('a', client))?.private_bytes, 200, 'the dump that finished is kept');
	assertEquals(await cache.get('b', null), null, 'no client, nothing measured');
	cache.retain(new Set());
	assertEquals(await cache.get('a', null), null, 'a closed session is forgotten');
});

Deno.test('TTK_MEMORY_LIMIT sizes: Compose spellings, bytes, nothing else', () => {
	assertEquals(parseMemorySize('1536m'), 1536 * 1024 ** 2);
	assertEquals(parseMemorySize('1.5g'), 1.5 * 1024 ** 3);
	assertEquals(parseMemorySize('1610612736'), 1610612736);
	assertEquals(parseMemorySize('512MiB'), 512 * 1024 ** 2);
	assertEquals(parseMemorySize('lots'), null);
	assertEquals(parseMemorySize('0'), null);
});
