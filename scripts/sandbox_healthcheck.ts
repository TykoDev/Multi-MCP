/** Probe only the sandbox's local readiness endpoint. */
const response = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(4000), redirect: 'error' });
await response.body?.cancel();
Deno.exit(response.ok ? 0 : 1);
