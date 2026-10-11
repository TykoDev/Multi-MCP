/**
 * An in-memory coding sandbox speaking the service's HTTP contract (`GET /healthz`, `POST /v1/<operation>` with
 * `{ principal, args }`), for browser-tier tests that need workspaces without cages. One workspace, its files held in
 * a map; `listed` records every directory listing the gateway asked for, so a test can assert exactly what the page
 * requested. Hand `env` and `secrets` to `harness()`; close it after the harness.
 */
import { join } from '@std/path';

export interface FakeSandbox {
	readonly url: string;
	/** The one workspace's id. */
	readonly workspaceId: string;
	/** The workspace's files: path → content (directories are implied by the paths). */
	readonly files: Map<string, string>;
	/** Every `list` of a directory, by path (`''` is the root), in order. */
	readonly listed: string[];
	/** For `harness({ env })`: the sandbox URL and its token file. */
	readonly env: Record<string, string>;
	/** For `harness({ secrets })`: the resolved token. */
	readonly secrets: Record<string, string>;
	close(): Promise<void>;
	/** `await using`: closes it. */
	[Symbol.asyncDispose](): Promise<void>;
}

/** One directory of `files`, as the sandbox lists it (`.git` never appears), in no particular order. */
function listDirectory(files: Map<string, string>, path: string): Array<{ name: string; type: string }> {
	const prefix = path === '' ? '' : `${path}/`;
	const seen = new Map<string, string>();
	for (const file of files.keys()) {
		if (!file.startsWith(prefix)) continue;
		const [head, ...tail] = file.slice(prefix.length).split('/');
		if (head === undefined || head === '') continue;
		seen.set(head, tail.length > 0 ? 'directory' : 'file');
	}
	return [...seen].map(([name, type]) => ({ name, type })).reverse();
}

export async function startFakeSandbox(
	options: { name?: string; workspaceId?: string; files?: Record<string, string> } = {},
): Promise<FakeSandbox> {
	const workspaceId = options.workspaceId ?? '7d0c3c4e-5b8f-4a7e-9a51-2f1f3b9c0a11';
	const files = new Map(Object.entries(options.files ?? {}));
	const listed: string[] = [];
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
		const url = new URL(request.url);
		if (url.pathname === '/healthz') return Response.json({ ok: true, backend: 'bwrap', clone: false });
		const operation = url.pathname.replace(/^\/v1\//, '');
		const { args } = await request.json() as { principal: string; args: Record<string, unknown> };
		switch (operation) {
			case 'list': {
				if (args.workspace_id === undefined) {
					return Response.json({
						workspaces: [{
							workspace_id: workspaceId,
							name: options.name ?? 'demo',
							created_at: new Date().toISOString(),
						}],
					});
				}
				const path = typeof args.path === 'string' ? args.path : '';
				listed.push(path);
				return Response.json({ entries: listDirectory(files, path), truncated: false });
			}
			case 'read': {
				const content = files.get(String(args.path));
				return content === undefined
					? Response.json({ error: 'not_found' }, { status: 404 })
					: Response.json({ content, bytes: content.length });
			}
			case 'write':
				files.set(String(args.path), String(args.content));
				return Response.json({ written: true, bytes: String(args.content).length, path: args.path });
			case 'diff':
				return Response.json({ patch: '' });
			default:
				return Response.json({ error: 'not_found' }, { status: 404 });
		}
	});
	const dir = join('tests', '.scratch', `fake-sandbox-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const tokenFile = join(dir, 'sandbox-token');
	const token = 'e2e-sandbox-token-0123456789abcdefghijklmnopqrstuvwxyz';
	await Deno.writeTextFile(tokenFile, token);
	const close = async (): Promise<void> => {
		await server.shutdown();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	};
	return {
		url: `http://127.0.0.1:${server.addr.port}`,
		workspaceId,
		files,
		listed,
		env: { TTK_SANDBOX_URL: `http://127.0.0.1:${server.addr.port}`, TTK_SANDBOX_TOKEN_FILE: tokenFile },
		secrets: { TTK_SANDBOX_TOKEN: token },
		close,
		[Symbol.asyncDispose]: close,
	};
}
