/**
 * At the gateway, `TTK_CHROMIUM_NO_SANDBOX` reaches the registry, the startup log and the admin diagnostics document —
 * and `chromiumSandboxed` is not `sandboxEnabled`, which is the coding sandbox.
 */
import { assert, assertEquals } from '@std/assert';
import { generateApiKey } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startGateway } from './server.ts';
import { fakeSession } from './support_test.ts';

async function diagnostics(env: Record<string, string>): Promise<Record<string, unknown>> {
	const admin = await generateApiKey('admin-key', ['mcp:invoke', 'admin']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '0',
		TTK_API_KEYS: JSON.stringify([admin.record]),
		TTK_LOG_LEVEL: 'error',
		...env,
	});
	const gateway = await startGateway({
		config,
		version: '0.1.0-test',
		logger: createLogger({ level: 'error', write: () => {} }),
		launch: () => Promise.resolve(fakeSession(false)),
	});
	try {
		assertEquals(gateway.registry.chromiumSandboxed, config.browser.chromiumSandbox, 'the registry got the setting');
		const response = await fetch(`${gateway.url}/api/v1/system/diagnostics`, {
			headers: { authorization: `Bearer ${admin.key}` },
		});
		assertEquals(response.status, 200);
		return (await response.json()).config as Record<string, unknown>;
	} finally {
		await gateway.shutdown();
		await gateway.finished;
	}
}

Deno.test('chromium sandbox: diagnostics report chromiumSandboxed from the registry, separately from the coding sandbox', async () => {
	const sandboxed = await diagnostics({});
	assertEquals(sandboxed.chromiumSandboxed, true);
	assertEquals(sandboxed.sandboxEnabled, false, 'no coding sandbox is configured here');

	const unsandboxed = await diagnostics({ TTK_CHROMIUM_NO_SANDBOX: 'true' });
	assertEquals(unsandboxed.chromiumSandboxed, false);
	assert('sandboxEnabled' in unsandboxed);
});
