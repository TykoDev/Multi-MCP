/**
 * The library's MCP surface (D-075): `file_*`, `skill_*` and `prompt_*` tools, the `ttk://share/{+path}` and
 * `ttk://skill/{name}` resources, and one MCP prompt per stored prompt and per skill.
 *
 * Reads take `files:read`, which is in the default grant; every mutation takes `files:write`, which must be
 * named. The tools are extension tools in the D-064 sense: composed by the gateway and the stdio mount when a data
 * directory exists, absent otherwise, never part of the frozen browser catalog.
 */
import * as z from 'zod';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/server';
import type { ToolDefinition, ToolHints } from './catalog.ts';
import { crypto as stdCrypto } from '@std/crypto';
import { encodeHex } from '@std/encoding/hex';
import { untilAborted } from './cancel.ts';
import { libraryCompleters } from './completions.ts';
import { ToolError } from './errors.ts';
import { isText, LIBRARY_LIMITS, LibraryError, type LibraryStore, walkShare } from './library.ts';
import { RESOURCE_SCHEME } from './resources.ts';
import type { Scope } from './scopes.ts';
import { peekSession } from './tools/shared.ts';
import { json, type ToolContext, type ToolResult } from './types.ts';

const path = z.string().min(1).max(4096);
const name = z.string().min(1).max(64);

// --- A8 / D-113: typed results, from the store's own types (`library.ts`) ----------------------------------------
//
// The store is in-process and its shapes are this package's own, so these are exact objects: the dispatcher's strip
// mode would drop an undeclared field, and `library_tools_test.ts` drives every tool against a real store and
// asserts the validated result *equals* the raw one, so a field the store grows before its schema fails a test.

const entry = z.object({
	name: z.string(),
	path: z.string(),
	kind: z.enum(['file', 'directory']),
	size: z.number(),
	modified_at: z.string().nullable(),
});
const skillSummary = {
	name: z.string(),
	description: z.string(),
	files: z.array(z.string()),
	updated_at: z.string().nullable(),
};
const skill = z.object({ ...skillSummary, instructions: z.string() });
const prompt = z.object({
	name: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	arguments: z.array(
		z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() }),
	),
	template: z.string(),
	updated_at: z.string(),
});

/** The result shape of every library tool, by name. Exported so the tests read the same table. */
export const LIBRARY_OUTPUT: Readonly<Record<string, z.ZodType>> = {
	file_list: z.object({ path: z.string(), entries: z.array(entry), truncated: z.boolean() }),
	file_stat: entry,
	file_read: z.object({ path: z.string(), size: z.number(), content: z.string() }),
	file_write: entry,
	file_mkdir: entry,
	file_delete: z.object({ path: z.string(), removed: z.literal(true) }),
	file_move: entry,
	skill_list: z.object({ skills: z.array(z.object(skillSummary)) }),
	skill_get: skill,
	skill_read_file: z.object({ path: z.string(), text: z.string() }),
	skill_put: skill,
	skill_delete: z.object({ name: z.string(), removed: z.literal(true) }),
	prompt_list: z.object({ prompts: z.array(prompt) }),
	prompt_get: prompt,
	prompt_put: prompt,
	prompt_delete: z.object({ name: z.string(), removed: z.literal(true) }),
	prompt_render: z.object({ name: z.string(), text: z.string() }),
	// R10 (design §2.7, D-119): a session file copied into the share.
	browser_save_to_share: z.object({ path: z.string(), size: z.number(), sha256: z.string() }),
};

/** Maps a store failure to a tool error code the client already knows. */
function toolError(cause: unknown): never {
	if (cause instanceof LibraryError) {
		const code = cause.code === 'not-found'
			? 'file-unavailable'
			: cause.code === 'too-large'
			? 'file-unavailable'
			: 'invalid-arguments';
		throw new ToolError(code, cause.message);
	}
	if (cause instanceof Deno.errors.NotFound) throw new ToolError('file-unavailable', 'no such path');
	throw cause;
}

