/**
 * The agent-facing groups of the Resources tree (D-152): **Agents** (the A2A agent card and endpoints, the model
 * providers, the ACP coding-agent bridge and the A2A peers), **Surfaces** (the A2UI surfaces agents published, and
 * the actions their buttons may bind) and **Sandbox** (the coding workspaces). Each lists itself from the routes and
 * tools the server already serves; nothing here writes. Managing what they show lives in one place each — providers
 * on System › Agents, surfaces and tasks on the Agents screen, workspaces on Sessions › Workspaces — and the viewer
 * links there rather than repeating the controls (D-092).
 *
 * The tools of each group (`agent_*`, `a2ui_*`, `sandbox_*`) are leaves of the group's Tools branch, added by the
 * screen like every other group's.
 */
import type { A2uiSurface } from '@tykotech/wire';
import { type AgentCard, api, ApiError, getUser, type ProviderInfo, type ProvidersResponse, send } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { jsonFacts } from './json_facts.ts';
import { mcp } from './mcp.ts';
import { tool } from './resources_drawer.ts';
import { AGENT_TARGET_PREFIX, preferTarget } from './task_composer.ts';
import { type Group, type GroupContext, setBranchCount, treeBranch, treeLeaf, viewerHead } from './resources_view.ts';
import { button, copyButton, dot, empty, jsonView, messageOf, segmented, skeleton, tag, tip } from './ui.ts';

const AGENT_SCOPE = 'agent:invoke';

/** Why an agent route refused, in words a person can act on. */
function refusal(cause: unknown): string {
	if (cause instanceof ApiError && cause.status === 403) {
		return `This credential lacks ${AGENT_SCOPE}. An administrator grants it on the Users screen.`;
	}
	return messageOf(cause);
}

/** One endpoint row: what it is, the absolute URL in mono with a copy button, and the binding as a tag. */
function endpointRow(glyph: IconName, name: string, path: string, binding: string, hint: string): HTMLElement {
	const url = new URL(path, location.origin).href;
	const row = el('div', { class: 'rx-endpoint' }, [
		el('span', { class: 'rx-endpoint-glyph', 'aria-hidden': 'true' }, [icon(glyph)]),
		el('div', { class: 'rx-endpoint-text' }, [
			el('span', { class: 'rx-endpoint-name', text: name }),
			el('code', { class: 'rx-endpoint-url mono', text: url }),
		]),
		tag(binding),
		copyButton(() => url, `Copy ${name} URL`),
	]);
	return tip(row, hint, 'top');
}

/** A titled block of the viewer body: a small section label over its content. */
function section(title: string, body: Node[], actions: Node[] = []): HTMLElement {
	return el('section', { class: 'rx-section' }, [
		el('div', { class: 'rx-section-head' }, [
			el('h3', { class: 'rx-section-title', text: title }),
			el('span', { class: 'grow' }),
			...actions,
		]),
		...body,
	]);
}

/** A JSON value as facts, or raw on the switch. */
function factsOrRaw(value: unknown): HTMLElement {
	const body = el('div', { class: 'rx-json-body' });
	const paint = (mode: string): void => {
		body.replaceChildren(mode === 'raw' ? jsonView(value) : jsonFacts(value));
	};
	const toggle = segmented([{ id: 'facts', label: 'Facts' }, { id: 'raw', label: 'Raw' }], 'facts', paint);
	toggle.node.setAttribute('aria-label', 'JSON view');
	paint('facts');
	return el('div', { class: 'rx-json' }, [el('div', { class: 'rx-json-tools' }, [toggle.node]), body]);
}

// --- Agents ----------------------------------------------------------------------------------------------------------

/**
 * The Agents group: A2A (the public card and the two bindings), the model providers this credential may see, the ACP
 * bridge and the configured peers. The card is public, so it always lists; the rest needs `agent:invoke`.
 */
