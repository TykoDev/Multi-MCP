/**
 * D-154: the gateway's actions behind the `memory_*` extension tools (`packages/mcp/src/extension_tools.ts`).
 *
 * The owner is `ctx.principal`, which the extension seam has already replaced with the realm-qualified owner
 * (`extensionPrincipal ?? principal`, GW-5) — the one `expansionOwner` spells for every other owned resource, and the
 * shared `anonymous-loopback:local` on the credential-less mounts (loopback development, stdio). The arguments arrive
 * validated by the tool's input schema; the store judges every bound again, since it is the authority.
 *
 * A {@linkcode MemoryError} becomes a {@linkcode ToolError} with a code clients already know (no new code): a refused
 * request is `invalid-arguments`, a missing collection `file-unavailable` (the library's precedent for persistent data
 * that is not there, D-075), and an embedder that cannot serve the call `feature-unavailable`. Anything else is left to
 * the seam, which answers a fixed text and never the cause.
 */
import { type ExtensionActions, ToolError, type ToolErrorCode } from '@tykotech/mcp';
import {
	MemoryError,
	type MemoryErrorCode,
	type MemoryFilter,
	type MemoryItemInput,
	type MemoryStore,
} from './memory.ts';

const CODES: Readonly<Record<MemoryErrorCode, ToolErrorCode>> = {
	invalid: 'invalid-arguments',
	'not-found': 'file-unavailable',
	unavailable: 'feature-unavailable',
};

/** Runs `work`, turning a store refusal into the tool error the model reads. */
async function guarded(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
	try {
		return await work();
	} catch (cause) {
		if (cause instanceof MemoryError) throw new ToolError(CODES[cause.code], cause.message);
		throw cause;
	}
}

/** The four memory tools' actions over `store`; merge into the `ExtensionActions` given to `extensionTools`. */
export function memoryActions(store: MemoryStore): ExtensionActions {
	return {
		memory_save: (args, ctx) =>
			guarded(async () => ({
				...await store.save(
					ctx.principal,
					String(args.collection),
					args.items as readonly MemoryItemInput[],
					ctx.signal,
				),
			})),
		memory_search: (args, ctx) =>
			guarded(async () => ({
				...await store.search(
					ctx.principal,
					String(args.collection),
					String(args.query),
					typeof args.limit === 'number' ? args.limit : undefined,
					args.filter as MemoryFilter | undefined,
					ctx.signal,
				),
			})),
		memory_delete: (args, ctx) =>
			guarded(() => {
				const collection = String(args.collection);
				if (args.all === true) {
					const removed = store.drop(ctx.principal, collection);
					return Promise.resolve({ collection, deleted: removed ?? 0, dropped: removed !== null });
				}
				const deleted = store.delete(ctx.principal, collection, args.ids as readonly string[]);
				return Promise.resolve({ collection, deleted, dropped: false });
			}),
		memory_list: (_args, ctx) =>
			guarded(() =>
				Promise.resolve({ default_embedder: store.defaultEmbedderId(), collections: store.collections(ctx.principal) })
			),
	};
}
