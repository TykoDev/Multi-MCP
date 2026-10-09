/**
 * D-155: `GET /api/v1/overview` — how much this credential has stored, per resource, as counts and byte totals only.
 *
 * One read for the Sessions dashboard and the Resources overview, so both say the same numbers. Every section is the
 * answer the store's own list route or tool would give this caller, reduced to a count:
 *
 * - **Gated by the scope that already reads the data.** A section the caller cannot read is *omitted*, never zero: a
 *   zero would be a claim about data the caller was not allowed to look at.
 * - **Owner-scoped like the listing it mirrors.** Sessions and recordings follow the registry's ownership mode
 *   (everything in `shared` mode or for `admin`); memory is the caller's own, or the deployment's totals for `admin`
 *   (what `GET /api/v1/system/memory` already tells one); tasks, surfaces and workspaces are always the caller's own,
 *   because no route or tool widens them for `admin`. Each owner-scoped section says which (`scope: 'own' | 'all'`).
 * - **No names, no contents, no secrets.** A file, profile, skill or prompt name never leaves this module; nor does a
 *   provider's id, host or key.
 * - **Bounded.** Directory walks never follow a link, stop at a fixed entry cap (`truncated: true` then, so the count
 *   reads as "at least"), and are cached for {@linkcode OVERVIEW_CACHE_MS} across callers — the trees are shared, not
 *   owned, so one walk answers everyone. The sandbox is asked once per read with a short deadline.
 *
 * Node-local in a cluster, like the providers and the memory: each node reports its own data directory and sessions.
 */
import type { Hono } from 'hono';
import { terminal } from '@tykotech/agents';
import type { SessionAccess, SessionSummary } from '@tykotech/mcp';
import type { AppVariables } from './app.ts';
import { expansionOwner, type Principal } from './auth.ts';
import { problemResponse } from './problem.ts';

/** How long a directory walk's answer is reused. Short: the dashboard must follow a write within one poll or two. */
export const OVERVIEW_CACHE_MS = 10_000;

/**
 * Entry caps per walk. The share and the profiles are walked on their own; the whole data directory (admin only) holds
 * both, plus downloads, so it gets the larger cap. Past a cap the walk stops and says so rather than run on.
 */
export const WALK_CAPS = { share: 20_000, profiles: 20_000, dataDir: 50_000, listing: 10_000 } as const;

/** Directory depth past which a walk does not descend (the library's own `maxDepth`). */
const MAX_DEPTH = 32;

/** How long the sandbox's workspace list may take before the section reads as unavailable. */
const SANDBOX_DEADLINE_MS = 2_000;

