/**
 * AC-GATE-12: the eleven versions, and the one value that reaches the wire.
 *
 * Eleven since C15: the list stopped at nine when `packages/sandbox` and `packages/agents` joined the workspace, so
 * both carried a version nothing checked. The list stays written out — a glob would hide a new manifest — and a
 * second test now holds it to the root `workspace`, so the next package cannot be missed the same way.
 *
 * **This is a one-off assertion, not a standing gate, and that is a decision
 * rather than an omission.** `SPECS/COMPLETIONS-CRITERIA.md` records four gates
 * as absent, versions among them, and `design-lead` ruled that adding one is
 * scope this run did not buy — the intake had already chosen the cheaper answer
 * when it deferred G-9 "so the 0.2.0 bump is done deliberately across nine
 * files". What this file does is make the bump *checkable* now: nine
 * `deno.json` files agree, and `VERSION` — which reaches a client twice, as the
 * `McpServer` identity and as the live-view `meta.version` — is that same value.
 *
 * It runs in the unit tier with `--allow-read=.`, so it reads the manifests
 * rather than trusting a constant that says what they contain.
 */
import { assert, assertEquals } from '@std/assert';
import { VERSION } from '../../packages/cli/mod.ts';
import { ENV_NAMES } from '../../packages/gateway/src/config.ts';
import { SECRET_FILE_VARS } from '../../packages/gateway/src/secrets.ts';
import { SERVER_DESCRIPTION, SERVER_TITLE } from '../../packages/mcp/src/identity.ts';

/** Every manifest that carries a version. Listed, because a glob would hide a new one. */
const MANIFESTS = [
	'deno.json',
	'packages/agents/deno.json',
	'packages/browser/deno.json',
	'packages/bus/deno.json',
	'packages/cdp/deno.json',
	'packages/cli/deno.json',
	'packages/gateway/deno.json',
	'packages/mcp/deno.json',
	'packages/sandbox/deno.json',
	'packages/web/deno.json',
	'packages/wire/deno.json',
] as const;

async function versionOf(path: string): Promise<unknown> {
	return (JSON.parse(await Deno.readTextFile(path)) as { version?: unknown }).version;
}

Deno.test('AC-GATE-12: all eleven manifests carry one version', async () => {
	const found = await Promise.all(MANIFESTS.map(async (path) => [path, await versionOf(path)] as const));
	const disagreeing = found.filter(([, version]) => version !== VERSION);
	assertEquals(
		disagreeing.map(([path, version]) => `${path}=${String(version)}`),
		[],
		`every manifest must read ${VERSION}`,
	);
	assertEquals(found.length, 11, 'the root plus the ten workspace packages');
});

Deno.test('AC-GATE-12: every workspace member is in the checked list (C15)', async () => {
	const root = JSON.parse(await Deno.readTextFile('deno.json')) as { workspace?: string[] };
	const members = (root.workspace ?? []).map((member) => `${member.replace(/\/$/, '')}/deno.json`);
	assertEquals(
		members.filter((manifest) => !(MANIFESTS as readonly string[]).includes(manifest)),
		[],
		'a workspace package whose version nothing checks',
	);
});

Deno.test('AC-GATE-12: the version that reaches a client is the version in the manifests', async () => {
	// `PKG_VERSION` is on the wire twice and neither is derived from the other, so
	// a miss is visible to a client and invisible to CI. One of the two — the
	// live-view `meta.version` — was a hard-coded `'0.1.0'` until B1.13.
	assertEquals(VERSION, await versionOf('deno.json'));
	const liveview = await Deno.readTextFile('packages/gateway/src/liveview.ts');
	assertEquals(
		liveview.includes("version: '0.1.0'"),
		false,
		'the live-view meta version must come from the build, not from a literal',
	);
});

Deno.test('AC-GATE-12: the image tag the build task publishes moves with the version', async () => {
	const root = await Deno.readTextFile('deno.json');
	const compose = await Deno.readTextFile('docker-compose.yml');
	assertEquals(root.includes(`tykotech-mcp:${VERSION}`), true, 'deno.json build:image tag');
	// The compose file names the same tag; an image built under one and run under
	// the other is the shape of a deploy that silently ships the previous build.
	assertEquals(compose.includes(`tykotech-mcp:${VERSION}`), true, 'docker-compose.yml image tag');
});

// --- R14 (D-122, AC17): the registry entry, kept in the repository and never published from it -------------------

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

const serverJson = async (): Promise<ServerJson> => JSON.parse(await Deno.readTextFile('server.json')) as ServerJson;

Deno.test('AC17: server.json carries the manifest version and the identity the server reports', async () => {
	const entry = await serverJson();
	assertEquals(entry.version, VERSION);
	assertEquals(entry.version, await versionOf('deno.json'));
	assertEquals(entry.name, 'eu.tykotech/tykotech-mcp');
	assertEquals(entry.title, SERVER_TITLE, 'the title serverInfo reports');
	assertEquals(entry.description, SERVER_DESCRIPTION);
	assertEquals(entry.packages.length, 1);
	const [oci] = entry.packages;
	assertEquals(oci!.registryType, 'oci');
	assertEquals(oci!.identifier, `tykotech-mcp:${VERSION}`, 'the tag the build task produces');
	assertEquals(oci!.transport, { type: 'streamable-http', url: 'http://localhost:8787/mcp' });
	// Added by the owner at publication time, not here: they cannot be verified offline (G14).
	for (const key of ['$schema', 'remotes', 'repository']) assertEquals(entry[key], undefined, key);
});

Deno.test('AC17: server.json lists every variable a deployer sets, and marks each secret-bearing file', async () => {
	const variables = (await serverJson()).packages[0]!.environmentVariables;
	const names = variables.map((variable) => variable.name);
	assertEquals(new Set(names).size, names.length, 'no variable twice');
	// The inline forms of a secret are left out on purpose: the image reads secrets from files, so a registry client
	// is never invited to put a credential into the environment Chromium inherits.
	const inline = Object.keys(SECRET_FILE_VARS);
	assertEquals(
		names.filter((name) => !(ENV_NAMES as readonly string[]).includes(name)),
		[],
		'every listed name is one the gateway reads',
	);
	assertEquals(
		ENV_NAMES.filter((name) => !inline.includes(name) && !names.includes(name)),
		[],
		'every name the gateway reads is listed (a new TTK_* variable is added here too)',
	);
	for (const name of inline) assert(!names.includes(name), `${name} is listed inline`);
	const secretFiles = new Set([
		...Object.values(SECRET_FILE_VARS),
		'TTK_VAULT_TOKEN_FILE',
		'TTK_OP_CONNECT_TOKEN_FILE',
		'TTK_SIGNED_LINK_KEY_FILE',
		// D-154: the key that opens every secret sealed in the database.
		'TTK_DB_KEY_FILE',
		// D-143: the providers file may carry an inline `api_key`; it is read by the CLI, never through the environment.
		'TTK_MODEL_PROVIDERS_FILE',
	]);
	for (const variable of variables) {
		assertEquals(variable.isSecret, secretFiles.has(variable.name), `${variable.name}.isSecret`);
		assertEquals(variable.isRequired, false, `${variable.name}: the image starts with none set`);
		assert(variable.description.length > 0 && variable.description.length <= 200, `${variable.name}.description`);
	}
});