/** Builds the library tools over `store`; an absent store yields no tools. */
export function libraryTools(store: LibraryStore | null): readonly ToolDefinition[] {
	if (store === null) return [];
	const tools: ToolDefinition[] = [];
	const add = (
		toolName: string,
		description: string,
		inputSchema: z.ZodType,
		scope: Scope,
		mutates: boolean,
		run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>,
		hints?: ToolHints,
	): void => {
		const output = LIBRARY_OUTPUT[toolName];
		if (output === undefined) throw new Error(`library tool ${toolName} has no output schema`);
		tools.push({
			name: toolName,
			title: toolName.replaceAll('_', ' '),
			description,
			inputSchema,
			// The D-064 `{ result }` envelope is kept for wire stability; what is inside it is now typed (A8).
			outputSchema: z.object({ result: output }),
			scope,
			mutates,
			...(hints === undefined ? {} : { hints }),
			handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
				// A10: nothing starts after a cancellation; a read stops waiting the moment one arrives.
				ctx.signal?.throwIfAborted();
				let value: Record<string, unknown>;
				try {
					const work = run(args as Record<string, unknown>, ctx);
					// A read has no effect to undo, so returning early is exact; a write is never abandoned half way,
					// because an early answer would claim nothing happened while the write still lands.
					value = mutates ? await work : await untilAborted(work, ctx.signal);
				} catch (cause) {
					if (ctx.signal?.aborted === true) throw cause;
					return toolError(cause);
				}
				return json({ result: value });
			},
		});
	};
	const decoder = new TextDecoder();

	// --- files ----------------------------------------------------------------------------------------------
	add(
		'file_list',
		'List a directory of the file share: directories first, then files, bounded to 2000 entries.',
		z.object({ path: z.string().max(4096).optional() }).strict(),
		'files:read',
		false,
		(args) => store.list(args.path ?? ''),
	);
	add(
		'file_stat',
		'Describe one path of the file share: kind, size and modification time.',
		z.object({ path }).strict(),
		'files:read',
		false,
		async (args) => ({ ...await store.stat(args.path) }),
	);
	add(
		'file_read',
		'Read a UTF-8 text file of at most 1 MiB from the file share. Larger or binary files are served by the HTTP download route.',
		z.object({ path }).strict(),
		'files:read',
		false,
		async (args) => {
			const { path: relative, bytes } = await store.readBytes(args.path);
			if (!isText(bytes)) {
				throw new ToolError('file-unavailable', `${relative} is not a text file; download it over HTTP instead`);
			}
			return { path: relative, size: bytes.length, content: decoder.decode(bytes) };
		},
	);
	add(
		'file_write',
		'Write a UTF-8 text file of at most 1 MiB to the file share, creating parent directories.',
		z.object({ path, content: z.string().max(LIBRARY_LIMITS.toolFileBytes) }).strict(),
		'files:write',
		true,
		async (args) => ({ ...await store.writeBytes(args.path, new TextEncoder().encode(String(args.content))) }),
		{ idempotent: true },
	);
	add(
		'file_mkdir',
		'Create a directory (and its parents) in the file share.',
		z.object({ path }).strict(),
		'files:write',
		true,
		async (args) => ({ ...await store.mkdir(args.path) }),
		{ idempotent: true },
	);
	add(
		'file_delete',
		'Delete a file, or a directory with recursive, from the file share.',
		z.object({ path, recursive: z.boolean().optional() }).strict(),
		'files:write',
		true,
		(args) => store.remove(args.path, args.recursive === true),
		{ destructive: true },
	);
	add(
		'file_move',
		'Move or rename a file or directory inside the file share; the target must not exist.',
		z.object({ from: path, to: path }).strict(),
		'files:write',
		true,
		async (args) => ({ ...await store.move(args.from, args.to) }),
	);

	// --- skills ---------------------------------------------------------------------------------------------
	add(
		'skill_list',
		'List the skills in the library with their descriptions and files.',
		z.object({}).strict(),
		'files:read',
		false,
		async () => ({ skills: await store.listSkills() }),
	);
	add(
		'skill_get',
		'Read a skill: its SKILL.md instructions and the list of files beside it. Use this to load a skill before following it.',
		z.object({ name }).strict(),
		'files:read',
		false,
		async (args) => ({ ...await store.getSkill(args.name) }),
	);
	add(
		'skill_read_file',
		'Read one text file that belongs to a skill.',
		z.object({ name, path }).strict(),
		'files:read',
		false,
		(args) => store.readSkillFile(args.name, args.path),
	);
	add(
		'skill_put',
		'Create or update a skill from text files; SKILL.md must carry frontmatter with name and description. Files not named are kept unless replace is true.',
		z.object({
			name,
			files: z.record(z.string().min(1).max(4096), z.string().max(LIBRARY_LIMITS.skillBytes)),
			replace: z.boolean().optional(),
		}).strict(),
		'files:write',
		true,
		async (args) => ({ ...await store.putSkill(args.name, args.files, args.replace === true) }),
		{ idempotent: true },
	);
	add(
		'skill_delete',
		'Delete a skill and every file in it.',
		z.object({ name }).strict(),
		'files:write',
		true,
		(args) => store.deleteSkill(args.name),
		{ destructive: true },
	);

	// --- prompts --------------------------------------------------------------------------------------------
	add(
		'prompt_list',
		'List the stored prompt templates with their arguments.',
		z.object({}).strict(),
		'files:read',
		false,
		async () => ({ prompts: await store.listPrompts() }),
	);
	add(
		'prompt_get',
		'Read one stored prompt template, including its raw template text and argument list.',
		z.object({ name }).strict(),
		'files:read',
		false,
		async (args) => ({ ...await store.getPrompt(args.name) }),
	);
	add(
		'prompt_put',
		'Create or replace a prompt template. Placeholders are {{argument}}; a required argument must be supplied when rendering.',
		z.object({
			name,
			title: z.string().max(512).optional(),
			description: z.string().max(512).optional(),
			arguments: z.array(
				z.object({
					name: z.string().min(1).max(64),
					description: z.string().max(512).optional(),
					required: z.boolean().optional(),
				}).strict(),
			).max(LIBRARY_LIMITS.promptArguments).optional(),
			template: z.string().min(1).max(LIBRARY_LIMITS.promptTemplateBytes),
		}).strict(),
		'files:write',
		true,
		async (args) => ({ ...await store.putPrompt(args.name, args) }),
		{ idempotent: true },
	);
	add(
		'prompt_delete',
		'Delete a stored prompt template.',
		z.object({ name }).strict(),
		'files:write',
		true,
		(args) => store.deletePrompt(args.name),
		{ destructive: true },
	);
	add(
		'prompt_render',
		'Render a stored prompt with argument values and return the text.',
		z.object({ name, arguments: z.record(z.string(), z.unknown()).optional() }).strict(),
		'files:read',
		false,
		(args) => store.renderPrompt(args.name, args.arguments ?? {}),
	);

	// --- R10: a session file into the share ---------------------------------------------------------------------
	add(
		'browser_save_to_share',
		'Copy a file this session downloaded or printed (a file_id from browser_list_files) into the file share at ' +
			'path, up to 64 MiB, so it outlives the session. An existing path is refused unless overwrite is true. ' +
			'Returns the path, size and SHA-256 of the bytes written.',
		z.object({
			file_id: z.string().min(1).max(128),
			path,
			session_id: z.string().optional(),
			overwrite: z.boolean().optional(),
		}).strict(),
		'files:write',
		true,
		(args, ctx) =>
			saveToShare(store, ctx, {
				fileId: String(args.file_id),
				path: String(args.path),
				sessionId: args.session_id === undefined ? undefined : String(args.session_id),
				overwrite: args.overwrite === true,
			}),
		{ destructive: true },
	);
	return tools;
}

