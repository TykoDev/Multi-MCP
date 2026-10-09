/// <reference lib="deno.ns" />
/**
 * The configuration composer's generators (run model-providers-ui, frontend §7 item 7, design §4): pure, never a
 * request, never a key. For every preset the `.env` block carries no inline secret and only paths for file-backed
 * entries; a providers file carries `REPLACE_WITH_KEY` or an `api_key_file` path and never anything shaped like a
 * key; the Compose override never restates the bundled image's argv (D-151: its net grant is unscoped) and names the
 * provider hosts in a comment; the diff lists only what differs and says "cannot compare" where the diagnostics are
 * silent.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { settingOf, SETTINGS } from './config_catalog.ts';
import {
	applyPreset,
	composeCompose,
	composeEnv,
	composeOutputs,
	composeProvidersFile,
	diffAgainstRunning,
	KEY_MODES,
	KEY_PLACEHOLDER,
	needsAllowHttp,
	PRESETS,
	PROVIDER_PRESETS,
	type ProviderDraft,
	providerHost,
	providerHosts,
	providerKey,
	PROVIDERS_SECRET_PATH,
} from './config_composer.ts';

/** Anything shaped like a provider key. */
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{6,}|\bsk-ant-|\bBearer\s+\S/;

Deno.test('config composer (G4): the module makes no request and touches no document', async () => {
	const code = await Deno.readTextFile(new URL('./config_composer.ts', import.meta.url));
	for (
		const forbidden of [/fetch/, /api\./, /\.\/api\.ts/, /mcp\./, /document/, /el\(/, /XMLHttpRequest|WebSocket/]
	) {
		assert(!forbidden.test(code), `config_composer.ts references ${forbidden}`);
	}
	assertEquals(code.match(/^import\b.*$/gm)?.map((line) => line.trim()), ['import {']);
	assertStringIncludes(code, "} from './config_catalog.ts';");
});

Deno.test('config composer: the presets, their exact keys, and that none proposes a secret value', () => {
	assertEquals(PRESETS.map((preset) => [preset.id, Object.keys(preset.values).sort()]), [
		['loopback', ['TTK_HOST', 'TTK_LOG_FORMAT']],
		['lan', ['TTK_ALLOWED_ORIGINS', 'TTK_API_KEYS_FILE', 'TTK_BIND', 'TTK_HOST', 'TTK_PUBLIC_URL']],
		['cluster-edge', [
			'TTK_CLUSTER_KV',
			'TTK_MCP_APPS',
			'TTK_NODE_ID',
			'TTK_ROLE',
			'TTK_SESSION_OWNERSHIP',
			'TTK_SIGNED_LINKS',
		]],
		['agents-sandbox', [
			'TTK_AGENT_BRIDGE_TOKEN_FILE',
			'TTK_AGENT_BRIDGE_URL',
			'TTK_DATA_DIR',
			'TTK_SANDBOX_TOKEN_FILE',
			'TTK_SANDBOX_URL',
		]],
		['model-providers', ['TTK_MODEL_PROVIDERS_FILE']],
		['running', []],
	]);
	for (const preset of PRESETS) {
		for (const [name, value] of Object.entries(preset.values)) {
			const setting = settingOf(name);
			assert(setting !== undefined, `${preset.id}: ${name} is catalogued`);
			assert(!setting.secret, `${preset.id}: ${name} is an inline secret`);
			if (setting.kind === 'secret-file') assert(value.startsWith('/run/secrets/'), `${preset.id}: ${name}=${value}`);
			assert(!KEY_SHAPED.test(value), `${preset.id}: ${name} looks like a key`);
		}
	}
	assertEquals(
		PRESETS.find((preset) => preset.id === 'model-providers')?.values.TTK_MODEL_PROVIDERS_FILE,
		PROVIDERS_SECRET_PATH,
	);
	assertEquals(PRESETS.find((preset) => preset.id === 'model-providers')?.providers?.map((draft) => draft.id), [
		'openai-main',
	]);
	// A preset is applied over the running seed; "Start from running" is the seed alone.
	assertEquals(applyPreset({ TTK_HOST: '0.0.0.0', TTK_PORT: '9000' }, PRESETS[0]!), {
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '9000',
		TTK_LOG_FORMAT: 'pretty',
	});
	assertEquals(applyPreset({ TTK_HOST: '0.0.0.0' }, PRESETS[5]!), { TTK_HOST: '0.0.0.0' });
});

Deno.test('config composer: for each preset, the .env block carries no value from a secret entry', () => {
	const secrets = SETTINGS.filter((setting) => setting.secret).map((setting) => setting.name);
	assertEquals(secrets.length, 3);
	for (const preset of PRESETS) {
		// Even with an inline secret smuggled into the values, the block carries a comment, never the value.
		const env = composeEnv({ ...applyPreset({}, preset), TTK_API_KEYS: '[{"id":"k","sha256":"abc"}]' });
		for (const name of secrets) assert(!new RegExp(`^${name}=`, 'm').test(env), `${preset.id}: ${name}= in .env`);
		assert(!env.includes('abc'), `${preset.id}: the inline secret's value leaked`);
		assertStringIncludes(env, '# TTK_API_KEYS: an inline secret is never written here; use TTK_API_KEYS_FILE.');
		assert(!KEY_SHAPED.test(env), `${preset.id}: a key-shaped string in .env`);
		for (const [name, value] of Object.entries(preset.values)) assertStringIncludes(env, `${name}=${value}`);
	}
	// Catalogue order, quoting only what needs it, unknown upper-case names after the catalogue's.
	const env = composeEnv({ ZZZ_EXTRA: 'x', TTK_LOG_LEVEL: 'debug', TTK_HOST: '0.0.0.0', TTK_MCP_APPS_DOMAIN: 'a b#c' });
	assertEquals(env.split('\n').filter((line) => line !== '' && !line.startsWith('#')), [
		'TTK_HOST=0.0.0.0',
		"TTK_MCP_APPS_DOMAIN='a b#c'",
		'TTK_LOG_LEVEL=debug',
		'ZZZ_EXTRA=x',
	]);
});

Deno.test('config composer: the providers file carries REPLACE_WITH_KEY or a file path, never a key', () => {
	for (const preset of PROVIDER_PRESETS) {
		const text = composeProvidersFile([preset.draft]);
		const file = JSON.parse(text) as { version: number; default?: string; providers: Record<string, unknown>[] };
		assertEquals(file.version, 1);
		assertEquals(file.default, preset.draft.id);
		assertEquals(file.providers.length, 1);
		const entry = file.providers[0]!;
		const keyed = entry.api_key === KEY_PLACEHOLDER || typeof entry.api_key_file === 'string';
		if (preset.draft.key.mode === 'none') assert(!('api_key' in entry) && !('api_key_file' in entry), preset.id);
		else assert(keyed, `${preset.id}: a placeholder or a file path`);
		assert(!KEY_SHAPED.test(text), `${preset.id}: looks like a key`);
		// Only the schema's own members: nothing that could carry a key by another name.
		const allowed = [
			'id',
			'kind',
			'base_url',
			'models',
			'default_model',
			'api_key',
			'api_key_file',
			'allow_http',
			'max_tokens_param',
		];
		assertEquals(Object.keys(entry).filter((key) => !allowed.includes(key)), []);
	}
	// Design §3.12: the OpenAI preset names the newer output-token parameter; local servers leave the default.
	const openai = JSON.parse(composeProvidersFile([PROVIDER_PRESETS[0]!.draft])).providers[0];
	assertEquals(openai.max_tokens_param, 'max_completion_tokens');
	assertEquals(openai.base_url, 'https://api.openai.com/v1');
	const ollama = JSON.parse(composeProvidersFile([PROVIDER_PRESETS[2]!.draft])).providers[0];
	assertEquals(ollama.max_tokens_param, undefined);
	assertEquals(ollama.allow_http, undefined, 'loopback http needs no flag (C2 ii)');
	// No Azure preset (design §3.12); custom remains.
	assertEquals(PROVIDER_PRESETS.map((preset) => preset.id), [
		'openai',
		'anthropic',
		'ollama',
		'vllm',
		'openrouter',
		'custom',
	]);
	// A private http host is admitted with the flag (C2 iii); a key file path is kept, an empty one defaulted.
	const draft: ProviderDraft = {
		id: 'ollama-lan',
		kind: 'openai',
		baseUrl: 'http://ollama:11434/v1/',
		models: ['llama3.1', 'qwen3'],
		defaultModel: 'qwen3',
		key: providerKey('file', ''),
	};
	const lan = JSON.parse(composeProvidersFile([draft, PROVIDER_PRESETS[1]!.draft]));
	assertEquals(lan.default, 'ollama-lan');
	assertEquals(lan.providers[0], {
		id: 'ollama-lan',
		kind: 'openai',
		base_url: 'http://ollama:11434/v1',
		models: ['llama3.1', 'qwen3'],
		default_model: 'qwen3',
		api_key_file: '/run/secrets/ollama-lan_key',
		allow_http: true,
	});
	assertEquals(lan.providers[1].api_key, KEY_PLACEHOLDER);
	assertEquals(
		JSON.parse(composeProvidersFile([{ ...draft, key: providerKey('file', '/run/secrets/k') }])).providers[0]
			.api_key_file,
		'/run/secrets/k',
	);
	assertEquals(needsAllowHttp('http://127.0.0.1:8000/v1'), false);
	assertEquals(needsAllowHttp('http://10.0.0.5:8000/v1'), true);
	assertEquals(needsAllowHttp('https://api.openai.com/v1'), false);
	assertEquals(composeProvidersFile([]), '{\n  "version": 1,\n  "providers": []\n}\n');
	// The key modes the drawer offers, and that an unknown choice is the placeholder.
	assertEquals(KEY_MODES.map((mode) => mode.id), ['placeholder', 'file', 'none']);
	assertEquals(providerKey('whatever', '/x'), { mode: 'placeholder' });
	assertEquals(providerKey('none', '/x'), { mode: 'none' });
});

Deno.test('config composer: provider hosts for the net grant — host:port by scheme, no repeats, no loopback', () => {
	assertEquals(providerHost('https://api.openai.com/v1'), 'api.openai.com:443');
	assertEquals(providerHost('http://ollama:11434/v1'), 'ollama:11434');
	assertEquals(providerHost('http://vllm.internal/v1'), 'vllm.internal:80');
	assertEquals(providerHost('not a url'), undefined);
	assertEquals(providerHost('ftp://x'), undefined);
	assertEquals(
		providerHosts([
			PROVIDER_PRESETS[0]!.draft,
			PROVIDER_PRESETS[1]!.draft,
			PROVIDER_PRESETS[0]!.draft,
			PROVIDER_PRESETS[2]!.draft,
			{ ...PROVIDER_PRESETS[5]!.draft, baseUrl: '' },
		]),
		['api.openai.com:443', 'api.anthropic.com:443'],
	);
});

/**
 * D-151: the bundled image's `CMD` grants an unscoped `--allow-net`, so the override never restates it — a restated
 * argv could only narrow the grant, and one naming the provider hosts would lose `sandbox:8080`, which the base
 * compose file now runs. The hosts are named in a comment.
 */
Deno.test('config composer: the Compose override — environment and secrets only, never the command', async () => {
	const dockerfile = await Deno.readTextFile(new URL('../../../Dockerfile', import.meta.url));
	assertStringIncludes(dockerfile, '\t"--allow-net", \\\n', 'the image grants unscoped net, so nothing is restated');
	const values = {
		TTK_HOST: '0.0.0.0',
		TTK_PUBLIC_URL: 'http://192.168.1.14:8787',
		TTK_API_KEYS_FILE: '/run/secrets/ttk_api_keys',
		TTK_MODEL_PROVIDERS_FILE: PROVIDERS_SECRET_PATH,
		TTK_SECRETS_FILE: '/run/secrets/ttk_secrets',
		TTK_BIND: '0.0.0.0',
		TTK_SANDBOX_BACKEND: 'docker',
		TTK_API_KEYS: 'never',
	};
	const hosts = providerHosts([PROVIDER_PRESETS[0]!.draft, PROVIDER_PRESETS[1]!.draft]);
	const compose = composeCompose(values, hosts);
	assert(!/^\s+command:/m.test(compose), 'no command override, with provider hosts or without');
	assertStringIncludes(
		compose,
		"    # command: unchanged — the image's CMD grants outbound net (D-151); restate it only to scope it back.\n",
	);
	assertStringIncludes(
		compose,
		'    # The providers file has the gateway dial: api.openai.com:443, api.anthropic.com:443.\n',
	);
	// Environment: the server's settings, quoted; never an inline secret; Compose's and the sandbox service's left out.
	assertStringIncludes(compose, "      TTK_HOST: '0.0.0.0'\n");
	assertStringIncludes(compose, `      TTK_MODEL_PROVIDERS_FILE: '${PROVIDERS_SECRET_PATH}'\n`);
	assert(!compose.includes('TTK_API_KEYS:'), 'an inline secret is never set');
	assert(!compose.includes('never'));
	assert(!compose.includes('TTK_BIND:'), 'TTK_BIND is interpolated from .env');
	assert(!compose.includes('TTK_SANDBOX_BACKEND'), 'the sandbox service has its own settings');
	// Secrets: the two the image mounts, plus each /run/secrets path named, with a top-level source for the extras.
	assertStringIncludes(compose, '    secrets: [ttk_api_keys, ttk_admin_user, ttk_secrets, ttk_model_providers]\n');
	assertStringIncludes(
		compose,
		'secrets:\n  ttk_secrets:\n    file: ./secrets/ttk_secrets.json\n  ttk_model_providers:\n    file: ./secrets/ttk_model_providers.json\n',
	);
	// Without providers there is no hosts line; another port is an environment value, never a restated grant.
	const plain = composeCompose({ TTK_HOST: '127.0.0.1' }, []);
	assert(!plain.includes('command: ['), 'no command override');
	assert(!plain.includes('The providers file'), 'no hosts line without providers');
	assertStringIncludes(plain, '    secrets: [ttk_api_keys, ttk_admin_user]\n');
	const port = composeCompose({ TTK_PORT: '9000' }, []);
	assertStringIncludes(port, "      TTK_PORT: '9000'\n");
	assert(!/^\s+command:/m.test(port), 'another port needs no grant: the unscoped one covers the bind');
	// The sandbox preset names the generated token (D-151), which mounts no compose secret of its own.
	const sandboxPreset = PRESETS.find((preset) => preset.id === 'agents-sandbox')!;
	assertEquals(sandboxPreset.values.TTK_SANDBOX_TOKEN_FILE, '/run/secrets/ttk-sandbox-token/token');
	assertStringIncludes(
		composeCompose(sandboxPreset.values, []),
		'    secrets: [ttk_api_keys, ttk_admin_user, ttk_agent',
	);
	assertStringIncludes(composeCompose({}, []), '    environment:\n      {}\n');
	assert(!KEY_SHAPED.test(compose));
});

const RUNNING = {
	config: {
		host: '127.0.0.1',
		port: 8787,
		publicUrl: 'http://127.0.0.1:8787',
		allowedDomains: [],
		allowedDomainsScope: 'documents',
		allowedOrigins: [],
		apiKeysCount: 0,
		hasAdminUser: false,
		oauthEnabled: false,
		egressEnabled: false,
		persistenceEnabled: false,
		recordingEnabled: false,
		sandboxEnabled: false,
		clusterMode: 'all',
		telemetry: false,
	},
};

Deno.test('config composer: the diff lists only differing keys and marks unreported ones "cannot compare"', () => {
	const rows = diffAgainstRunning({
		TTK_HOST: '0.0.0.0',
		TTK_PORT: '8787',
		TTK_PUBLIC_URL: 'http://127.0.0.1:8787',
		TTK_LOG_FORMAT: 'pretty',
		OTEL_DENO: 'off',
		TTK_ALLOWED_DOMAINS: '',
		TTK_ROLE: 'edge',
		CUSTOM_X: '1',
	}, RUNNING);
	assertEquals(rows, [
		{ key: 'TTK_HOST', before: '127.0.0.1', after: '0.0.0.0', compare: 'differs', reach: true },
		{ key: 'TTK_LOG_FORMAT', after: 'pretty', compare: 'cannot compare', reach: false },
		{ key: 'TTK_ROLE', before: 'all', after: 'edge', compare: 'differs', reach: false },
		{ key: 'CUSTOM_X', after: '1', compare: 'cannot compare', reach: false },
	]);
	// A reported key the gateway omits (an older gateway) cannot be compared either.
	assertEquals(diffAgainstRunning({ TTK_HOST: '0.0.0.0' }, { config: {} }), [
		{ key: 'TTK_HOST', after: '0.0.0.0', compare: 'cannot compare', reach: true },
	]);
	// Equal by meaning: booleans in any spelling, lists without spacing.
	assertEquals(diffAgainstRunning({ OTEL_DENO: 'FALSE', TTK_ALLOWED_DOMAINS: ' ' }, RUNNING), []);
	assertEquals(
		diffAgainstRunning({ TTK_ALLOWED_DOMAINS: 'a.test, b.test' }, { config: { allowedDomains: ['a.test', 'b.test'] } }),
		[],
	);
	assertEquals(diffAgainstRunning({}, RUNNING), []);
});

Deno.test('config composer: the four outputs from a form read-back', () => {
	const outputs = composeOutputs(
		{ TTK_HOST: '0.0.0.0', TTK_PORT: 8787, TTK_HEADLESS: true, TTK_MODEL_PROVIDERS_FILE: PROVIDERS_SECRET_PATH },
		[PROVIDER_PRESETS[0]!.draft],
		RUNNING,
	);
	assertStringIncludes(outputs.env, 'TTK_HEADLESS=true\n');
	assertStringIncludes(outputs.compose, 'api.openai.com:443');
	assertStringIncludes(outputs.providersFile, KEY_PLACEHOLDER);
	assertEquals(outputs.diff.map((row) => [row.key, row.compare]), [
		['TTK_HOST', 'differs'],
		['TTK_HEADLESS', 'cannot compare'],
		['TTK_MODEL_PROVIDERS_FILE', 'cannot compare'],
	]);
	for (const text of [outputs.env, outputs.compose, outputs.providersFile]) assert(!KEY_SHAPED.test(text));
});
