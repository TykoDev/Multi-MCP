/**
 * A workspace's A2UI surfaces, in Sessions › Workspaces: the interfaces agents publish live with the code they belong
 * to. A surface belongs to a workspace by its `workspaceId` (set by `createSurface`, or attached here,
 * `PATCH /api/v1/a2ui/surfaces/{id}`); each one attached to the open workspace is rendered by `a2ui.ts`, with its
 * revision, its authorized actions, Detach and Delete. Surfaces attached to no workspace are listed under the
 * attached ones, one **Attach here** each, so nothing an agent published is out of reach. **New surface** opens the
 * surface builder; what it publishes is created in this workspace.
 *
 * The panel keeps itself current (a poll; a surface re-renders only when its revision moves, so what a person types
 * into it survives the poll), and releases every rendered surface — share reads aborted, object URLs revoked
 * (R3-4) — when it stops and when a load fails.
 */
import type { A2uiSurface } from '@tykotech/wire';
import { api, ApiError, loadUser, send as authorizedFetch } from './api.ts';
import { el, on } from './dom.ts';
import { icon } from './icons.ts';
import { newSurfaceHome } from './task_composer.ts';
import { busy, button, confirmButton, iconButton, messageOf, toast } from './ui.ts';

/** How often the panel re-reads the surfaces: agents publish while a person watches. */
const SURFACE_POLL_MS = 4000;

/**
 * R3-4: releases every rendered surface the panel holds — its share reads aborted, its object URLs revoked — and
 * forgets them, so the next render starts from nothing. Run when the panel stops and when a load of the surface list
 * fails (whose placeholder replaces the nodes, which must not stay marked as rendered either).
 */
export function releaseSurfaces(
	nodes: Map<string, { readonly surface: Element }>,
	release: ((surface: Element) => void) | null,
): void {
	if (release !== null) { for (const { surface } of nodes.values()) release(surface); }
	nodes.clear();
}

/** The surfaces of one workspace and the ones of none, in the order the server lists them. */
export function surfacesFor(
	surfaces: readonly A2uiSurface[],
	workspaceId: string,
): { attached: A2uiSurface[]; loose: A2uiSurface[] } {
	return {
		attached: surfaces.filter((surface) => surface.workspaceId === workspaceId),
		loose: surfaces.filter((surface) => surface.workspaceId === undefined),
	};
}

/**
 * A message the builder publishes, with this workspace's id on its `createSurface` (one the message already names
 * stays); every other message is returned as it is.
 */
export function inWorkspace(message: unknown, workspaceId: string): unknown {
	if (message === null || typeof message !== 'object' || Array.isArray(message)) return message;
	const create = (message as { createSurface?: unknown }).createSurface;
	if (create === null || typeof create !== 'object' || Array.isArray(create)) return message;
	return { ...message, createSurface: { workspaceId, ...create } };
}

/**
 * BUG-2: the open surface-builder drawer, if any. It lives in `document.body`, outside the panel's nodes, so the
 * panel's `stop()` must close it itself; one builder is open at most, across panels.
 */
let builder: { close(): void } | null = null;

export interface WorkspaceSurfaces {
	readonly node: HTMLElement;
	/** Stops the poll, closes the builder and releases every rendered surface. */
	stop(): void;
}

/** What the panel tells its screen. */
export interface WorkspaceSurfacesOptions {
	/** The number of surfaces in the workspace, each time it is known again (the Surfaces tab's badge). */
	readonly onCount?: (count: number) => void;
}

