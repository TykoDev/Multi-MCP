/**
 * D-080: the per-instance change notifications, on the modern era (the SDK's listen router filters) and when the
 * connection is not open. The legacy era's subscribe filtering runs end to end in gateway `stateful_test.ts`.
 */
import { assertEquals } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import { resourceUris } from './resources.ts';
import { watchResourceChanges } from './resource_notifications.ts';

type Change = { kind: 'session-added' | 'session-removed' | 'page-changed' | 'files-changed'; sessionId: string };

function harness(connected: boolean) {
	const server = new McpServer({ name: 'notify-test', version: '0' });
	const sent: string[] = [];
	server.isConnected = () => connected;
	server.sendResourceListChanged = () => void sent.push('list_changed');
	server.server.sendResourceUpdated = (params: { uri: string }) => {
		sent.push(`updated ${params.uri}`);
		return Promise.resolve();
	};
	const watchers = new Set<(change: Change) => void>();
	const registry = {
		watch: (watcher: (change: Change) => void) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
	};
	const fire = (change: Change) => {
		for (const watcher of watchers) watcher(change);
	};
	return { server, sent, registry, fire, watchers };
}

Deno.test('D-080: a modern-era instance hands every change to the SDK router, which filters', () => {
	const h = harness(true);
	const watch = watchResourceChanges(h.server, h.registry as never, 'modern');
	assertEquals(h.server.server.getCapabilities().resources?.listChanged, true);
	assertEquals(h.server.server.getCapabilities().resources?.subscribe, undefined);
	h.fire({ kind: 'session-added', sessionId: 's' });
	h.fire({ kind: 'files-changed', sessionId: 's' });
	h.fire({ kind: 'page-changed', sessionId: 's' });
	assertEquals(h.sent, ['list_changed', 'list_changed', ...resourceUris('s').map((uri) => `updated ${uri}`)]);
	watch.close();
	assertEquals(h.watchers.size, 0);
});

Deno.test('D-080: a legacy-era instance advertises subscribe and sends updated only for subscriptions', () => {
	const h = harness(true);
	watchResourceChanges(h.server, h.registry as never, 'legacy');
	assertEquals(h.server.server.getCapabilities().resources?.subscribe, true);
	h.fire({ kind: 'page-changed', sessionId: 's' });
	assertEquals(h.sent, [], 'nothing was subscribed');
});

Deno.test('D-080: nothing is sent, or queued, while the connection is not open', () => {
	const h = harness(false);
	watchResourceChanges(h.server, h.registry as never, 'modern');
	h.fire({ kind: 'session-added', sessionId: 's' });
	h.fire({ kind: 'page-changed', sessionId: 's' });
	assertEquals(h.sent, []);
});