/**
 * `browser_save_to_share` — one session file streamed into the share (R10, design §2.7, D-119).
 *
 * `peekSession` semantics: the session must exist and is never launched, and the caller's access rides the lookup
 * (R8). The bytes are never held whole: the session file's leased stream is written chunk by chunk to the share's
 * temporary name and hashed as it goes, then `commit()` renames it into place, so a reader of the share never sees
 * half a file and memory stays one read chunk whatever the size. The cap is the share's own REST limit
 * (`LIBRARY_LIMITS.restFileBytes`), checked against the resolved size before anything is opened and again as the
 * bytes arrive. "Exists" is checked before the copy and once more just before the rename, so the window in which a
 * concurrent writer could be replaced without `overwrite` is the rename itself.
 */
async function saveToShare(
	store: LibraryStore,
	ctx: ToolContext,
	input: { fileId: string; path: string; sessionId: string | undefined; overwrite: boolean },
): Promise<Record<string, unknown>> {
	const record = peekSession(ctx, input.sessionId);
	const cap = LIBRARY_LIMITS.restFileBytes;
	const resolved = await record.files.resolve(input.fileId);
	if (resolved.size > cap) {
		throw new ToolError('file-unavailable', `${resolved.info.name} is ${resolved.size} bytes, over the share's ${cap}`);
	}
	const exists = async (): Promise<boolean> => {
		try {
			await store.stat(input.path);
			return true;
		} catch (cause) {
			if (cause instanceof LibraryError && cause.code === 'not-found') return false;
			throw cause;
		}
	};
	const refuseExisting = (): never => {
		throw new ToolError(
			'invalid-arguments',
			`${input.path} already exists in the share; pass overwrite: true to replace it`,
		);
	};
	if (!input.overwrite && await exists()) refuseExisting();
	const target = await store.uploadTarget(input.path);
	const opened = await record.files.open(input.fileId);
	let written = 0;
	let file: Deno.FsFile | null = null;
	try {
		file = await Deno.open(target.temporary, { createNew: true, write: true });
		const sink = file;
		// Fed to the digest as an async iterable, so each chunk is written and hashed once and then dropped.
		const chunks = async function* (): AsyncGenerator<Uint8Array<ArrayBuffer>> {
			for await (const chunk of opened.stream) {
				written += chunk.byteLength;
				if (written > cap) throw new ToolError('file-unavailable', `the file grew past the share's ${cap} bytes`);
				let offset = 0;
				while (offset < chunk.byteLength) offset += await sink.write(chunk.subarray(offset));
				yield new Uint8Array(chunk);
			}
		};
		const digest = encodeHex(new Uint8Array(await stdCrypto.subtle.digest('SHA-256', chunks())));
		file.close();
		file = null;
		if (!input.overwrite && await exists()) refuseExisting();
		const entry = await target.commit();
		ctx.registry.touch(record.id);
		return { path: entry.path, size: entry.size, sha256: digest };
	} catch (cause) {
		await opened.stream.cancel().catch(() => {});
		try {
			file?.close();
		} catch { /* already closed */ }
		await Deno.remove(target.temporary).catch(() => {});
		throw cause;
	}
}