export function agentsGroup(ctx: GroupContext): Group {
	const node = treeBranch('group:agents', 'Agents', 'agents', 'A2A, model providers, the ACP bridge and peers');
	const a2a = treeBranch('agent:a2a', 'A2A', 'a2a', 'The A2A agent card and its JSON-RPC and HTTP+JSON bindings');
	const providersBranch = treeBranch(
		'agent:providers',
		'Model providers',
		'model',
		'The model providers the built-in agent runs on',
	);
	const acp = treeLeaf('agent:acp', 'Coding agent (ACP)', 'acp', 'The ACP bridge to a coding agent');
	// D-156: the built-in coding agent, its own A2A agent.
	const sloplord = treeLeaf('agent:sloplord', 'SlopLord', 'code', 'The built-in coding agent, served over A2A');
	const peersLeaf = treeLeaf('agent:peers', 'Peers', 'peers', 'A2A peers this server may delegate to');
	let card: AgentCard | null = null;
	let cardError: string | null = null;
	let providers: ProvidersResponse | null = null;
	let providersError: string | null = null;
	let peers: string[] | null = null;
	let peersError: string | null = null;
	let listing: Promise<void> | null = null;

	const manage = (): HTMLButtonElement =>
		button({
			label: 'Manage providers',
			icon: 'provider',
			small: true,
			onClick: () => ctx.navigate('#/system/agents'),
		});

	function showA2a(): void {
		const skills = card?.skills ?? [];
		const caps = card?.capabilities ?? {};
		ctx.show('agent:a2a', [
			viewerHead({
				glyph: 'a2a',
				kind: 'Agent-to-Agent protocol',
				title: card?.name ?? 'A2A',
				mono: false,
				tags: [
					...(card?.version === undefined ? [] : [tip(tag(`v${card.version}`), 'Card version')]),
					tip(tag(`${skills.length} skills`, 'skills'), 'Skills the public card advertises'),
					...(caps.pushNotifications === true ? [tag('push', 'webhook', 'ok')] : []),
				],
				actions: [copyButton(() => new URL('/.well-known/agent-card.json', location.origin).href, 'Copy card URL')],
			}),
			el('div', { class: 'rx-body' }, [
				...(card?.description === undefined ? [] : [el('p', { class: 'rx-lede', text: card.description })]),
				section('Endpoints', [
					el('div', { class: 'rx-endpoints' }, [
						endpointRow(
							'id-card',
							'Agent card',
							'/.well-known/agent-card.json',
							'public',
							'The public card: who this agent is, its bindings and skills',
						),
						endpointRow(
							'a2a',
							'JSON-RPC',
							'/a2a',
							'JSONRPC',
							'SendMessage, GetTask, CancelTask, ListTasks, push configs — bearer with agent:invoke, A2A-Version: 1.0',
						),
						endpointRow(
							'link',
							'HTTP+JSON',
							'/a2a/v1',
							'HTTP+JSON',
							'message:send, tasks, tasks/{id}:cancel, :subscribe, pushNotificationConfigs',
						),
					]),
				]),
				...(skills.length === 0 ? [] : [
					section('Skills', [
						el(
							'div',
							{ class: 'rx-cards' },
							skills.map((skill) =>
								el('div', { class: 'rx-card static' }, [
									el('span', { class: 'rx-card-glyph', 'aria-hidden': 'true' }, [icon('sparkles')]),
									el('div', { class: 'rx-card-text' }, [
										el('span', { class: 'rx-card-title', text: skill.name ?? skill.id }),
										el('span', { class: 'rx-card-hint', text: skill.description ?? skill.id }),
									]),
								])
							),
						),
					]),
				]),
				section('Card', [cardError === null ? factsOrRaw(card ?? {}) : empty('lock', 'Card unavailable', cardError)]),
			]),
		]);
	}

	/**
	 * D-156: SlopLord — whether this deployment can run it, its own A2A card and endpoints (static paths: the card is
	 * public, so they are shown even to a credential that cannot read the providers route), and a way into the chat.
	 */
	function showSlopLord(): void {
		const info = providers?.agents?.find((agent) => agent.id === 'sloplord');
		const base = '/a2a/agents/sloplord';
		const cardPath = `${base}/.well-known/agent-card.json`;
		const available = info?.available === true;
		ctx.show('agent:sloplord', [
			viewerHead({
				glyph: 'code',
				kind: 'Built-in coding agent',
				title: 'SlopLord',
				mono: false,
				tags: [
					info === undefined
						? tip(tag('unknown', 'lock', 'warn'), providersError ?? 'This gateway does not list SlopLord')
						: available
						? tag('available', 'check', 'ok')
						: tip(
							tag('unavailable', 'lock', 'warn'),
							'Needs the coding sandbox and a reachable model provider (System › Agents)',
						),
				],
				actions: [
					copyButton(() => new URL(cardPath, location.origin).href, 'Copy card URL'),
					...(available
						? [button({
							label: 'Chat with SlopLord',
							icon: 'agents',
							small: true,
							onClick: () => {
								preferTarget(`${AGENT_TARGET_PREFIX}sloplord`);
								ctx.navigate('#/agents');
							},
						})]
						: []),
				],
			}),
			el('div', { class: 'rx-body' }, [
				el('p', {
					class: 'rx-lede',
					text: info?.description ??
						'Built-in coding agent: works in your private sandbox workspace, runs commands and tests, iterates ' +
							'until they pass, then reports concisely.',
				}),
				section('Endpoints', [
					el('div', { class: 'rx-endpoints' }, [
						endpointRow('id-card', 'Agent card', cardPath, 'public', "SlopLord's own public A2A card"),
						endpointRow(
							'a2a',
							'JSON-RPC',
							base,
							'JSONRPC',
							'Every message runs on SlopLord — bearer with agent:invoke, model:invoke, mcp:invoke and ' +
								'sandbox:execute; A2A-Version: 1.0',
						),
						endpointRow('link', 'HTTP+JSON', `${base}/v1`, 'HTTP+JSON', 'message:send, tasks, tasks/{id}:cancel'),
					]),
				]),
			]),
		]);
	}

	function providerRow(provider: ProviderInfo, fallback: string | null): HTMLElement {
		const row = el('button', { type: 'button', class: 'rx-row' }, [
			el('span', { class: 'rx-glyph' }, [icon('model')]),
			el('span', { class: 'rx-row-name', text: provider.label }),
			el('code', { class: 'rx-row-uri mono', text: `${provider.kind} · ${provider.models.length} models` }),
			...(provider.id === fallback ? [tag('default', 'check', 'ok')] : []),
			dot(provider.reachable ? 'live' : 'warn', provider.reachable ? 'Reachable' : provider.reason ?? 'Not reachable'),
		]);
		on(row, 'click', () => showProvider(provider.id));
		return row;
	}

	function showProviders(): void {
		const list = providers?.providers ?? [];
		const admin = getUser()?.scopes.includes('admin') === true;
		ctx.show('agent:providers', [
			viewerHead({
				glyph: 'model',
				kind: 'Model providers',
				title: 'Model providers',
				mono: false,
				tags: [
					tip(tag(String(list.length)), 'Providers'),
					...(providers === null ? [] : [
						providers.invocable
							? tag('model:invoke', 'check', 'ok')
							: tip(tag('needs model:invoke', 'lock', 'warn'), 'Text tasks on a provider need model:invoke'),
					]),
				],
				actions: admin ? [manage()] : [],
			}),
			el('div', { class: 'rx-body' }, [
				providersError !== null ? empty('lock', 'Providers unavailable', providersError) : list.length === 0
					? empty(
						'model',
						'No model providers',
						"The built-in agent runs on the providers file's providers and those added on System › Agents.",
						admin ? manage() : undefined,
					)
					: el('div', { class: 'rx-rows', role: 'list' }, list.map((p) => providerRow(p, providers?.default ?? null))),
			]),
		]);
	}

	function showProvider(id: string): void {
		const provider = providers?.providers.find((entry) => entry.id === id);
		if (provider === undefined) {
			showProviders();
			return;
		}
		const admin = getUser()?.scopes.includes('admin') === true;
		ctx.show(`provider:${id}`, [
			viewerHead({
				glyph: 'model',
				kind: `${provider.kind} provider`,
				title: provider.label,
				mono: false,
				tags: [
					tag(provider.kind, 'brain'),
					tip(tag(provider.id), 'Provider id'),
					provider.reachable
						? tag('reachable', 'check', 'ok')
						: tip(tag('not reachable', 'alert', 'warn'), provider.reason ?? 'Not reachable'),
					...(provider.id === providers?.default ? [tag('default', 'check', 'ok')] : []),
				],
				actions: admin ? [manage()] : [],
			}),
			el('div', { class: 'rx-body' }, [
				section('Models', [
					el(
						'div',
						{ class: 'rx-chips' },
						provider.models.map((model) =>
							el('span', { class: `rx-chip mono${model === provider.default_model ? ' on' : ''}`, text: model })
						),
					),
				]),
				section('Facts', [factsOrRaw(provider)]),
			]),
		]);
	}

	function showAcp(): void {
		const configured = providers?.acp === true;
		ctx.show('agent:acp', [
			viewerHead({
				glyph: 'acp',
				kind: 'Agent Client Protocol bridge',
				title: 'Coding agent (ACP)',
				mono: false,
				tags: [configured ? tag('configured', 'check', 'ok') : tag('not configured', 'circle-dashed')],
			}),
			el('div', { class: 'rx-body' }, [
				providersError !== null
					? empty('lock', 'Bridge state unavailable', providersError)
					: section(configured ? 'Configured' : 'Not configured', [
						el('p', {
							class: 'rx-lede',
							text: configured
								? 'A text task sent without a provider runs on the coding agent behind the bridge; agent_prompt ' +
									'is served. Editors connect through `tykotech-mcp acp`, which relays ACP over stdio to the bridge.'
								: 'Set TTK_AGENT_BRIDGE_URL and TTK_AGENT_BRIDGE_TOKEN_FILE (and run the agent runner) to give ' +
									'text tasks a coding agent. System › Configuration lists every agent setting.',
						}),
					]),
			]),
		]);
	}

	function showPeers(): void {
		const list = peers ?? [];
		ctx.show('agent:peers', [
			viewerHead({
				glyph: 'peers',
				kind: 'A2A peers',
				title: 'Peers',
				mono: false,
				tags: [tip(tag(String(list.length)), 'Configured peers')],
			}),
			el('div', { class: 'rx-body' }, [
				peersError !== null
					? empty('lock', 'Peers unavailable', peersError)
					: list.length === 0
					? empty('peers', 'No peers', 'TTK_AGENT_PEERS_FILE names the A2A peers this server may delegate to.')
					: el(
						'div',
						{ class: 'rx-rows', role: 'list' },
						list.map((peer) =>
							el('div', { class: 'rx-row static', role: 'listitem' }, [
								el('span', { class: 'rx-glyph' }, [icon('peers')]),
								el('span', { class: 'rx-row-name mono', text: peer }),
								el('span', { class: 'rx-row-uri', text: 'agent_delegate target' }),
							])
						),
					),
			]),
		]);
	}

	function load(again = false): Promise<void> {
		if (!again && listing !== null) return listing;
		listing = (async () => {
			const [cardResult, providersResult] = await Promise.allSettled([api.agentCard(), api.listProviders()]);
			card = cardResult.status === 'fulfilled' ? cardResult.value : null;
			cardError = cardResult.status === 'rejected' ? messageOf(cardResult.reason) : null;
			providers = providersResult.status === 'fulfilled' ? providersResult.value : null;
			providersError = providersResult.status === 'rejected' ? refusal(providersResult.reason) : null;
			try {
				const served = (await mcp.tools()).some((entry) => entry.name === 'agent_peers');
				peers = served ? (await tool<{ peers: Array<{ id: string }> }>('agent_peers', {})).peers.map((p) => p.id) : [];
				peersError = served ? null : `This credential lacks ${AGENT_SCOPE}.`;
			} catch (cause) {
				peers = [];
				peersError = messageOf(cause);
			}
			if (!ctx.alive()) return;
			for (const child of Array.from(providersBranch.querySelectorAll(':scope > wa-tree-item'))) child.remove();
			const list = providers?.providers ?? [];
			providersBranch.append(
				...list.map((provider) =>
					treeLeaf(
						`provider:${provider.id}`,
						provider.label,
						'model',
						`${provider.kind} · ${provider.models.join(', ')}`,
					)
				),
			);
			setBranchCount(providersBranch, providersError === null ? String(list.length) : null);
			setBranchCount(a2a, String(card?.skills?.length ?? 0));
			setBranchCount(node, String(list.length + (peers?.length ?? 0) + (providers?.acp ? 1 : 0)));
			ctx.commands('agents', [
				{ id: 'agent:a2a', label: 'A2A agent card', icon: 'a2a', group: 'Agents', run: showA2a },
				{ id: 'agent:sloplord', label: 'SlopLord', icon: 'code', group: 'Agents', run: showSlopLord },
				{ id: 'agent:providers', label: 'Model providers', icon: 'model', group: 'Agents', run: showProviders },
				...list.map((provider) => ({
					id: `provider:${provider.id}`,
					label: provider.label,
					icon: 'model' as IconName,
					hint: provider.kind,
					group: 'Agents',
					run: () => showProvider(provider.id),
				})),
			]);
		})();
		return listing;
	}

	node.append(a2a, sloplord, providersBranch, acp, peersLeaf);
	return {
		node,
		load,
		async open(rest) {
			await load();
			if (!ctx.alive()) return;
			if (rest === undefined || rest === '' || rest === 'a2a') showA2a();
			else if (rest === 'providers') showProviders();
			else if (rest.startsWith('provider/')) showProvider(rest.slice('provider/'.length));
			else if (rest === 'acp') showAcp();
			else if (rest === 'sloplord') showSlopLord();
			else if (rest === 'peers') showPeers();
			else showA2a();
		},
	};
}

