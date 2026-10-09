/**
 * D-108: `capabilities.tykotech.sandbox = { backend }` — the coding sandbox's backend, told to the caller who can run
 * commands in it, and to nobody else (SEC-16).
 */
import { assertEquals } from '@std/assert';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { buildCapabilities } from './capabilities.ts';
import { SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';
import { capabilitiesFor, type McpDeps } from './server.ts';

const availability = { persistence: false, recording: false, egress: false };

Deno.test('D-108 capabilities: the sandbox block is for a principal holding sandbox:execute', () => {
	const sandbox = { backend: 'docker' } as const;
	const block = (scopes: Scope[]) =>
		buildCapabilities({ version: 'v', scopes: new Set(scopes), availability, sandbox });
	assertEquals(block(['mcp:invoke', 'sandbox:execute']).sandbox, { backend: 'docker' });
	assertEquals(block(['sandbox:execute']).sandbox, { backend: 'docker' });
	assertEquals(block(['mcp:invoke', 'view:watch']).sandbox, undefined);
	assertEquals(
		buildCapabilities({ version: 'v', scopes: new Set<Scope>(['sandbox:execute']), availability }).sandbox,
		undefined,
		'no sandbox configured, or none has answered',
	);
});

Deno.test('D-108 capabilities: the backend is read live, for an owned caller only, once the sandbox has said', () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0, launch: () => Promise.reject(new Error('no browser')) });
	let backend: 'bwrap' | 'docker' | null = null;
	const deps: McpDeps = { registry, version: 'v', sandboxBackend: () => backend };
	const owned: AuthInfo = { token: 't', clientId: 'k', scopes: ['sandbox:execute'], extra: { owner: 'api-key:k' } };
	const unowned: AuthInfo = { token: 't', clientId: 'k', scopes: ['sandbox:execute'], extra: {} };
	assertEquals(capabilitiesFor(deps, owned).sandbox, undefined);
	backend = 'bwrap';
	assertEquals(capabilitiesFor(deps, owned).sandbox, { backend: 'bwrap' });
	backend = 'docker';
	assertEquals(capabilitiesFor(deps, owned).sandbox, { backend: 'docker' });
	// GW-5: a caller with no owner holds no extension tool, so it hears nothing of the sandbox either.
	assertEquals(capabilitiesFor(deps, unowned).sandbox, undefined);
	assertEquals(capabilitiesFor({ registry, version: 'v' }, owned).sandbox, undefined);
});