export const SHARE_URI_PREFIX = `${RESOURCE_SCHEME}://share/`;
export const SKILL_URI_PREFIX = `${RESOURCE_SCHEME}://skill/`;

function mimeOf(path: string, text: boolean): string {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	const known: Record<string, string> = {
		json: 'application/json',
		md: 'text/markdown',
		txt: 'text/plain',
		csv: 'text/csv',
		html: 'text/html',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		pdf: 'application/pdf',
	};
	return known[extension] ?? (text ? 'text/plain' : 'application/octet-stream');
}

/**
 * Registers the library's resources and prompts for a principal that holds `files:read`. Registered per server
 * instance like the session resources, so `resources/list` and `prompts/list` read the disk as it is now.
 */
export function registerLibrary(server: McpServer, store: LibraryStore | null, scopes: ReadonlySet<Scope>): void {
	if (store === null || !scopes.has('files:read')) return;
	// R13 (D-129): share paths and skill names complete for the caller this registration already admitted.
	const complete = libraryCompleters(store);
	server.registerResource(
		'library-share-file',
		new ResourceTemplate(`${SHARE_URI_PREFIX}{+path}`, {
			complete: { path: complete.path },
			list: async () => ({
				resources: (await walkShare(store)).map((entry) => ({
					uri: `${SHARE_URI_PREFIX}${entry.path.split('/').map(encodeURIComponent).join('/')}`,
					name: entry.name,
					title: entry.path,
					description: `A file in the share (${entry.size} bytes).`,
					size: entry.size,
				})),
			}),
		}),
		{
			title: 'Shared file',
			description: 'A file in the library share. Text is returned as text, anything else as a blob, up to 1 MiB.',
		},
		async (uri, variables): Promise<ReadResourceResult> => {
			const relative = String(variables.path ?? '').split('/').map((part) => decodeURIComponent(part)).join('/');
			const { path: resolved, bytes } = await store.readBytes(relative);
			const text = isText(bytes);
			const mimeType = mimeOf(resolved, text);
			return {
				contents: [
					text
						? { uri: uri.href, mimeType, text: new TextDecoder().decode(bytes) }
						: { uri: uri.href, mimeType, blob: btoa(String.fromCharCode(...bytes)) },
				],
			};
		},
	);
	server.registerResource(
		'library-skill',
		new ResourceTemplate(`${SKILL_URI_PREFIX}{name}`, {
			complete: { name: complete.name },
			list: async () => ({
				resources: (await store.listSkills()).map((skill) => ({
					uri: `${SKILL_URI_PREFIX}${encodeURIComponent(skill.name)}`,
					name: skill.name,
					title: `Skill ${skill.name}`,
					description: skill.description,
					mimeType: 'text/markdown',
				})),
			}),
		}),
		{ title: 'Skill', description: 'The SKILL.md instructions of a library skill.' },
		async (uri, variables): Promise<ReadResourceResult> => {
			const skill = await store.getSkill(decodeURIComponent(String(variables.name ?? '')));
			return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.instructions }] };
		},
	);
	registerPrompts(server, store);
}

