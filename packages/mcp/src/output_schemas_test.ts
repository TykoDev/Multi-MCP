/**
 * AC15 (A8, D-113): every extension and library tool declares a typed `outputSchema` inside the kept `{ result }`
 * envelope, and the dispatcher validates the real results against it.
 *
 * "Validated and unchanged" is checked one way throughout: a success's text block is the handler's own JSON
 * (`json()`), and its `structuredContent` is what survived the dispatcher's schema check. The two must be equal —
 * a field the schema forgot would be stripped from the second and the test would see it.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import * as z from 'zod';
import { captureSession, loadCapture } from '../fixtures/capture_session.ts';
import { EXTENSION_OUTPUT, extensionTools } from './extension_tools.ts';
import { LibraryStore } from './library.ts';
import { LIBRARY_OUTPUT, libraryTools } from './library_tools.ts';
import { SessionRegistry } from './registry.ts';
import { SCOPES } from './scopes.ts';
import { createToolExecutor } from './server.ts';
import type { ToolResult } from './types.ts';

/** The success's validated structured result, after asserting it equals the handler's own JSON. */
function unchanged(name: string, result: ToolResult): Record<string, unknown> {
	const call = result as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	assertEquals(call.isError, undefined, `${name} failed: ${call.content[0]?.text}`);
	const raw = JSON.parse(call.content[0]?.text ?? 'null') as Record<string, unknown>;
	assertEquals(call.structuredContent, raw, `${name}: the schema dropped or changed a field`);
	return (raw as { result: Record<string, unknown> }).result;
}

Deno.test('AC15: every extension and library tool types what is inside its { result } envelope', () => {
	const tools = [
		...extensionTools(
			Object.fromEntries(Object.keys(EXTENSION_OUTPUT).map((name) => [name, () => Promise.resolve({})])),
		),
		...libraryTools(new LibraryStore({ dataDir: 'tests/.scratch/never-created' })),
	];
	// 27 extension (D-154 adds the four memory tools; the MCP Apps stream tickets add two) + 18 library (W2 adds
	// browser_save_to_share).
	assertEquals(tools.length, 45);
	for (const tool of tools) {
		const schema = z.toJSONSchema(tool.outputSchema) as {
			properties?: {
				result?: { type?: string; properties?: object; anyOf?: unknown[]; additionalProperties?: unknown };
			};
			required?: string[];
		};
		assertEquals(schema.required, ['result'], `${tool.name} keeps the envelope`);
		const result = schema.properties?.result;
		assert(result !== undefined, `${tool.name} has a result`);
		// Typed: named properties (or a union of typed objects), never the old open record.
		assert(
			result.properties !== undefined || result.anyOf !== undefined,
			`${tool.name} result is untyped: ${JSON.stringify(result)}`,
		);
	}
});

