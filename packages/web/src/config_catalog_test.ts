/// <reference lib="deno.ns" />
/**
 * The settings catalogue against its source of truth, `docs/reference/environment-variables.md`:
 * every `TTK_*` the page's tables document appears in the catalogue exactly
 * once, nothing test-only or credential-bearing does, and the readers and reach rules behave as the Configuration
 * panel relies on.
 */
import { assert, assertEquals } from '@std/assert';
import {
	booleanOf,
	derivedDefault,
	isLoopbackHost,
	readingSource,
	reportedSettings,
	runningValue,
	SECTION_WORDS,
	SECTIONS,
	settingOf,
	SETTINGS,
	sourceOf,
	widensReach,
} from './config_catalog.ts';

const DOC = new URL('../../../docs/reference/environment-variables.md', import.meta.url);

/** The variables each `## ` section of the reference page documents in its tables, by section heading. */
async function documentedNames(): Promise<Map<string, Set<string>>> {
	const text = await Deno.readTextFile(DOC);
	const sections = new Map<string, Set<string>>();
	let heading = '';
	for (const line of text.split('\n')) {
		if (line.startsWith('## ')) {
			heading = line.slice(3).trim();
			continue;
		}
		// A table row whose first cell names variables in backticks: `TTK_API_KEYS` / `TTK_API_KEYS_FILE`.
		if (!line.startsWith('| `')) continue;
		const cell = line.split('|')[1] ?? '';
		const names = sections.get(heading) ?? new Set<string>();
		for (const [, name = ''] of cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) names.add(name);
		sections.set(heading, names);
	}
	return sections;
}

Deno.test('config catalogue: every TTK_* the reference page documents appears exactly once', async () => {
	const documented = await documentedNames();
	// The server's, the sandbox service's and Compose's variables; not the browser layer's, not the test-only ones.
	const excluded = new Set(['Browser-layer variables', 'Test-only variables']);
	const expected = new Set<string>();
	for (const [heading, names] of documented) {
		if (excluded.has(heading)) continue;
		for (const name of names) if (name.startsWith('TTK_')) expected.add(name);
	}
	assert(expected.size > 60, `the page documents ${expected.size} TTK_* variables`);
	const names = SETTINGS.map((setting) => setting.name);
	assertEquals(names.length, new Set(names).size, 'no variable is catalogued twice');
	const catalogued = new Set(names.filter((name) => name.startsWith('TTK_')));
	assertEquals([...expected].filter((name) => !catalogued.has(name)), [], 'documented but not catalogued');
	// The providers file may be catalogued without its reference-page row; nothing else may.
	const extra = [...catalogued].filter((name) => !expected.has(name));
	assertEquals(extra, expected.has('TTK_MODEL_PROVIDERS_FILE') ? [] : ['TTK_MODEL_PROVIDERS_FILE']);
});

Deno.test('config catalogue: no OTEL_* name is a row, and no test-only name is', async () => {
	const documented = await documentedNames();
	// OpenTelemetry export is not a feature of this server: nothing in the catalogue configures it.
	assertEquals(SETTINGS.filter((setting) => /OTEL/.test(setting.name)), []);
	// The test-only table names a model key variable; the catalogue must never hold it.
	const testOnly = documented.get('Test-only variables') ?? new Set<string>();
	assert(testOnly.has('TTK_MODEL_API_KEY'), 'the page lists TTK_MODEL_API_KEY as test-only');
	assertEquals([...testOnly].filter((name) => settingOf(name) !== undefined), []);
	assertEquals(SETTINGS.filter((setting) => /API_KEY$|OPENAI|ANTHROPIC/.test(setting.name)), []);
});

Deno.test('config catalogue: sections are the reference page’s, in order, each with words', () => {
	assertEquals<readonly string[]>(SECTIONS, Object.keys(SECTION_WORDS));
	for (const section of SECTIONS) {
		assert(SECTION_WORDS[section] !== '', section);
		assert(SETTINGS.some((setting) => setting.section === section), `${section} has entries`);
	}
	// The catalogue is in section order, so the panel's groups follow the page.
	const order = SETTINGS.map((setting) => SECTIONS.indexOf(setting.section));
	assertEquals(order, [...order].sort((a, b) => a - b));
	for (const setting of SETTINGS) {
		assert(setting.explain.endsWith('.'), `${setting.name}: one sentence`);
		if (setting.secret) assertEquals(setting.kind, 'text', `${setting.name}: an inline secret is text`);
	}
});

Deno.test('config catalogue: inline secrets and file-backed paths are told apart', () => {
	assertEquals(SETTINGS.filter((setting) => setting.secret).map((setting) => setting.name), [
		'TTK_API_KEYS',
		'TTK_ADMIN_USER',
		'TTK_SECRETS',
	]);
	const files = SETTINGS.filter((setting) => setting.kind === 'secret-file').map((setting) => setting.name);
	for (const name of files) assert(/_FILE$/.test(name), name);
	for (const name of ['TTK_API_KEYS_FILE', 'TTK_SANDBOX_TOKEN_FILE', 'TTK_MODEL_PROVIDERS_FILE']) {
		assert(files.includes(name), name);
	}
	// A CA certificate is a file, not a secret.
	assertEquals(settingOf('TTK_SECRET_PROVIDER_CA_FILE')?.kind, 'path');
});