/**
 * Registers one MCP prompt per stored prompt and per skill, from the store's cache: registration must be
 * synchronous because the server instance answers its first request right after it is built, and the cache is
 * refreshed by every mutation this process makes and re-read from the volume when stale.
 */
export function registerPrompts(server: McpServer, store: LibraryStore): void {
	const { prompts, skills } = store.cached();
	for (const prompt of prompts) {
		const shape: Record<string, z.ZodType> = {};
		for (const argument of prompt.arguments) {
			const base = z.string().describe(argument.description ?? argument.name);
			shape[argument.name] = argument.required === true ? base : base.optional();
		}
		server.registerPrompt(
			prompt.name,
			{
				...(prompt.title === undefined ? {} : { title: prompt.title }),
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				argsSchema: shape,
			},
			async (args: Record<string, unknown>): Promise<GetPromptResult> => {
				const { text } = await store.renderPrompt(prompt.name, args ?? {});
				return { messages: [{ role: 'user', content: { type: 'text', text } }] };
			},
		);
	}
	for (const skill of skills) {
		server.registerPrompt(
			`skill:${skill.name}`,
			{ title: `Skill ${skill.name}`, description: skill.description },
			async (): Promise<GetPromptResult> => {
				const full = await store.getSkill(skill.name);
				return { messages: [{ role: 'user', content: { type: 'text', text: full.instructions } }] };
			},
		);
	}
}
