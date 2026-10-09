/** Private ACP runner composition root. D-066 fixes executable grants in the runner image. */
import { AcpClient, type AcpCommand, AgentBridgeServer } from '../packages/agents/mod.ts';
import { isAbsolute } from '@std/path';

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected commands configuration object');
	}
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) {
		throw new Error('Invalid command configuration string');
	}
	return value;
}
async function file(path: string, limit: number): Promise<string> {
	const info = await Deno.stat(path);
	if (!info.isFile || info.size > limit) throw new Error('Agent configuration file exceeds limit');
	return await Deno.readTextFile(path);
}

/** Parse only operator commands; HTTP callers can select their ids, never their arguments. */
export async function loadAgentCommands(path: string): Promise<AcpCommand[]> {
	const config = JSON.parse(await file(path, 256 * 1024));
	if (!Array.isArray(config) || config.length < 1 || config.length > 16) {
		throw new Error('Expected 1 to 16 configured agents');
	}
	const commands: AcpCommand[] = [];
	for (const item of config) {
		const command = record(item);
		const executable = string(command.executable);
		const cwd = string(command.cwd);
		if (!isAbsolute(executable) || !isAbsolute(cwd)) throw new Error('Agent executable and cwd must be absolute');
		if (!(await Deno.stat(executable)).isFile || !(await Deno.stat(cwd)).isDirectory) {
			throw new Error('Agent command unavailable');
		}
		if (!Array.isArray(command.args) || command.args.length > 64) throw new Error('Expected bounded agent arguments');
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(record(command.env ?? {}))) {
			if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || key === 'DENO_FLAGS' || key === 'NODE_OPTIONS') {
				throw new Error('Unsafe agent environment name');
			}
			if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)$/.test(key)) {
				throw new Error('Agent credentials must be supplied by file reference, never process environment');
			}
			const configured = string(value);
			if (key.endsWith('_FILE') && !isAbsolute(configured)) {
				throw new Error('Agent credential file references must be absolute');
			}
			env[key] = configured;
		}
		const mcpServers: Record<string, unknown>[] = [];
		const servers = command.mcp_servers ?? [];
		if (!Array.isArray(servers) || servers.length > 8) throw new Error('Expected bounded configured MCP servers');
		for (const item of servers) {
			const server = record(item);
			if (server.bearer_file !== undefined || server.headers !== undefined) {
				throw new Error('Static MCP credentials are forbidden; use gateway session delegation');
			}
			const url = new URL(string(server.url));
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
				throw new Error('Invalid configured MCP URL');
			}
			mcpServers.push({
				type: 'http',
				name: string(server.name),
				url: url.href,
			});
		}
		commands.push({ id: string(command.id), executable, cwd, args: command.args.map(string), env, mcpServers });
	}
	return commands;
}

if (import.meta.main) {
	const commandFile = Deno.env.get('TTK_AGENT_COMMANDS_FILE');
	const tokenFile = Deno.env.get('TTK_AGENT_BRIDGE_TOKEN_FILE');
	if (!commandFile || !tokenFile) throw new Error('Runner requires commands and bridge token files');
	const commands = await loadAgentCommands(commandFile);
	const token = (await file(tokenFile, 8192)).trim();
	// Readiness proves the same identity and measured launch matrix can negotiate
	// the configured executable, rather than reporting only that its file exists.
	for (const command of commands) {
		const probe = new AcpClient(command);
		try {
			await probe.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 10_000);
		} finally {
			await probe.close();
		}
	}
	const bridge = new AgentBridgeServer(commands, token);
	const server = Deno.serve(
		{ hostname: '0.0.0.0', port: 8789 },
		(request: Request): Promise<Response> => bridge.fetch(request),
	);
	const shutdown = async (): Promise<void> => {
		await bridge.close();
		await server.shutdown();
	};
	Deno.addSignalListener('SIGTERM', shutdown);
	Deno.addSignalListener('SIGINT', shutdown);
}
