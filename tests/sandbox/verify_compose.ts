/**
 * Disposable Compose proof: gateway MCP scopes and ownership all the way to a real code cage.
 *
 *   docker build -t tykotech-mcp:verify .
 *   docker build -f docker/Dockerfile.sandbox -t tykotech-sandbox:verify .
 *   deno task test:compose --tag verify
 *
 * ERRATUM(E-112), review R3-4 / K-6: it runs the images built from this tree under `--tag` (required; a deployed tag is
 * refused), never the deployed ones, and mounts nothing from the checkout's `secrets/`: the keys and a synthetic
 * administrator record are made in a scratch folder, and the resolved configuration is checked to say so before
 * anything starts. Its own project name, its own volumes, an ephemeral loopback port; all removed at the end.
 *
 * D-151: it runs `docker-compose.yml` alone, as a plain `up` does — the sandbox is in the base file, and its token is
 * the one the service generates into the project's own `ttk-sandbox-token` volume, so no token file is made here (the
 * agents proof covers the operator-file overlay, `docker-compose.sandbox.yml`).
 *
 * D-154: the database key is a scratch secret too, and the proof checks the default stack end to end: `/data/ttk.db`
 * is created owner-only with no plaintext key in it or beside it; a provider key typed through the admin route survives
 * a restart sealed; `ttk seed` runs inside the image; and the built-in model agent — on a scripted OpenAI-compatible
 * model (`fake-model`, the gateway image running a scratch script on the default network) — creates a workspace, runs
 * code in the sandbox cage and saves what it saw to its memory, which the same caller then finds over MCP.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assert, assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import {
	assertBuilt,
	assertIsolated,
	type ComposeConfig,
	deployedTags,
	docker,
	dockerExecutable,
	proofTag,
	writeStackFiles,
	writeSyntheticAdmin,
} from '../support/compose_proof.ts';

const tag = proofTag(Deno.args, await deployedTags());
const images = { 'tykotech-mcp': `tykotech-mcp:${tag}`, sandbox: `tykotech-sandbox:${tag}` };
const executable = await dockerExecutable();
const run = (args: string[]): Promise<string> => docker(executable, args);
await assertBuilt(executable, Object.values(images));
async function digest(value: string): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}
await Deno.mkdir('tests/.scratch', { recursive: true });
const scratch = resolve(await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'sandbox-compose-' }));
const project = `ttk-compose-${crypto.randomUUID().slice(0, 8)}`;
const fixture = resolve(`${scratch}/compose.yml`);
const keyFile = resolve(`${scratch}/keys.json`);
const adminFile = resolve(`${scratch}/admin-user.json`);
const dbKeyFile = resolve(`${scratch}/db-key`);
const fakeModel = resolve(`${scratch}/fake_model.ts`);
const keys = [
	crypto.randomUUID() + crypto.randomUUID(),
	crypto.randomUUID() + crypto.randomUUID(),
	crypto.randomUUID() + crypto.randomUUID(),
	crypto.randomUUID() + crypto.randomUUID(),
];
/** D-154: who manages providers and runs the built-in agent, with every grant its task's tools need. */
const OPERATOR_SCOPES = [
	'admin',
	'mcp:invoke',
	'agent:invoke',
	'model:invoke',
	'sandbox:execute',
	'files:read',
	'files:write',
];
await Deno.writeTextFile(
	keyFile,
	JSON.stringify(
		await Promise.all(keys.map(async (key, index) => ({
			id: ['alice', 'bob', 'no-execution', 'operator'][index],
			sha256: await digest(key),
			scopes: index === 3 ? OPERATOR_SCOPES : index === 2 ? ['mcp:invoke'] : ['mcp:invoke', 'sandbox:execute'],
		}))),
	),
);
await writeSyntheticAdmin(adminFile);
// D-154: 32 random bytes, base64url, as `setup` writes it.
await Deno.writeTextFile(
	dbKeyFile,
	`${
		btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_')
			.replace(/=+$/, '')
	}\n`,
);
/**
 * D-154: a scripted OpenAI-compatible model. Its turn is chosen by how many tool results the transcript holds: create a
 * workspace, run its program, save the output to memory, then answer with what the cage printed.
 *
 * D-156: a transcript whose system prompt is SlopLord's takes the SlopLord script instead — create a workspace with a
 * test, run it in the cage, then answer with the test's outcome and whether any browser tool was offered (SlopLord's
 * allowlist offers none) — so the answer proves the profile's prompt and tool list reached the model.
 */
