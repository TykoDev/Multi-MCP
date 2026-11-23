/**
 * `TTK_BROWSER_ARGS` refuses every sandbox-weakening and launcher-owned Chromium switch at parse time, naming the
 * switch; `TTK_CHROMIUM_NO_SANDBOX` is the one way to run Chromium unsandboxed.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { ConfigError, loadConfig } from './config.ts';
import { generateDbKey } from './vault.ts';

/** Each refused family: its switches, the phrase its refusal carries, and whether it rides behind a benign switch. */
const REFUSED: ReadonlyArray<readonly [readonly string[], string]> = [
	[[
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--no-zygote',
		'--single-process',
		'--disable-seccomp-filter-sandbox',
		'--disable-namespace-sandbox',
		'--disable-gpu-sandbox',
		// The GPU process as a thread of the unsandboxed browser process.
		'--in-process-gpu',
		// Off the named list: every switch whose name says "sandbox", so the next spelling is caught too.
		'--no-zygote-sandbox',
		'--no-sandbox-and-elevated',
		'--allow-sandbox-debugging',
	], 'TTK_CHROMIUM_NO_SANDBOX'],
	[[
		'--remote-debugging-port',
		'--remote-debugging-pipe',
		'--remote-debugging-address',
		'--remote-allow-origins',
		'--user-data-dir',
		'--remote-debugging-io-pipes',
	], 'launcher'],
	[[
		'--renderer-cmd-prefix',
		'--utility-cmd-prefix',
		'--gpu-launcher',
		'--browser-subprocess-path',
		'--zygote-cmd-prefix',
		'--ppapi-plugin-launcher',
	], 'execute another program'],
	[[
		'--disable-site-isolation-trials',
		'--disable-web-security',
		'--allow-file-access-from-files',
		'--allow-file-access',
		'--load-extension',
		'--disable-extensions-except',
	], 'isolation'],
];

const refusal = (args: string): ConfigError =>
	assertThrows(() => loadConfig({ TTK_BROWSER_ARGS: args }), ConfigError) as ConfigError;

Deno.test('TTK_BROWSER_ARGS: every weakening, launcher-owned or program-running switch is refused in any spelling, by name', () => {
	for (const [names, phrase] of REFUSED) {
		for (const name of names) {
			const spellings = [
				name,
				`${name}=1`,
				`${name}=/opt/value with spaces`,
				name.toUpperCase(),
				`${name.slice(0, 4).toUpperCase()}${name.slice(4)}=x`,
			];
			for (const entry of spellings) {
				const error = refusal(`--lang=en-US,${entry}`);
				for (const part of ['TTK_BROWSER_ARGS', name, phrase]) assertStringIncludes(error.message, part, entry);
			}
		}
	}
	// A refusal names the switch and never echoes its value.
	const profile = refusal('--user-data-dir=C:\\Users\\operator\\secret-profile');
	assert(!profile.message.includes('secret-profile'), profile.message);
	assert(!refusal('--gpu-launcher=/usr/bin/env TOKEN=abc123').message.includes('abc123'));
});

Deno.test('TTK_BROWSER_ARGS: non-switches, sandbox or isolation features and unsafe V8 flags are refused; the rest pass in order', () => {
	for (const entry of ['-no-sandbox', '/no-sandbox', 'no-sandbox', 'about:blank', '--', '--=x', '--\u00a0no-sandbox']) {
		assertStringIncludes(refusal(entry).message, 'not a Chromium switch', entry);
	}
	// A comma inside a value splits it; said so, rather than failing at launch.
	assertStringIncludes(refusal('--disable-features=Translate,MediaRouter').message, 'split on commas');
	const sandboxFeature = refusal('--disable-features=NetworkServiceSandbox').message;
	assertStringIncludes(sandboxFeature, 'NetworkServiceSandbox');
	assertStringIncludes(sandboxFeature, 'TTK_CHROMIUM_NO_SANDBOX');
	for (
		const feature of ['site-per-process', 'SitePerProcess', 'IsolateOrigins', 'isolate-origins', 'StrictSiteIsolation']
	) {
		const error = refusal(`--disable-features=${feature}`);
		assertStringIncludes(error.message, feature);
		assertStringIncludes(error.message, 'site isolation');
	}
	for (const value of ['--no-v8-sandbox', '--allow-natives-syntax', '--expose-gc --Allow_Natives_Syntax']) {
		const error = refusal(`--js-flags=${value}`);
		assertStringIncludes(error.message, '--js-flags');
		assert(!error.message.includes('expose-gc'), error.message);
	}
	const args = [
		'--lang=fr-FR',
		'--disable-gpu',
		'--force-color-profile=srgb',
		'--disable-features=Translate',
		'--proxy-server=http://127.0.0.1:3128',
		'--js-flags=--expose-gc',
	];
	assertEquals(loadConfig({ TTK_BROWSER_ARGS: args.join(',') }).browser.args, args);
	assertEquals(loadConfig({ TTK_BROWSER_ARGS: ` ${args[0]} , ${args[1]} ` }).browser.args, args.slice(0, 2));
	assertEquals(loadConfig({}).browser.args, []);
});

