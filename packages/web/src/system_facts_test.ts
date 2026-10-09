/// <reference lib="deno.ns" />
/**
 * The System screen's capability tiles for the mcp-recommendations features (design §5): every key is read
 * defensively — absent is unknown, never "off" — and each tile's glyph is one the sprite already carries.
 *
 * Run containment-otel-links: no glyph appears twice in the System content area (FXD-N1, D-092 amended), the tiles
 * are tab stops with a focus ring (RV-13), and the Network panel reads the telemetry collectors and the domain
 * allowlist's scope (D-137, D-138), "not reported" when a gateway omits them. Real Chromium checks the painted screen
 * in `tests/e2e/ownership_e2e_test.ts`.
 *
 * D-149: the screen is three page tabs; every tile says what it does and how to turn it on, the withheld tools are
 * grouped by reason, an empty domain allowlist reads "Any site", and the Configuration tab filters its rows.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { CUSTOM_ICONS, type IconName, ICONS } from './icon_names.ts';
import {
	browserReach,
	CAPABILITY_FACTS_LABELS,
	CAPABILITY_FACTS_OMIT,
	CAPABILITY_GROUPS,
	CAPABILITY_INFO,
	capabilityGroupOf,
	collectorsFact,
	configRowMatches,
	diagnosticsKey,
	domainsScopeTag,
	FACT_NOT_REPORTED,
	featureState,
	NOT_REPORTED,
	ownershipState,
	RECOMMENDATION_TILES,
	recommendationState,
	REPEATABLE_GLYPHS,
	SYSTEM_BAR_GLYPHS,
	SYSTEM_GLYPHS,
	systemTabOf,
	WITHHELD_WORDS,
	withheldGroups,
} from './system_facts.ts';

Deno.test('system facts: the eight design §5 tiles, in order, each with a glyph in the sprite', () => {
	// Four glyphs differ from design §5's table (RV-3): D-092 — no glyph repeated on one screen — outranks it.
	assertEquals(RECOMMENDATION_TILES.map((tile) => [tile.name, tile.glyph]), [
		['Session ownership', 'user-cog'],
		['MCP Apps', 'surface'],
		['Signed links', 'external'],
		['Confirmations', 'question'],
		['Human handoff', 'control'],
		['Secret provider', 'eye-off'],
		['OpenTelemetry', 'gauge'],
		['Git clone', 'revision'],
	]);
	assertEquals(RECOMMENDATION_TILES.map((tile) => tile.key), [
		'sessionOwnership',
		'mcpApps',
		'signedLinks',
		'confirmations',
		'humanHandoff',
		'secretProvider',
		'telemetry',
		'sandboxClone',
	]);
	const lucide = nodes as Record<string, unknown>;
	for (const tile of RECOMMENDATION_TILES) {
		const source: string = ICONS[tile.glyph];
		const drawn = source.startsWith('@') ? source.slice(1) in CUSTOM_ICONS : source in lucide;
		assert(drawn, `${tile.glyph} → ${source} is not in the sprite`);
	}
});

/** Every app icon name a source file spells as a quoted literal, with how often. */
async function iconLiteralsIn(file: string): Promise<Map<string, number>> {
	const code = await Deno.readTextFile(new URL(file, import.meta.url));
	const names = new Map<string, number>();
	for (const [, name = ''] of code.matchAll(/'([a-z][a-z0-9-]*)'/g)) {
		if (Object.hasOwn(ICONS, name)) names.set(name, (names.get(name) ?? 0) + 1);
	}
	return names;
}

Deno.test('system facts (FXD-N1, RV-3, D-092): no glyph is drawn twice in the System content area', () => {
	// Every glyph the content area draws, by what it names, plus the context bar's own tools above it. The dock is
	// excluded: it names the sections. Compared as Lucide glyphs, since two app names can share one.
	const drawn: Array<readonly [string, string]> = [
		...Object.entries(SYSTEM_GLYPHS).map(([role, name]) => [role, ICONS[name]] as const),
		...RECOMMENDATION_TILES.map((tile) => [tile.name, ICONS[tile.glyph]] as const),
		...SYSTEM_BAR_GLYPHS.map((name) => [`bar: ${name}`, ICONS[name]] as const),
		// The row actions may repeat among themselves, but nothing else may draw them.
		...REPEATABLE_GLYPHS.map((name) => [`row action: ${name}`, ICONS[name]] as const),
	];
	const owners = new Map<string, string[]>();
	for (const [role, glyph] of drawn) owners.set(glyph, [...owners.get(glyph) ?? [], role]);
	assertEquals([...owners].filter(([, roles]) => roles.length > 1).map(([glyph, roles]) => `${glyph}: ${roles}`), []);
	assertEquals(
		REPEATABLE_GLYPHS,
		['copy', 'x', 'edit', 'check', 'trash'],
		"copy, Remove on an overlay origin, and a provider card's Edit, Make default and Remove are the only repeats",
	);
});