await Deno.writeTextFile(
	fakeModel,
	`const reply = (message, finish) => Response.json({
	id: 'chatcmpl-proof', object: 'chat.completion',
	choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: finish }],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const call = (name, args) => reply({ tool_calls: [{ id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
Deno.serve({ hostname: '0.0.0.0', port: 8080 }, async (request) => {
	if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
	const { messages, tools } = await request.json();
	const results = messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
	const text = results.join('\\n');
	const workspace = () => /workspace_id[^0-9a-f]*([0-9a-f-]{36})/.exec(text)?.[1] ?? 'missing';
	if (String(messages[0]?.content).startsWith('You are SlopLord')) {
		if (results.length === 0) {
			return call('sandbox_create', {
				name: 'sloplord-proof',
				files: { 'test_answer.py': 'assert 6 * 7 == 42\\nprint("tests pass")\\n' },
			});
		}
		if (results.length === 1) return call('sandbox_exec', { workspace_id: workspace(), command: 'python3 test_answer.py' });
		const browser = (tools ?? []).some((tool) => String(tool.function?.name).startsWith('browser_'));
		return reply({
			content: 'sloplord-proof: ' + (text.includes('tests pass') ? 'tests pass' : 'tests fail') +
				'; browser tools offered: ' + (browser ? 'yes' : 'no'),
		}, 'stop');
	}
	if (results.length === 0) return call('sandbox_create', { name: 'agent-proof', files: { 'main.py': 'print(6 * 7)\\n' } });
	if (results.length === 1) return call('sandbox_exec', { workspace_id: workspace(), command: 'python3 main.py' });
	const printed = text.includes('42') ? '42' : 'nothing';
	if (results.length === 2) {
		return call('memory_save', { collection: 'proof', items: [{ id: 'answer', text: 'the cage printed ' + printed }] });
	}
	return reply({ content: 'agent-proof: the cage printed ' + printed }, 'stop');
});
`,
);
const file = (path: string): string => JSON.stringify(path.replaceAll('\\', '/'));
// The default stack's placeholders and its A2A peer's token pair, as `deno task setup` writes them.
const stack = await writeStackFiles(scratch);
await Deno.writeTextFile(
	fixture,
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
  fake-model:
    image: ${images['tykotech-mcp']}
    command: ['deno', 'run', '--allow-net=0.0.0.0:8080', '/fake/fake_model.ts']
    # The image's healthcheck probes the gateway's /healthz, which this script does not serve.
    healthcheck:
      disable: true
    volumes:
      - type: bind
        source: ${file(fakeModel)}
        target: /fake/fake_model.ts
        read_only: true
secrets:
  ttk_api_keys:
    file: ${file(keyFile)}
  ttk_admin_user:
    file: ${file(adminFile)}
  ttk_db_key:
    file: ${file(dbKeyFile)}
${stack.secrets}`,
);
const compose = [
	'compose',
	'-p',
	project,
	'-f',
	resolve('docker-compose.yml'),
	'-f',
	fixture,
];
const clients: Client[] = [];
try {
	const config = JSON.parse(await run([...compose, 'config', '--format', 'json']));
	// Before anything starts: the tree's images by tag, and every secret file from the scratch folder.
	assertIsolated(config as ComposeConfig, {
		scratch,
		images: { ...images, 'a2a-peer': images['tykotech-mcp'], 'fake-model': images['tykotech-mcp'] },
		required: ['ttk_admin_user', 'ttk_api_keys', 'ttk_db_key', ...stack.names],
	});
	// D-154: the vault key reaches the gateway as a secret file, never the environment's value.
	assertEquals(config.services['tykotech-mcp'].environment.TTK_DB_KEY_FILE, '/run/secrets/ttk_db_key');
	// D-151: no token secret at all; both services name the generated token, the gateway through a read-only mount.
	assert(!config.secrets?.ttk_sandbox_token, 'the default stack needs no sandbox token file');
	assertEquals(config.services.sandbox.environment.TTK_SANDBOX_TOKEN_FILE, '/run/ttk-sandbox-token/token');
	assertEquals(
		config.services['tykotech-mcp'].environment.TTK_SANDBOX_TOKEN_FILE,
		'/run/secrets/ttk-sandbox-token/token',
	);
	const tokenMounts = (service: string) =>
		(config.services[service].volumes as Array<{ source?: string; target: string; read_only?: boolean }>)
			.filter((mount) => mount.source === 'ttk-sandbox-token')
			.map((mount) => `${mount.target}${mount.read_only ? ':ro' : ''}`);
	assertEquals(tokenMounts('tykotech-mcp'), ['/run/secrets/ttk-sandbox-token:ro']);
	assertEquals(tokenMounts('sandbox'), ['/run/ttk-sandbox-token']);
	assert(!config.services.sandbox.ports, 'Production sandbox must not publish a port');
	assert(config.networks['sandbox-private'].internal, 'Private ingress must be an internal network');
	assert(!config.services['tykotech-mcp'].volumes.some((mount: { target: string }) => mount.target === '/work'));
	// `--pull never`: an image that is not there is a refusal, never a download.
	await run([...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90']);
	// D-151: the service made its token on this first start — owner-read-only, uid 1993, 64 hex characters.
	assertEquals(
		(await run([...compose, 'exec', '-T', 'sandbox', 'stat', '-c', '%a %u %s', '/run/ttk-sandbox-token/token']))
			.trim(),
		'400 1993 65',
	);
	let origin = `http://${(await run([...compose, 'port', 'tykotech-mcp', '8787'])).trim()}`;
	const url = new URL(`${origin}/mcp`);
	for (const key of keys) {
		const client = new Client({ name: 'sandbox-compose-proof', version: '0.2.0' });
		await client.connect(
			new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
		);
		clients.push(client);
	}
	const alice = clients[0]!;
	const bob = clients[1]!;
	const restricted = clients[2]!;
	const tools = await alice.listTools();
	assert(tools.tools.some((tool) => tool.name === 'sandbox_create'), 'Ready sandbox tools must be advertised');
	const created = await alice.callTool({
		name: 'sandbox_create',
		arguments: { name: 'Compose test', files: { 'main.py': 'print(17)\n' } },
	});
	assert(created.isError !== true, JSON.stringify(created.content));
	const workspace_id = (created.structuredContent as { result: { workspace_id: string } }).result.workspace_id;
	assert(typeof workspace_id === 'string');
	const written = await alice.callTool({
		name: 'sandbox_write',
		arguments: { workspace_id, path: 'main.py', content: 'print(42)\n' },
	});
	assert(written.isError !== true);
	const executed = await alice.callTool({
		name: 'sandbox_exec',
		arguments: { workspace_id, command: 'python3 main.py' },
	});
	assert(executed.isError !== true, JSON.stringify(executed.content));
	assertEquals((executed.structuredContent as { result: { output: string } }).result.output, '42\n');
	const diff = await alice.callTool({ name: 'sandbox_diff', arguments: { workspace_id } });
	assert(diff.isError !== true);
	assert((diff.structuredContent as { result: { patch: string } }).result.patch.includes('print(42)'));
	const foreign = await bob.callTool({ name: 'sandbox_read', arguments: { workspace_id, path: 'main.py' } });
	assertEquals(foreign.isError, true, 'Foreign workspace access must be denied through MCP');
	const denied = await restricted.callTool({ name: 'sandbox_exec', arguments: { workspace_id, command: 'true' } });
	assertEquals(denied.isError, true, 'MCP invocation alone must not grant sandbox execution');
	const browser = await alice.callTool({ name: 'browser_get_state', arguments: {} });
	assert(browser.isError !== true, JSON.stringify(browser.content));
	const deleted = await alice.callTool({ name: 'sandbox_delete', arguments: { workspace_id } });
	assert(deleted.isError !== true);

	// --- D-154: the database, its vault, and the built-in agent end to end -------------------------------------------
	const exec = (command: string) => run([...compose, 'exec', '-T', 'tykotech-mcp', 'sh', '-c', command]);
	assertEquals((await exec('stat -c "%a %u" /data/ttk.db')).trim(), '600 1993', 'the database is owner-only');
	const operatorKey = keys[3]!;
	const api = async (method: string, path: string, body?: unknown): Promise<Response> =>
		await fetch(`${origin}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${operatorKey}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const typedKey = `sk-compose-proof-${crypto.randomUUID()}`;
	const providers = {
		default: 'fake',
		providers: [
			{
				id: 'fake',
				kind: 'openai',
				label: 'Scripted model',
				base_url: 'http://fake-model:8080/v1',
				models: ['proof-1'],
				allow_http: true,
				key: { mode: 'none' },
			},
			{
				id: 'cloud',
				kind: 'openai',
				base_url: 'https://api.example.invalid/v1',
				models: ['m1'],
				key: { mode: 'set', value: typedKey },
			},
		],
	};
	const put = await api('PUT', '/api/v1/system/model-providers', providers);
	const putText = await put.text();
	assertEquals(put.status, 200, putText);
	assert(!putText.includes(typedKey), 'the typed key is never echoed');
	// Sealed: no byte of the database files carries it, and no plaintext key file sits beside them.
	assertEquals((await exec(`grep -l '${typedKey}' /data/ttk.db* || true`)).trim(), '');
	assert(!(await exec('ls /data')).includes('link-signing.key'), 'no plaintext link key');
	// The maintenance command runs inside the image under its own matrix, beside the running server.
	const seeded = await run([...compose, 'run', '--rm', '--no-deps', '-T', 'tykotech-mcp', 'ttk', 'seed']);
	assert(seeded.includes('model providers: no source configured'), seeded);
	// A restart reopens the vault with the same key: the sealed provider key is still there.
	await run([...compose, 'restart', 'tykotech-mcp']);
	await run([...compose, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90']);
	origin = `http://${(await run([...compose, 'port', 'tykotech-mcp', '8787'])).trim()}`;
	const after = await (await api('GET', '/api/v1/system/model-providers')).json();
	assertEquals(
		after.providers.map((provider: { id: string; key: { source: string } }) => [provider.id, provider.key.source]),
		[['fake', 'none'], ['cloud', 'stored']],
	);
	assertEquals(after.store.vault, 'unlocked');

	// The built-in agent: model turn → sandbox_create → sandbox_exec in the cage → memory_save → answer.
	const submitted = await api('POST', '/api/v1/agent/tasks', { message: 'run the proof', provider: 'fake' });
	assertEquals(submitted.status, 202, await submitted.clone().text());
	const taskId = (await submitted.json()).task.id as string;
	let task: { status: { state: string; message?: unknown } } = { status: { state: 'unknown' } };
	for (let attempt = 0; attempt < 240; attempt++) {
		task = (await (await api('GET', `/api/v1/agent/tasks/${taskId}`)).json()).task;
		if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status.state)) break;
		await new Promise((done) => setTimeout(done, 500));
	}
	assertEquals(task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(task));
	assert(JSON.stringify(task).includes('agent-proof: the cage printed 42'), JSON.stringify(task));
	// The agent's memory is its caller's: the same key finds the note over MCP; another caller does not.
	const operator = new Client({ name: 'sandbox-compose-proof', version: '0.2.0' });
	await operator.connect(
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${operatorKey}` } },
		}),
	);
	clients.push(operator);
	const found = await operator.callTool({
		name: 'memory_search',
		arguments: { collection: 'proof', query: 'what did the cage print' },
	});
	assert(found.isError !== true, JSON.stringify(found.content));
	const hits = (found.structuredContent as { result: { results: Array<{ id: string; text: string }> } }).result.results;
	assertEquals(hits[0]?.id, 'answer');
	assertEquals(hits[0]?.text, 'the cage printed 42');

	// --- D-156: SlopLord, the built-in coding agent, served over A2A by the default stack -----------------------------
	// Its public card says it takes text: the stack composes the sandbox and the scripted provider is the default.
	const sloplordCard = await (await fetch(`${origin}/a2a/agents/sloplord/.well-known/agent-card.json`)).json();
	assertEquals(sloplordCard.name, 'SlopLord');
	assertEquals(sloplordCard.defaultInputModes, ['text/plain'], JSON.stringify(sloplordCard));
	assertEquals(
		(sloplordCard.supportedInterfaces as Array<{ url: string; protocolBinding: string }>)
			.find((entry) => entry.protocolBinding === 'JSONRPC')?.url,
		'http://127.0.0.1:8787/a2a/agents/sloplord',
	);
	// One blocking A2A SendMessage to its JSON-RPC endpoint: model → sandbox_create → sandbox_exec in the cage → answer.
	const sent = await fetch(`${origin}/a2a/agents/sloplord`, {
		method: 'POST',
		headers: { authorization: `Bearer ${operatorKey}`, 'content-type': 'application/json', 'a2a-version': '1.0' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'SendMessage',
			params: {
				message: {
					messageId: crypto.randomUUID(),
					role: 'ROLE_USER',
					parts: [{ text: 'write a test for 6 * 7 and make it pass' }],
				},
			},
		}),
	});
	const rpc = await sent.json();
	const sloplordTask = rpc.result?.task as
		| { id: string; status: { state: string }; metadata?: { agent?: string; provider?: string } }
		| undefined;
	assertEquals(sloplordTask?.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(rpc));
	assertEquals(sloplordTask?.metadata?.agent, 'sloplord');
	assertEquals(sloplordTask?.metadata?.provider, 'fake');
	assert(
		JSON.stringify(sloplordTask).includes('sloplord-proof: tests pass; browser tools offered: no'),
		JSON.stringify(sloplordTask),
	);
	// The command really ran in the cage: the workspace SlopLord created is the caller's own.
	const workspaces = await operator.callTool({ name: 'sandbox_list', arguments: {} });
	assert(JSON.stringify(workspaces.structuredContent).includes('sloplord-proof'), JSON.stringify(workspaces.content));
	// REST and its persisted document carry the profile too.
	const listedTask = (await (await api('GET', `/api/v1/agent/tasks/${sloplordTask!.id}`)).json()).task;
	assertEquals(listedTask.metadata.agent, 'sloplord');
	console.log(
		`PASS Compose (${images['tykotech-mcp']}, ${images.sandbox}, scratch secrets only, generated sandbox token): ` +
			'private sandbox, ' +
			'authenticated scoped MCP create/write/exec/diff/delete, wrong-owner and scope denial, sandboxed Chromium state, ' +
			'owner-only database with sealed keys across a restart, ttk seed in the image, built-in agent through ' +
			'sandbox and memory, SlopLord over A2A through the sandbox',
	);
} catch (error) {
	console.error(await run([...compose, 'logs', '--no-color', '--tail', '40']).catch(() => 'Logs unavailable'));
	throw error;
} finally {
	await Promise.allSettled(clients.map((client) => client.close()));
	await run([...compose, 'down', '--volumes', '--remove-orphans']).catch(() => {});
	await Deno.remove(scratch, { recursive: true });
}
