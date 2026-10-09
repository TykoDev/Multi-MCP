/**
 * AC22 (F7, D-094): `TTK_BROWSER_ARGS` refuses every sandbox-weakening and launcher-owned Chromium switch at
 * parse time, naming the switch; `TTK_CHROMIUM_NO_SANDBOX` is the one way to run Chromium unsandboxed.
 *
 * The lists below are the design's (report_design.md §2.1), written out here rather than imported from the
 * implementation: a switch dropped from `config.ts` must fail this file, not quietly shrink it.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { ConfigError, ENV_NAMES, loadConfig } from './config.ts';
import { generateDbKey } from './vault.ts';

/** Sandbox-weakening switches: refused, and the refusal names `TTK_CHROMIUM_NO_SANDBOX`. */
const SANDBOX_WEAKENING = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--no-zygote',
	'--single-process',
	'--disable-seccomp-filter-sandbox',
	'--disable-namespace-sandbox',
	'--disable-gpu-sandbox',
	// R1-4: the GPU process as a thread of the unsandboxed browser process — the GPU analogue of --single-process.
	'--in-process-gpu',
	// Beyond the design's seven: every switch whose name says "sandbox", so the next spelling is caught too.
	'--no-zygote-sandbox',
	'--no-sandbox-and-elevated',
	'--allow-sandbox-debugging',
] as const;

/** Launcher-owned switches: the DevTools endpoint and the profile directory. */
const LAUNCHER_OWNED = [
	'--remote-debugging-port',
	'--remote-debugging-pipe',
	'--remote-debugging-address',
	'--remote-allow-origins',
	'--user-data-dir',
	'--remote-debugging-io-pipes',
] as const;

/** Switches that make Chromium execute another program, by name and by suffix. */
const COMMAND = [
	'--renderer-cmd-prefix',
	'--utility-cmd-prefix',
	'--gpu-launcher',
	'--browser-subprocess-path',
	'--zygote-cmd-prefix',
	'--ppapi-plugin-launcher',
] as const;

/** Each switch in the three spellings an operator writes: bare, with a value, and in another case. */
function spellings(name: string): string[] {
	return [
		name,
		`${name}=1`,
		`${name}=/opt/value with spaces`,
		name.toUpperCase(),
		`${name.slice(0, 4).toUpperCase()}${name.slice(4)}=x`,
	];
}

function refusal(args: string): ConfigError {
	return assertThrows(() => loadConfig({ TTK_BROWSER_ARGS: args }), ConfigError) as ConfigError;
}

Deno.test('AC22: every sandbox-weakening switch is refused at parse time, naming it and TTK_CHROMIUM_NO_SANDBOX', () => {
	for (const name of SANDBOX_WEAKENING) {
		for (const entry of spellings(name)) {
			const error = refusal(`--lang=en-US,${entry}`);
			assertStringIncludes(error.message, 'TTK_BROWSER_ARGS', entry);
			assertStringIncludes(error.message, name, `${entry}: the refusal must name the switch`);
			assertStringIncludes(error.message, 'TTK_CHROMIUM_NO_SANDBOX', entry);
		}
	}
});

Deno.test('AC22: every launcher-owned switch is refused at parse time, naming it', () => {
	for (const name of LAUNCHER_OWNED) {
		for (const entry of spellings(name)) {
			const error = refusal(entry);
			assertStringIncludes(error.message, 'TTK_BROWSER_ARGS', entry);
			assertStringIncludes(error.message, name, `${entry}: the refusal must name the switch`);
			assertStringIncludes(error.message, 'launcher', entry);
		}
	}
});

Deno.test('AC22: every switch that runs another program is refused, by name and by suffix', () => {
	for (const name of COMMAND) {
		for (const entry of spellings(name)) {
			const error = refusal(entry);
			assertStringIncludes(error.message, name, entry);
			assertStringIncludes(error.message, 'execute another program', entry);
		}
	}
});

