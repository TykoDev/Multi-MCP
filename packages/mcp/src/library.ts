/**
 * The library: a file share, skills and prompts kept on the data volume (D-075).
 *
 * Three roots under `<TTK_DATA_DIR>`: `share/` holds any files an operator or a model puts there, `skills/<name>/`
 * holds a SKILL.md with its supporting files, `prompts/<name>.json` holds a template with named arguments. One
 * store serves the MCP tools, the MCP resources and prompts, the gateway's REST routes and the stdio mount, so the
 * path rules are enforced in exactly one place.
 *
 * **Every path is relative, normalised and walked segment by segment with `lstat`.** A symbolic link anywhere on
 * the path is refused, so a link planted through the share (or on the volume by anything else) cannot turn a
 * read of `share/x` into a read of `/etc/passwd`. Absolute paths, `..`, control characters, backslashes, over-long
 * names and over-deep trees are refused before anything touches the disk.
 */
import { join } from '@std/path';

export const LIBRARY_LIMITS = {
	/** What a tool reads or writes in one call. */
	toolFileBytes: 1024 * 1024,
	/** What the REST upload and download routes carry. */
	restFileBytes: 64 * 1024 * 1024,
	listEntries: 2000,
	maxDepth: 32,
	maxNameLength: 255,
	skillFiles: 64,
	skillBytes: 2 * 1024 * 1024,
	promptTemplateBytes: 64 * 1024,
	promptArguments: 16,
	/** How many share files a `resources/list` enumerates. */
	resourceListEntries: 500,
} as const;

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** How long the prompt and skill listing cache is trusted before it is re-read from the volume. */
export const CACHE_TTL_MS = 15_000;

export type LibraryErrorCode =
	| 'invalid-path'
	| 'invalid-name'
	| 'invalid-argument'
	| 'not-found'
	| 'exists'
	| 'not-empty'
	| 'too-large'
	| 'not-a-file'
	| 'not-a-directory';

export class LibraryError extends Error {
	readonly code: LibraryErrorCode;
	constructor(code: LibraryErrorCode, message: string) {
		super(message);
		this.name = 'LibraryError';
		this.code = code;
	}
}

export interface Entry {
	readonly name: string;
	readonly path: string;
	readonly kind: 'file' | 'directory';
	readonly size: number;
	readonly modified_at: string | null;
}

export interface SkillSummary {
	readonly name: string;
	readonly description: string;
	readonly files: readonly string[];
	readonly updated_at: string | null;
}

export interface Skill extends SkillSummary {
	/** The SKILL.md body (frontmatter included). */
	readonly instructions: string;
}

export interface PromptArgument {
	readonly name: string;
	readonly description?: string;
	readonly required?: boolean;
}

export interface Prompt {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly arguments: readonly PromptArgument[];
	readonly template: string;
	readonly updated_at: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Normalises a share-relative path: `''` is the root. Throws for anything that is not a plain relative path made of
 * ordinary segments.
 */
export function safeRelative(raw: unknown): string {
	if (typeof raw !== 'string') throw new LibraryError('invalid-path', 'path must be a string');
	// A leading "./" and trailing slashes are tolerated; nothing else is rewritten.
	const trimmed = raw.replace(/^\.\//, '').replace(/\/+$/, '');
	if (trimmed === '' || trimmed === '.') return '';
	if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\\')) {
		throw new LibraryError('invalid-path', 'path must be relative to the share and use forward slashes');
	}
	const segments = trimmed.split('/');
	if (segments.length > LIBRARY_LIMITS.maxDepth) throw new LibraryError('invalid-path', 'path is too deep');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') {
			throw new LibraryError('invalid-path', 'path must not contain empty, "." or ".." segments');
		}
		if (segment.length > LIBRARY_LIMITS.maxNameLength) throw new LibraryError('invalid-path', 'a name is too long');
		for (const character of segment) {
			const code = character.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f) throw new LibraryError('invalid-path', 'path contains a control character');
		}
	}
	return segments.join('/');
}