export function workspaceSurfaces(workspaceId: string, options: WorkspaceSurfacesOptions = {}): WorkspaceSurfaces {
	let alive = true;
	let loading = false;
	let canPublish = false;
	/** The renderer module once a surface needed it; `null` means none was ever rendered. */
	let renderer: typeof import('./a2ui.ts') | null = null;
	const surfaceNodes = new Map<string, { node: HTMLElement; surface: HTMLElement; signature: string }>();
	let looseSignature = '';
	let failed: string | null = null;

	const count = el('span', { class: 'rx-section-count', hidden: true });
	const newSurface = button({ label: 'New surface', icon: 'plus', variant: 'primary', small: true });
	const headActions = el('span', { class: 'ws-surf-actions' });
	const list = el('div', { class: 'ws-surf-list' });
	const empty = el('div', { class: 'ws-surf-empty', hidden: true });
	const looseList = el('div', { class: 'ws-surf-loose', hidden: true });
	const node = el('section', { class: 'ws-surfaces', 'aria-label': 'Surfaces' }, [
		el('header', { class: 'ws-surf-head' }, [
			icon('surface'),
			el('h3', { class: 'rx-section-title', text: 'Surfaces' }),
			count,
			el('span', { class: 'grow' }),
			headActions,
		]),
		list,
		empty,
		looseList,
	]);

	/** D-111: `ttk://share/` media is read with the page's own credential and shown from an object URL. */
	const fetchShare = (path: string, signal: AbortSignal): Promise<Response> =>
		authorizedFetch(api.shareFilePath(path), { signal });

	on(newSurface, 'click', () => {
		void busy(newSurface, () => import('./surface_builder.ts')).then((module) => {
			if (!alive) return;
			builder?.close();
			builder = module.openSurfaceBuilder({
				publish: (message) => api.publishSurface(inWorkspace(message, workspaceId)),
				actionNames: async () => (await api.listActionNames()).names,
				fetchShare,
				onPublished: () => {
					if (alive) void load();
				},
			});
		}).catch((cause) => toast(messageOf(cause), 'error'));
	});

	function paintEmpty(attached: number): void {
		options.onCount?.(attached);
		// D-092: the one New-surface action lives in the header with surfaces, in the empty line without.
		const home = newSurfaceHome(attached, canPublish);
		headActions.replaceChildren(...(home === 'header' ? [newSurface] : []));
		empty.hidden = attached > 0;
		if (attached === 0) {
			empty.replaceChildren(
				el('span', {
					text: 'No surfaces in this workspace yet. Agents add one with a2ui_publish and this workspaceId.',
				}),
				...(home === 'empty' ? [newSurface] : []),
			);
		}
	}

	function card(surface: A2uiSurface, a2ui: typeof import('./a2ui.ts')): { node: HTMLElement; surface: HTMLElement } {
		const actions = surface.availableActions?.length ?? 0;
		const tools: Node[] = [];
		if (canPublish) {
			const detach = iconButton('unplug', 'Detach from this workspace', undefined, { small: true });
			on(detach, 'click', () => {
				void busy(detach, () => api.attachSurface(surface.surfaceId, null)).then(() => {
					toast(`${surface.surfaceId} detached`, 'ok');
					return load();
				}).catch((cause) => toast(messageOf(cause), 'error'));
			});
			// D-092: quiet until reached for, and it asks first.
			const remove = confirmButton(
				{ label: 'Delete surface', icon: 'trash', iconOnly: true, small: true },
				async () => {
					await api.deleteSurface(surface.surfaceId);
					await load();
				},
			);
			remove.classList.add('destructive');
			tools.push(detach, remove);
		}
		const rendered = a2ui.renderA2uiSurface(surface, api.surfaceAction, { fetchShare });
		const node = el('article', { class: 'ws-surface', 'data-surface': surface.surfaceId }, [
			el('header', { class: 'ws-surface-head' }, [
				el('span', { class: 'ws-surface-id mono', text: surface.surfaceId }),
				el('span', {
					class: 'ws-surface-chip',
					role: 'img',
					'aria-label': `Revision ${surface.revision}`,
					'data-tip': `Revision ${surface.revision}`,
				}, [icon('revision'), el('span', { text: String(surface.revision) })]),
				el('span', {
					class: `ws-surface-chip${actions > 0 ? ' live' : ''}`,
					role: 'img',
					'aria-label': actions === 1 ? '1 authorized action' : `${actions} authorized actions`,
					'data-tip': actions === 1 ? '1 authorized action' : `${actions} authorized actions`,
				}, [icon('control'), el('span', { text: String(actions) })]),
				el('span', { class: 'grow' }),
				...tools,
			]),
			el('div', { class: 'ws-surface-body' }, [rendered]),
		]);
		return { node, surface: rendered };
	}

	function renderLoose(loose: readonly A2uiSurface[]): void {
		const signature = JSON.stringify([canPublish, loose.map((surface) => [surface.surfaceId, surface.revision])]);
		if (signature === looseSignature) return;
		looseSignature = signature;
		looseList.hidden = loose.length === 0;
		looseList.replaceChildren(
			el('p', {
				class: 'ws-surf-loose-title',
				text: loose.length === 1 ? '1 surface is in no workspace' : `${loose.length} surfaces are in no workspace`,
			}),
			el(
				'div',
				{ class: 'ws-surf-loose-row' },
				loose.map((surface) => {
					const attach = button({ label: 'Attach here', icon: 'link', small: true, variant: 'ghost' });
					attach.disabled = !canPublish;
					on(attach, 'click', () => {
						void busy(attach, () => api.attachSurface(surface.surfaceId, workspaceId)).then(() => {
							toast(`${surface.surfaceId} attached to this workspace`, 'ok');
							return load();
						}).catch((cause) => toast(messageOf(cause), 'error'));
					});
					return el('span', { class: 'ws-surf-loose-item' }, [
						el('span', { class: 'mono', text: surface.surfaceId }),
						attach,
					]);
				}),
			),
		);
	}

	function render(surfaces: readonly A2uiSurface[], a2ui: typeof import('./a2ui.ts')): void {
		const { attached, loose } = surfacesFor(surfaces, workspaceId);
		for (const [id, item] of surfaceNodes) {
			if (!attached.some((surface) => surface.surfaceId === id)) {
				a2ui.releaseA2uiSurface(item.surface);
				item.node.remove();
				surfaceNodes.delete(id);
			}
		}
		attached.forEach((surface, index) => {
			const signature = JSON.stringify([surface.revision, surface.availableActions, canPublish]);
			const prior = surfaceNodes.get(surface.surfaceId);
			let item = prior;
			if (prior?.signature !== signature) {
				const made = card(surface, a2ui);
				if (prior !== undefined) {
					a2ui.releaseA2uiSurface(prior.surface);
					prior.node.replaceWith(made.node);
				}
				item = { ...made, signature };
				surfaceNodes.set(surface.surfaceId, item);
			}
			const at = list.children[index];
			if (item !== undefined && at !== item.node) list.insertBefore(item.node, at ?? null);
		});
		count.hidden = attached.length === 0;
		count.textContent = String(attached.length);
		paintEmpty(attached.length);
		renderLoose(loose);
	}

	async function load(): Promise<void> {
		if (!alive || loading) return;
		loading = true;
		try {
			const [user, listed] = await Promise.all([loadUser(), api.listSurfaces()]);
			if (!alive) return;
			canPublish = user?.scopes.includes('a2ui:publish') === true;
			failed = null;
			const { attached } = surfacesFor(listed.surfaces, workspaceId);
			// The renderer re-validates every surface against the shared schemas: loaded on first use only.
			if (attached.length > 0 && renderer === null) renderer = await import('./a2ui.ts');
			if (!alive) return;
			if (renderer !== null) render(listed.surfaces, renderer);
			else {
				count.hidden = true;
				paintEmpty(0);
				renderLoose(surfacesFor(listed.surfaces, workspaceId).loose);
			}
		} catch (cause) {
			if (!alive) return;
			const reason = cause instanceof ApiError && cause.status === 403
				? 'Surfaces need the agent:invoke scope.'
				: `Surfaces unavailable: ${messageOf(cause)}`;
			if (failed === reason) return;
			failed = reason;
			releaseSurfaces(surfaceNodes, renderer?.releaseA2uiSurface ?? null);
			list.replaceChildren();
			looseSignature = '';
			looseList.hidden = true;
			headActions.replaceChildren();
			count.hidden = true;
			empty.hidden = false;
			empty.replaceChildren(el('span', { text: reason }));
		} finally {
			loading = false;
		}
	}

	const timer = setInterval(() => void load(), SURFACE_POLL_MS);
	void load();
	return {
		node,
		stop: (): void => {
			alive = false;
			clearInterval(timer);
			releaseSurfaces(surfaceNodes, renderer?.releaseA2uiSurface ?? null);
			// BUG-2: the builder drawer is not under the panel's nodes; it goes with the panel.
			builder?.close();
			builder = null;
		},
	};
}