// --- Surfaces --------------------------------------------------------------------------------------------------------

/** The Surfaces group: every A2UI surface this owner published, drawn live, and the action names buttons may bind. */
export function surfacesGroup(ctx: GroupContext): Group {
	const node = treeBranch('group:surfaces', 'Surfaces', 'surface', 'A2UI surfaces agents published, and their actions');
	const actionsLeaf = treeLeaf('surfaces:actions', 'Actions', 'control', 'Action names a surface button may bind');
	let surfaces: A2uiSurface[] = [];
	let error: string | null = null;
	let actions: string[] = [];
	let listing: Promise<void> | null = null;
	/** The surface drawn in the viewer, released when another replaces it. */
	let drawn: { node: Element; release: (node: Element) => void } | null = null;

	function release(): void {
		drawn?.release(drawn.node);
		drawn = null;
	}

	function showAll(): void {
		release();
		ctx.show('group:surfaces', [
			viewerHead({
				glyph: 'surface',
				kind: 'A2UI surfaces',
				title: 'Surfaces',
				mono: false,
				tags: [
					tip(tag(String(surfaces.length)), 'Published'),
					tip(tag(`${actions.length} actions`), 'Bindable actions'),
				],
				actions: [
					button({ label: 'Open on Agents', icon: 'agents', small: true, onClick: () => ctx.navigate('#/agents') }),
				],
			}),
			el('div', { class: 'rx-body' }, [
				error !== null ? empty('lock', 'Surfaces unavailable', error) : surfaces.length === 0
					? empty(
						'surface',
						'No surfaces yet',
						'Agents publish them with a2ui_publish; build one on the Agents screen.',
					)
					: el(
						'div',
						{ class: 'rx-rows', role: 'list' },
						surfaces.map((surface) => {
							const row = el('button', { type: 'button', class: 'rx-row', role: 'listitem' }, [
								el('span', { class: 'rx-glyph' }, [icon('surface')]),
								el('span', { class: 'rx-row-name mono', text: surface.surfaceId }),
								el('code', {
									class: 'rx-row-uri mono',
									text: `r${surface.revision} · ${surface.components.length} components`,
								}),
							]);
							on(row, 'click', () => void showSurface(surface.surfaceId));
							return row;
						}),
					),
			]),
		]);
	}

	async function showSurface(id: string): Promise<void> {
		const surface = surfaces.find((entry) => entry.surfaceId === id);
		if (surface === undefined) {
			showAll();
			return;
		}
		const key = `surface:${id}`;
		ctx.loading(key);
		release();
		const preview = el('div', { class: 'rx-surface-preview' }, [skeleton(2)]);
		try {
			const renderer = await import('./a2ui.ts');
			if (!ctx.alive()) return;
			const rendered = renderer.renderA2uiSurface(surface, api.surfaceAction, {
				// D-111: share media is read with this screen's own credential, through the one request path.
				fetchShare: (path, signal) => send(api.shareFilePath(path), { signal }),
			});
			drawn = { node: rendered, release: renderer.releaseA2uiSurface };
			preview.replaceChildren(rendered);
		} catch (cause) {
			preview.replaceChildren(empty('alert', 'Could not draw the surface', messageOf(cause)));
		}
		const bound = surface.availableActions?.length ?? 0;
		ctx.show(key, [
			viewerHead({
				glyph: 'surface',
				kind: 'A2UI surface',
				title: surface.surfaceId,
				tags: [
					tip(tag(`r${surface.revision}`, 'revision'), 'Revision'),
					tip(tag(`${surface.components.length}`, 'grid'), 'Components'),
					tip(tag(`${bound} actions`, 'control', bound > 0 ? 'ok' : ''), 'Authorized actions'),
					tip(tag(surface.catalogId, 'book'), 'Catalog'),
				],
				actions: [copyButton(() => JSON.stringify(surface, null, 2), 'Copy surface JSON')],
			}),
			el('div', { class: 'rx-body' }, [
				section('Preview', [preview]),
				section('Definition', [factsOrRaw(surface)]),
			]),
		]);
	}

	function showActions(): void {
		release();
		ctx.show('surfaces:actions', [
			viewerHead({
				glyph: 'control',
				kind: 'A2UI actions',
				title: 'Actions',
				mono: false,
				tags: [tip(tag(String(actions.length)), 'Bindable action names')],
			}),
			el('div', { class: 'rx-body' }, [
				el('p', {
					class: 'rx-lede',
					text: 'A surface button may bind one of these names. cancelTask and permissionDecision are built in; ' +
						'TTK_A2UI_ACTIONS adds the rest.',
				}),
				el('div', { class: 'rx-chips' }, actions.map((name) => el('span', { class: 'rx-chip mono', text: name }))),
			]),
		]);
	}

	function load(again = false): Promise<void> {
		if (!again && listing !== null) return listing;
		listing = (async () => {
			const [listResult, actionResult] = await Promise.allSettled([api.listSurfaces(), api.listActionNames()]);
			surfaces = listResult.status === 'fulfilled' ? listResult.value.surfaces : [];
			error = listResult.status === 'rejected' ? refusal(listResult.reason) : null;
			actions = actionResult.status === 'fulfilled' ? actionResult.value.names : [];
			if (!ctx.alive()) return;
			for (const child of Array.from(node.querySelectorAll(':scope > wa-tree-item.rx-surface'))) child.remove();
			node.append(...surfaces.map((surface) => {
				const leaf = treeLeaf(
					`surface:${surface.surfaceId}`,
					surface.surfaceId,
					'surface',
					`Revision ${surface.revision}`,
					{ mono: true },
				);
				leaf.classList.add('rx-surface');
				return leaf;
			}));
			setBranchCount(node, error === null ? String(surfaces.length) : null);
			ctx.commands(
				'surfaces',
				surfaces.map((surface) => ({
					id: `surface:${surface.surfaceId}`,
					label: surface.surfaceId,
					icon: 'surface' as IconName,
					hint: `r${surface.revision}`,
					group: 'Surfaces',
					run: () => void showSurface(surface.surfaceId),
				})),
			);
		})();
		return listing;
	}

	node.append(actionsLeaf);
	return {
		node,
		load,
		async open(rest) {
			await load();
			if (!ctx.alive()) return;
			if (rest === undefined || rest === '') showAll();
			else if (rest === '@actions') showActions();
			else await showSurface(rest);
		},
		leave: release,
	};
}

