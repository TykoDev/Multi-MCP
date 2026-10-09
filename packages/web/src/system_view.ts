/**
 * The System screen (admin), as three page tabs in the context bar (D-149), each its own route:
 *
 * - **Overview** (`#/system`): the metrics strip; the capabilities, grouped, each tile saying what it does and — while
 *   off — the setting that turns it on; the network facts; the process memory.
 * - **MCP** (`#/system/mcp`): what this credential is served and, grouped by reason, what it is not; the event
 *   stream; the rest of the capabilities document as a grid of facts; the live-view origins and the token's overlay.
 * - **Agents** (`#/system/agents`, D-152): the model providers, managed in place, and the A2A, ACP, peer and A2UI
 *   configuration (`system_agents.ts`).
 * - **Configuration** (`#/system/config`): the settings catalogue's rows as one card per section, with a filter.
 *
 * Run model-providers-ui: the raw JSON has one home — a context-bar action opening a modal with Diagnostics and
 * Capabilities tabs — and the configuration composer is a drawer from the second bar action. The composer makes no
 * request: it reads a form and runs the pure generators in `config_composer.ts`; the screen's only network effects are
 * the 5 s diagnostics poll and one read of the MCP documents per visit (design §4).
 */
import { api, ApiError, type OriginsInfo, type SystemDiagnostics } from './api.ts';
import {
	readingSource,
	reportedSettings,
	runningValue,
	runningValues,
	SECTION_WORDS,
	SECTIONS,
	type Setting,
	settingOf,
	type SettingSection,
	settingsSchema,
	widensReach,
} from './config_catalog.ts';
import type { ConfigPreset, ProviderDraft } from './config_composer.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { jsonFacts } from './json_facts.ts';
import { onLeave } from './lifecycle.ts';
import { mcp } from './mcp.ts';
import { schemaForm } from './schema_form.ts';
import { type Navigate, renderShell, type ShellOptions } from './shell.ts';
import { agentsTab } from './system_agents.ts';
import {
	badge,
	busy,
	button,
	copyButton,
	diffView,
	dot,
	factGroup,
	type FactRow,
	formatBytes,
	iconButton,
	jsonView,
	messageOf,
	meterBar,
	meterRing,
	type ModalHandle,
	openModal,
	panel,
	poll,
	skeleton,
	statTile,
	tag,
	textView,
	tip,
	toast,
} from './ui.ts';
import {
	browserReach,
	CAPABILITY_FACTS_LABELS,
	CAPABILITY_FACTS_OMIT,
	CAPABILITY_GROUPS,
	CAPABILITY_INFO,
	type CapabilityGroup,
	capabilityGroupOf,
	collectorsFact,
	configRowMatches,
	FACT_NOT_REPORTED,
	RECOMMENDATION_TILES,
	recommendationState,
	SYSTEM_GLYPHS as G,
	type SystemTab,
	systemTabOf,
	WITHHELD_WORDS,
	withheldGroups,
} from './system_facts.ts';

// --- the tabs ------------------------------------------------------------------------------------------------------

/** The page tabs: links, so the address bar, Back and a reload agree with the lit tab (the Sessions pattern). */
function systemTabs(active: SystemTab): NonNullable<ShellOptions['tabs']> {
	return {
		label: 'System views',
		active,
		items: [
			{ id: 'overview', label: 'Overview', glyph: G.tabOverview, route: '#/system' },
			{ id: 'mcp', label: 'MCP', glyph: G.tabMcp, route: '#/system/mcp' },
			{ id: 'agents', label: 'Agents', glyph: G.tabAgents, route: '#/system/agents' },
			{ id: 'config', label: 'Configuration', glyph: G.tabConfig, route: '#/system/config' },
		],
	};
}

// --- system diagnostics -------------------------------------------------------