Deno.test('config catalogue: which values widen reach', () => {
	const host = settingOf('TTK_HOST')!;
	assertEquals(widensReach(host, '127.0.0.1'), false);
	assertEquals(widensReach(host, 'localhost'), false);
	assertEquals(widensReach(host, '[::1]'), false);
	assertEquals(widensReach(host, '0.0.0.0'), true);
	assertEquals(widensReach(host, '192.168.1.14'), true);
	assertEquals(widensReach(host, undefined), false);
	const publicUrl = settingOf('TTK_PUBLIC_URL')!;
	assertEquals(widensReach(publicUrl, 'http://127.0.0.1:8787'), false);
	assertEquals(widensReach(publicUrl, 'http://192.168.1.14:8787'), true);
	assertEquals(widensReach(settingOf('TTK_ALLOWED_ORIGINS')!, 'app.example.com'), true);
	assertEquals(widensReach(settingOf('TTK_ALLOWED_ORIGINS')!, ''), false);
	assertEquals(widensReach(settingOf('TTK_SIGNED_LINKS')!, 'true'), true);
	assertEquals(widensReach(settingOf('TTK_SIGNED_LINKS')!, 'off'), false);
	assertEquals(widensReach(settingOf('TTK_MCP_APPS')!, 'off'), false);
	assertEquals(widensReach(settingOf('TTK_MCP_APPS')!, 'watch'), true);
	assertEquals(widensReach(settingOf('TTK_SANDBOX_BACKEND')!, 'bwrap'), false);
	assertEquals(widensReach(settingOf('TTK_SANDBOX_BACKEND')!, 'docker'), true);
	assertEquals(widensReach(settingOf('TTK_MODEL_PROVIDERS_FILE')!, '/run/secrets/ttk_model_providers'), true);
	assertEquals(widensReach(settingOf('TTK_CHROMIUM_NO_SANDBOX')!, 'yes'), true);
	// A narrowing allowlist is not reach.
	assertEquals(widensReach(settingOf('TTK_ALLOWED_DOMAINS')!, 'example.com'), false);
	assertEquals(widensReach(settingOf('TTK_LOG_LEVEL')!, 'debug'), false);
	assertEquals(isLoopbackHost('127.0.0.8'), true);
	assertEquals(booleanOf('On'), true);
	assertEquals(booleanOf('maybe'), undefined);
});

const RUNNING = {
	version: '0.2.0',
	config: {
		host: '0.0.0.0',
		port: 8787,
		publicUrl: 'http://192.168.1.14:8787',
		allowedDomains: ['example.com'],
		allowedDomainsScope: 'documents',
		allowedOrigins: [],
		apiKeysCount: 2,
		hasAdminUser: true,
		egressEnabled: false,
		persistenceEnabled: true,
		recordingEnabled: false,
		sandboxEnabled: false,
		chromiumSandboxed: true,
		sessionOwnership: 'owner',
		mcpApps: 'off',
		signedLinks: false,
		confirmations: true,
		humanHandoff: { enabled: false },
		secretProvider: null,
		sandboxClone: false,
		modelProviders: [{ id: 'openai-main', kind: 'openai', models: 1, reachable: false }],
		modelProvidersFile: false,
		diskBudgetMb: 2048,
		builtinAgent: false,
	},
};

