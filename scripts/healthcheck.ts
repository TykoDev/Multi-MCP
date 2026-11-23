/**
 * Container liveness probe. Dials `127.0.0.1`, never `TTK_HOST`: a server bound to `0.0.0.0` answers on loopback,
 * but connecting to `0.0.0.0` fails and presents as a restart loop.
 */
const port = Deno.env.get('TTK_PORT') ?? '8787';

try {
	const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
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
