/**
 * Combined shipping-overlay proof: ACP delegation preserves MCP scopes and sandbox ownership.
 *
 *   docker build -t tykotech-mcp:verify .
 *   docker build -f docker/Dockerfile.sandbox -t tykotech-sandbox:verify .
 *   deno task test:agents:compose --tag verify
 *
 * ERRATUM(E-112), review R3-4 / K-6: the gateway and sandbox images are the ones built from this tree under `--tag`
 * (required; a deployed tag is refused). The proof builds the agent runner from this tree as
 * `tykotech-agent-runner:<tag>` and its fixture as `tykotech-agent-runner:<tag>-fixture` (removed at the end) — never
 * over the deployed `:0.2.0`. Every secret, the administrator record included, is made in a scratch folder, and the
 * resolved configuration is checked to say so before anything starts.
 *
 * D-151: it layers `docker-compose.sandbox.yml`, which since D-151 only swaps the generated sandbox token for an
 * operator-made file — so this proof is also the one that keeps the operator-file path working (the sandbox proof runs
 * the generated token).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assert, assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import { encodeBase64Url } from '@std/encoding/base64url';
import {
	assertBuilt,
	assertIsolated,
	type ComposeConfig,
	deployedTags,
	docker as dockerCli,
	dockerExecutable,
	proofTag,
	writeStackFiles,
	writeSyntheticAdmin,
} from '../support/compose_proof.ts';

const tag = proofTag(Deno.args, await deployedTags());
const runnerImage = `tykotech-agent-runner:${tag}`;
const images = {
	'tykotech-mcp': `tykotech-mcp:${tag}`,
	sandbox: `tykotech-sandbox:${tag}`,
	'agent-runner': `tykotech-agent-runner:${tag}-fixture`,
};
const executable = await dockerExecutable();
async function docker(args: string[]): Promise<string> {
	return (await dockerCli(executable, args)).trim();
}
await assertBuilt(executable, [images['tykotech-mcp'], images.sandbox]);
async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const project = `ttk-agents-compose-${crypto.randomUUID().slice(0, 8)}`;
const scratch = resolve('tests/.scratch', project);
await Deno.mkdir(scratch, { recursive: true });
const keys = Array.from({ length: 4 }, () => crypto.randomUUID() + crypto.randomUUID());
await Deno.writeTextFile(
	`${scratch}/keys.json`,
	JSON.stringify(
		await Promise.all(keys.map(async (key, index) => ({
			id: ['alice', 'bob', 'restricted', 'agent-only'][index],
			sha256: await digest(key),
			scopes: index < 2
				? ['agent:invoke', 'mcp:invoke', 'sandbox:execute']
				: index === 2
				? ['agent:invoke', 'mcp:invoke']
				: ['agent:invoke'],
		}))),
	),
);
await Deno.writeTextFile(`${scratch}/sandbox-token`, crypto.randomUUID() + crypto.randomUUID());
await Deno.writeTextFile(`${scratch}/bridge-token`, crypto.randomUUID() + crypto.randomUUID());
await writeSyntheticAdmin(`${scratch}/admin-user.json`);
await Deno.writeTextFile(
	`${scratch}/commands.json`,
	JSON.stringify([{
		id: 'default',
		executable: '/opt/agents/agent',
		args: [],
		cwd: '/agent-workspace',
		mcp_servers: [{ name: 'tykotech', url: 'http://tykotech-mcp:8787/mcp' }],
	}]),
);
// The base file's database key (D-154) and the default stack's placeholders and A2A peer pair: every secret the
// combined files declare comes from this folder.
await Deno.writeTextFile(`${scratch}/db-key`, `${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}\n`);
const stack = await writeStackFiles(scratch);
const safePath = (path: string): string => JSON.stringify(`${scratch}/${path}`.replaceAll('\\', '/'));
await Deno.writeTextFile(
	`${scratch}/compose.yml`,
	`services:
  tykotech-mcp:
    image: ${images['tykotech-mcp']}
    ports: !override ['127.0.0.1::8787']
    environment:
      TTK_PUBLIC_URL: http://127.0.0.1:8787
  sandbox:
    image: ${images.sandbox}
  a2a-peer:
    image: ${images['tykotech-mcp']}
  agent-runner:
    image: ${images['agent-runner']}
    init: true
secrets:
  ttk_api_keys:
    file: ${safePath('keys.json')}
  ttk_sandbox_token:
    file: ${safePath('sandbox-token')}
  ttk_admin_user:
    file: ${safePath('admin-user.json')}
  ttk_agent_bridge_token:
    file: ${safePath('bridge-token')}
  ttk_agent_commands:
    file: ${safePath('commands.json')}
  ttk_db_key:
    file: ${safePath('db-key')}
${stack.secrets}`,
);
const compose = [
	'compose',
	'-p',
	project,
	'-f',
	resolve('docker-compose.yml'),
	'-f',
	resolve('docker-compose.sandbox.yml'),
	'-f',
	resolve('docker-compose.agents.yml'),
	'-f',
	`${scratch}/compose.yml`,
];
const clients: Client[] = [];
let fixtureBuilt = false;
try {
	const config = JSON.parse(await docker([...compose, 'config', '--format', 'json']));
	// Before anything is built or started: the tree's images by tag, and every secret file from the scratch folder.
	assertIsolated(config as ComposeConfig, {
		scratch,
		images: { ...images, 'a2a-peer': images['tykotech-mcp'] },
		required: [
			'ttk_admin_user',
			'ttk_api_keys',
			'ttk_db_key',
			'ttk_sandbox_token',
			'ttk_agent_bridge_token',
			'ttk_agent_commands',
			...stack.names,
		],
	});
	assert(!config.services.sandbox.ports && !config.services['agent-runner'].ports);
	assert(config.networks['agents-private'].internal && config.networks['sandbox-private'].internal);
	assert(
		!config.services['tykotech-mcp'].volumes.some((mount: { target: string }) =>
			mount.target === '/work' || mount.target === '/agent-workspace'
		),
	);
	assert(
		!config.services['agent-runner'].secrets.some((secret: { source: string }) => secret.source === 'ttk_api_keys'),
	);
	await docker(['build', '-f', 'docker/Dockerfile.agent-runner', '-t', runnerImage, '.']);
	fixtureBuilt = true;
	await docker([
		'build',
		'-f',
		'tests/agents/Dockerfile.fixture',
		'--build-arg',
		`RUNNER_IMAGE=${runnerImage}`,
		'-t',
		images['agent-runner'],
		'.',
	]);
	// `--pull never`: an image that is not there is a refusal, never a download.
	await docker([...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120']);
	const origin = `http://${await docker([...compose, 'port', 'tykotech-mcp', '8787'])}`;
	for (const key of keys.slice(0, 3)) {
		const client = new Client({ name: 'agents-compose-proof', version: '0.2.0' });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				requestInit: { headers: { authorization: `Bearer ${key}` } },
			}),
		);
		clients.push(client);
	}
	const prompt = async (
		index: number,
		tool: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const response = await fetch(`${origin}/api/v1/agent/tasks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${keys[index]}`, 'content-type': 'application/json' },
			body: JSON.stringify({ message: `invoke_mcp:${JSON.stringify({ tool, arguments: args })}` }),
		});
		assertEquals(response.status, 202);
		const submitted = await response.json();
		for (let attempt = 0; attempt < 400; attempt++) {
			const response = await fetch(`${origin}/api/v1/agent/tasks/${submitted.task.id}`, {
				headers: { authorization: `Bearer ${keys[index]}` },
			});
			const current = await response.json();
			const state = current.task.status.state;
			if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state)) {
				assertEquals(state, 'TASK_STATE_COMPLETED', JSON.stringify(current.task.status));
				const parts = current.task.artifacts[0]?.parts as { text: string }[];
				return JSON.parse(parts.map((part) => part.text).join(''));
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error('ACP delegated task did not terminate');
	};
	const created = await prompt(0, 'sandbox_create', { files: { 'owner.txt': 'alice-owned' } });
	const result = created.result as { isError?: boolean; structuredContent: { result: { workspace_id: string } } };
	assert(result.isError !== true, JSON.stringify(created));
	const aliceWorkspace = result.structuredContent.result.workspace_id;
	assert(typeof aliceWorkspace === 'string');
	const read = await clients[0]!.callTool({
		name: 'sandbox_read',
		arguments: { workspace_id: aliceWorkspace, path: 'owner.txt' },
	});
	assert(read.isError !== true, JSON.stringify(read));
	assertEquals(
		(await clients[1]!.callTool({
			name: 'sandbox_read',
			arguments: { workspace_id: aliceWorkspace, path: 'owner.txt' },
		})).isError,
		true,
	);
	const executed = await prompt(0, 'sandbox_exec', { workspace_id: aliceWorkspace, command: 'python3 -c "print(73)"' });
	assertEquals(
		(executed.result as { structuredContent: { result: { output: string } } }).structuredContent.result.output,
		'73\n',
	);
	console.log(
		'PASS originating Alice ACP task invokes scoped MCP and executes in a real cage; Bob cannot access Alice workspace',
	);
	const bobCreated = await prompt(1, 'sandbox_create', { files: { 'owner.txt': 'bob-owned' } });
	const bobWorkspace =
		(bobCreated.result as { structuredContent: { result: { workspace_id: string } } }).structuredContent.result
			.workspace_id;
	assert(
		(await clients[1]!.callTool({ name: 'sandbox_read', arguments: { workspace_id: bobWorkspace, path: 'owner.txt' } }))
			.isError !== true,
	);
	assertEquals(
		(await clients[0]!.callTool({ name: 'sandbox_read', arguments: { workspace_id: bobWorkspace, path: 'owner.txt' } }))
			.isError,
		true,
	);
	console.log('PASS independent Bob ACP session preserves his own sandbox principal and owner boundary');
	const denied = await prompt(2, 'sandbox_create', {});
	assertEquals((denied.result as { isError?: boolean }).isError, true);
	assertEquals((await prompt(3, 'sandbox_create', {})).missingScopedMcp, true);
	console.log('PASS delegated scopes cannot widen sandbox:execute and agent:invoke alone obtains no MCP credential');
	assert(
		(await clients[0]!.callTool({ name: 'sandbox_delete', arguments: { workspace_id: aliceWorkspace } })).isError !==
			true,
	);
	assert(
		(await clients[1]!.callTool({ name: 'sandbox_delete', arguments: { workspace_id: bobWorkspace } })).isError !==
			true,
	);
	console.log(
		`PASS combined production Compose overlays (${Object.values(images).join(', ')}, scratch secrets only) have ` +
			'private services, distinct volumes, scoped ephemeral delegation and no static MCP key',
	);
} catch (error) {
	console.error(
		await docker([...compose, 'logs', '--no-color', '--tail', '30']).catch(() => 'Container logs unavailable'),
	);
	throw error;
} finally {
	await Promise.allSettled(clients.map((client) => client.close()));
	await docker([...compose, 'down', '--volumes', '--remove-orphans']).catch(() => {});
	// The fixture image is this proof's alone; the runner image under the tag is left for whoever built the others.
	if (fixtureBuilt) await docker(['rmi', images['agent-runner']]).catch(() => {});
	await Deno.remove(scratch, { recursive: true });
}