/** What a bounded walk found. `truncated`: the cap or the depth limit was reached, so every number is a floor. */
export interface TreeUsage {
	readonly files: number;
	readonly directories: number;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** `scope` on an owner-scoped section: the caller's own data, or everyone's. */
export type OverviewScope = 'own' | 'all';

/** The route's body. Every section is optional: absent means the caller holds no scope that reads it, or none exists. */
export interface Overview {
	readonly generated_at: string;
	/** `mcp:invoke`: live browser sessions the caller can reach. */
	readonly sessions?: {
		readonly scope: OverviewScope;
		readonly count: number;
		readonly tabs: number;
		readonly viewers: number;
		readonly in_use: number;
	};
	/** `mcp:invoke`, with a data directory: named browser profiles (shared by design, G8). */
	readonly profiles?: { readonly count: number; readonly bytes: number; readonly truncated: boolean };
	/** `mcp:invoke`, with a data directory: saved storage-state documents (shared by name, like profiles). */
	readonly storage_states?: { readonly count: number; readonly bytes: number };
	/** `view:watch`, where recording is configured: the recordings this caller may download. */
	readonly recordings?: { readonly scope: OverviewScope; readonly count: number; readonly bytes: number };
	/** `files:read`: the file share. */
	readonly files?: {
		readonly count: number;
		readonly folders: number;
		readonly bytes: number;
		readonly truncated: boolean;
	};
	/** `files:read`: stored skills. */
	readonly skills?: { readonly count: number };
	/** `files:read`: stored prompts. */
	readonly prompts?: { readonly count: number };
	/** `files:read`, with a database: agent memory. */
	readonly memory?: { readonly scope: OverviewScope; readonly collections: number; readonly items: number };
	/** `sandbox:execute`, with a sandbox: the caller's workspaces; `count: null` when the sandbox did not answer. */
	readonly workspaces?: { readonly scope: 'own'; readonly count: number | null };
	/** `agent:invoke`: the caller's agent tasks, by state (`completed`, `working`, …). */
	readonly tasks?: {
		readonly scope: 'own';
		readonly count: number;
		readonly active: number;
		readonly by_state: Readonly<Record<string, number>>;
	};
	/** `agent:invoke`: the caller's A2UI surfaces. */
	readonly surfaces?: { readonly scope: 'own'; readonly count: number };
	/** `agent:invoke` or `admin`: the model providers configured, and how many this process may reach. */
	readonly providers?: { readonly count: number; readonly reachable: number };
	/** `admin`, with a data directory: everything under `TTK_DATA_DIR`. */
	readonly disk?: { readonly bytes: number; readonly truncated: boolean };
}

/**
 * Where the numbers come from. Narrow structural views of the real stores, so a test can hand in a fake and the route
 * cannot reach more of a store than counting needs.
 */
export interface OverviewSources {
	readonly registry: {
		readonly ownership: 'shared' | 'owner';
		listFor(access?: SessionAccess): SessionSummary[];
	};
	readonly dataDir: string | null;
	readonly library?: {
		readonly share: string;
		cached(): { readonly prompts: readonly unknown[]; readonly skills: readonly unknown[] };
	};
	readonly recorder?: { readonly dir: string | null; mayRead(name: string, access: SessionAccess): boolean } | null;
	readonly sandbox?: {
		call(principal: string, operation: 'list', args: Record<string, unknown>, signal?: AbortSignal): Promise<
			Record<string, unknown>
		>;
	};
	/** The sandbox's last health answer; `false` skips the call. */
	readonly sandboxUp?: () => boolean | undefined;
	readonly tasks?: { list(owner: string): ReadonlyArray<{ readonly status: { readonly state: string } }> };
	readonly surfaces?: { list(owner: string): Record<string, unknown> };
	readonly providers?: () => { readonly providers: ReadonlyArray<{ readonly reachable: boolean }> };
	readonly memory?: {
		collections(owner: string): ReadonlyArray<{ readonly items: number }>;
		summary(): ReadonlyArray<{ readonly collections: number; readonly items: number }>;
	};
	/** Test seam: the cache clock. */
	readonly now?: () => number;
}

/**
 * Walks `root` without following a link, counting files, directories and file bytes, and stops at `cap` entries or
 * {@linkcode MAX_DEPTH}. A missing or unreadable directory counts as empty. Every step is async I/O, so a large tree
 * costs time, never the event loop.
 */
export async function measureTree(root: string, cap: number): Promise<TreeUsage> {
	let files = 0;
	let directories = 0;
	let bytes = 0;
	let seen = 0;
	let truncated = false;
	const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: root, depth: 0 }];
	walk: while (pending.length > 0) {
		const { path, depth } = pending.pop()!;
		try {
			for await (const entry of Deno.readDir(path)) {
				if (seen >= cap) {
					truncated = true;
					break walk;
				}
				seen += 1;
				// `readDir` reports a link as a link: neither followed nor counted.
				if (entry.isSymlink) continue;
				const child = `${path}/${entry.name}`;
				if (entry.isDirectory) {
					directories += 1;
					if (depth + 1 < MAX_DEPTH) pending.push({ path: child, depth: depth + 1 });
					else truncated = true;
				} else if (entry.isFile) {
					const info = await Deno.lstat(child).catch(() => null);
					if (info === null || !info.isFile) continue;
					files += 1;
					bytes += info.size;
				}
			}
		} catch {
			// Gone between listing and reading, or not readable: nothing to count there.
		}
	}
	return { files, directories, bytes, truncated };
}

/** One level of `dir`: plain files (with their size) and directories, links skipped, bounded by `cap`. */
async function listTop(dir: string, cap: number): Promise<Array<{ name: string; directory: boolean; bytes: number }>> {
	const out: Array<{ name: string; directory: boolean; bytes: number }> = [];
	try {
		for await (const entry of Deno.readDir(dir)) {
			if (out.length >= cap) break;
			if (entry.isSymlink) continue;
			if (entry.isDirectory) out.push({ name: entry.name, directory: true, bytes: 0 });
			else if (entry.isFile) {
				const info = await Deno.lstat(`${dir}/${entry.name}`).catch(() => null);
				if (info !== null && info.isFile) out.push({ name: entry.name, directory: false, bytes: info.size });
			}
		}
	} catch {
		// No such directory yet: nothing stored.
	}
	return out;
}