export function checkName(raw: unknown): string {
	if (typeof raw !== 'string' || !NAME_PATTERN.test(raw)) {
		throw new LibraryError('invalid-name', 'a name is 1 to 64 lowercase letters, digits, ".", "_" or "-"');
	}
	return raw;
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
	try {
		return await Deno.lstat(path);
	} catch (cause) {
		if (cause instanceof Deno.errors.NotFound) return null;
		throw cause;
	}
}

function toIso(date: Date | null): string | null {
	return date === null ? null : date.toISOString();
}

export function isText(bytes: Uint8Array): boolean {
	try {
		const text = decoder.decode(bytes);
		return !text.includes('\0');
	} catch {
		return false;
	}
}

/** Splits a SKILL.md into its frontmatter map and body; a file without frontmatter has an empty map. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (match === null) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}
	return { fields, body: match[2] ?? '' };
}

/** Fills `{{name}}` placeholders; a required argument that is missing is an error, an unknown placeholder is empty. */
export function renderTemplate(prompt: Prompt, values: Record<string, unknown>): string {
	for (const argument of prompt.arguments) {
		const value = values[argument.name];
		if (argument.required === true && (value === undefined || value === null || value === '')) {
			throw new LibraryError('invalid-argument', `argument ${JSON.stringify(argument.name)} is required`);
		}
	}
	return prompt.template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
		const value = values[name];
		return value === undefined || value === null ? '' : String(value);
	});
}

export interface LibraryStoreOptions {
	readonly dataDir: string;
}

export class LibraryStore {
	readonly share: string;
	readonly skills: string;
	readonly prompts: string;

	constructor(options: LibraryStoreOptions) {
		this.share = join(options.dataDir, 'share');
		this.skills = join(options.dataDir, 'skills');
		this.prompts = join(options.dataDir, 'prompts');
	}

	/**
	 * What `prompts/list` is built from. Registration on a server instance is synchronous, so the listing comes
	 * from a cache this process keeps current: filled at startup, refreshed after every mutation made through this
	 * store, and re-read from disk when it is older than `CACHE_TTL_MS` (another process, or an operator's editor,
	 * may have written the volume).
	 */
	#promptCache: { at: number; prompts: Prompt[]; skills: SkillSummary[] } | null = null;
	#refreshing: Promise<void> | null = null;

	/** Creates the three roots; harmless when they exist. Fills the prompt and skill cache. */
	async initialize(): Promise<void> {
		for (const root of [this.share, this.skills, this.prompts]) await Deno.mkdir(root, { recursive: true });
		await this.refresh();
	}