Deno.test('TTK_CHROMIUM_NO_SANDBOX defaults to a sandboxed Chromium and parses as a strict boolean', () => {
	for (
		const [value, sandboxed] of [[undefined, true], ['', true], ['false', true], ['true', false], ['1', false]] as const
	) {
		const env = value === undefined ? {} : { TTK_CHROMIUM_NO_SANDBOX: value };
		assertEquals(loadConfig(env).browser.chromiumSandbox, sandboxed, String(value));
	}
	assertThrows(() => loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'sometimes' }), ConfigError, 'TTK_CHROMIUM_NO_SANDBOX');
	// Setting it is how --no-sandbox is reached; spelling the switch is refused alongside it.
	assertThrows(
		() => loadConfig({ TTK_CHROMIUM_NO_SANDBOX: 'true', TTK_BROWSER_ARGS: '--no-sandbox' }),
		ConfigError,
		'--no-sandbox',
	);
});

Deno.test('TTK_ALLOWED_DOMAINS_SCOPE defaults to documents, is case-insensitive, and all needs a list', () => {
	const domains = { TTK_ALLOWED_DOMAINS: 'example.com' };
	for (const env of [{}, { TTK_ALLOWED_DOMAINS_SCOPE: '' }, domains, { TTK_ALLOWED_DOMAINS_SCOPE: 'Documents' }]) {
		assertEquals(loadConfig(env).allowedDomainsScope, 'documents');
	}
	for (const spelling of ['all', 'ALL', ' All ', '\tall']) {
		assertEquals(loadConfig({ ...domains, TTK_ALLOWED_DOMAINS_SCOPE: spelling }).allowedDomainsScope, 'all', spelling);
	}
	for (const other of ['any', 'none', 'subresources', 'documents,all', 'true']) {
		assertThrows(() => loadConfig({ ...domains, TTK_ALLOWED_DOMAINS_SCOPE: other }), ConfigError, 'documents|all');
	}
	for (const empty of [{}, { TTK_ALLOWED_DOMAINS: '' }, { TTK_ALLOWED_DOMAINS: ' , ,' }]) {
		const error = assertThrows(() => loadConfig({ ...empty, TTK_ALLOWED_DOMAINS_SCOPE: 'all' }), ConfigError);
		assertEquals(error.message, 'TTK_ALLOWED_DOMAINS_SCOPE: all needs a non-empty TTK_ALLOWED_DOMAINS');
	}
});

Deno.test('TTK_SIGNED_LINK_TTL_S accepts 10–3600, defaults to 3600, and refuses 3601', () => {
	// A generated link key is sealed in the vault, so the data directory needs the vault's key.
	const on = (ttl?: string) =>
		loadConfig({
			TTK_SIGNED_LINKS: 'true',
			TTK_DATA_DIR: '/data',
			...(ttl === undefined ? {} : { TTK_SIGNED_LINK_TTL_S: ttl }),
		}, { secrets: { TTK_DB_KEY: generateDbKey() } }).signedLinks?.ttlS;
	assertEquals([on(), on('10'), on('3600')], [3600, 10, 3600]);
	for (const ttl of ['9', '3601', '86400']) {
		assertThrows(() => on(ttl), ConfigError, 'TTK_SIGNED_LINK_TTL_S: expected an integer in [10, 3600]');
	}
});
