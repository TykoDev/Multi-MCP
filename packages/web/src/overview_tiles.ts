/**
 * D-155: what this credential has stored, read from `GET /api/v1/overview` — the Sessions screen's dashboard strip and
 * the item counts on the Resources screen's group cards and tree heads. One source for both, so the two screens never
 * disagree about how many files or tasks there are.
 *
 * A section the server left out (the credential holds no scope that reads it) is left out here too: no tile, no count.
 * A count that hit the server's walk cap reads as a floor (`20000+`); a sandbox that did not answer reads as `—`.
 */
import type { Overview, SessionSummary } from './api.ts';
import { el } from './dom.ts';
import type { IconName } from './icons.ts';
import type { ToolDomain } from './resources_tools.ts';
import { formatBytes, statTile } from './ui.ts';

/** `1 file`, `2 files`; an irregular plural is given. */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/** One tile of the dashboard: what it counts, the number, the line under it, the tooltip, and where it is managed. */
export interface OverviewTile {
	readonly id: string;
	readonly glyph: IconName;
	readonly label: string;
	readonly value: string;
	/** Shown under the label (a byte total); empty for none. */
	readonly sub: string;
	/** The tooltip and the screen reader's detail. */
	readonly detail: string;
	/** The screen that manages it, when one exists for this credential. */
	readonly route?: string;
	readonly tone: string;
}

/** An owner-scoped count says whose it is. */
function whose(scope: 'own' | 'all'): string {
	return scope === 'own' ? 'yours' : 'everyone’s';
}

/** `14`, or `20000+` when the walk stopped at its cap. */
function floor(n: number, truncated: boolean): string {
	return truncated ? `${n}+` : String(n);
}

/** `completed 3 · failed 1`, most frequent first: the task states as the server named them. */
function states(byState: Readonly<Record<string, number>>): string {
	return Object.entries(byState)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([state, n]) => `${state.replace(/_/g, ' ')} ${n}`)
		.join(' · ');
}

/** The dashboard's tiles for `overview`, in a fixed order: the browser's data, the library, then the agents'. */
export function overviewTiles(overview: Overview): OverviewTile[] {
	const tiles: OverviewTile[] = [];
	const { sessions, profiles, storage_states, recordings, files, skills, prompts } = overview;
	const { workspaces, tasks, providers, memory, surfaces, disk } = overview;
	if (sessions !== undefined) {
		tiles.push({
			id: 'sessions',
			glyph: 'sessions',
			label: 'Sessions',
			value: String(sessions.count),
			sub: sessions.in_use > 0 ? `${sessions.in_use} in use` : '',
			detail: `${counted(sessions.tabs, 'tab')} · ${
				counted(sessions.viewers, 'viewer')
			} · ${sessions.in_use} in use · ${whose(sessions.scope)}`,
			tone: 'accent',
		});
	}
	if (profiles !== undefined) {
		tiles.push({
			id: 'profiles',
			glyph: 'user',
			label: 'Profiles',
			value: String(profiles.count),
			sub: formatBytes(profiles.bytes),
			detail: `persistent browser profiles · ${profiles.truncated ? 'at least ' : ''}${
				formatBytes(profiles.bytes)
			} on disk`,
			tone: 'info',
		});
	}
	if (storage_states !== undefined) {
		tiles.push({
			id: 'storage',
			glyph: 'cookie',
			label: 'Storage states',
			value: String(storage_states.count),
			sub: formatBytes(storage_states.bytes),
			detail: `saved cookies and origins · ${formatBytes(storage_states.bytes)} on disk`,
			tone: 'info',
		});
	}
	if (recordings !== undefined) {
		tiles.push({
			id: 'recordings',
			glyph: 'record',
			label: 'Recordings',
			value: String(recordings.count),
			sub: formatBytes(recordings.bytes),
			detail: `${formatBytes(recordings.bytes)} on disk · ${whose(recordings.scope)}`,
			tone: 'info',
		});
	}
	if (files !== undefined) {
		tiles.push({
			id: 'files',
			glyph: 'folder',
			label: 'Files',
			value: floor(files.count, files.truncated),
			sub: formatBytes(files.bytes),
			detail: `the file share · ${counted(files.folders, 'folder')} · ${files.truncated ? 'at least ' : ''}${
				formatBytes(files.bytes)
			}`,
			route: '#/resources/files',
			tone: 'info',
		});
	}
	if (skills !== undefined) {
		tiles.push({
			id: 'skills',
			glyph: 'skills',
			label: 'Skills',
			value: String(skills.count),
			sub: '',
			detail: 'stored skills',
			route: '#/resources/skills',
			tone: 'info',
		});
	}
	if (prompts !== undefined) {
		tiles.push({
			id: 'prompts',
			glyph: 'prompt',
			label: 'Prompts',
			value: String(prompts.count),
			sub: '',
			detail: 'stored prompts',
			route: '#/resources/prompts',
			tone: 'info',
		});
	}
	if (workspaces !== undefined) {
		tiles.push({
			id: 'workspaces',
			glyph: 'workspace',
			label: 'Workspaces',
			value: workspaces.count === null ? '—' : String(workspaces.count),
			sub: '',
			detail: workspaces.count === null ? 'the sandbox did not answer' : `coding workspaces · ${whose('own')}`,
			route: '#/workspaces',
			tone: 'accent',
		});
	}
	if (tasks !== undefined) {
		tiles.push({
			id: 'tasks',
			glyph: 'list-checks',
			label: 'Agent tasks',
			value: String(tasks.count),
			sub: tasks.active > 0 ? `${tasks.active} active` : '',
			detail: [states(tasks.by_state), whose('own')].filter((part) => part !== '').join(' · '),
			route: '#/agents',
			tone: tasks.active > 0 ? 'live' : 'agent',
		});
	}
	if (providers !== undefined) {
		tiles.push({
			id: 'providers',
			glyph: 'provider',
			label: 'Model providers',
			value: String(providers.count),
			sub: '',
			detail: `${providers.reachable} reachable`,
			route: '#/system/agents',
			tone: 'agent',
		});
	}
	if (memory !== undefined) {
		tiles.push({
			id: 'memory',
			glyph: 'brain',
			label: 'Memory items',
			value: String(memory.items),
			sub: '',
			detail: `${counted(memory.collections, 'collection')} · ${whose(memory.scope)}`,
			// Memory is managed on System › Agents, which is an administrator's screen.
			...(memory.scope === 'all' ? { route: '#/system/agents' } : {}),
			tone: 'agent',
		});
	}
	if (surfaces !== undefined) {
		tiles.push({
			id: 'surfaces',
			glyph: 'surface',
			label: 'Surfaces',
			value: String(surfaces.count),
			sub: '',
			detail: `A2UI surfaces · ${whose('own')}`,
			route: '#/resources/surfaces',
			tone: 'agent',
		});
	}
	if (disk !== undefined) {
		tiles.push({
			id: 'disk',
			glyph: 'disk',
			label: 'Data directory',
			value: `${disk.truncated ? '≥ ' : ''}${formatBytes(disk.bytes)}`,
			sub: '',
			detail: disk.truncated ? 'TTK_DATA_DIR · walk capped, at least this much' : 'everything under TTK_DATA_DIR',
			route: '#/system',
			tone: 'warn',
		});
	}
	return tiles;
}