Deno.test('config catalogue: running values read defensively — words, faithful values, "not reported"', () => {
	const config = RUNNING.config;
	const read = (name: string) => runningValue(settingOf(name)!, config, RUNNING);
	assertEquals(read('TTK_HOST'), { kind: 'reading', reading: { text: '0.0.0.0', value: '0.0.0.0' } });
	assertEquals(read('TTK_PORT'), { kind: 'reading', reading: { text: '8787', value: '8787' } });
	assertEquals(read('TTK_ALLOWED_DOMAINS'), {
		kind: 'reading',
		reading: { text: 'example.com', value: 'example.com' },
	});
	// An empty origins list means the derived list is in force: words, no value to seed from.
	assertEquals(read('TTK_ALLOWED_ORIGINS'), { kind: 'reading', reading: { text: 'derived' } });
	// Facts that only say whether a variable is in use.
	assertEquals(read('TTK_API_KEYS_FILE'), { kind: 'reading', reading: { text: '2 keys', set: true } });
	assertEquals(read('TTK_ADMIN_USER_FILE'), { kind: 'reading', reading: { text: 'configured', set: true } });
	assertEquals(read('TTK_DATA_DIR'), { kind: 'reading', reading: { text: 'configured', set: true } });
	// Inverted: the sandbox fact is on, so the variable that turns it off reads false.
	assertEquals(read('TTK_CHROMIUM_NO_SANDBOX'), { kind: 'reading', reading: { text: 'false', value: 'false' } });
	assertEquals(read('TTK_SESSION_OWNERSHIP'), { kind: 'reading', reading: { text: 'owner', value: 'owner' } });
	assertEquals(read('TTK_MCP_APPS'), { kind: 'reading', reading: { text: 'off', value: 'off' } });
	assertEquals(read('TTK_HUMAN_HANDOFF'), { kind: 'reading', reading: { text: 'false', value: 'false' } });
	assertEquals(read('TTK_API_KEYS_REF'), { kind: 'reading', reading: { text: 'none', set: false } });
	// A provider added in the web app is in force, but no providers file is named.
	assertEquals(read('TTK_MODEL_PROVIDERS_FILE'), { kind: 'reading', reading: { text: 'not set', set: false } });
	assertEquals(read('TTK_DISK_BUDGET_MB'), { kind: 'reading', reading: { text: '2048 MiB', value: '2048' } });
	// No fact maps to it; a fact the gateway omits; a fact of the wrong shape.
	assertEquals(read('TTK_LOG_FORMAT'), { kind: 'none' });
	assertEquals(runningValue(settingOf('TTK_HOST')!, {}, {}), { kind: 'not-reported' });
	assertEquals(runningValue(settingOf('TTK_PORT')!, { port: 'eight' }, {}), { kind: 'not-reported' });
	// Every reported setting names a key the fixture carries or a gateway may omit; none is secret.
	for (const setting of reportedSettings()) assert(!setting.secret, setting.name);
});

Deno.test('config catalogue: the source tag — set, default or derived', () => {
	const config = RUNNING.config;
	assertEquals(sourceOf(settingOf('TTK_HOST')!, '0.0.0.0', config), 'set');
	assertEquals(sourceOf(settingOf('TTK_HOST')!, '127.0.0.1', config), 'default');
	assertEquals(sourceOf(settingOf('TTK_PORT')!, '8787', config), 'default');
	assertEquals(derivedDefault(settingOf('TTK_PUBLIC_URL')!, config), 'http://0.0.0.0:8787');
	assertEquals(
		derivedDefault(settingOf('TTK_PUBLIC_URL')!, { host: '127.0.0.1', port: 9000 }),
		'http://127.0.0.1:9000',
	);
	assertEquals(sourceOf(settingOf('TTK_PUBLIC_URL')!, 'http://0.0.0.0:8787', config), 'derived');
	assertEquals(sourceOf(settingOf('TTK_PUBLIC_URL')!, 'http://192.168.1.14:8787', config), 'set');
	assertEquals(sourceOf(settingOf('TTK_ALLOWED_ORIGINS')!, undefined, config), 'derived');
	assertEquals(readingSource(settingOf('TTK_API_KEYS_FILE')!, { text: '2 keys', set: true }, config), 'set');
	assertEquals(readingSource(settingOf('TTK_ALLOWED_ORIGINS')!, { text: 'derived' }, config), undefined);
});

Deno.test('config catalogue: the default-on switches tag their deployment-shaped defaults as derived', () => {
	const single = { persistenceEnabled: true };
	const keyless = { persistenceEnabled: false };
	const apps = settingOf('TTK_MCP_APPS')!;
	const links = settingOf('TTK_SIGNED_LINKS')!;
	for (const setting of [apps, links]) {
		assertEquals(setting.derived, true, setting.name);
		assertEquals(sourceOf(setting, undefined, single), 'derived', `${setting.name} unset`);
	}
	// Control, and links wherever a data directory holds the generated key.
	assertEquals(derivedDefault(apps, single), 'control');
	assertEquals(sourceOf(apps, 'control', single), 'derived');
	assertEquals(sourceOf(apps, 'watch', single), 'set');
	assertEquals(sourceOf(links, 'true', single), 'derived');
	assertEquals(sourceOf(links, 'false', single), 'set');
	assertEquals(sourceOf(links, 'false', keyless), 'derived');
	// Facts the gateway omits derive nothing, so a reading tags "set" rather than a guess.
	assertEquals(derivedDefault(links, {}), undefined);
	// Session ownership is a plain default: owner.
	const ownership = settingOf('TTK_SESSION_OWNERSHIP')!;
	assertEquals(ownership.default, 'owner');
	assertEquals(sourceOf(ownership, 'owner', single), 'default');
	assertEquals(sourceOf(ownership, 'shared', single), 'set');
	// The handoff is a plain default: on.
	const handoff = settingOf('TTK_HUMAN_HANDOFF')!;
	assertEquals(handoff.default, 'true');
	assertEquals(sourceOf(handoff, 'true', single), 'default');
	assertEquals(sourceOf(handoff, 'false', single), 'set');
});