Deno.test('AC22: an entry that is not a --switch is refused (F7), whatever it looks like', () => {
	for (const entry of ['-no-sandbox', '/no-sandbox', 'no-sandbox', 'about:blank', '--', '--=x', '--\u00a0no-sandbox']) {
		const error = refusal(entry);
		assertStringIncludes(error.message, 'TTK_BROWSER_ARGS', entry);
		assertStringIncludes(error.message, 'not a Chromium switch', entry);
	}
	// A comma inside a value splits it, and the tail is not a switch — said so, rather than failing at launch.
	const split = refusal('--disable-features=Translate,MediaRouter');
	assertStringIncludes(split.message, 'split on commas');
});

Deno.test('AC22: a feature list that disables a sandbox is refused like the switch would be', () => {
	const error = refusal('--disable-features=NetworkServiceSandbox');
	assertStringIncludes(error.message, 'NetworkServiceSandbox');
	assertStringIncludes(error.message, 'TTK_CHROMIUM_NO_SANDBOX');
});

Deno.test('AC22: a refusal names the switch and never echoes its value', () => {
	const error = refusal('--user-data-dir=C:\\Users\\operator\\secret-profile');
	assertStringIncludes(error.message, '--user-data-dir');
	assert(!error.message.includes('secret-profile'), error.message);
	const proxy = refusal('--gpu-launcher=/usr/bin/env TOKEN=abc123');
	assert(!proxy.message.includes('abc123'), proxy.message);
});

Deno.test('AC22: ordinary switches still pass through, unchanged and in order', () => {
	const args = [
		'--lang=fr-FR',
		'--disable-gpu',
		'--force-color-profile=srgb',
		'--disable-features=Translate',
		'--proxy-server=http://127.0.0.1:3128',
	];
	assertEquals(loadConfig({ TTK_BROWSER_ARGS: args.join(',') }).browser.args, args);
	assertEquals(loadConfig({ TTK_BROWSER_ARGS: ` ${args[0]} , ${args[1]} ` }).browser.args, args.slice(0, 2));
	assertEquals(loadConfig({}).browser.args, []);
});

Deno.test('D-094: TTK_CHROMIUM_NO_SANDBOX defaults to a sandboxed Chromium and parses as a strict boolean', () => {
	assertEquals(loadConfig({}).browser.chromiumSandbox, true);
	assertEquals(loadConfig({ TTK_CHROMIUM_NO_SANDBOX: '' }).browser.chromiumSandbox, true);
	assertEquals(loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'false' }).browser.chromiumSandbox, true);
	assertEquals(loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'true' }).browser.chromiumSandbox, false);
	assertEquals(loadConfig({ TTK_CHROMIUM_NO_SANDBOX: '1' }).browser.chromiumSandbox, false);
	assertThrows(() => loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'sometimes' }), ConfigError, 'TTK_CHROMIUM_NO_SANDBOX');
	// Setting it is how --no-sandbox is reached; spelling the switch is still refused alongside it.
	assertThrows(
		() => loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'true', TTK_BROWSER_ARGS: '--no-sandbox' }),
		ConfigError,
		'--no-sandbox',
	);
	assert((ENV_NAMES as readonly string[]).includes('TTK_CHROMIUM_NO_SANDBOX'), 'read only if it is in ENV_NAMES');
	assert((ENV_NAMES as readonly string[]).includes('TTK_BROWSER_ARGS'));
});

// --- containment-otel-links S0 (design §2.0 item 1, §2.1) -----------------------------------------------------------

Deno.test('S0: TTK_OTEL_ENDPOINTS and TTK_ALLOWED_DOMAINS_SCOPE are read from the process (ENV_NAMES)', () => {
	for (const name of ['TTK_OTEL_ENDPOINTS', 'TTK_ALLOWED_DOMAINS_SCOPE', 'TTK_ALLOWED_DOMAINS']) {
		assert((ENV_NAMES as readonly string[]).includes(name), `${name} is read only if it is in ENV_NAMES`);
	}
});