Deno.test('system facts (FXD-N1): the System screen chooses its glyphs only through SYSTEM_GLYPHS', async () => {
	// A glyph spelled directly in the view would escape the table above. The literals left are the dock key the shell
	// highlights (`active: 'system'`; the dock is excluded), the Remove row action, and four words that are not glyphs
	// though the vocabulary has them: `radio`, the input type of the composer's preset tiles; `search`, the input type
	// of the Configuration tab's filter; `code`, the element a tile's setting is set in; and `tabs`, the shell option's
	// name in a type (D-149). Each is pinned to that one spelling so it never becomes a glyph.
	const literals = await iconLiteralsIn('./system_view.ts');
	// D-152: `agents` is the Agents tab's id twice (its page tab and its branch), a route word, never a glyph here.
	assertEquals(Object.fromEntries(literals), { system: 1, x: 1, radio: 1, search: 1, code: 1, tabs: 1, agents: 2 });
	const code = await Deno.readTextFile(new URL('./system_view.ts', import.meta.url));
	assertStringIncludes(code, "active: 'system'");
	assertStringIncludes(code, "iconButton('x', `Remove ${entry}`");
	assertStringIncludes(code, "type: 'radio',");
	assertStringIncludes(code, "type: 'search',");
	assertStringIncludes(code, "el('code', { text: info.enable })");
	assertStringIncludes(code, "NonNullable<ShellOptions['tabs']>");
	assertStringIncludes(code, "{ id: 'agents', label: 'Agents', glyph: G.tabAgents, route: '#/system/agents' }");
	assertStringIncludes(code, "} else if (tab === 'agents') {");
	for (const word of ['radio', 'search', 'code', 'tabs', 'agents']) {
		assert(!code.includes(`icon('${word}')`), `${word} is not a glyph`);
	}
	// Every role in the table is drawn by the view or its Agents tab (D-152), so the table is the screen, not a wish list.
	const agents = await Deno.readTextFile(new URL('./system_agents.ts', import.meta.url));
	assertEquals(
		Object.keys(SYSTEM_GLYPHS).filter((role) => !code.includes(`G.${role}`) && !agents.includes(`G.${role}`)),
		[],
	);
	// D-152: the Agents tab draws a glyph only through the table, or as a provider card's row action (Edit, Make
	// default; Remove is a confirm button's trash), so a card per provider repeats nothing else.
	assertEquals(
		[...new Set([...agents.matchAll(/\b(?:icon|iconButton)\('([a-z-]+)'/g)].map((match) => match[1]))].sort(),
		['check', 'edit'],
	);
	assert(!/\bempty\(/.test(agents), 'no illustration glyph in the Agents tab');
	// The tiles' state marks are drawn by the stylesheet, not a sprite glyph per tile (`flag()` draws one).
	assert(!/\bflag\(/.test(code), 'no flag() glyph in the capability tiles');
	assertStringIncludes(code, "stateMark(state.on ? 'on' : state.warnOff === true ? 'warn' : 'off', words)");
	// The context bar's tools are the ones SYSTEM_BAR_GLYPHS lists.
	const shell = await Deno.readTextFile(new URL('./shell.ts', import.meta.url));
	assertStringIncludes(shell, "[icon('search'), el('kbd'");
	// D-152: the theme picker draws the current theme's glyph, one of four.
	assertStringIncludes(shell, "dark: 'moon',\n\tshade: 'cloud-moon',\n\tlight: 'sun',\n\tdawn: 'sunrise',");
	const lucide = nodes as Record<string, unknown>;
	for (const name of Object.values(SYSTEM_GLYPHS) as IconName[]) {
		assert(ICONS[name] in lucide, `${name} → ${ICONS[name]} is in the sprite`);
	}
});

Deno.test('system facts (RV-13): every capability tile is a tab stop with a visible focus ring', async () => {
	const code = await Deno.readTextFile(new URL('./system_view.ts', import.meta.url));
	// The three shapes a tile takes — a value, an unreported fact, on/off — each carry tabindex 0.
	assertEquals([...code.matchAll(/el\('li', \{ class: [^\n]*sys-cap[^\n]*tabindex: 0,/g)].length, 3);
	const css = await Deno.readTextFile(new URL('./styles/screens/system.css', import.meta.url));
	assert(
		/\.sys-cap:focus-visible \{\s*outline: 2px solid var\(--wa-color-focus\);/.test(css),
		'a 2 px focus ring in the kit focus colour',
	);
});

Deno.test('system facts (run model-providers-ui, F11): the glyph table names the composer, configuration and raw', () => {
	// `rawCapabilities` and `diagnostics` left with the MCP panel's raw button and the collapsed details: the raw JSON
	// has one home, the Raw action (`braces`), and the configuration panel and composer have their own glyphs. The
	// model providers became rows of the Agents group (F-06), and rows draw no glyph, so `providers` left too.
	// D-149: the Configuration panel became the Configuration tab, whose glyph is the tab's (`tabConfig`).
	const roles = Object.keys(SYSTEM_GLYPHS);
	for (const role of ['composer', 'tabConfig', 'raw']) assert(roles.includes(role), role);
	assert(!roles.includes('providers'), 'the providers rows draw no glyph (F-06)');
	assert(!roles.includes('rawCapabilities'), 'no second raw button');
	assert(!roles.includes('diagnostics'), 'renamed to raw');
	assert(!roles.includes('configuration'), 'the panel became a tab (D-149)');
	assertEquals(SYSTEM_GLYPHS.composer, 'sliders');
	assertEquals(SYSTEM_GLYPHS.tabConfig, 'settings');
	assertEquals(SYSTEM_GLYPHS.raw, 'braces');
	// The capabilities facts leave out what the tiles, the tool access and the Events panel already show (C8, D-149),
	// and label what remains.
	assertEquals(CAPABILITY_FACTS_OMIT, ['version', 'sandbox', 'browser', 'sessions', 'tools_withheld', 'events']);
	assertEquals(CAPABILITY_FACTS_LABELS.model, 'Model providers');
});

Deno.test('system facts (run model-providers-ui, F6): the raw JSON has one home — the Raw modal with two tabs', async () => {
	const code = await Deno.readTextFile(new URL('./system_view.ts', import.meta.url));
	// No `pre.code.json` is drawn on the page itself: `jsonView` is called only by the Raw modal's documents and the
	// composer drawer's providers.json tab, both overlays opened by a bar action.
	const calls = [...code.matchAll(/jsonView\(/g)].length;
	assertEquals(calls, 2, 'jsonView: the raw document helper and the composer tab');
	assert(!code.includes('sys-diag'), 'the collapsed diagnostics details is gone');
	assert(!code.includes('Raw capabilities'), 'the MCP panel has no raw button');
	assertStringIncludes(code, "el('wa-tab', { panel: 'diagnostics', text: 'Diagnostics' })");
	assertStringIncludes(code, "el('wa-tab', { panel: 'capabilities', text: 'Capabilities' })");
	assertStringIncludes(code, "openModal('Raw', [tabs], true)");
	// The MCP panel shows the capabilities as facts, with the omit list from this module.
	assertStringIncludes(code, 'jsonFacts(caps, { omit: [...CAPABILITY_FACTS_OMIT]');
	// The two bar actions are hidden until the diagnostics answer (admin only), and the composer loads lazily.
	assertStringIncludes(code, 'rawAction.hidden = composeAction.hidden = true;');
	assertStringIncludes(code, "await import('./config_composer.ts')");
	assertStringIncludes(code, 'actions: [composeAction, rawAction]');
	// The composer never calls the API: the view's only requests are the diagnostics poll and the MCP panels.
	const composerBody = code.slice(code.indexOf('function openComposer('), code.indexOf('// --- the screen'));
	assert(!/api\.|mcp\.|fetch\(/.test(composerBody), 'the composer drawer makes no request');
	assertStringIncludes(composerBody, 'Apply by restarting with these values.');
});

Deno.test('system facts (D-138): the Allowed-domains scope tag, "not reported" when absent', () => {
	assertEquals(domainsScopeTag('documents'), 'documents only');
	assertEquals(domainsScopeTag('all'), 'all requests');
	for (const raw of [undefined, null, '', 'ALL', 'everything', true, ['all']]) {
		assertEquals(domainsScopeTag(raw), FACT_NOT_REPORTED, String(raw));
	}
	assertEquals(FACT_NOT_REPORTED, 'not reported');
});

Deno.test('system facts (D-137): Telemetry collectors — shown while exporting or listed, origins only', () => {
	const two = ['http://127.0.0.1:4318', 'https://otel.example.test'];
	// Exporting with two collectors.
	assertEquals(collectorsFact({ telemetry: true, otelEndpoints: two }, {}), { entries: two });
	// Listed but not exporting: still shown (the allowlist is configured); on/off is the tile's.
	assertEquals(collectorsFact({ telemetry: false, otelEndpoints: two }, {}), { entries: two });
	// Neither: omitted, and the telemetry tile says off.
	assertEquals(collectorsFact({ telemetry: false, otelEndpoints: [] }, {}), null);
	// Exporting with an empty list (a gateway the edge gate did not hold): said, not hidden.
	assertEquals(collectorsFact({ telemetry: true, otelEndpoints: [] }, {}), { none: 'None listed' });
	// Absent: "not reported", unless the gateway says it is not exporting.
	assertEquals(collectorsFact({ telemetry: true }, {}), { none: FACT_NOT_REPORTED });
	assertEquals(collectorsFact({}, {}), { none: FACT_NOT_REPORTED });
	assertEquals(collectorsFact({ telemetry: false }, {}), null);
	// From the document's top level too, like every other key here.
	assertEquals(collectorsFact({}, { telemetry: true, otelEndpoints: two }), { entries: two });
	// Only an origin reaches the screen: a path, a query, userinfo or a non-http scheme never does.
	assertEquals(
		collectorsFact({
			telemetry: true,
			otelEndpoints: ['http://u:secret@c.test:4318/v1?t=v2.x', 'ftp://c.test', 'not a url', 42, 'HTTP://C.TEST'],
		}, {}),
		{ entries: ['http://c.test:4318', 'http://c.test'] },
	);
});

Deno.test('system facts: an absent key is unknown, never off', () => {
	for (const tile of RECOMMENDATION_TILES) {
		assertEquals(recommendationState(tile, {}, {}), { unknown: NOT_REPORTED }, tile.key);
	}
	assertEquals(featureState(Symbol('x'), 'On', 'Off'), { unknown: NOT_REPORTED });
	assertEquals(featureState('a value that is far too long to be a short word', 'On', 'Off'), { unknown: NOT_REPORTED });
});

Deno.test('system facts: booleans, null, off-words and words', () => {
	assertEquals(featureState(true, 'On', 'Off'), { on: true, yes: 'On', no: 'Off' });
	assertEquals(featureState(false, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' });
	assertEquals(featureState(null, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' });
	for (const word of ['off', 'OFF', 'none', 'disabled', '']) {
		assertEquals(featureState(word, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' }, word);
	}
	assertEquals(featureState('watch', 'On', 'Off'), { on: true, yes: 'On', no: 'Off', detail: 'watch' });
	assertEquals(featureState('vault', 'On', 'None'), { on: true, yes: 'On', no: 'None', detail: 'vault' });
	// Markup never reaches a tile as a detail.
	assertEquals(featureState('<b>x</b>', 'On', 'Off'), { unknown: NOT_REPORTED });
});

Deno.test('system facts: objects carrying enabled, mode or provider', () => {
	assertEquals(featureState({ enabled: true }, 'On', 'Off'), { on: true, yes: 'On', no: 'Off' });
	assertEquals(featureState({ mode: 'control' }, 'On', 'Off'), {
		on: true,
		yes: 'On',
		no: 'Off',
		detail: 'control',
	});
	assertEquals(featureState({ mode: 'off' }, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' });
	assertEquals(featureState({ provider: '1password', enabled: true }, 'On', 'None'), {
		on: true,
		yes: 'On',
		no: 'None',
		detail: '1password',
	});
	assertEquals(featureState({ enabled: false, mode: 'watch' }, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' });
	assertEquals(featureState({}, 'On', 'Off'), { on: false, yes: 'On', no: 'Off' });
});

Deno.test('system facts: session ownership reads shared or owner, nothing else', () => {
	assertEquals(ownershipState('owner'), { on: true, yes: 'Per principal', no: 'Shared' });
	assertEquals(ownershipState('shared'), { on: false, yes: 'Per principal', no: 'Shared' });
	assertEquals(ownershipState('everyone'), { unknown: NOT_REPORTED });
	assertEquals(ownershipState(true), { unknown: NOT_REPORTED });
});

Deno.test('system facts: a key is read from config first, then from the top level', () => {
	assertEquals(diagnosticsKey({ telemetry: true }, { telemetry: false }, 'telemetry'), true);
	assertEquals(diagnosticsKey({}, { telemetry: false }, 'telemetry'), false);
	assertEquals(diagnosticsKey(undefined, undefined, 'telemetry'), undefined);
	const telemetry = RECOMMENDATION_TILES.find((tile) => tile.key === 'telemetry')!;
	assertEquals(recommendationState(telemetry, { telemetry: false }, {}), {
		on: false,
		yes: 'Exporting',
		no: 'Off',
	});
});

Deno.test('system facts (FX-B, D-149): the tabs, the layout, the diff cells and the overlays', async () => {
	const css = await Deno.readTextFile(new URL('./styles/screens/system.css', import.meta.url));
	const components = await Deno.readTextFile(new URL('./styles/components.css', import.meta.url));
	const code = await Deno.readTextFile(new URL('./system_view.ts', import.meta.url));
	const app = await Deno.readTextFile(new URL('./app.ts', import.meta.url));
	// D-149: three page tabs, each a route of its own, rendered by the one view.
	assertStringIncludes(app, "if (hash === '#/system' || hash.startsWith('#/system/')) {");
	assertStringIncludes(app, "systemView(navigate, param(hash, '#/system/'))");
	assertStringIncludes(code, 'tabs: systemTabs(tab),');
	for (const route of ["route: '#/system' }", "route: '#/system/mcp' }", "route: '#/system/config' }"]) {
		assertStringIncludes(code, route);
	}
	// FE-5: the configuration keys are mono through the kit's token; `--ttk-mono` was never defined, and the
	// `.tag.reach` selector never matched (the tag's class is `chip`).
	assertStringIncludes(css, '.sys-config-card .fact-key {\n\tfont-family: var(--wa-font-family-code);');
	assert(!css.includes('--ttk-mono'), 'no undefined mono token');
	assert(!css.includes('.tag.reach'), 'no dead reach selector');
	// F-02: a diff key never wraps mid-word; only the value cells may break; the outputs column has a floor.
	assertStringIncludes(components, '.diff-table td.diff-key {\n\twidth: max-content;\n\twhite-space: nowrap;');
	assertStringIncludes(
		components,
		'.diff-table td.diff-before,\n.diff-table td.diff-after {\n\toverflow-wrap: anywhere;',
	);
	assert(!/\.diff-table td \{[^}]*overflow-wrap/.test(components), 'overflow-wrap is not on every diff cell');
	assertStringIncludes(css, 'grid-template-columns: minmax(0, 1fr) minmax(360px, 1fr);');
	// D-149 (F-03's aim kept): the Overview puts the capabilities beside a side column; the configuration sections are
	// cards in columns, each kept whole, so no column towers over a hole.
	assertStringIncludes(css, '.sys-overview {\n\t\tgrid-template-columns: minmax(0, 1fr) minmax(300px, 380px);');
	assertStringIncludes(css, '.sys-config-card {\n\tbreak-inside: avoid;');
	assertStringIncludes(code, "el('div', { class: 'sys-side' }, [networkSlot, process.node])");
	// A list of chips never grows to its group's height (the origins grid stretched each chip into a blob).
	assert(!/\.sys-entries \{[^}]*flex: 1;/.test(css), 'the entries list does not grow');
	// F-06: the providers are rows of the Agents group, glyph-less.
	assertStringIncludes(code, "const providersSection = settingOf('TTK_MODEL_PROVIDERS_FILE')?.section;");
	assertStringIncludes(code, 'if (section === providersSection) rows.push(...providerRows(config));');
	assert(!code.includes('providersFact('), 'no separate providers fact');
	// BUG-2: the overlays the bar actions open are closed when the screen is left.
	assertStringIncludes(code, 'onLeave(closeOverlays);');
	assertStringIncludes(code, "rawModal = openModal('Raw', [tabs], true);");
	// CRW-9: the kit's size token.
	assert(!code.includes("size: 'small'"), "size: 's', not the deprecated 'small'");
});

Deno.test('system facts (D-149): every capability tile has its group, its line, and how to turn it on', () => {
	const drawnFirst = [
		'Admin user',
		'OAuth 2.1',
		'Sandboxed Chromium',
		'Coding sandbox',
		'Outbound egress',
		'Persistence',
		'Screencast recording',
		'API keys',
		'Cluster mode',
	];
	const names = [...drawnFirst, ...RECOMMENDATION_TILES.map((tile) => tile.name)];
	assertEquals(names.filter((name) => CAPABILITY_INFO[name] === undefined), [], 'every tile is described');
	assertEquals(Object.keys(CAPABILITY_INFO).sort(), [...names].sort(), 'and nothing else is');
	for (const [name, info] of Object.entries(CAPABILITY_INFO)) {
		assert(info.group in CAPABILITY_GROUPS, `${name}: a known group`);
		assert(info.about.length > 0 && info.about.length <= 80, `${name}: one short line`);
		assert(info.about.endsWith('.'), `${name}: a sentence`);
	}
	// A count and a role switch nothing; every other tile names what turns it on.
	assertEquals(
		Object.entries(CAPABILITY_INFO).filter(([, info]) => info.enable === undefined).map(([name]) => name).sort(),
		['API keys', 'Cluster mode'],
	);
	assertEquals(CAPABILITY_INFO['OpenTelemetry']?.enable, 'OTEL_DENO=true');
	assertEquals(capabilityGroupOf('Human handoff'), 'browser');
	assertEquals(capabilityGroupOf('A tile from a newer gateway'), 'platform', 'unknown lands somewhere, never nowhere');
});

Deno.test('system facts (D-149): the tab a route names, the withheld groups, the browser reach, the filter', () => {
	assertEquals(systemTabOf(undefined), 'overview');
	assertEquals(systemTabOf('mcp'), 'mcp');
	assertEquals(systemTabOf('config'), 'config');
	assertEquals(systemTabOf('nonsense'), 'overview');
	// Grouped in the vocabulary's order, names sorted, a reason a newer gateway adds kept at the end.
	assertEquals(
		withheldGroups([
			{ name: 'browser_head', reason: 'feature-unavailable' },
			{ name: 'browser_evaluate', reason: 'scope-required' },
			{ name: 'browser_file_link', reason: 'feature-unavailable' },
			{ name: 'future_tool', reason: 'quota-spent' },
		]),
		[
			{ reason: 'scope-required', names: ['browser_evaluate'] },
			{ reason: 'feature-unavailable', names: ['browser_file_link', 'browser_head'] },
			{ reason: 'quota-spent', names: ['future_tool'] },
		],
	);
	assertEquals(withheldGroups([]), []);
	for (const reason of ['scope-required', 'feature-unavailable', 'human-has-control']) {
		assert(WITHHELD_WORDS[reason] !== undefined, reason);
	}
	// No allowlist is every site, in words, and no scope tag (the tag qualifies an allowlist only, D-138).
	assertEquals(browserReach([], 'documents'), { entries: [], none: 'Any site', scopeTag: null });
	assertEquals(browserReach(['example.com'], 'all'), {
		entries: ['example.com'],
		none: 'Any site',
		scopeTag: 'all requests',
	});
	assertEquals(browserReach(['example.com'], undefined).scopeTag, 'not reported');
	// Every word, in the name or the value, case-insensitively.
	assert(configRowMatches('', 'TTK_HOST', '0.0.0.0'));
	assert(configRowMatches('sandbox', 'TTK_SANDBOX_URL', 'none (off)'));
	assert(configRowMatches('ttk_host 0.0', 'TTK_HOST', '0.0.0.0'));
	assert(!configRowMatches('host 1.2', 'TTK_HOST', '0.0.0.0'));
});
