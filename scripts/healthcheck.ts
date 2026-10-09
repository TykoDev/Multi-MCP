/**
 * Container liveness probe.
 *
 * Always dials `127.0.0.1`, never `TTK_HOST`: a server bound to `0.0.0.0` is
 * reachable on loopback, but a probe that *connects* to `0.0.0.0` fails — the
 * classic bind-versus-connect mistake that presents as a restart loop.
 */
const port = Deno.env.get('TTK_PORT') ?? '8787';

try {
	const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
		signal: AbortSignal.timeout(2500),
	});
	const body = await response.json() as { status?: string };
	if (!response.ok || body.status !== 'ok') {
		console.error(`unhealthy: ${response.status} ${JSON.stringify(body)}`);
		Deno.exit(1);
	}
	Deno.exit(0);
} catch (cause) {
	console.error(`unhealthy: ${cause instanceof Error ? cause.message : String(cause)}`);
	Deno.exit(1);
}