// --- Sandbox ---------------------------------------------------------------------------------------------------------

interface Workspace {
	readonly workspace_id: string;
	readonly name?: string;
	readonly created_at: string;
	readonly busy?: boolean;
}

/** The Sandbox group: the caller's coding workspaces; each opens on Sessions › Workspaces, where its editor lives. */
export function sandboxGroup(ctx: GroupContext): Group {
	const node = treeBranch('group:sandbox', 'Sandbox', 'terminal', 'Coding workspaces and their tools');
	let workspaces: Workspace[] = [];
	let error: string | null = null;
	let listing: Promise<void> | null = null;

	const nameOf = (workspace: Workspace): string => workspace.name ?? workspace.workspace_id.slice(0, 8);

	function showAll(focus?: string): void {
		const chosen = focus === undefined ? undefined : workspaces.find((entry) => entry.workspace_id === focus);
		ctx.show(chosen === undefined ? 'group:sandbox' : `workspace:${chosen.workspace_id}`, [
			viewerHead({
				glyph: chosen === undefined ? 'terminal' : 'workspace',
				kind: chosen === undefined ? 'Coding sandbox' : 'Workspace',
				title: chosen === undefined ? 'Sandbox' : nameOf(chosen),
				mono: chosen !== undefined && chosen.name === undefined,
				tags: chosen === undefined
					? [tip(tag(String(workspaces.length)), 'Workspaces')]
					: [tip(tag(chosen.workspace_id), 'Workspace id'), ...(chosen.busy ? [tag('busy', 'loader', 'warn')] : [])],
				actions: [
					button({
						label: 'Open in Workspaces',
						icon: 'workspace',
						small: true,
						onClick: () =>
							ctx.navigate(
								chosen === undefined ? '#/workspaces' : `#/workspaces/${encodeURIComponent(chosen.workspace_id)}`,
							),
					}),
				],
			}),
			el('div', { class: 'rx-body' }, [
				error !== null
					? empty('lock', 'Workspaces unavailable', error)
					: chosen !== undefined
					? factsOrRaw(chosen)
					: workspaces.length === 0
					? empty('workspace', 'No workspaces', 'Create one on Sessions › Workspaces, or with sandbox_create.')
					: el(
						'div',
						{ class: 'rx-rows', role: 'list' },
						workspaces.map((workspace) => {
							const row = el('button', { type: 'button', class: 'rx-row', role: 'listitem' }, [
								el('span', { class: 'rx-glyph' }, [icon('workspace')]),
								el('span', { class: 'rx-row-name', text: nameOf(workspace) }),
								el('code', { class: 'rx-row-uri mono', text: workspace.workspace_id }),
							]);
							on(row, 'click', () => showAll(workspace.workspace_id));
							return row;
						}),
					),
			]),
		]);
	}

	function load(again = false): Promise<void> {
		if (!again && listing !== null) return listing;
		listing = (async () => {
			try {
				const served = (await mcp.tools()).some((entry) => entry.name === 'sandbox_list');
				if (!served) {
					workspaces = [];
					error = 'No coding sandbox is served to this credential (sandbox:execute, and a deployed sandbox).';
				} else {
					({ workspaces } = await tool<{ workspaces: Workspace[] }>('sandbox_list', {}));
					error = null;
				}
			} catch (cause) {
				workspaces = [];
				error = messageOf(cause);
			}
			if (!ctx.alive()) return;
			for (const child of Array.from(node.querySelectorAll(':scope > wa-tree-item:not(.rx-tools)'))) child.remove();
			node.append(
				...workspaces.map((workspace) =>
					treeLeaf(`workspace:${workspace.workspace_id}`, nameOf(workspace), 'workspace', workspace.workspace_id)
				),
			);
			setBranchCount(node, error === null ? String(workspaces.length) : null);
			ctx.commands(
				'sandbox',
				workspaces.map((workspace) => ({
					id: `workspace:${workspace.workspace_id}`,
					label: nameOf(workspace),
					icon: 'workspace' as IconName,
					hint: workspace.workspace_id,
					group: 'Workspaces',
					run: () => showAll(workspace.workspace_id),
				})),
			);
		})();
		return listing;
	}

	return {
		node,
		load,
		async open(rest) {
			await load();
			if (ctx.alive()) showAll(rest === '' ? undefined : rest);
		},
	};
}