	/** Re-reads prompts and skills from disk into the cache. */
	async refresh(): Promise<void> {
		if (this.#refreshing === null) {
			this.#refreshing = (async () => {
				const [prompts, skills] = await Promise.all([
					this.listPrompts().catch(() => [] as Prompt[]),
					this.listSkills().catch(() => [] as SkillSummary[]),
				]);
				this.#promptCache = { at: Date.now(), prompts, skills };
			})().finally(() => {
				this.#refreshing = null;
			});
		}
		await this.#refreshing;
	}

	/** The cached prompts and skills, kicking off a refresh when stale; empty until the first refresh lands. */
	cached(): { prompts: readonly Prompt[]; skills: readonly SkillSummary[] } {
		const cache = this.#promptCache;
		if (cache === null || Date.now() - cache.at > CACHE_TTL_MS) void this.refresh();
		return cache ?? { prompts: [], skills: [] };
	}

	// --- path resolution ------------------------------------------------------------------------------------

	/**
	 * Resolves a relative path under `root`, refusing a symbolic link at any segment. `mustExist` false allows the
	 * last segment to be absent (for a write); every parent must still exist and be a directory, unless
	 * `createParents` asks for them.
	 */
	async #resolve(
		root: string,
		relative: string,
		options: { mustExist?: boolean; createParents?: boolean } = {},
	): Promise<{ absolute: string; info: Deno.FileInfo | null }> {
		const rootInfo = await lstatOrNull(root);
		if (rootInfo === null) await Deno.mkdir(root, { recursive: true });
		else if (rootInfo.isSymlink || !rootInfo.isDirectory) {
			throw new LibraryError('invalid-path', 'the library root is not a plain directory');
		}
		if (relative === '') return { absolute: root, info: await Deno.lstat(root) };
		const segments = relative.split('/');
		let current = root;
		for (let index = 0; index < segments.length; index += 1) {
			current = join(current, segments[index]!);
			const info = await lstatOrNull(current);
			const last = index === segments.length - 1;
			if (info === null) {
				if (last && options.mustExist !== true) return { absolute: current, info: null };
				if (!last && options.createParents === true) {
					await Deno.mkdir(current);
					continue;
				}
				throw new LibraryError('not-found', `no such path ${JSON.stringify(relative)}`);
			}
			if (info.isSymlink) throw new LibraryError('invalid-path', 'symbolic links are not followed');
			if (!last && !info.isDirectory) {
				throw new LibraryError('not-a-directory', `${segments[index]} is not a directory`);
			}
			if (last) return { absolute: current, info };
		}
		throw new LibraryError('invalid-path', 'unreachable');
	}

	async #writeAtomically(absolute: string, bytes: Uint8Array): Promise<void> {
		const temporary = `${absolute}.${crypto.randomUUID()}.tmp`;
		await Deno.writeFile(temporary, bytes);
		try {
			await Deno.rename(temporary, absolute);
		} catch (cause) {
			await Deno.remove(temporary).catch(() => {});
			throw cause;
		}
	}

	// --- share ----------------------------------------------------------------------------------------------

	/** Lists one directory, directories first, names sorted, bounded to `listEntries`. */
	async list(path: unknown): Promise<{ path: string; entries: Entry[]; truncated: boolean }> {
		const relative = safeRelative(path);
		const { absolute, info } = await this.#resolve(this.share, relative, { mustExist: true });
		if (!info!.isDirectory) throw new LibraryError('not-a-directory', `${relative} is not a directory`);
		const entries: Entry[] = [];
		let truncated = false;
		for await (const entry of Deno.readDir(absolute)) {
			if (entry.name.endsWith('.tmp') && /\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
			if (entries.length >= LIBRARY_LIMITS.listEntries) {
				truncated = true;
				break;
			}
			const child = join(absolute, entry.name);
			const childInfo = await lstatOrNull(child);
			if (childInfo === null || childInfo.isSymlink) continue;
			entries.push({
				name: entry.name,
				path: relative === '' ? entry.name : `${relative}/${entry.name}`,
				kind: childInfo.isDirectory ? 'directory' : 'file',
				size: childInfo.isDirectory ? 0 : childInfo.size,
				modified_at: toIso(childInfo.mtime),
			});
		}
		entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
		return { path: relative, entries, truncated };
	}

	/**
	 * Every text file under the share folder `path`, keyed by its path relative to that folder — what a sandbox
	 * workspace is seeded from (`sandbox_create { from_share }`, E-6). Bounded before anything is read twice: at most
	 * `maxFiles` files and `maxBytes` in all; a binary file, a link (skipped by `list`), or a folder with more is
	 * refused rather than seeded in part. `.git` folders are skipped, as the sandbox refuses them anyway.
	 */
	async collectText(
		path: unknown,
		limits: { maxFiles: number; maxBytes: number },
	): Promise<Record<string, string>> {
		const root = safeRelative(path);
		const files: Record<string, string> = {};
		let count = 0;
		let total = 0;
		const walk = async (folder: string, depth: number): Promise<void> => {
			if (depth > 32) throw new LibraryError('invalid-path', `${folder} is nested too deeply`);
			const listing = await this.list(folder);
			if (listing.truncated) throw new LibraryError('too-large', `${folder} has too many entries`);
			for (const entry of listing.entries) {
				if (entry.kind === 'directory') {
					if (entry.name.toLowerCase() !== '.git') await walk(entry.path, depth + 1);
					continue;
				}
				count += 1;
				total += entry.size;
				if (count > limits.maxFiles) {
					throw new LibraryError('too-large', `${root || 'the share'} holds more than ${limits.maxFiles} files`);
				}
				if (total > limits.maxBytes) {
					throw new LibraryError('too-large', `${root || 'the share'} holds more than ${limits.maxBytes} bytes`);
				}
				const { bytes } = await this.readBytes(entry.path, limits.maxBytes);
				if (!isText(bytes)) throw new LibraryError('not-a-file', `${entry.path} is not a text file`);
				files[root === '' ? entry.path : entry.path.slice(root.length + 1)] = decoder.decode(bytes);
			}
		};
		await walk(root, 0);
		return files;
	}

	async stat(path: unknown): Promise<Entry> {
		const relative = safeRelative(path);
		const { info } = await this.#resolve(this.share, relative, { mustExist: true });
		return {
			name: relative === '' ? '' : relative.slice(relative.lastIndexOf('/') + 1),
			path: relative,
			kind: info!.isDirectory ? 'directory' : 'file',
			size: info!.isDirectory ? 0 : info!.size,
			modified_at: toIso(info!.mtime),
		};
	}

	/** Reads a regular file of at most `maxBytes`. */
	async readBytes(
		path: unknown,
		maxBytes = LIBRARY_LIMITS.toolFileBytes,
	): Promise<{ path: string; bytes: Uint8Array }> {
		const relative = safeRelative(path);
		const { absolute, info } = await this.#resolve(this.share, relative, { mustExist: true });
		if (!info!.isFile) throw new LibraryError('not-a-file', `${relative} is not a file`);
		if (info!.size > maxBytes) {
			throw new LibraryError('too-large', `${relative} is ${info!.size} bytes; the limit here is ${maxBytes}`);
		}
		const file = await Deno.open(absolute, { read: true });
		try {
			const opened = await file.stat();
			if (!opened.isFile || opened.ino !== info!.ino || opened.dev !== info!.dev) {
				throw new LibraryError('invalid-path', 'the file changed while it was being opened');
			}
			const bytes = await new Response(file.readable).bytes();
			return { path: relative, bytes };
		} finally {
			// `file.readable` consumed and closed the handle when read to the end; closing twice is an error.
		}
	}

	/** The absolute path of a readable regular file, for a streaming route; the caller opens it. */
	async locate(path: unknown): Promise<{ path: string; absolute: string; size: number }> {
		const relative = safeRelative(path);
		const { absolute, info } = await this.#resolve(this.share, relative, { mustExist: true });
		if (!info!.isFile) throw new LibraryError('not-a-file', `${relative} is not a file`);
		return { path: relative, absolute, size: info!.size };
	}

	async writeBytes(path: unknown, bytes: Uint8Array, maxBytes = LIBRARY_LIMITS.toolFileBytes): Promise<Entry> {
		const relative = safeRelative(path);
		if (relative === '') throw new LibraryError('invalid-path', 'a file path is required');
		if (bytes.length > maxBytes) throw new LibraryError('too-large', `content is over ${maxBytes} bytes`);
		const { absolute, info } = await this.#resolve(this.share, relative, { createParents: true });
		if (info !== null && !info.isFile) throw new LibraryError('not-a-file', `${relative} is a directory`);
		await this.#writeAtomically(absolute, bytes);
		return await this.stat(relative);
	}

	/** Where a streaming upload should land, with the temporary name the caller writes to; `commit` renames. */
	async uploadTarget(path: unknown): Promise<{ path: string; temporary: string; commit(): Promise<Entry> }> {
		const relative = safeRelative(path);
		if (relative === '') throw new LibraryError('invalid-path', 'a file path is required');
		const { absolute, info } = await this.#resolve(this.share, relative, { createParents: true });
		if (info !== null && !info.isFile) throw new LibraryError('not-a-file', `${relative} is a directory`);
		const temporary = `${absolute}.${crypto.randomUUID()}.tmp`;
		return {
			path: relative,
			temporary,
			commit: async (): Promise<Entry> => {
				await Deno.rename(temporary, absolute);
				return await this.stat(relative);
			},
		};
	}

	async mkdir(path: unknown): Promise<Entry> {
		const relative = safeRelative(path);
		if (relative === '') throw new LibraryError('invalid-path', 'a directory path is required');
		const { absolute, info } = await this.#resolve(this.share, relative, { createParents: true });
		if (info !== null) {
			if (info.isDirectory) return await this.stat(relative);
			throw new LibraryError('exists', `${relative} exists and is a file`);
		}
		await Deno.mkdir(absolute);
		return await this.stat(relative);
	}

	async remove(path: unknown, recursive = false): Promise<{ path: string; removed: true }> {
		const relative = safeRelative(path);
		if (relative === '') throw new LibraryError('invalid-path', 'the share root cannot be removed');
		const { absolute, info } = await this.#resolve(this.share, relative, { mustExist: true });
		if (info!.isDirectory && !recursive) {
			for await (const _entry of Deno.readDir(absolute)) {
				throw new LibraryError('not-empty', `${relative} is not empty; pass recursive to remove it`);
			}
		}
		await Deno.remove(absolute, { recursive });
		return { path: relative, removed: true };
	}

	async move(from: unknown, to: unknown): Promise<Entry> {
		const source = safeRelative(from);
		const target = safeRelative(to);
		if (source === '' || target === '') throw new LibraryError('invalid-path', 'both paths are required');
		if (target === source || target.startsWith(`${source}/`)) {
			throw new LibraryError('invalid-path', 'cannot move a path into itself');
		}
		const resolvedSource = await this.#resolve(this.share, source, { mustExist: true });
		const resolvedTarget = await this.#resolve(this.share, target, { createParents: true });
		if (resolvedTarget.info !== null) throw new LibraryError('exists', `${target} exists`);
		await Deno.rename(resolvedSource.absolute, resolvedTarget.absolute);
		return await this.stat(target);
	}

	// --- skills ---------------------------------------------------------------------------------------------

	async #skillFiles(name: string): Promise<string[]> {
		const root = join(this.skills, name);
		const files: string[] = [];
		const walk = async (directory: string, prefix: string): Promise<void> => {
			for await (const entry of Deno.readDir(directory)) {
				const info = await lstatOrNull(join(directory, entry.name));
				if (info === null || info.isSymlink) continue;
				const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
				if (info.isDirectory) await walk(join(directory, entry.name), relative);
				else files.push(relative);
				if (files.length > LIBRARY_LIMITS.skillFiles * 4) return;
			}
		};
		await walk(root, '');
		return files.sort();
	}

	async listSkills(): Promise<SkillSummary[]> {
		await Deno.mkdir(this.skills, { recursive: true });
		const skills: SkillSummary[] = [];
		for await (const entry of Deno.readDir(this.skills)) {
			if (!entry.isDirectory || !NAME_PATTERN.test(entry.name)) continue;
			const skill = await this.getSkill(entry.name).catch(() => null);
			if (skill !== null) {
				skills.push({
					name: skill.name,
					description: skill.description,
					files: skill.files,
					updated_at: skill.updated_at,
				});
			}
		}
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	async getSkill(rawName: unknown): Promise<Skill> {
		const name = checkName(rawName);
		const { absolute, info } = await this.#resolve(this.skills, `${name}/SKILL.md`, { mustExist: true });
		if (!info!.isFile) throw new LibraryError('not-found', `skill ${name} has no SKILL.md`);
		const text = await Deno.readTextFile(absolute);
		const { fields } = parseFrontmatter(text);
		return {
			name,
			description: fields.description ?? '',
			instructions: text,
			files: await this.#skillFiles(name),
			updated_at: toIso(info!.mtime),
		};
	}

	async readSkillFile(rawName: unknown, path: unknown): Promise<{ path: string; text: string }> {
		const name = checkName(rawName);
		const relative = safeRelative(path);
		if (relative === '') throw new LibraryError('invalid-path', 'a file path is required');
		const { absolute, info } = await this.#resolve(this.skills, `${name}/${relative}`, { mustExist: true });
		if (!info!.isFile) throw new LibraryError('not-a-file', `${relative} is not a file`);
		if (info!.size > LIBRARY_LIMITS.toolFileBytes) throw new LibraryError('too-large', `${relative} is too large`);
		const bytes = await Deno.readFile(absolute);
		if (!isText(bytes)) throw new LibraryError('not-a-file', `${relative} is not a text file`);
		return { path: relative, text: decoder.decode(bytes) };
	}

	/**
	 * Creates or updates a skill from `files`, which must include `SKILL.md` whose frontmatter `name` equals
	 * `name`. Existing files not named are kept; pass `replace` to remove them first.
	 */
	async putSkill(rawName: unknown, files: unknown, replace = false): Promise<Skill> {
		const name = checkName(rawName);
		if (files === null || typeof files !== 'object' || Array.isArray(files)) {
			throw new LibraryError('invalid-argument', 'files must be an object of path to text');
		}
		const entries = Object.entries(files as Record<string, unknown>);
		if (entries.length === 0 || entries.length > LIBRARY_LIMITS.skillFiles) {
			throw new LibraryError('invalid-argument', `a skill has 1 to ${LIBRARY_LIMITS.skillFiles} files`);
		}
		let total = 0;
		const checked: Array<[string, Uint8Array]> = [];
		for (const [path, content] of entries) {
			const relative = safeRelative(path);
			if (relative === '') throw new LibraryError('invalid-path', 'a file path is required');
			if (typeof content !== 'string') throw new LibraryError('invalid-argument', `${relative} must be text`);
			const bytes = encoder.encode(content);
			total += bytes.length;
			if (total > LIBRARY_LIMITS.skillBytes) throw new LibraryError('too-large', 'the skill is over its size limit');
			checked.push([relative, bytes]);
		}
		const skillMd = checked.find(([path]) => path === 'SKILL.md');
		const existing = await lstatOrNull(join(this.skills, name));
		if (skillMd === undefined && (existing === null || replace)) {
			throw new LibraryError('invalid-argument', 'a skill needs a SKILL.md');
		}
		if (skillMd !== undefined) {
			const { fields } = parseFrontmatter(decoder.decode(skillMd[1]));
			if (fields.name !== undefined && fields.name !== name) {
				throw new LibraryError('invalid-argument', `SKILL.md names ${JSON.stringify(fields.name)}, not ${name}`);
			}
			if (!fields.description) throw new LibraryError('invalid-argument', 'SKILL.md frontmatter needs a description');
		}
		if (replace && existing !== null) await Deno.remove(join(this.skills, name), { recursive: true });
		await Deno.mkdir(join(this.skills, name), { recursive: true });
		for (const [relative, bytes] of checked) {
			const { absolute, info } = await this.#resolve(this.skills, `${name}/${relative}`, { createParents: true });
			if (info !== null && !info.isFile) throw new LibraryError('not-a-file', `${relative} is a directory`);
			await this.#writeAtomically(absolute, bytes);
		}
		const skill = await this.getSkill(name);
		await this.refresh();
		return skill;
	}

	async deleteSkill(rawName: unknown): Promise<{ name: string; removed: true }> {
		const name = checkName(rawName);
		const { absolute } = await this.#resolve(this.skills, name, { mustExist: true });
		await Deno.remove(absolute, { recursive: true });
		await this.refresh();
		return { name, removed: true };
	}

	// --- prompts --------------------------------------------------------------------------------------------

	async listPrompts(): Promise<Prompt[]> {
		await Deno.mkdir(this.prompts, { recursive: true });
		const prompts: Prompt[] = [];
		for await (const entry of Deno.readDir(this.prompts)) {
			if (!entry.isFile || !entry.name.endsWith('.json')) continue;
			const name = entry.name.slice(0, -'.json'.length);
			if (!NAME_PATTERN.test(name)) continue;
			const prompt = await this.getPrompt(name).catch(() => null);
			if (prompt !== null) prompts.push(prompt);
		}
		return prompts.sort((a, b) => a.name.localeCompare(b.name));
	}

	async getPrompt(rawName: unknown): Promise<Prompt> {
		const name = checkName(rawName);
		const { absolute, info } = await this.#resolve(this.prompts, `${name}.json`, { mustExist: true });
		if (!info!.isFile) throw new LibraryError('not-found', `no prompt ${name}`);
		const parsed: unknown = JSON.parse(await Deno.readTextFile(absolute));
		return this.#checkPrompt(name, parsed, true);
	}

	#checkPrompt(name: string, input: unknown, stored: boolean): Prompt {
		if (input === null || typeof input !== 'object' || Array.isArray(input)) {
			throw new LibraryError('invalid-argument', 'a prompt is an object');
		}
		const record = input as Record<string, unknown>;
		if (typeof record.template !== 'string' || record.template === '') {
			throw new LibraryError('invalid-argument', 'template must be a non-empty string');
		}
		if (encoder.encode(record.template).length > LIBRARY_LIMITS.promptTemplateBytes) {
			throw new LibraryError('too-large', 'template is over its size limit');
		}
		const rawArguments = record.arguments ?? [];
		if (!Array.isArray(rawArguments) || rawArguments.length > LIBRARY_LIMITS.promptArguments) {
			throw new LibraryError('invalid-argument', `arguments is a list of at most ${LIBRARY_LIMITS.promptArguments}`);
		}
		const seen = new Set<string>();
		const args: PromptArgument[] = rawArguments.map((argument) => {
			if (argument === null || typeof argument !== 'object') {
				throw new LibraryError('invalid-argument', 'an argument is an object');
			}
			const { name: argName, description, required } = argument as Record<string, unknown>;
			if (typeof argName !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(argName) || seen.has(argName)) {
				throw new LibraryError('invalid-argument', 'argument names are unique, 1 to 64 word characters');
			}
			seen.add(argName);
			return {
				name: argName,
				...(typeof description === 'string' ? { description: description.slice(0, 512) } : {}),
				...(required === true ? { required: true } : {}),
			};
		});
		const optional = (key: 'title' | 'description'): Record<string, string> => {
			const value = record[key];
			if (value === undefined || value === null || value === '') return {};
			if (typeof value !== 'string') throw new LibraryError('invalid-argument', `${key} must be a string`);
			return { [key]: value.slice(0, 512) };
		};
		return {
			name,
			...optional('title'),
			...optional('description'),
			arguments: args,
			template: record.template,
			updated_at: stored && typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
		};
	}

	async putPrompt(rawName: unknown, input: unknown): Promise<Prompt> {
		const name = checkName(rawName);
		const prompt = this.#checkPrompt(name, input, false);
		const { absolute } = await this.#resolve(this.prompts, `${name}.json`, { createParents: true });
		await this.#writeAtomically(absolute, encoder.encode(`${JSON.stringify(prompt, null, '\t')}\n`));
		await this.refresh();
		return prompt;
	}

	async deletePrompt(rawName: unknown): Promise<{ name: string; removed: true }> {
		const name = checkName(rawName);
		const { absolute } = await this.#resolve(this.prompts, `${name}.json`, { mustExist: true });
		await Deno.remove(absolute);
		await this.refresh();
		return { name, removed: true };
	}

	async renderPrompt(rawName: unknown, values: unknown): Promise<{ name: string; text: string }> {
		const prompt = await this.getPrompt(rawName);
		const record = values === undefined || values === null ? {} : values;
		if (typeof record !== 'object' || Array.isArray(record)) {
			throw new LibraryError('invalid-argument', 'arguments must be an object');
		}
		return { name: prompt.name, text: renderTemplate(prompt, record as Record<string, unknown>) };
	}
}

/** Lists share files recursively for `resources/list`, bounded. */
export async function walkShare(store: LibraryStore, limit = LIBRARY_LIMITS.resourceListEntries): Promise<Entry[]> {
	const out: Entry[] = [];
	const queue: string[] = [''];
	while (queue.length > 0 && out.length < limit) {
		const directory = queue.shift()!;
		const { entries } = await store.list(directory).catch(() => ({ entries: [] as Entry[] }));
		for (const entry of entries) {
			if (entry.kind === 'directory') queue.push(entry.path);
			else if (out.length < limit) out.push(entry);
		}
	}
	return out;
}