Deno.test('AC9: TTK_ALLOWED_DOMAINS_SCOPE defaults to documents, is case-insensitive, and refuses the rest', () => {
	const domains = { TTK_ALLOWED_DOMAINS: 'example.com' };
	assertEquals(loadConfig({}).allowedDomainsScope, 'documents');
	assertEquals(loadConfig({ TTK_ALLOWED_DOMAINS_SCOPE: '' }).allowedDomainsScope, 'documents');
	assertEquals(loadConfig({ ...domains }).allowedDomainsScope, 'documents');
	assertEquals(loadConfig({ ...domains, TTK_ALLOWED_DOMAINS_SCOPE: 'documents' }).allowedDomainsScope, 'documents');
	// `documents` with no allowlist is the default deployment, and stays accepted.
	assertEquals(loadConfig({ TTK_ALLOWED_DOMAINS_SCOPE: 'Documents' }).allowedDomainsScope, 'documents');
	for (const spelling of ['all', 'ALL', ' All ', '\tall']) {
		assertEquals(loadConfig({ ...domains, TTK_ALLOWED_DOMAINS_SCOPE: spelling }).allowedDomainsScope, 'all', spelling);
	}
	for (const other of ['any', 'none', 'subresources', 'documents,all', 'true']) {
		const error = assertThrows(
			() => loadConfig({ ...domains, TTK_ALLOWED_DOMAINS_SCOPE: other }),
			ConfigError,
		) as ConfigError;
		assertStringIncludes(error.message, 'TTK_ALLOWED_DOMAINS_SCOPE', other);
		assertStringIncludes(error.message, 'documents|all', other);
	}
});

Deno.test('AC9: TTK_ALLOWED_DOMAINS_SCOPE=all with an empty TTK_ALLOWED_DOMAINS is refused', () => {
	for (const empty of [{}, { TTK_ALLOWED_DOMAINS: '' }, { TTK_ALLOWED_DOMAINS: ' , ,' }]) {
		const error = assertThrows(
			() => loadConfig({ ...empty, TTK_ALLOWED_DOMAINS_SCOPE: 'all' }),
			ConfigError,
		) as ConfigError;
		assertEquals(error.message, 'TTK_ALLOWED_DOMAINS_SCOPE: all needs a non-empty TTK_ALLOWED_DOMAINS');
	}
});

Deno.test('S0: TTK_OTEL_ENDPOINTS is carried as a trimmed list for the diagnostics, empty by default', () => {
	assertEquals(loadConfig({}).otelEndpoints, []);
	assertEquals(loadConfig({ TTK_OTEL_ENDPOINTS: '  ' }).otelEndpoints, []);
	assertEquals(
		loadConfig({ TTK_OTEL_ENDPOINTS: ' http://collector:4318 ,, https://otel.example.test ' }).otelEndpoints,
		['http://collector:4318', 'https://otel.example.test'],
	);
});

Deno.test('AC18 (G5): TTK_SIGNED_LINK_TTL_S accepts 10–3600, defaults to 3600, and refuses 3601', () => {
	const on = (ttl?: string) =>
		loadConfig({
			TTK_SIGNED_LINKS: 'true',
			TTK_DATA_DIR: '/data',
			...(ttl === undefined ? {} : { TTK_SIGNED_LINK_TTL_S: ttl }),
			// D-154: a generated link key is sealed in the vault, so the data directory needs the vault's key.
		}, { secrets: { TTK_DB_KEY: generateDbKey() } }).signedLinks?.ttlS;
	assertEquals(on(), 3600);
	assertEquals(on('10'), 10);
	assertEquals(on('3600'), 3600);
	for (const ttl of ['9', '3601', '86400']) {
		assertThrows(() => on(ttl), ConfigError, 'TTK_SIGNED_LINK_TTL_S: expected an integer in [10, 3600]');
	}
});
