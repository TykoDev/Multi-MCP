/**
 * Zod without its `new Function` fast path, for the SPA and the MCP Apps embeds (R9, D-135; K-5).
 *
 * Zod 4 probes whether `eval` is allowed when it builds its first object schema, inside a `try`. Under a CSP without
 * `'unsafe-eval'` — the SPA's page policy and each embed's meta policy — the probe throws, which is fine, and is also
 * **reported**, as a `securitypolicyviolation`, to the document and to anything watching it (in the SPA, on the first
 * Live View, when the lazy socket chunk builds the wire schemas). `jitless` skips the probe and the compiled fast path
 * with it; the pages parse small socket messages and A2UI snapshots, so the interpreted path costs nothing anyone
 * could see.
 *
 * Imported **first** by each entry (`app.ts`, `embed_live.ts`, `embed_a2ui.ts`): module evaluation follows import
 * order, and a lazy chunk evaluates after the entry, so this runs before any schema exists.
 *
 * Why not `import { config } from 'zod'`: in the SPA that import puts the whole validator into the entry's static
 * graph — the bundler cannot split Zod's `config` from its schemas — and every first paint would download what D-069
 * keeps lazy until a Live View opens. Zod's global configuration *is* one object on `globalThis`
 * (`__zod_globalConfig`, which Zod adopts when it is evaluated after this and shares when before), so setting the flag
 * there is `config({ jitless: true })` without the import. `web_test.ts` holds the installed Zod to that: after this
 * module, Zod's own `config()` reports `jitless`.
 */

/** The object Zod 4 keeps its global configuration in. */
interface ZodGlobal {
	__zod_globalConfig?: { jitless?: boolean };
}

const holder = globalThis as typeof globalThis & ZodGlobal;
(holder.__zod_globalConfig ??= {}).jitless = true;