/** A value computed at most once per {@linkcode OVERVIEW_CACHE_MS}, shared by concurrent readers. */
class Cached<T> {
	#at = -Infinity;
	#value: Promise<T> | null = null;
	constructor(private readonly compute: () => Promise<T>, private readonly now: () => number) {}
	get(): Promise<T> {
		const now = this.now();
		if (this.#value === null || now - this.#at >= OVERVIEW_CACHE_MS) {
			this.#at = now;
			// A failed computation is not kept: the next read tries again.
			this.#value = this.compute().catch((cause) => {
				this.#value = null;
				throw cause;
			});
		}
		return this.#value;
	}
}

/** `TASK_STATE_INPUT_REQUIRED` → `input_required`: the state's own name, without the protocol's prefix. */
export function taskStateKey(state: string): string {
	return state.replace(/^TASK_STATE_/, '').toLowerCase();
}

/** The body's key order: the browser's data, the library, the agents', then the disk. */
const SECTION_ORDER: ReadonlyArray<keyof Overview> = [
	'generated_at',
	'sessions',
	'profiles',
	'storage_states',
	'recordings',
	'files',
	'skills',
	'prompts',
	'memory',
	'workspaces',
	'tasks',
	'surfaces',
	'providers',
	'disk',
];

/** Builds the overview reader over `sources`; the walks it needs are cached across calls and callers. */
export function createOverview(sources: OverviewSources): (principal: Principal) => Promise<Overview> {
	const now = sources.now ?? Date.now;
	const dataDir = sources.dataDir;
	const share = sources.library === undefined
		? null
		: new Cached(() => measureTree(sources.library!.share, WALK_CAPS.share), now);
	const profiles = dataDir === null ? null : new Cached(async () => {
		const top = await listTop(`${dataDir}/profiles`, WALK_CAPS.listing);
		const usage = await measureTree(`${dataDir}/profiles`, WALK_CAPS.profiles);
		return { count: top.filter((entry) => entry.directory).length, bytes: usage.bytes, truncated: usage.truncated };
	}, now);
	const storage = dataDir === null ? null : new Cached(async () => {
		const states = (await listTop(`${dataDir}/storage`, WALK_CAPS.listing)).filter((entry) =>
			!entry.directory && entry.name.endsWith('.json')
		);
		return { count: states.length, bytes: states.reduce((sum, entry) => sum + entry.bytes, 0) };
	}, now);
	const recorderDir = sources.recorder?.dir ?? null;
	const recordings = recorderDir === null
		? null
		: new Cached(async () =>
			(await listTop(recorderDir, WALK_CAPS.listing))
				.filter((entry) => !entry.directory && entry.name.endsWith('.webm'))
				.map((entry) => ({ name: entry.name.slice(0, -'.webm'.length), bytes: entry.bytes })), now);
	const disk = dataDir === null ? null : new Cached(() => measureTree(dataDir, WALK_CAPS.dataDir), now);

	return async (principal: Principal): Promise<Overview> => {
		const scopes = principal.scopes;
		const admin = scopes.has('admin');
		const owner = expansionOwner(principal);
		const access: SessionAccess = { owner, admin };
		// Sessions and recordings: everyone's in `shared` mode or for `admin`, as the registry and `mayRead` decide.
		const sessionScope: OverviewScope = sources.registry.ownership === 'owner' && !admin ? 'own' : 'all';
		const out: { -readonly [K in keyof Overview]: Overview[K] } = { generated_at: new Date(now()).toISOString() };
		const work: Promise<void>[] = [];

		if (scopes.has('mcp:invoke')) {
			const list = sources.registry.listFor(access);
			out.sessions = {
				scope: sessionScope,
				count: list.length,
				tabs: list.reduce((sum, session) => sum + session.tab_count, 0),
				viewers: list.reduce((sum, session) => sum + session.viewer_count, 0),
				in_use: list.filter((session) => session.human_has_control).length,
			};
			if (profiles !== null) work.push(profiles.get().then((value) => void (out.profiles = value)));
			if (storage !== null) work.push(storage.get().then((value) => void (out.storage_states = value)));
		}
		if (scopes.has('view:watch') && recordings !== null && sources.recorder) {
			const recorder = sources.recorder;
			work.push(
				recordings.get().then((all) => {
					const mine = all.filter((entry) => recorder.mayRead(entry.name, access));
					out.recordings = {
						scope: sessionScope,
						count: mine.length,
						bytes: mine.reduce((sum, entry) => sum + entry.bytes, 0),
					};
				}),
			);
		}
		if (scopes.has('files:read')) {
			if (share !== null) {
				work.push(
					share.get().then((usage) => {
						out.files = {
							count: usage.files,
							folders: usage.directories,
							bytes: usage.bytes,
							truncated: usage.truncated,
						};
					}),
				);
			}
			if (sources.library !== undefined) {
				// The library's own listing cache (refreshed after every write through it, and every 15 s).
				const cached = sources.library.cached();
				out.skills = { count: cached.skills.length };
				out.prompts = { count: cached.prompts.length };
			}
			if (sources.memory !== undefined) {
				// `memory_list` is the caller's own; `GET /api/v1/system/memory` gives an admin the deployment's totals.
				if (admin) {
					const totals = sources.memory.summary();
					out.memory = {
						scope: 'all',
						collections: totals.reduce((sum, row) => sum + row.collections, 0),
						items: totals.reduce((sum, row) => sum + row.items, 0),
					};
				} else {
					const own = sources.memory.collections(owner);
					out.memory = { scope: 'own', collections: own.length, items: own.reduce((sum, row) => sum + row.items, 0) };
				}
			}
		}
		if (scopes.has('sandbox:execute') && sources.sandbox !== undefined) {
			const sandbox = sources.sandbox;
			const up = sources.sandboxUp?.();
			work.push((async () => {
				let count: number | null = null;
				if (up !== false) {
					try {
						const reply = await sandbox.call(owner, 'list', {}, AbortSignal.timeout(SANDBOX_DEADLINE_MS));
						count = Array.isArray(reply.workspaces) ? reply.workspaces.length : null;
					} catch {
						// The sandbox is down or slow: the section says it does not know, rather than zero.
					}
				}
				out.workspaces = { scope: 'own', count };
			})());
		}
		if (scopes.has('agent:invoke')) {
			if (sources.tasks !== undefined) {
				const by_state: Record<string, number> = {};
				let active = 0;
				const tasks = sources.tasks.list(owner);
				for (const task of tasks) {
					const key = taskStateKey(task.status.state);
					by_state[key] = (by_state[key] ?? 0) + 1;
					if (!terminal(task.status.state)) active += 1;
				}
				out.tasks = { scope: 'own', count: tasks.length, active, by_state };
			}
			if (sources.surfaces !== undefined) {
				const listed = sources.surfaces.list(owner).surfaces;
				out.surfaces = { scope: 'own', count: Array.isArray(listed) ? listed.length : 0 };
			}
		}
		if ((scopes.has('agent:invoke') || admin) && sources.providers !== undefined) {
			const views = sources.providers().providers;
			out.providers = { count: views.length, reachable: views.filter((view) => view.reachable).length };
		}
		if (admin && disk !== null) {
			work.push(disk.get().then((usage) => void (out.disk = { bytes: usage.bytes, truncated: usage.truncated })));
		}
		await Promise.all(work);
		// The walks finish in any order; the document's keys do not.
		return Object.fromEntries(
			SECTION_ORDER.filter((key) => out[key] !== undefined).map((key) => [key, out[key]]),
		) as unknown as Overview;
	};
}

/**
 * Mounts `GET /api/v1/overview` behind the gateway's auth gate. Any authenticated caller may ask; what it is told is
 * {@linkcode createOverview}'s to decide per scope, so a caller holding none of them gets `generated_at` alone.
 */
export function attachOverviewRoute(
	app: Hono<{ Variables: AppVariables }>,
	overview: (principal: Principal) => Promise<Overview>,
	onError: (cause: unknown) => void = () => {},
): void {
	app.get('/api/v1/overview', async (c) => {
		const principal = c.get('principal') as Principal | undefined;
		if (principal === undefined) return problemResponse('unauthenticated', c.get('requestId'));
		try {
			return c.json(await overview(principal), 200, { 'cache-control': 'no-store' });
		} catch (cause) {
			onError(cause);
			return problemResponse('internal', c.get('requestId'), 'the overview could not be computed');
		}
	});
}
