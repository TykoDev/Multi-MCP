/** The gateway's actions behind the `memory_*` extension tools (`packages/mcp/src/extension_tools.ts`). */
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