/**
 * `overview` with its sessions section taken from the live admin list (`GET /api/v1/sessions`, polled every 5 s) —
 * fresher than the overview's 20 s poll. That list is an administrator's, who reaches every session: scope `all`.
 */
export function withLiveSessions(
	overview: Overview,
	sessions: ReadonlyArray<Pick<SessionSummary, 'tab_count' | 'viewer_count' | 'human_has_control'>>,
): Overview {
	return {
		...overview,
		sessions: {
			scope: 'all',
			count: sessions.length,
			tabs: sessions.reduce((sum, session) => sum + session.tab_count, 0),
			viewers: sessions.reduce((sum, session) => sum + session.viewer_count, 0),
			in_use: sessions.filter((session) => session.human_has_control).length,
		},
	};
}

/**
 * The item count a Resources group's card and tree head show: the things added to that resource, with their noun.
 * `null` for the Server group (nothing there is added by anyone: its resources are the server's own) and for a group
 * whose section the server left out.
 */
export function domainItems(domain: ToolDomain, overview: Overview | null): { count: string; text: string } | null {
	if (overview === null) return null;
	const of = (n: number, truncated: boolean, singular: string) => ({
		count: floor(n, truncated),
		text: truncated ? `${n}+ ${singular}s` : counted(n, singular),
	});
	switch (domain) {
		case 'browser':
			return overview.sessions === undefined ? null : of(overview.sessions.count, false, 'session');
		case 'files':
			return overview.files === undefined ? null : of(overview.files.count, overview.files.truncated, 'file');
		case 'skills':
			return overview.skills === undefined ? null : of(overview.skills.count, false, 'skill');
		case 'prompts':
			return overview.prompts === undefined ? null : of(overview.prompts.count, false, 'prompt');
		case 'sandbox': {
			const count = overview.workspaces?.count;
			if (count === undefined) return null;
			return count === null ? { count: '—', text: 'workspaces unknown' } : of(count, false, 'workspace');
		}
		case 'agents':
			return overview.tasks === undefined ? null : of(overview.tasks.count, false, 'task');
		case 'surfaces':
			return overview.surfaces === undefined ? null : of(overview.surfaces.count, false, 'surface');
		default:
			return null;
	}
}

/**
 * The dashboard strip: one compact tile per section, a link where a screen manages it. `paint` updates the tiles in
 * place (a changed number bumps, as on the stat strip), adds the sections that appeared and drops the ones that went.
 */
export function overviewStrip(): { node: HTMLElement; paint(overview: Overview): void } {
	const list = el('ul', { class: 'ov-grid' });
	const node = el('section', { class: 'ov', 'aria-label': 'Stored data', hidden: true }, [list]);
	const shown = new Map<string, { item: HTMLElement; set(value: string, detail?: string): void; sub: HTMLElement }>();
	return {
		node,
		paint(overview) {
			const tiles = overviewTiles(overview);
			node.hidden = tiles.length === 0;
			const ids = new Set(tiles.map((tile) => tile.id));
			for (const [id, entry] of shown) {
				if (ids.has(id)) continue;
				entry.item.remove();
				shown.delete(id);
			}
			for (const tile of tiles) {
				let entry = shown.get(tile.id);
				if (entry === undefined) {
					const built = statTile(tile.glyph, tile.label, tile.tone);
					const sub = el('span', { class: 'tile-sub' });
					built.node.children[1]?.append(sub);
					const body = tile.route === undefined
						? built.node
						: el('a', { class: 'ov-link', href: tile.route }, [built.node]);
					const item = el('li', { class: 'ov-item', 'data-tile': tile.id }, [body]);
					entry = { item, set: built.set, sub };
					shown.set(tile.id, entry);
				}
				entry.set(tile.value, tile.detail);
				entry.sub.textContent = tile.sub;
				// Appending an item already in the list moves it: the order is the tiles' order whatever arrived when.
				list.append(entry.item);
			}
		},
	};
}
