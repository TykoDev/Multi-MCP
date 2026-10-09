/** Runner health probe with only its loopback endpoint in the permission matrix (D-066). */
try {
	const response = await fetch('http://127.0.0.1:8789/healthz', {
		signal: AbortSignal.timeout(4000),
		redirect: 'error',
	});
	await response.body?.cancel();
	Deno.exit(response.ok ? 0 : 1);
} catch {
	Deno.exit(1);
}
