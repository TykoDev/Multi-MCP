/**
 * One version everywhere a client or deployer reads it: every workspace manifest, `VERSION` (the `McpServer` identity
 * and the live-view `meta.version`), the image tag, and the MCP Registry entry `server.json`.
 */
import { assert, assertEquals } from '@std/assert';
import { VERSION } from '../../packages/cli/mod.ts';
import { ENV_NAMES } from '../../packages/gateway/src/config.ts';
import { SECRET_FILE_VARS } from '../../packages/gateway/src/secrets.ts';
import { SERVER_DESCRIPTION, SERVER_TITLE } from '../../packages/mcp/src/identity.ts';

const json = async <T>(path: string): Promise<T> => JSON.parse(await Deno.readTextFile(path)) as T;

Deno.test('version: the root and every workspace manifest, the image tag and VERSION agree', async () => {
	const root = await json<{ version: string; workspace: string[] }>('deno.json');
	assertEquals(root.version, VERSION);
	assert(root.workspace.length >= 10, 'the workspace is readable');
	for (const member of root.workspace) {
		assertEquals((await json<{ version?: string }>(`${member}/deno.json`)).version, VERSION, member);
	}
	for (const file of ['deno.json', 'docker-compose.yml']) {
		assert((await Deno.readTextFile(file)).includes(`tykotech-mcp:${VERSION}`), `${file}: the image tag`);
	}
});

interface ServerJson {
	name: string;
	title: string;
	description: string;
	version: string;
	packages: Array<{
		registryType: string;
		identifier: string;
		transport: { type: string; url: string };
		environmentVariables: Array<{ name: string; isRequired: boolean; isSecret: boolean; description: string }>;
	}>;
	[key: string]: unknown;
}

Deno.test('registry entry: server.json carries the identity the server reports and every variable a deployer sets', async () => {
	const entry = await json<ServerJson>('server.json');
	assertEquals([entry.name, entry.version, entry.title, entry.description], [
		'eu.tykotech/tykotech-mcp',
		VERSION,
		SERVER_TITLE,
		SERVER_DESCRIPTION,
	]);
	assertEquals(entry.packages.length, 1);
	const [oci] = entry.packages;
	assertEquals([oci!.registryType, oci!.identifier], ['oci', `tykotech-mcp:${VERSION}`]);
	assertEquals(oci!.transport, { type: 'streamable-http', url: 'http://localhost:8787/mcp' });
	for (const key of ['$schema', 'remotes', 'repository']) {
		assertEquals(entry[key], undefined, `${key}: set at publication`);
	}

	// Every name the gateway reads, except a secret's inline form: a registry client is never invited to put a
	// credential into the environment Chromium inherits.
	const names = oci!.environmentVariables.map((variable) => variable.name);
	const inline = Object.keys(SECRET_FILE_VARS);
	assertEquals(new Set(names).size, names.length, 'no variable twice');
	assertEquals(names.filter((name) => !(ENV_NAMES as readonly string[]).includes(name)), [], 'unknown names');
	assertEquals(ENV_NAMES.filter((name) => !inline.includes(name) && !names.includes(name)), [], 'unlisted names');
	const secretFiles = new Set([
		...Object.values(SECRET_FILE_VARS),
		'TTK_VAULT_TOKEN_FILE',
		'TTK_OP_CONNECT_TOKEN_FILE',
		'TTK_SIGNED_LINK_KEY_FILE',
		'TTK_DB_KEY_FILE',
		'TTK_MODEL_PROVIDERS_FILE', // may carry an inline api_key
	]);
	for (const variable of oci!.environmentVariables) {
		assertEquals(variable.isSecret, secretFiles.has(variable.name), `${variable.name}.isSecret`);
		assertEquals(variable.isRequired, false, `${variable.name}: the image starts with none set`);
		assert(variable.description.length > 0 && variable.description.length <= 200, `${variable.name}.description`);
	}
});
