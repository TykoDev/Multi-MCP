/**
 * Zod without its `new Function` fast path, for the SPA and the MCP Apps embeds. Zod 4 probes `eval` when it builds
 * its first schema; under a CSP without `'unsafe-eval'` the probe is reported as a `securitypolicyviolation`.
 * Imported **first** by each entry, so it runs before any schema exists. It sets Zod's global configuration object
 * directly: importing `config` from Zod would pull the whole validator into the SPA's first paint.
 */

interface ZodGlobal {
	__zod_globalConfig?: { jitless?: boolean };
}

const holder = globalThis as typeof globalThis & ZodGlobal;
(holder.__zod_globalConfig ??= {}).jitless = true;