Deno.test('AC15: real library results validate and pass the dispatcher unchanged', async () => {
	const dir = join('tests/.scratch', `outputs-${crypto.randomUUID().slice(0, 8)}`);
	await Deno.mkdir(dir, { recursive: true });
	const store = new LibraryStore({ dataDir: dir });
	await store.initialize();
	// W2: a session with a download directory, so browser_save_to_share has a session file to copy.
	const downloads = join(dir, 'downloads');
	await Deno.mkdir(downloads);
	const session = captureSession(await loadCapture('baseline_button'));
	const registry = new SessionRegistry({
		reapIntervalMs: 0,
		launch: () => Promise.resolve({ session, downloads: null, downloadsDir: downloads }),
	});
	const call = createToolExecutor({ registry, version: 'test', library: store }, 'owner', new Set(SCOPES));
	const seen = new Set<string>();
	const run = async (name: string, args: Record<string, unknown>) => {
		seen.add(name);
		return unchanged(name, await call(name, args));
	};
	try {
		assertEquals((await run('file_write', { path: 'docs/a.md', content: '# a' })).path, 'docs/a.md');
		assertEquals((await run('file_mkdir', { path: 'docs/empty' })).kind, 'directory');
		assertEquals(((await run('file_list', { path: 'docs' })).entries as unknown[]).length, 2);
		assertEquals((await run('file_stat', { path: 'docs/a.md' })).size, 3);
		assertEquals((await run('file_read', { path: 'docs/a.md' })).content, '# a');
		assertEquals((await run('file_move', { from: 'docs/a.md', to: 'docs/b.md' })).name, 'b.md');
		const skill = { 'SKILL.md': '---\nname: plan\ndescription: Plan work\n---\nPlan it.', 'notes.txt': 'n' };
		assertEquals((await run('skill_put', { name: 'plan', files: skill })).files, ['SKILL.md', 'notes.txt']);
		assertEquals(((await run('skill_list', {})).skills as unknown[]).length, 1);
		assertStringIncludes(String((await run('skill_get', { name: 'plan' })).instructions), 'Plan it.');
		assertEquals((await run('skill_read_file', { name: 'plan', path: 'notes.txt' })).text, 'n');
		const prompt = {
			name: 'ask',
			title: 'Ask',
			description: 'Ask a question',
			arguments: [{ name: 'q', description: 'the question', required: true }, { name: 'tone' }],
			template: 'Q: {{q}} ({{tone}})',
		};
		assertEquals((await run('prompt_put', prompt)).title, 'Ask');
		assertEquals(((await run('prompt_list', {})).prompts as unknown[]).length, 1);
		assertEquals(((await run('prompt_get', { name: 'ask' })).arguments as unknown[]).length, 2);
		assertEquals(
			(await run('prompt_render', { name: 'ask', arguments: { q: 'why', tone: 'calm' } })).text,
			'Q: why (calm)',
		);
		const record = await registry.resolve(undefined);
		const art = await record.files.addArtifact({
			name: 'page.pdf',
			mimeType: 'application/pdf',
			bytes: new TextEncoder().encode('%PDF'),
		});
		const saved = await run('browser_save_to_share', { file_id: art.file_id, path: 'docs/page.pdf' });
		assertEquals([saved.path, saved.size, saved.sha256], ['docs/page.pdf', 4, art.sha256]);
		assertEquals((await run('file_delete', { path: 'docs', recursive: true })).removed, true);
		assertEquals((await run('skill_delete', { name: 'plan' })).removed, true);
		assertEquals((await run('prompt_delete', { name: 'ask' })).removed, true);
		assertEquals([...seen].sort(), Object.keys(LIBRARY_OUTPUT).sort(), 'every library tool was driven');
	} finally {
		await registry.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});

/** The sandbox service's replies, field for field from `packages/sandbox/src` (workspaces.ts, sandbox.ts). */
const LIMITS = {
	disk_budget_bytes: 1_073_741_824,
	disk_used_bytes: 4096,
	file_bytes: 262_144,
	exec_timeout_default_ms: 300_000,
	exec_timeout_max_ms: 900_000,
	exec_output_bytes: 1_048_576,
	session_idle_ms: 1_800_000,
	session_lifetime_ms: 14_400_000,
	session_input_bytes: 16_384,
};
const WORKSPACE = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const SESSION = '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d';
const TASK = {
	id: WORKSPACE,
	contextId: SESSION,
	status: { state: 'TASK_STATE_WORKING', timestamp: new Date(0).toISOString() },
	artifacts: [{ artifactId: 'a', parts: [{ text: 'partial' }] }],
	history: [{ messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hello' }] }],
};
const SERVICE_REPLIES: Record<string, { args: Record<string, unknown>; reply: Record<string, unknown> }> = {
	sandbox_create: {
		args: { name: 'demo' },
		reply: { workspace_id: WORKSPACE, created_at: new Date(0).toISOString(), name: 'demo', limits: LIMITS },
	},
	sandbox_clone: {
		args: { remote: 'app', ref: 'main' },
		reply: {
			workspace_id: WORKSPACE,
			created_at: new Date(0).toISOString(),
			commit: '80445e2e21d609fd261502c216b1847b40923c7d',
			ref: 'main',
			limits: LIMITS,
		},
	},
	sandbox_list: {
		args: {},
		reply: {
			workspaces: [{ workspace_id: WORKSPACE, created_at: new Date(0).toISOString(), busy: true }],
			clone: { hosts: ['github.com'], remotes: ['app'] },
		},
	},
	sandbox_read: { args: { workspace_id: WORKSPACE, path: 'a.txt' }, reply: { content: 'hi', bytes: 2 } },
	sandbox_write: {
		args: { workspace_id: WORKSPACE, path: 'a.txt', content: 'hi' },
		reply: { written: true, bytes: 2, path: 'a.txt' },
	},
	sandbox_exec: {
		args: { workspace_id: WORKSPACE, command: 'echo hi' },
		reply: {
			exitCode: 0,
			timedOut: false,
			killed: null,
			durationMs: 12,
			output: 'hi\n',
			truncated: false,
			omittedBytes: 0,
			outputBytes: 3,
			diskBytes: 4096,
			diskBudgetBytes: 1_073_741_824,
			overBudget: false,
			cleanupOnly: false,
			reachedHosts: [],
			refusedHosts: [],
		},
	},
	sandbox_diff: {
		args: { workspace_id: WORKSPACE },
		reply: { patch: '+hi\n', files: [{ path: 'a.txt', change: 'added' }], truncated: false },
	},
	sandbox_delete: { args: { workspace_id: WORKSPACE }, reply: { removed: true } },
	sandbox_session_open: {
		args: { workspace_id: WORKSPACE },
		reply: { session_id: SESSION, created_at: new Date(0).toISOString() },
	},
	sandbox_session_input: { args: { session_id: SESSION, data: 'ls\n' }, reply: { accepted: true } },
	sandbox_session_read: {
		args: { session_id: SESSION },
		reply: { output: 'a.txt\n', seq: 6, gap: false, ended: false, exit_code: null, killed: null },
	},
	sandbox_session_close: { args: { session_id: SESSION }, reply: { closed: true } },
	agent_peers: { args: {}, reply: { peers: [{ id: 'reviewer' }] } },
	agent_delegate: { args: { peer: 'reviewer', message: 'look' }, reply: { task: TASK } },
	agent_prompt: { args: { message: 'go' }, reply: { task: TASK } },
	agent_get_task: { args: { task_id: WORKSPACE }, reply: { task: TASK } },
	agent_cancel_task: { args: { task_id: WORKSPACE }, reply: { task: TASK } },
	// R1 (D-121).
	agent_run_tool: { args: { tool: 'sandbox_exec', arguments: { command: 'true' } }, reply: { task: TASK } },
	agent_list_tasks: {
		args: { state: 'active', limit: 5 },
		reply: { tasks: [{ ...TASK, history: [] }], truncated: false, unreachable_nodes: ['b'] },
	},
	a2ui_delete: { args: { surface_id: 's' }, reply: { removed: true, surfaceId: 's' } },
	// D-154: the memory store's answers (`packages/gateway/src/memory.ts`, `memory_tools.ts`).
	memory_save: {
		args: { collection: 'notes', items: [{ text: 'the cat sat', metadata: { kind: 'pet' } }] },
		reply: { collection: 'notes', embedder: 'builtin:lexical-512', created: true, ids: ['01J0000000000000000000000A'] },
	},
	memory_search: {
		args: { collection: 'notes', query: 'cat', limit: 3, filter: { kind: 'pet', ok: true, n: 1, z: null } },
		reply: {
			collection: 'notes',
			embedder: 'builtin:lexical-512',
			results: [{ id: 'a', text: 'the cat sat', metadata: { kind: 'pet' }, score: 0.81 }],
		},
	},
	memory_delete: {
		args: { collection: 'notes', all: true },
		reply: { collection: 'notes', deleted: 1, dropped: true },
	},
	memory_list: {
		args: {},
		reply: {
			default_embedder: 'builtin:lexical-512',
			collections: [{
				name: 'notes',
				embedder: 'builtin:lexical-512',
				dims: 512,
				items: 1,
				created_at: new Date(0).toISOString(),
				available: true,
			}],
		},
	},
};

Deno.test('AC15: service replies of the documented shape validate, and an added field passes through', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const actions = Object.fromEntries(
		Object.entries(SERVICE_REPLIES).map(([name, { reply }]) => [
			name,
			// A later service version adding a field must not lose it in validation (loose objects).
			() => Promise.resolve({ ...reply, added_later: 1 }),
		]),
	);
	const call = createToolExecutor(
		// R12: the sandbox says it clones, so `sandbox_clone` is offered too.
		{ registry, version: 'test', extraTools: extensionTools(actions), sandboxClone: () => true },
		'owner',
		new Set(SCOPES),
	);
	try {
		for (const [name, { args, reply }] of Object.entries(SERVICE_REPLIES)) {
			assertEquals(unchanged(name, await call(name, args)), { ...reply, added_later: 1 }, name);
		}
	} finally {
		await registry.shutdown();
	}
});

Deno.test('AC15: a reply that drifts from its declared shape is refused as a server fault, not passed on', async () => {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const warnings: string[] = [];
	const call = createToolExecutor(
		{
			registry,
			version: 'test',
			logger: { warn: (message) => warnings.push(message), info: () => {} },
			extraTools: extensionTools({
				// `exitCode` missing and `output` renamed: what a backend that drifted would send.
				sandbox_exec: () => Promise.resolve({ timedOut: false, killed: null, durationMs: 1, stdout: 'x' }),
				a2ui_publish: () => Promise.resolve({ surface: { surfaceId: 's' } }),
			}),
		},
		'owner',
		new Set(SCOPES),
	);
	try {
		for (
			const [name, args] of [
				['sandbox_exec', { workspace_id: WORKSPACE, command: 'true' }],
				['a2ui_publish', { message: { version: 'v0.9', deleteSurface: { surfaceId: 's' } } }],
			] as const
		) {
			const result = await call(name, args) as { isError?: boolean; structuredContent: { error: { code: string } } };
			assertEquals(result.isError, true, name);
			assertEquals(result.structuredContent.error.code, 'browser-unavailable');
		}
		assert(warnings.some((warning) => warning.includes('sandbox_exec returned a result its schema rejects')));
	} finally {
		await registry.shutdown();
	}
});
