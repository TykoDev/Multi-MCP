/** The resource URI helpers (R4, E-33): pure, and the gateway routes on them. */
import { assertEquals } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import { fileResourceUri, parseFileResourceUri, registerResources, resourceUri } from './resources.ts';
import { SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';

Deno.test('resources: file URIs round-trip and encode both segments', () => {
	const uri = fileResourceUri('sess/1', 'b61d5943-1086-4a5b-bc70-fdd8144a25ca');
	assertEquals(uri, 'ttk://session/sess%2F1/files/b61d5943-1086-4a5b-bc70-fdd8144a25ca');
	assertEquals(parseFileResourceUri(uri), { sessionId: 'sess/1', fileId: 'b61d5943-1086-4a5b-bc70-fdd8144a25ca' });
});

Deno.test('resources: only file URIs parse as file URIs', () => {
	assertEquals(parseFileResourceUri(resourceUri('default', 'state')), null);
	assertEquals(parseFileResourceUri('ttk://session/default/files'), null);
	assertEquals(parseFileResourceUri('ttk://session/default/files/a/b'), null);
	assertEquals(parseFileResourceUri('http://session/default/files/a'), null);
	assertEquals(parseFileResourceUri('ttk://session/%E0%A4%A/files/a'), null, 'malformed escapes are not a match');
});

/**
 * The session resources carry the same page content the tools do — the element
 * tree, the serialized text, a PNG of the screen, and any downloaded file — so
 * they take `mcp:invoke`.
 *
 * Until B1.5 `registerResources` took no scopes at all and was called outside
 * the catalog's scope loop, so a `view:watch`-only credential, or an OAuth token
 * whose scope claim matched nothing and yielded an empty set, could read the
 * whole observation through `resources/read`. That contradicted the reasoning
 * `SPECS/API-CONTRACT.md` route 14 already applies to downloaded files: watching
 * a browser is not permission to carry off its documents.
 */
Deno.test('resources: a principal without mcp:invoke gets no session resources', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	try {
		const registered = (scopes: Scope[]): string[] => {
			const server = new McpServer({ name: 't', version: '0' });
			registerResources(server, registry, new Set(scopes));
			return Object.keys(
				(server as unknown as { _registeredResourceTemplates: Record<string, unknown> })
					._registeredResourceTemplates ?? {},
			).sort();
		};

		assertEquals(registered(['view:watch', 'view:control', 'admin', 'task']), []);
		assertEquals(registered([]), []);
		// And the scope still buys what it always bought.
		assertEquals(registered(['mcp:invoke']), ['browser-session', 'browser-session-file']);
	} finally {
		await registry.shutdown();
	}
});
