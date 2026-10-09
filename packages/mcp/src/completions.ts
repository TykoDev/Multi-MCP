/**
 * `completion/complete` for the resource templates (R13, design §2.17, D-129).
 *
 * A client filling in `ttk://session/{sessionId}/{kind}` should not have to call a tool to learn which session ids
 * exist, which kinds there are, which files a session holds, or what is in the share. Registering a `complete` map on a
 * `ResourceTemplate` is all the SDK needs: it installs `completion/complete` and declares the `completions`
 * capability by itself.
 *
 * **The callbacks get no caller.** The SDK hands a completer only `(value, {arguments})` — no `ServerContext`, no
 * `authInfo` — so authorization cannot be checked inside one. It is captured instead: every map here is built per
 * server instance, and a server instance is built per request (2026 stateless) or per connection whose principal is
 * fixed at `initialize` (stateful, stdio), with that caller's {@linkcode SessionAccess} closed over. A completer
 * therefore offers exactly what a `resources/list` from the same caller would list — in `owner` mode never another
 * owner's session or file id — and never creates anything: a session is looked up with `peekFor`, never `resolve`.
 *
 * In a cluster the request is served by the node that received it, so the lists are that node's (documented).
 */
import { LIBRARY_LIMITS, type LibraryStore, walkShare } from './library.ts';
import type { SessionAccess, SessionRegistry } from './registry.ts';

/** The most values one completion returns; the SDK truncates at the same number. */
export const MAX_COMPLETIONS = 100;

/** The SDK's `CompleteResourceTemplateCallback`, restated so this module needs no SDK import. */
export type Completer = (
	value: string,
	context?: { arguments?: Record<string, string> },
) => string[] | Promise<string[]>;

/** Up to {@linkcode MAX_COMPLETIONS} of `values` that start with `prefix`, in their own order, without duplicates. */
export function completeByPrefix(values: Iterable<string>, prefix: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value.startsWith(prefix) || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
		if (out.length >= MAX_COMPLETIONS) break;
	}
	return out;
}

/** A template variable as the client typed it: percent-decoded when it decodes, verbatim otherwise. */
function decoded(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** The completers of the two session templates (`{sessionId}/{kind}`, `{sessionId}/files/{fileId}`). */
export interface SessionCompleters {
	readonly sessionId: Completer;
	readonly kind: Completer;
	readonly fileId: Completer;
}

/**
 * Completers over the sessions `access` may reach (`shared` mode: all of them).
 *
 * `kinds` is passed in rather than imported, so the resource module can call this without an import cycle.
 */
export function sessionCompleters(
	registry: Pick<SessionRegistry, 'visibleTo' | 'peekFor'>,
	access: SessionAccess | undefined,
	kinds: readonly string[],
): SessionCompleters {
	return {
		sessionId: (value) => completeByPrefix(registry.visibleTo(access).map((record) => record.id), value),
		kind: (value) => completeByPrefix(kinds, value),
		fileId: (value, context) => {
			// `peekFor`, never `resolve`: completing a file id must not launch a browser. An omitted session is the
			// caller's default, as everywhere else.
			const record = registry.peekFor(decoded(context?.arguments?.sessionId), access);
			if (record === undefined) return [];
			return completeByPrefix(
				record.files.list().filter((file) => file.available).map((file) => file.file_id),
				value,
			);
		},
	};
}

/** The completers of the two library templates (`ttk://share/{+path}`, `ttk://skill/{name}`). */
export interface LibraryCompleters {
	readonly path: Completer;
	readonly name: Completer;
}

/**
 * Completers over the library — shared storage, so the only gate is the `files:read` registration already applies.
 * The share walk is bounded by {@linkcode LIBRARY_LIMITS.resourceListEntries}, the same bound `resources/list` uses,
 * because a completer runs per keystroke.
 */
export function libraryCompleters(store: LibraryStore): LibraryCompleters {
	return {
		path: async (value) => {
			try {
				const entries = await walkShare(store, LIBRARY_LIMITS.resourceListEntries);
				return completeByPrefix(entries.map((entry) => entry.path), value);
			} catch {
				// A share that cannot be read completes to nothing; `resources/list` reports the fault.
				return [];
			}
		},
		name: (value) => completeByPrefix(store.cached().skills.map((skill) => skill.name), value),
	};
}
