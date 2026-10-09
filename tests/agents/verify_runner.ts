/** Verify the private runner over its loopback-published test port with real ACP fixture I/O. */
import { assertEquals } from '@std/assert';
import { AgentBridgeClient } from '../../packages/agents/mod.ts';
import { resolve } from '@std/path';

async function docker(args: string[]): Promise<string> {
	const output = await new Deno.Command('docker', { args, stdout: 'piped', stderr: 'piped' }).output();
	if (output.code) throw new Error(`Docker operation failed: ${new TextDecoder().decode(output.stderr)}`);
	return new TextDecoder().decode(output.stdout).trim();
}

const name = `ttk-runner-test-${crypto.randomUUID().slice(0, 8)}`;
const scratch = resolve('tests/.scratch', name);
const token = crypto.randomUUID() + crypto.randomUUID();
const clients: AgentBridgeClient[] = [];
await Deno.mkdir(scratch, { recursive: true });
await Deno.writeTextFile(`${scratch}/token`, token);
await Deno.writeTextFile(
	`${scratch}/commands.json`,
	JSON.stringify([{ id: 'fixture', executable: '/opt/agents/agent', args: [], cwd: '/agent-workspace' }]),
);
try {
	await docker(['build', '-f', 'docker/Dockerfile.agent-runner', '-t', 'tykotech-agent-runner:0.2.0', '.']);
	console.log('PASS runner image build and frozen dependency cache');
	await docker(['build', '-f', 'tests/agents/Dockerfile.fixture', '-t', 'tykotech-agent-runner:fixture', '.']);
	await docker([
		'run',
		'-d',
		'--name',
		name,
		'--read-only',
		'--cap-drop=ALL',
		'--security-opt=no-new-privileges:true',
		'--pids-limit=64',
		'--memory=256m',
		'--cpus=1',
		'--publish',
		'127.0.0.1::8789',
		'--tmpfs',
		'/tmp:size=32m',
		'--mount',
		`type=bind,src=${scratch},dst=/run/secrets,readonly`,
		'--env',
		'TTK_AGENT_COMMANDS_FILE=/run/secrets/commands.json',
		'--env',
		'TTK_AGENT_BRIDGE_TOKEN_FILE=/run/secrets/token',
		'tykotech-agent-runner:fixture',
	]);
	const address = await docker(['port', name, '8789/tcp']);
	const url = `http://${address}`;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(`${url}/healthz`);
			await response.body?.cancel();
			if (response.ok) break;
		} catch { /* Service startup is bounded below. */ }
		if (attempt === 59) throw new Error('Runner failed readiness');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	console.log('PASS nonroot read-only runner readiness and exact launch grants');
	const unauthorized = await fetch(`${url}/v1/open`, { method: 'POST', body: '{}' });
	assertEquals(unauthorized.status, 401);
	await unauthorized.body?.cancel();
	console.log('PASS private bearer gate refuses credentialless callers');
	const client = new AgentBridgeClient({ url, token, agent: 'fixture' }, 'container-fixture');
	clients.push(client);
	await client.open();
	const controller = new AbortController();
	const events: Record<string, unknown>[] = [];
	const reading = (async (): Promise<void> => {
		for await (const event of client.events(controller.signal)) events.push(event);
	})().catch(() => {});
	await client.request('initialize', { protocolVersion: 1 });
	const sessionId = (await client.request('session/new', { cwd: client.cwd, mcpServers: [] })).sessionId;
	assertEquals(
		await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'container proof' }] }),
		{ stopReason: 'end_turn' },
	);
	for (
		let attempt = 0;
		attempt < 100 && !events.some((event) => event.method === 'bridge/prompt_complete');
		attempt++
	) await new Promise((resolve) => setTimeout(resolve, 10));
	assertEquals(events.some((event) => event.method === 'session/update'), true);
	console.log('PASS ACP initialize/session/prompt/stream with an actual Linux subprocess');
	assertEquals((await docker(['top', name, '-eo', 'pid,args'])).includes('sleep 300'), true);
	await client.close();
	controller.abort();
	await reading;
	for (let attempt = 0; attempt < 100; attempt++) {
		const processes = await docker(['top', name, '-eo', 'pid,args']);
		if (!processes.includes('acp_fixture.ts') && !processes.includes('sleep 300')) break;
		if (attempt === 99) throw new Error('Agent subprocess survived connection cancellation');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	console.log('PASS connection shutdown reaps the Linux agent process group');
} finally {
	await Promise.allSettled(clients.map((client) => client.close()));
	await docker(['rm', '-f', name]).catch(() => {});
	// Exact randomly named test scratch is confined below tests/.scratch.
	await Deno.remove(scratch, { recursive: true });
}