function uptime(seconds: number): string {
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

/** Marks a panel with its place in its tab's grid (`system.css` places the panels by these). */
function withClass(name: string, node: HTMLElement): HTMLElement {
	node.classList.add(name);
	return node;
}

/** A glyph tile whose meaning is its tooltip and accessible name. */
function glyphTile(glyph: IconName, meaning: string, className = 'sys-glyph'): HTMLElement {
	return el('span', { class: className, role: 'img', 'aria-label': meaning, 'data-tip': meaning }, [icon(glyph)]);
}

/** A number, with a glyph when one names it, the meaning in the tooltip. */
function countChip(glyph: IconName | undefined, value: number, meaning: string, tone = ''): HTMLElement {
	return el('span', { class: `sys-chip ${tone}`, role: 'img', 'aria-label': meaning, 'data-tip': meaning }, [
		...(glyph === undefined ? [] : [icon(glyph)]),
		el('span', { text: String(value) }),
	]);
}

/** One fact: a glyph, its name, its value in mono, and optionally a copy button. */
function fact(glyph: IconName, key: string, value: string, copy = false): HTMLElement {
	return el('div', { class: 'sys-fact' }, [
		el('span', { class: 'sys-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
		el('span', { class: 'sys-fact-key', text: key }),
		el('span', { class: 'sys-fact-value mono', text: value }),
		...(copy ? [copyButton(() => value, `Copy ${key.toLowerCase()}`)] : []),
	]);
}

/**
 * A read-only list of hosts or origins as chips; `none` when the list is empty — dashed, as an absence, unless `open`
 * says the empty list means "everything" (the browser's reach), which reads as a fact in its own right. The chips
 * carry no glyph: the fact or group they belong to already names them (FXD-N1, D-092).
 */
function entriesList(values: readonly string[], none = '—', extra: Node[] = [], open = false): HTMLElement {
	return el('ul', { class: 'sys-entries' }, [
		...(values.length === 0
			? [el('li', { class: open ? 'sys-entry open' : 'sys-entry none', text: none })]
			: values.map((value) => el('li', { class: 'sys-entry mono', text: value }))),
		...extra.map((node) => el('li', { class: 'sys-entry-extra' }, [node])),
	]);
}

/** A fact whose value is a list (see `fact`); `extra` follows the entries, such as a scope tag. */
function entryFact(
	glyph: IconName,
	key: string,
	values: readonly string[],
	none: string,
	extra: Node[] = [],
	open = false,
): HTMLElement {
	return el('div', { class: 'sys-fact top' }, [
		el('span', { class: 'sys-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
		el('span', { class: 'sys-fact-key', text: key }),
		entriesList(values, none, extra, open),
	]);
}

/**
 * A capability tile's on/off mark, drawn by the stylesheet rather than the sprite (FXD-N1: a glyph in every tile's
 * corner would be the screen's most repeated one). A filled disc is on, a ring is off, and a ring with a sign is a
 * protection switched off or a fact not reported: shape, not only colour, tells them apart (WCAG 1.4.1). The words
 * are its accessible name; the tile's tooltip carries them too.
 */
function stateMark(kind: 'on' | 'off' | 'warn' | 'unknown', words: string): HTMLElement {
	return el('span', { class: `sys-cap-state ${kind}`, role: 'img', 'aria-label': words });
}

/**
 * D-149: the lines under a tile's head — what the capability does, and while it is off the setting that turns it on
 * (`CAPABILITY_INFO`). A tile the table does not know (a newer gateway's) has neither.
 */
function capabilityNotes(name: string, off: boolean): HTMLElement[] {
	const info = CAPABILITY_INFO[name];
	if (info === undefined) return [];
	return [
		el('span', { class: 'sys-cap-about', text: info.about }),
		...(off && info.enable !== undefined
			? [el('span', { class: 'sys-cap-enable' }, [
				el('span', { class: 'sys-cap-enable-word', text: 'Enable with' }),
				el('code', { text: info.enable }),
			])]
			: []),
	];
}

/**
 * One capability as a tile: its glyph, its name and under the name its state in words (or its value), the on/off
 * mark at the end of that head, then what it does and how to turn it on (D-149). The state words are hidden from
 * assistive technology, which hears the mark's name instead, so nothing is read twice. RV-13: every tile is a tab
 * stop, its tooltip carrying the state and any detail, with a focus ring.
 */
function capability(
	glyph: IconName,
	name: string,
	state:
		| { on: boolean; yes?: string; no?: string; detail?: string; warnOff?: boolean }
		| { value: string; detail?: string }
		| { unknown: string },
): HTMLElement {
	const glyphNode = el('span', { class: 'sys-cap-glyph', 'aria-hidden': 'true' }, [icon(glyph)]);
	if ('value' in state) {
		const tipText = state.detail === undefined
			? `${name} · ${state.value}`
			: `${name} · ${state.value} · ${state.detail}`;
		return el('li', { class: 'sys-cap value', tabindex: 0, 'data-tip': tipText }, [
			el('span', { class: 'sys-cap-head' }, [
				glyphNode,
				el('span', { class: 'sys-cap-text' }, [
					el('span', { class: 'sys-cap-name', text: name }),
					el('span', { class: 'sr-only', text: ': ' }),
					el('span', { class: 'sys-cap-value', text: state.value }),
					...(state.detail === undefined ? [] : [el('span', { class: 'sys-cap-words', text: state.detail })]),
				]),
			]),
			...capabilityNotes(name, false),
		]);
	}
	if ('unknown' in state) {
		// The server did not report this fact (an older gateway): say so rather than guess either way.
		return el('li', { class: 'sys-cap unknown', tabindex: 0, 'data-tip': `${name} · ${state.unknown}` }, [
			el('span', { class: 'sys-cap-head' }, [
				glyphNode,
				el('span', { class: 'sys-cap-text' }, [
					el('span', { class: 'sys-cap-name', text: name }),
					el('span', { class: 'sys-cap-words', 'aria-hidden': 'true', text: 'Not reported' }),
				]),
				stateMark('unknown', state.unknown),
			]),
			...capabilityNotes(name, false),
		]);
	}
	const words = state.on ? state.yes ?? 'On' : state.no ?? 'Off';
	const tone = state.on ? 'on' : state.warnOff === true ? 'off warn' : 'off';
	const tipText = state.detail === undefined ? `${name} · ${words}` : `${name} · ${words} · ${state.detail}`;
	return el('li', { class: `sys-cap ${tone}`, tabindex: 0, 'data-tip': tipText }, [
		el('span', { class: 'sys-cap-head' }, [
			glyphNode,
			el('span', { class: 'sys-cap-text' }, [
				el('span', { class: 'sys-cap-name', text: name }),
				el('span', {
					class: 'sys-cap-words',
					'aria-hidden': 'true',
					text: state.detail === undefined ? words : `${words} · ${state.detail}`,
				}),
				...(state.detail === undefined ? [] : [el('span', { class: 'sr-only', text: state.detail })]),
			]),
			stateMark(state.on ? 'on' : state.warnOff === true ? 'warn' : 'off', words),
		]),
		...capabilityNotes(name, !state.on),
	]);
}

/**
 * C12: what the diagnostics may carry beyond the typed shape. Each is newer than some gateways an operator may
 * point this screen at, so each is read defensively and an absent one is reported as unknown, never as "off".
 * The mcp-recommendations keys (design §3.1) are read by `system_facts.ts`.
 */
type DiagnosticsConfig = SystemDiagnostics['config'] & {
	readonly chromiumSandboxed?: unknown;
	readonly sandboxBackend?: unknown;
	readonly sessionOwnership?: unknown;
	readonly mcpApps?: unknown;
	readonly signedLinks?: unknown;
	readonly confirmations?: unknown;
	readonly humanHandoff?: unknown;
	readonly secretProvider?: unknown;
	readonly telemetry?: unknown;
	readonly sandboxClone?: unknown;
};

/**
 * The capabilities mcp-recommendations added (design §5): one glyph tile each among the others — no stat card, no
 * control (D-092, D-093). Each key is read defensively by `system_facts.ts`; absent is unknown, never "off".
 */
function recommendationTiles(config: DiagnosticsConfig, diag?: SystemDiagnostics): HTMLElement[] {
	return RECOMMENDATION_TILES.map((tile) => capability(tile.glyph, tile.name, recommendationState(tile, config, diag)));
}

/**
 * The API-key tile: every key that can sign in — configured ones and, from a gateway with account keys (D-146), the
 * ones accounts hold — with the split under it. An older gateway reports the configured count alone.
 */
function apiKeysState(config: DiagnosticsConfig): { value: string; detail?: string } {
	const held = typeof config.accountKeysCount === 'number' ? config.accountKeysCount : undefined;
	if (held === undefined) return { value: String(config.apiKeysCount) };
	return {
		value: String(config.apiKeysCount + held),
		detail: `${config.apiKeysCount} configured · ${held} on accounts`,
	};
}

/** The coding sandbox's backend, from `config` or the top level of the diagnostics, when it is a short name. */
function sandboxBackend(config: DiagnosticsConfig, diag?: SystemDiagnostics): string | undefined {
	const value = config.sandboxBackend ?? (diag as { sandboxBackend?: unknown } | undefined)?.sandboxBackend;
	return typeof value === 'string' && /^[a-z0-9-]{1,16}$/.test(value) ? value : undefined;
}

/** Which tiles the Capabilities panel shows: all of them, the ones on (a count or a role counts as on), or the rest. */
type CapabilityFilter = 'all' | 'on' | 'off';

/** Whether a tile passes the filter, read from the class `capability()` gave it. */
function passes(tile: Element, show: CapabilityFilter): boolean {
	if (show === 'all') return true;
	const lit = tile.classList.contains('on') || tile.classList.contains('value');
	return show === 'on' ? lit : !lit;
}

/**
 * A three-way switch as pressed buttons — All · On · Off — with the counts in its words. Text only (FXD-N1: no glyph
 * for a control that names itself). `apply` runs on a press with the choice.
 */
function filterSwitch(
	label: string,
	choices: ReadonlyArray<{ readonly id: string; readonly words: string }>,
	apply: (id: string) => void,
): HTMLElement {
	const group = el('div', { class: 'sys-seg', role: 'group', 'aria-label': label });
	for (const [index, choice] of choices.entries()) {
		const press = el('button', {
			type: 'button',
			class: 'sys-seg-btn',
			'aria-pressed': index === 0 ? 'true' : 'false',
			'data-choice': choice.id,
			text: choice.words,
		});
		on(press, 'click', () => {
			for (const other of group.querySelectorAll('.sys-seg-btn')) {
				other.setAttribute('aria-pressed', String(other === press));
			}
			apply(choice.id);
		});
		group.append(press);
	}
	return group;
}

/**
 * The Capabilities panel (D-149): the tiles sorted into four titled groups (`CAPABILITY_GROUPS`), each a grid, and a
 * switch in the head that narrows them to the ones on or off. A group the switch empties is hidden with its title.
 */
function capabilityGrid(config: DiagnosticsConfig, diag?: SystemDiagnostics): HTMLElement {
	const chromium = typeof config.chromiumSandboxed === 'boolean' ? config.chromiumSandboxed : undefined;
	const backend = sandboxBackend(config, diag);
	const tiles = [
		capability(G.adminUser, 'Admin user', { on: config.hasAdminUser, yes: 'Configured', no: 'Not set' }),
		capability(G.oauth, 'OAuth 2.1', { on: config.oauthEnabled, yes: 'Enabled', no: 'Disabled' }),
		// Chromium's own sandbox; off only when TTK_CHROMIUM_NO_SANDBOX was set, which is worth a warning tone.
		capability(
			G.chromium,
			'Sandboxed Chromium',
			chromium === undefined
				? { unknown: 'Not reported by this gateway' }
				: { on: chromium, yes: 'Isolated', no: 'Sandbox disabled', warnOff: true },
		),
		// The coding sandbox (sandbox_* tools): configured and reachable, and which backend runs workspaces.
		capability(G.codingSandbox, 'Coding sandbox', {
			on: config.sandboxEnabled,
			yes: 'Available',
			// One word for both causes (no TTK_SANDBOX_URL, or no answer from it): the tile's foot says how to set it.
			no: 'Unavailable',
			...(backend === undefined ? {} : { detail: backend }),
		}),
		capability(G.egress, 'Outbound egress', { on: config.egressEnabled, yes: 'Enabled', no: 'Loopback only' }),
		capability(G.persistence, 'Persistence', { on: config.persistenceEnabled }),
		capability(G.recording, 'Screencast recording', { on: config.recordingEnabled }),
		capability(G.apiKeys, 'API keys', apiKeysState(config)),
		capability(G.cluster, 'Cluster mode', { value: config.clusterMode }),
		...recommendationTiles(config, diag),
	];
	const byGroup = new Map<CapabilityGroup, HTMLElement[]>();
	for (const tile of tiles) {
		const name = tile.getAttribute('data-tip')?.split(' · ')[0] ?? '';
		const group = capabilityGroupOf(name);
		byGroup.set(group, [...byGroup.get(group) ?? [], tile]);
	}
	const groups = (Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[]).flatMap((group) => {
		const members = byGroup.get(group);
		if (members === undefined) return [];
		const id = `sys-capgroup-${group}`;
		return [el('section', { class: 'sys-capgroup', 'aria-labelledby': id }, [
			el('h3', { id, class: 'sys-capgroup-title', text: CAPABILITY_GROUPS[group] }),
			el('ul', { class: 'sys-caps', 'aria-labelledby': id }, members),
		])];
	});
	const lit = tiles.filter((tile) => passes(tile, 'on')).length;
	const show = filterSwitch('Show capabilities', [
		{ id: 'all', words: `All ${tiles.length}` },
		{ id: 'on', words: `On ${lit}` },
		{ id: 'off', words: `Off ${tiles.length - lit}` },
	], (choice) => {
		const wanted = choice === 'on' || choice === 'off' ? choice : 'all';
		for (const section of groups) {
			let shown = 0;
			for (const tile of section.querySelectorAll('.sys-cap')) {
				const visible = passes(tile, wanted);
				(tile as HTMLElement).hidden = !visible;
				if (visible) shown++;
			}
			section.hidden = shown === 0;
		}
	});
	return withClass(
		'sys-caps-panel',
		panel('Capabilities', G.capabilities, [el('div', { class: 'sys-capgroups' }, groups)], [show]),
	);
}

function networkPanel(diag: SystemDiagnostics): HTMLElement {
	const c = diag.config;
	// D-149: an empty allowlist is every site, said in words; the D-138 scope tag only qualifies an allowlist.
	const reach = browserReach(c.allowedDomains, c.allowedDomainsScope);
	const scopeTag = reach.scopeTag === null ? [] : [tip(tag(reach.scopeTag), `The allowlist judges: ${reach.scopeTag}`)];
	// D-137: the collectors `TTK_OTEL_ENDPOINTS` allowlists. On/off stays the OpenTelemetry tile's (D-092).
	const collectors = collectorsFact(c, diag);
	return withClass(
		'sys-network-panel',
		panel('Network', G.network, [
			el('div', { class: 'sys-facts' }, [
				fact(G.version, 'Server version', diag.version),
				fact(G.bind, 'Bind', `${c.host}:${c.port}`, true),
				fact(G.publicUrl, 'Public URL', c.publicUrl, true),
				entryFact(G.browserReach, 'Browser reach', reach.entries, reach.none, scopeTag, true),
				entryFact(G.allowedOrigins, 'Allowed origins', c.allowedOrigins, 'Host bind'),
				...(collectors === null ? [] : [
					'entries' in collectors
						? entryFact(G.collectors, 'Telemetry collectors', collectors.entries, '—')
						: entryFact(G.collectors, 'Telemetry collectors', [], collectors.none),
				]),
			]),
		]),
	);
}

/** The process memory as meter bars — no glyph each, so a column of them repeats nothing (D-092 amended). */
function memoryBars(memory: { rss: number; heapTotal: number; heapUsed: number; external: number }): HTMLElement[] {
	const of = (part: number, whole: number): number => whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
	const share = (part: number): string =>
		`${formatBytes(part)}, ${Math.round(of(part, memory.rss) * 100)}% of resident`;
	return [
		meterBar(
			'Heap used',
			of(memory.heapUsed, memory.heapTotal),
			`${formatBytes(memory.heapUsed)} of ${formatBytes(memory.heapTotal)} heap`,
		),
		meterBar('Heap total', of(memory.heapTotal, memory.rss), share(memory.heapTotal)),
		meterBar('External', of(memory.external, memory.rss), share(memory.external)),
	];
}

/**
 * The Process panel (D-149: it was the Configuration panel's memory group): the resident set in words, the bars
 * sharing it out under it, redrawn every poll.
 */
function processPanel(): { node: HTMLElement; update(diag: SystemDiagnostics): void } {
	const resident = el('span', { class: 'sys-resident-value mono', text: '—' });
	const bars = el('div', { class: 'sys-memory' });
	const node = withClass(
		'sys-process-panel',
		panel('Process', G.process, [
			el('div', { class: 'sys-resident' }, [el('span', { class: 'sys-resident-key', text: 'Resident' }), resident]),
			bars,
		]),
	);
	return {
		node,
		update(diag) {
			resident.textContent = formatBytes(diag.memory.rss);
			bars.replaceChildren(...memoryBars(diag.memory));
		},
	};
}

// --- the Configuration tab ------------------------------------------------------------------------------------

/** A words-only tag beside a configuration row; the reach tag is the one with a tone. */
function rowTag(text: string, tone = '', explain?: string): HTMLElement {
	const node = tag(text, undefined, tone);
	if (tone !== '') node.classList.add('reach');
	return explain === undefined ? node : tip(node, explain);
}

/** What the Configuration tab's filter reads of a row: its name, its value in words, and where the value came from. */
interface RowFacts {
	readonly key: string;
	readonly text: string;
	readonly source: string | undefined;
}

/**
 * One catalogue row: the variable name, its running value in mono, its source (set, default or derived), a "widens
 * reach" tag where the value does, and "file-backed" on a file path. A fact the gateway does not report reads
 * "not reported" (frontend §2(a)); the explanation is the key's tooltip and a hidden sentence (`factGroup`).
 */
function configRow(setting: Setting, config: DiagnosticsConfig, diag: SystemDiagnostics): FactRow & RowFacts {
	const running = runningValue(setting, config, diag);
	const tags: Node[] = [];
	let value: string;
	let source: string | undefined;
	if (running.kind === 'reading') {
		value = running.reading.text;
		source = readingSource(setting, running.reading, config);
		if (source !== undefined) tags.push(rowTag(source));
		if (widensReach(setting, running.reading.value)) {
			tags.push(rowTag('widens reach', 'warn', 'This value widens what the deployment reaches or who reaches it.'));
		}
	} else {
		value = FACT_NOT_REPORTED;
	}
	if (setting.kind === 'secret-file') {
		tags.push(rowTag('file-backed', '', 'A path to a file; its content is never shown or sent.'));
	}
	return { key: setting.name, value, explain: setting.explain, tags, text: value, source };
}

/**
 * D-143: the configured model providers as two rows of the Agents group, under the providers-file row — a visible
 * key each, no glyph (F-06): the providers (id, kind, model count and whether the grant proof reached the host) and
 * whether the built-in agent can run. An older gateway reads "not reported".
 */
function providerRows(config: DiagnosticsConfig): Array<FactRow & RowFacts> {
	const providers = Array.isArray(config.modelProviders) ? config.modelProviders : undefined;
	const builtin = typeof config.builtinAgent === 'boolean' ? config.builtinAgent : undefined;
	const list = el('ul', { class: 'sys-providers' });
	if (providers === undefined) list.append(el('li', { class: 'sys-entry none', text: FACT_NOT_REPORTED }));
	else if (providers.length === 0) list.append(el('li', { class: 'sys-entry none', text: 'None configured' }));
	for (const provider of providers ?? []) {
		const models = provider.models === 1 ? '1 model' : `${provider.models} models`;
		list.append(el('li', { class: 'sys-provider' }, [
			el('span', { class: 'mono', text: provider.id }),
			badge(provider.kind),
			el('span', { class: 'muted', text: models }),
			dot(
				provider.reachable ? 'ok' : 'warn',
				provider.reachable ? 'Reachable: the net grant covers its host' : 'Not reachable: no outbound net grant',
			),
		]));
	}
	const builtinText = builtin === undefined ? FACT_NOT_REPORTED : builtin ? 'on' : 'off';
	return [
		{
			key: 'Model providers',
			value: list,
			explain:
				"The providers in force (the database's, D-154): id, kind, model count and whether the net grant reaches each host.",
			text: list.textContent ?? '',
			source: undefined,
		},
		{
			key: 'Built-in agent',
			value: builtinText,
			explain: builtin === false
				? 'No provider is reachable, so text tasks need an ACP agent.'
				: 'Runs text tasks itself while at least one provider is reachable.',
			text: builtinText,
			source: undefined,
		},
	];
}

/** The catalogue's reported settings as one card per section, in the reference page's order, with each row's facts. */
function configCards(
	config: DiagnosticsConfig,
	diag: SystemDiagnostics,
): Array<{ readonly card: HTMLElement; readonly rows: ReadonlyArray<RowFacts> }> {
	const bySection = new Map<SettingSection, Setting[]>();
	for (const setting of reportedSettings()) {
		bySection.set(setting.section, [...bySection.get(setting.section) ?? [], setting]);
	}
	// The providers rows belong to the group of the providers-file row, under it (F-06).
	const providersSection = settingOf('TTK_MODEL_PROVIDERS_FILE')?.section;
	return SECTIONS.flatMap((section) => {
		const rows = (bySection.get(section) ?? []).map((setting) => configRow(setting, config, diag));
		if (section === providersSection) rows.push(...providerRows(config));
		if (rows.length === 0) return [];
		return [{ card: el('div', { class: 'sys-config-card' }, [factGroup(SECTION_WORDS[section], rows)]), rows }];
	});
}

/** Which rows the source switch keeps: every row, the ones an operator set, or the ones left at their default. */
type SourceFilter = 'all' | 'set' | 'default';

/**
 * The Configuration tab (D-149): a filter over the rows by name or value, a switch over where each value came from,
 * a count of what is shown, and the section cards — in columns, so a long section does not leave a hole beside a
 * short one. The cards are rebuilt only when the configuration changes, and the filter is re-applied to them.
 */
function configurationTab(): { node: HTMLElement; update(diag: SystemDiagnostics, redraw: boolean): void } {
	const cards = el('div', { class: 'sys-config-cards' });
	const count = el('span', { class: 'sys-config-count', role: 'status' });
	const query = el('input', {
		type: 'search',
		class: 'sys-filter-input',
		placeholder: 'Filter by variable or value',
		'aria-label': 'Filter settings by variable or value',
		autocomplete: 'off',
		spellcheck: false,
	});
	const empty = el('p', { class: 'sys-config-empty', text: 'No setting matches the filter.', hidden: true });
	let source: SourceFilter = 'all';
	let built: Array<{ readonly card: HTMLElement; readonly rows: ReadonlyArray<RowFacts> }> = [];

	function apply(): void {
		let shown = 0;
		let total = 0;
		for (const { card, rows } of built) {
			const nodes = card.querySelectorAll('.fact');
			let visible = 0;
			rows.forEach((row, index) => {
				total++;
				const bySource = source === 'all' ||
					(source === 'set' ? row.source === 'set' : row.source === 'default' || row.source === 'derived');
				const keep = bySource && configRowMatches(query.value, row.key, row.text);
				const node = nodes[index] as HTMLElement | undefined;
				if (node !== undefined) node.hidden = !keep;
				if (keep) visible++;
			});
			card.hidden = visible === 0;
			shown += visible;
		}
		count.textContent = shown === total ? `${total} settings` : `${shown} of ${total} settings`;
		empty.hidden = shown > 0 || built.length === 0;
	}
	on(query, 'input', apply);
	const sources = filterSwitch('Show settings', [
		{ id: 'all', words: 'All' },
		{ id: 'set', words: 'Set' },
		{ id: 'default', words: 'Default' },
	], (choice) => {
		source = choice === 'set' || choice === 'default' ? choice : 'all';
		apply();
	});
	const node = el('div', { class: 'sys-config-tab' }, [
		el('div', { class: 'sys-config-bar' }, [
			el('label', { class: 'sys-filter' }, [icon(G.filter), query]),
			sources,
			count,
		]),
		empty,
		cards,
	]);
	return {
		node,
		update(diag, redraw) {
			if (!redraw) return;
			built = configCards(diag.config, diag);
			cards.replaceChildren(...built.map(({ card }) => card));
			apply();
		},
	};
}

// --- the live-view origins -----------------------------------------------------------------------------------

/**
 * A section label inside a panel: a word, the full meaning in the tooltip. No glyph (FXD-N1): the panel's heading
 * names the section, and a glyph per label repeated glyphs the screen draws elsewhere.
 */
function groupLabel(word: string, meaning: string, extra: Node[] = []): HTMLElement {
	return el('div', { class: 'sys-group-label', 'data-tip': meaning }, [
		el('span', { text: word }),
		el('span', { class: 'sr-only', text: ` — ${meaning}` }),
		...extra,
	]);
}

function originsPanel(info: OriginsInfo, reload: () => void): HTMLElement {
	let entries = [...info.token.entries];
	const saved = JSON.stringify(info.token.entries);
	const list = el('ul', { class: 'sys-origins' });
	const input = el('input', {
		type: 'text',
		class: 'mono',
		placeholder: 'https://app.example.com',
		'aria-label': 'Origin to add',
		disabled: !info.writable,
	});
	const add = iconButton(G.addOrigin, 'Add origin', undefined, { small: true });
	// Text only (FXD-N1): the Persistence tile owns the save glyph on this screen. Offered only while the list differs
	// from what is saved (D-092: no idle control).
	const save = button({ label: 'Save overlay', variant: 'primary', small: true });
	add.disabled = save.disabled = !info.writable;

	function renderChips(): void {
		clear(list);
		save.hidden = !info.writable || JSON.stringify(entries) === saved;
		if (entries.length === 0) {
			list.append(el('li', { class: 'sys-origin none' }, [el('span', { text: 'No per-token narrowing' })]));
		}
		for (const entry of entries) {
			// A row action, like copy: one per origin it removes (`REPEATABLE_GLYPHS`).
			const remove = iconButton('x', `Remove ${entry}`, undefined, { small: true });
			remove.disabled = !info.writable;
			on(remove, 'click', () => {
				entries = entries.filter((value) => value !== entry);
				renderChips();
			});
			list.append(el('li', { class: 'sys-origin' }, [el('span', { class: 'mono grow', text: entry }), remove]));
		}
	}
	const addEntry = (): void => {
		const value = input.value.trim();
		if (value !== '' && !entries.includes(value)) entries.push(value);
		input.value = '';
		renderChips();
	};
	on(add, 'click', addEntry);
	on(input, 'keydown', (event) => {
		if (event.key === 'Enter') addEntry();
	});
	on(save, 'click', () => {
		void busy(save, async () => {
			await api.setOrigins(entries);
			toast('Origin overlay saved', 'ok');
			reload();
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});
	renderChips();

	// `absent` is the normal state of a token that never narrowed anything; only `unreadable` is a fault.
	const overlayTone = info.overlay_status === 'ok' ? 'ok' : info.overlay_status === 'unreadable' ? 'warn' : '';
	const readOnly = info.writable
		? []
		: [glyphTile(G.readOnly, 'Read-only: the overlay needs TTK_DATA_DIR.', 'sys-glyph locked')];
	return withClass(
		'sys-origins-panel',
		panel('Live-view origins', G.origins, [
			el('div', { class: 'sys-origin-group' }, [
				groupLabel('Process', `Process-wide (${info.process_wide.rule})`),
				entriesList(info.process_wide.entries),
			]),
			el('div', { class: 'sys-origin-group' }, [
				groupLabel('Effective', `Effective (${info.effective.rule})`),
				entriesList(info.effective.entries),
			]),
			el('div', { class: 'sys-origin-group' }, [
				groupLabel('Overlay', 'This token’s overlay (exact origins)', [
					dot(overlayTone, `Overlay status: ${info.overlay_status}`),
				]),
				list,
				el('div', { class: 'sys-origin-add' }, [input, add]),
			]),
		], [...readOnly, save]),
	);
}

// --- MCP ---------------------------------------------------------------------------------------------------------

interface Capabilities {
	version?: string;
	/** Unverified (C8): not in `TykotechCapabilities`; shown as facts when present. */
	scopes?: string[];
	tools_withheld?: Array<{ name: string; reason: string }>;
	events?: { transports?: string[]; kinds?: string[] } & Record<string, unknown>;
	live_view?: Record<string, unknown>;
	model?: { providers?: number; builtin_agent?: boolean };
}

/**
 * The Tool access panel (D-149): the served and withheld counts, then the withheld tools grouped by why — a grant
 * this credential lacks, or a capability this deployment has off — each group a heading, a line on what to do, and
 * the names in columns. The reason is visible, not only a tooltip, because it decides who can fix it.
 */
function toolAccessPanel(caps: Capabilities, toolCount: number, navigate: Navigate): HTMLElement {
	const withheld = caps.tools_withheld ?? [];
	const openTools = iconButton(G.openTools, 'Open tools', () => navigate('#/resources/tools'), { small: true });
	const groups = withheldGroups(withheld).map(({ reason, names }) => {
		const words = WITHHELD_WORDS[reason] ?? { title: reason, hint: '' };
		const id = `sys-withheld-${reason}`;
		return el('section', { class: 'sys-withheld-group', 'aria-labelledby': id }, [
			el('h3', { id, class: 'sys-withheld-title' }, [
				el('span', { text: words.title }),
				el('span', { class: 'sys-withheld-count', text: String(names.length) }),
			]),
			...(words.hint === '' ? [] : [el('p', { class: 'sys-withheld-hint', text: words.hint })]),
			el(
				'ul',
				{ class: 'sys-withheld', 'aria-labelledby': id },
				names.map((name) => el('li', { class: 'sys-withheld-item mono', text: name })),
			),
		]);
	});
	return withClass(
		'sys-tools-panel',
		panel('Tool access', G.toolAccess, [
			el('div', { class: 'sys-tool-counts' }, [
				el('div', { class: 'sys-count' }, [
					// The metrics strip's Tools tile owns the tools glyph; this chip is its number (FXD-N1).
					el('div', { class: 'sys-chips' }, [
						countChip(undefined, toolCount, `${toolCount} tools served`, 'accent'),
						countChip(
							G.withheld,
							withheld.length,
							`${withheld.length} tools withheld`,
							withheld.length > 0 ? 'warn' : '',
						),
					]),
					el('span', {
						class: 'sys-count-words',
						text: withheld.length === 0
							? 'Every tool is served to this credential.'
							: `${toolCount} served to this credential, ${withheld.length} withheld.`,
					}),
				]),
			]),
			...groups,
		], [openTools]),
	);
}

/** A scalar of the capabilities document as row text. */
function scalarText(value: unknown): string | undefined {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
	return value === null ? 'null' : undefined;
}

/**
 * The Events panel (D-149): the `events` block of the capabilities document whole — the transports, the kinds as a
 * quiet vocabulary, and the ring's numbers as facts — so the Protocol panel leaves `events` out.
 */
function eventsPanel(caps: Capabilities): HTMLElement {
	const events = caps.events ?? {};
	const transports = events.transports ?? [];
	const kinds = events.kinds ?? [];
	const rows: FactRow[] = Object.entries(events).flatMap(([key, value]) => {
		if (key === 'transports' || key === 'kinds') return [];
		const text = scalarText(value);
		return text === undefined ? [] : [{ key: key.replaceAll('_', ' '), value: text }];
	});
	return withClass(
		'sys-events-panel',
		panel('Events', G.events, [
			el('div', { class: 'sys-origin-group' }, [
				groupLabel('Transports', 'How a client can receive the event stream'),
				el(
					'div',
					{ class: 'sys-tags' },
					transports.length === 0
						? [el('span', { class: 'muted', text: '—' })]
						: transports.map((transport) => tag(transport, undefined, 'accent')),
				),
			]),
			el('div', { class: 'sys-origin-group' }, [
				groupLabel('Kinds', 'The event kinds this credential can receive'),
				el('div', { class: 'sys-tags' }, kinds.map((kind) => badge(kind))),
			]),
			...(rows.length === 0 ? [] : [el('div', { class: 'sys-origin-group' }, [factGroup('Buffer', rows)])]),
		]),
	);
}

/**
 * The Protocol panel: the rest of the capabilities document as facts (C8) — the keys with a home elsewhere left out,
 * a key with no label kept in a trailing "Other" group — laid out as a grid of groups rather than one long column
 * (D-149). The raw document lives in the Raw modal, not here (one home).
 */
function protocolPanel(caps: Capabilities): HTMLElement {
	return withClass(
		'sys-protocol-panel',
		panel('Protocol', G.protocol, [
			jsonFacts(caps, { omit: [...CAPABILITY_FACTS_OMIT], labels: { ...CAPABILITY_FACTS_LABELS } }),
		]),
	);
}

// --- the Raw modal -----------------------------------------------------------------------------------------------

/** The overlays a bar action opened — torn down when the screen is left, which the kit would not do (BUG-2). */
let rawModal: ModalHandle | null = null;
let composerDrawer: { open: boolean } | null = null;

/** Closes whichever overlays are open; their own `wa-after-hide` handlers remove them. */
function closeOverlays(): void {
	rawModal?.close();
	rawModal = null;
	if (composerDrawer !== null) composerDrawer.open = false;
	composerDrawer = null;
}

/** A JSON document under its copy button. */
function rawDocument(value: unknown, label: string): HTMLElement {
	return el('div', { class: 'sys-json' }, [copyButton(() => JSON.stringify(value, null, 2), label), jsonView(value)]);
}

/** The raw JSON, one home: a wide modal with a Diagnostics tab and a Capabilities tab, each copyable. */
function openRaw(diag: SystemDiagnostics, caps: Capabilities | null): void {
	const capabilities = caps === null
		? el('p', { class: 'muted', text: 'The capabilities document has not loaded.' })
		: rawDocument(caps, 'Copy capabilities');
	const tabs = el('wa-tab-group', { class: 'sys-raw' }, [
		el('wa-tab', { panel: 'diagnostics', text: 'Diagnostics' }),
		el('wa-tab', { panel: 'capabilities', text: 'Capabilities' }),
		el('wa-tab-panel', { name: 'diagnostics' }, [rawDocument(diag, 'Copy diagnostics')]),
		el('wa-tab-panel', { name: 'capabilities' }, [capabilities]),
	]);
	rawModal = openModal('Raw', [tabs], true);
}

// --- the configuration composer ------------------------------------------------------------------------------------

type Composer = typeof import('./config_composer.ts');

/** The kit controls a form seeds by value after render (`schemaForm` seeds selects and switches from `default`). */
function seedInputs(root: HTMLElement, prefix: string, values: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(values)) {
		const control = root.querySelector(`#${prefix}${name}`);
		if (control instanceof HTMLElement && (control.localName === 'wa-input' || control.localName === 'wa-textarea')) {
			(control as HTMLElement & { value: string }).value = value;
		}
	}
}

/** A labelled kit input for the providers sub-form. */
function providerInput(label: string, value: string, hint: string, onInput: (value: string) => void): HTMLElement {
	const input = el('wa-input', { label, value, hint, size: 's' });
	on(input, 'input', () => onInput((input as HTMLElement & { value: string }).value));
	return input;
}

/** A labelled kit select for the providers sub-form. */
function providerSelect(
	label: string,
	value: string,
	options: ReadonlyArray<{ readonly id: string; readonly label: string }>,
	onChange: (value: string) => void,
): HTMLElement {
	const select = el(
		'wa-select',
		{ label, value, size: 's' },
		options.map((option) => el('wa-option', { value: option.id, text: option.label })),
	);
	on(select, 'change', () => onChange((select as HTMLElement & { value: string }).value));
	return select;
}

/**
 * The composer drawer (frontend §2(a)): a preset picker, the settings form (one group per catalogue section, the
 * schema form inside), the providers sub-form, and the four outputs with a copy button each. Everything is derived
 * from the form by the pure generators; the footer says how it is applied. Nothing is sent (G4).
 */
function openComposer(composer: Composer, diag: SystemDiagnostics): void {
	const seed = runningValues(diag.config, diag);
	let providers: ProviderDraft[] = [];
	let forms: Array<{ read(): Record<string, unknown> }> = [];
	let scheduled = false;

	// --- outputs
	// `textView` of nothing is an empty `pre.code`; the class is not spelled here (the glyph-literal pin).
	const envPre = textView('');
	const composePre = textView('');
	const providersHost = el('div', { class: 'sys-json' });
	const diffHost = el('div');
	const diffTab = el('wa-tab', { panel: 'changes', text: 'Diff' });
	const fault = el('wa-callout', { class: 'sys-composer-fault', variant: 'danger', size: 's', hidden: true });
	let outputs = { env: '', compose: '', providersFile: '' };
	const out = el('div', { class: 'sys-composer-out' }, [
		fault,
		el('wa-tab-group', {}, [
			el('wa-tab', { panel: 'env', text: '.env' }),
			el('wa-tab', { panel: 'compose', text: 'compose' }),
			el('wa-tab', { panel: 'providers', text: 'providers.json' }),
			diffTab,
			el('wa-tab-panel', { name: 'env' }, [
				el('div', { class: 'sys-json' }, [copyButton(() => outputs.env, 'Copy .env'), envPre]),
			]),
			el('wa-tab-panel', { name: 'compose' }, [
				el('div', { class: 'sys-json' }, [copyButton(() => outputs.compose, 'Copy compose override'), composePre]),
			]),
			el('wa-tab-panel', { name: 'providers' }, [providersHost]),
			el('wa-tab-panel', { name: 'changes' }, [diffHost]),
		]),
	]);

	function recompute(): void {
		scheduled = false;
		let read: Record<string, unknown> = {};
		try {
			for (const form of forms) read = { ...read, ...form.read() };
			fault.hidden = true;
		} catch (cause) {
			fault.textContent = messageOf(cause);
			fault.hidden = false;
			return;
		}
		const result = composer.composeOutputs(read, providers, diag);
		outputs = result;
		envPre.textContent = result.env;
		composePre.textContent = result.compose;
		providersHost.replaceChildren(
			copyButton(() => outputs.providersFile, 'Copy providers.json'),
			jsonView(result.providersFile),
		);
		diffHost.replaceChildren(diffView(result.diff.map((row) => ({
			key: row.key,
			before: row.before,
			after: row.after,
			tags: [
				...(row.compare === 'cannot compare'
					? [rowTag('cannot compare', '', 'The diagnostics do not report it.')]
					: []),
				...(row.reach ? [rowTag('widens reach', 'warn')] : []),
			],
		}))));
		diffTab.textContent = result.diff.length === 0 ? 'Diff' : `Diff (${result.diff.length})`;
	}
	function schedule(): void {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(recompute);
	}

	// --- the settings form, one group per section
	const formHost = el('div', { class: 'sys-composer-form' });
	function renderForm(values: Readonly<Record<string, string>>, open: ReadonlySet<SettingSection>): void {
		clear(formHost);
		forms = [];
		for (const section of SECTIONS) {
			const schema = settingsSchema(section, values);
			const names = Object.keys(schema.properties ?? {});
			if (names.length === 0) continue;
			const form = schemaForm(schema, 'cfg-');
			seedInputs(form.node, 'cfg-', values);
			forms.push(form);
			const touched = names.filter((name) => values[name] !== undefined).length;
			formHost.append(el('wa-details', { class: 'sys-section', open: open.has(section) }, [
				el('span', { slot: 'summary' }, [
					el('span', { text: SECTION_WORDS[section] }),
					...(touched === 0 ? [] : [el('span', { class: 'sys-section-count', text: String(touched) })]),
				]),
				form.node,
			]));
		}
	}

	// --- the providers sub-form
	const providerList = el('div', { class: 'sys-provider-list' });
	function renderProviders(): void {
		clear(providerList);
		providers.forEach((draft, index) => {
			const current = (): ProviderDraft => providers[index] ?? draft;
			const update = (patch: Partial<ProviderDraft>): void => {
				providers[index] = { ...current(), ...patch };
				schedule();
			};
			const keyPath = providerInput(
				'Key file path',
				composer.keyPathOf(draft.key) ?? '',
				'An absolute path the server reads; the key never enters this page.',
				(value) => update({ key: composer.providerKey(current().key.mode, value) }),
			);
			keyPath.hidden = composer.keyPathOf(draft.key) === undefined;
			const remove = button({ label: 'Remove', variant: 'ghost', small: true });
			remove.classList.add('destructive');
			on(remove, 'click', () => {
				providers = providers.filter((_, at) => at !== index);
				renderProviders();
				schedule();
			});
			providerList.append(el('div', { class: 'sys-provider-card' }, [
				providerInput('Id', draft.id, 'Lower-case letters, digits, - and _.', (value) => update({ id: value })),
				providerSelect('Kind', draft.kind, [
					{ id: 'openai', label: 'OpenAI-compatible' },
					{ id: 'anthropic', label: 'Anthropic' },
				], (value) => update({ kind: value === 'anthropic' ? 'anthropic' : 'openai' })),
				providerInput(
					'Base URL',
					draft.baseUrl,
					'https://, or http:// on loopback or a private host.',
					(value) => update({ baseUrl: value }),
				),
				providerInput(
					'Models',
					draft.models.join(', '),
					'Comma-separated model ids.',
					(value) => update({ models: value.split(',').map((item) => item.trim()).filter((item) => item !== '') }),
				),
				providerInput(
					'Default model',
					draft.defaultModel ?? '',
					'One of the models.',
					(value) => update({ defaultModel: value === '' ? undefined : value }),
				),
				providerSelect('Key', draft.key.mode, composer.KEY_MODES, (value) => {
					const key = composer.providerKey(value, composer.keyPathOf(current().key) ?? '');
					update({ key });
					keyPath.hidden = composer.keyPathOf(key) === undefined;
				}),
				keyPath,
				el('div', { class: 'sys-provider-foot' }, [
					el('span', { text: 'No key is typed here: the file carries REPLACE_WITH_KEY or a path.' }),
					remove,
				]),
			]));
		});
	}
	const providerAdd = el(
		'div',
		{ class: 'sys-provider-add' },
		composer.PROVIDER_PRESETS.map((entry) => {
			const add = button({ label: `+ ${entry.label}`, small: true });
			on(add, 'click', () => {
				providers.push({ ...entry.draft, models: [...entry.draft.models] });
				renderProviders();
				schedule();
			});
			return add;
		}),
	);
	const providersSection = el('wa-details', { class: 'sys-section sys-providers-form' }, [
		el('span', { slot: 'summary', text: 'Model providers file' }),
		providerAdd,
		providerList,
	]);

	// --- presets: native radio tiles (the Users scope-tile pattern)
	function choose(next: ConfigPreset): void {
		providers = (next.providers ?? []).map((draft) => ({ ...draft, models: [...draft.models] }));
		const values = composer.applyPreset(seed, next);
		// The first section (reachability) and the sections the preset touches open; the rest stay folded.
		const open = new Set<SettingSection>(SECTIONS.slice(0, 1));
		for (const name of Object.keys(next.values)) {
			const section = settingOf(name)?.section;
			if (section !== undefined) open.add(section);
		}
		renderForm(values, open);
		renderProviders();
		providersSection.open = providers.length > 0;
		schedule();
	}
	const presetTiles = el(
		'div',
		{ class: 'sys-preset-tiles' },
		composer.PRESETS.map((entry, index) => {
			const box = el('input', {
				type: 'radio',
				name: 'sys-preset',
				value: entry.id,
				class: 'sys-preset-box',
				checked: index === 0,
			});
			on(box, 'change', () => {
				if (box.checked) choose(entry);
			});
			return el('label', { class: 'sys-preset' }, [
				box,
				el('span', { class: 'sys-preset-name', text: entry.label }),
				el('span', { class: 'sys-preset-hint', text: entry.explain }),
			]);
		}),
	);
	const presets = el('fieldset', { class: 'sys-presets' }, [
		el('legend', { class: 'sys-presets-legend', text: 'Preset' }),
		presetTiles,
	]);

	const body = el('div', { class: 'sys-composer-body' }, [
		presets,
		el('div', { class: 'sys-composer-left' }, [formHost, providersSection]),
		out,
	]);
	on(body, 'input', schedule);
	on(body, 'change', schedule);
	on(body, 'click', schedule);
	const heading = el('span', { slot: 'label', class: 'sys-composer-title' }, [
		icon(G.composer),
		el('span', { text: 'Compose configuration' }),
	]);
	const footer = el('p', { slot: 'footer', class: 'sys-composer-apply' }, [
		el('span', { text: 'Apply by restarting with these values. Nothing is sent from this page.' }),
	]);
	const node = el('wa-drawer', { class: 'sys-composer', label: 'Compose configuration', placement: 'end' }, [
		heading,
		body,
		footer,
	]);
	node.addEventListener('wa-after-hide', (event) => {
		// Kit overlays inside the drawer emit the same event; only the drawer's own ends it.
		if (event.target !== node) return;
		node.remove();
		if (composerDrawer === node) composerDrawer = null;
	});
	document.body.append(node);
	composerDrawer = node;
	choose(composer.PRESETS[0]!);
	// Not if the screen was left before the frame (BUG-2).
	requestAnimationFrame(() => {
		if (composerDrawer === node) node.open = true;
	});
}

// --- the screen -------------------------------------------------------------------------------------------------

/**
 * One tab of the System screen (D-149). Every tab polls the diagnostics (the bar's Raw and Compose actions read
 * them, and they are the admin gate) and reads the capabilities document once (the Raw modal's second tab); the
 * Overview draws them as tiles and facts, the MCP tab adds the tool list and the origins, and the Configuration tab
 * draws the catalogue.
 */
export function systemView(navigate: Navigate, tabParam?: string): void {
	const tab = systemTabOf(tabParam);
	const noticeText = el('span');
	const noticeGlyph = icon(G.notice);
	noticeGlyph.setAttribute('slot', 'icon');
	const notice = el('wa-callout', { class: 'sys-notice', variant: 'warning', size: 's', hidden: true }, [
		noticeGlyph,
		noticeText,
	]);
	// The heap tile's glyph is a ring that fills with heap use.
	const heapRing = meterRing(G.heap, 'Heap used');
	const ring = heapRing.node;
	ring.classList.add('sys-ring');
	const tiles = {
		status: statTile(G.gateway, 'Gateway', 'ok'),
		uptime: statTile(G.uptime, 'Uptime', 'accent'),
		heap: statTile(G.heap, 'Heap', 'agent', ring),
		sessions: statTile(G.sessions, 'Sessions'),
		viewers: statTile(G.viewers, 'Viewers'),
		tools: statTile(G.tools, 'Tools', 'accent'),
	};

	// Overview: the capabilities and, beside them, Network over Process; one column on a narrow screen.
	const capsSlot = el('div', { class: 'sys-slot sys-caps-slot' }, [skeleton(4)]);
	const networkSlot = el('div', { class: 'sys-slot' });
	const process = processPanel();
	process.node.hidden = true;
	// MCP: Tool access beside Events, then Protocol and the origins across the width.
	const mcpSlot = el('div', { class: 'sys-slot sys-mcp-slot' }, [skeleton(4)]);
	// Configuration: the catalogue.
	const configuration = configurationTab();

	let body: HTMLElement[];
	if (tab === 'overview') {
		body = [
			el('div', { class: 'tiles sys-tiles' }, Object.values(tiles).map((tile) => tile.node)),
			notice,
			el('div', { class: 'sys-grid sys-overview' }, [
				capsSlot,
				el('div', { class: 'sys-side' }, [networkSlot, process.node]),
			]),
		];
	} else if (tab === 'mcp') {
		body = [notice, el('div', { class: 'sys-grid sys-mcp' }, [mcpSlot])];
	} else if (tab === 'agents') {
		const agents = agentsTab(navigate);
		void agents.load().catch((cause) => toast(`Could not load the agent settings: ${messageOf(cause)}`, 'error'));
		body = [notice, agents.node];
	} else {
		configuration.node.hidden = true;
		body = [notice, configuration.node];
	}
	// The poll stops itself once this node leaves the document.
	const anchor = body[body.length - 1]!;
	let configSignature = '';

	let latest: SystemDiagnostics | null = null;
	let latestCaps: Capabilities | null = null;

	// The two bar actions are shown once the diagnostics answer: without `admin` the page keeps its notice only.
	const rawAction = iconButton(G.raw, 'Raw', () => {
		if (latest !== null) openRaw(latest, latestCaps);
	});
	const composeAction = iconButton(G.composer, 'Compose configuration', () => {
		const diag = latest;
		if (diag === null) return;
		void busy(composeAction, async () => {
			// The composer's generators load on first use; they are not part of the screen's chunk.
			const composer = await import('./config_composer.ts');
			openComposer(composer, diag);
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});
	rawAction.hidden = composeAction.hidden = true;

	/** The screen stays live (D-092: no refresh or pause controls) until the server refuses it. */
	let auto = true;

	function renderDiagnostics(diag: SystemDiagnostics): void {
		latest = diag;
		rawAction.hidden = composeAction.hidden = false;
		tiles.status.set(diag.status.toUpperCase(), `v${diag.version}`);
		tiles.status.node.classList.toggle('ok', diag.status === 'ok');
		tiles.status.node.classList.toggle('warn', diag.status !== 'ok');
		// The context bar's health dot already says "online"; the metric speaks up only when something is off.
		tiles.status.node.hidden = diag.status === 'ok';
		tiles.uptime.set(uptime(diag.uptimeSeconds), `${diag.uptimeSeconds.toLocaleString()} s`);
		const fraction = diag.memory.heapTotal > 0
			? Math.min(1, Math.max(0, diag.memory.heapUsed / diag.memory.heapTotal))
			: 0;
		const percent = Math.round(fraction * 100);
		tiles.heap.set(
			formatBytes(diag.memory.heapUsed),
			`${percent}% of ${formatBytes(diag.memory.heapTotal)} · resident ${formatBytes(diag.memory.rss)} · external ${
				formatBytes(diag.memory.external)
			}`,
		);
		heapRing.set(percent / 100);
		ring.setAttribute('aria-label', `Heap ${percent}% used`);
		ring.classList.toggle('hot', fraction > 0.85);
		tiles.sessions.set(`${diag.sessions.active}/${diag.sessions.total}`, 'active / total');
		tiles.viewers.set(String(diag.sessions.viewers), 'connected');
		process.node.hidden = false;
		process.update(diag);

		// The configuration rarely changes; redrawing it every poll would only replay its entrance.
		const signature = JSON.stringify([diag.version, diag.config, sandboxBackend(diag.config, diag)]);
		const changed = signature !== configSignature;
		if (changed) {
			configSignature = signature;
			clear(capsSlot);
			capsSlot.append(capabilityGrid(diag.config, diag));
			networkSlot.replaceChildren(networkPanel(diag));
			configuration.node.hidden = false;
		}
		configuration.update(diag, changed);
	}

	async function loadExtras(): Promise<void> {
		const [caps, tools, origins] = await Promise.allSettled([
			mcp.read('ttk://capabilities'),
			mcp.tools(),
			tab === 'mcp' ? api.origins() : Promise.reject(new Error('not on this tab')),
		]);
		const toolCount = tools.status === 'fulfilled' ? tools.value.length : 0;
		tiles.tools.set(tools.status === 'fulfilled' ? String(toolCount) : '—', 'served to this credential');
		if (caps.status === 'fulfilled' && caps.value[0]?.text !== undefined) {
			latestCaps = JSON.parse(caps.value[0].text) as Capabilities;
		}
		if (tab !== 'mcp') return;
		clear(mcpSlot);
		if (latestCaps !== null) {
			mcpSlot.append(
				toolAccessPanel(latestCaps, toolCount, navigate),
				eventsPanel(latestCaps),
				protocolPanel(latestCaps),
			);
		}
		if (origins.status === 'fulfilled') mcpSlot.append(originsPanel(origins.value, () => void loadExtras()));
		if (mcpSlot.childElementCount === 0) {
			mcpSlot.append(el('p', { class: 'muted', text: 'The MCP documents could not be read for this credential.' }));
		}
	}

	async function load(): Promise<void> {
		try {
			const diag = await api.diagnostics();
			notice.hidden = true;
			renderDiagnostics(diag);
		} catch (cause) {
			notice.hidden = false;
			// Nothing is coming to replace the loading placeholders; leave the notice to explain.
			if (capsSlot.querySelector('.skeleton-group') !== null) clear(capsSlot);
			const forbidden = cause instanceof ApiError && cause.status === 403;
			noticeText.textContent = forbidden
				? 'Access denied. The diagnostics endpoint requires the admin scope.'
				: `Failed to load diagnostics: ${messageOf(cause)}`;
			// A refusal will not change on its own; polling it would only spend the rate budget (D-070).
			if (forbidden) auto = false;
		}
	}

	mount(
		renderShell(navigate, {
			active: 'system',
			title: 'System',
			subtitle: 'Telemetry, security posture, MCP capabilities, model providers and agent protocols',
			tabs: systemTabs(tab),
			actions: [composeAction, rawAction],
		}, body),
	);
	// The composer drawer and the Raw modal live on the body: leaving the screen takes them down (BUG-2). The poll
	// clears itself once the tab's content is gone.
	onLeave(closeOverlays);
	void load();
	void loadExtras().catch((cause) => toast(`Could not load the MCP documents: ${messageOf(cause)}`, 'error'));
	poll(anchor, 5000, () => {
		if (auto) void load();
	});
}
