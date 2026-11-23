/**
 * The app shell every signed-in screen lives in: a rail of the five sections on the left, a bar along the top with
 * the section's tabs, the screen's actions, the theme switch and the account menu, and one scrolling main region.
 */
import { endSession, getUser, hasSession, loadUser, type UserInfo } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { onSignOut, signOut } from './lifecycle.ts';
import { canChangeOwnPassword, openOwnPassword } from './password_dialog.ts';
import { currentTheme, toggleTheme } from './theme.ts';
import { brandLogo, button, iconButton, relabel, toast } from './ui.ts';

export type Navigate = (route: string) => void;

export type Section = 'sessions' | 'resources' | 'agents' | 'users' | 'system';

/** The rail, in order: section, name, glyph. */
export const SECTIONS: ReadonlyArray<readonly [Section, string, IconName]> = [
	['sessions', 'Sessions', 'sessions'],
	['resources', 'Resources', 'resources'],
	['agents', 'Agents', 'agents'],
	['users', 'Users', 'users'],
	['system', 'System', 'system'],
];

/** One page tab: a view of the section with a route of its own. */
export interface PageTab {
	readonly id: string;
	readonly label: string;
	readonly route: string;
}

export interface ShellOptions {
	readonly active: Section;
	/** The page's heading for assistive technology; the lit rail item is its visible name. */
	readonly title: string;
	readonly actions?: Node[];
	/** The section's views as links at the left of the bar, and the one on screen. */
	readonly tabs?: { readonly items: readonly PageTab[]; readonly active: string };
	/** The screen fills the frame itself instead of scrolling a padded page. */
	readonly flush?: boolean;
}

let watched = 'default';
let workspace: string | null = null;

/** The Live View tab returns to the session last watched, by the id `default` resolved to. */
export function rememberWatched(sessionId: string): void {
	watched = sessionId;
}

/** The Workspaces tab returns to the workspace last open. */
export function rememberWorkspace(workspaceId: string | null): void {
	workspace = workspaceId;
}

/** The Sessions section's three views. */
export function sessionTabs(active: 'sessions' | 'view' | 'workspaces'): NonNullable<ShellOptions['tabs']> {
	return {
		active,
		items: [
			{ id: 'sessions', label: 'Sessions', route: '#/sessions' },
			{ id: 'view', label: 'Live View', route: `#/view/${encodeURIComponent(watched)}` },
			{
				id: 'workspaces',
				label: 'Workspaces',
				route: workspace === null ? '#/workspaces' : `#/workspaces/${encodeURIComponent(workspace)}`,
			},
		],
	};
}

/** How many times an unconfirmed sign-out is retried on its own before the page waits for the user. */
const SIGN_OUT_ATTEMPTS = 4;
const SIGN_OUT_RETRY_MS = 5_000;
let signOutRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * While a sign-out is unconfirmed the HttpOnly cookie still signs this browser in, so a reload or a closed tab asks
 * first: nobody should walk away from a shared screen believing the opposite of what the browser holds.
 */
function holdUnload(event: BeforeUnloadEvent): void {
	event.preventDefault();
}

onSignOut(() => {
	if (signOutRetry !== null) clearTimeout(signOutRetry);
	signOutRetry = null;
	globalThis.removeEventListener('beforeunload', holdUnload);
});

/** Ends the sign-in, and shows Connect only once the server confirmed it; otherwise says why and tries again. */
async function attemptSignOut(navigate: Navigate, attempt: number): Promise<void> {
	if (signOutRetry !== null) clearTimeout(signOutRetry);
	signOutRetry = null;
	const outcome = await endSession();
	if (outcome.kind === 'signed-out') {
		signOut();
		navigate('#/connect');
		return;
	}
	globalThis.addEventListener('beforeunload', holdUnload);
	const failed = `Sign-out did not complete: ${outcome.message}. You are still signed in`;
	if (attempt >= SIGN_OUT_ATTEMPTS) {
		toast(`${failed}; choose Sign out to try again.`, 'error');
		return;
	}
	const wait = Math.max(outcome.retryAfterMs ?? 0, SIGN_OUT_RETRY_MS * attempt);
	toast(`${failed}; trying again in ${Math.ceil(wait / 1000)} s.`, 'error');
	signOutRetry = setTimeout(() => void attemptSignOut(navigate, attempt + 1), wait);
}

function nameOf(user: UserInfo): string {
	return user.username ?? user.label ?? user.id;
}

/** The account button and its menu: who is signed in, how, the password change and sign-out. */
function userMenu(navigate: Navigate): HTMLElement {
	const trigger = el('button', {
		class: 'user-trigger',
		type: 'button',
		id: 'ttk-user-trigger',
		'aria-label': 'Account',
		title: 'Account',
	}, [icon('user')]);
	const card = el('div', { class: 'user-card' });
	const popover = el('wa-popover', { class: 'user-popover', for: 'ttk-user-trigger', placement: 'bottom-end' }, [card]);
	const fill = (user: UserInfo | null): void => {
		if (user === null) return;
		const how = user.backing === 'user-key'
			? 'Signed in with an account API key'
			: hasSession() && user.username !== undefined && (user.backing ?? 'user') === 'user'
			? 'Account sign-in'
			: 'Signed in with an API key';
		const password = button({
			label: 'Change password',
			icon: 'key',
			small: true,
			onClick: () => {
				popover.open = false;
				openOwnPassword(user);
			},
		});
		card.replaceChildren(
			el('div', { class: 'user-name', text: nameOf(user) }),
			el('div', { class: 'user-how', text: how }),
			el('div', { class: 'user-scopes mono', text: user.scopes.join(' ') }),
			el('div', { class: 'actions' }, [
				...(canChangeOwnPassword(user) ? [password] : []),
				button({
					label: 'Sign out',
					icon: 'logout',
					small: true,
					variant: 'danger',
					onClick: () => void attemptSignOut(navigate, 1),
				}),
			]),
		);
	};
	const user = getUser();
	if (user === null) void loadUser().then(fill);
	else fill(user);
	return el('div', { class: 'user-menu' }, [trigger, popover]);
}

function themeButton(): HTMLButtonElement {
	const glyph = (): IconName => currentTheme() === 'dark' ? 'moon' : 'sun';
	const node = iconButton(glyph(), 'Switch theme', () => {
		toggleTheme();
		relabel(node, 'Switch theme', glyph());
	});
	return node;
}

/** The rail, the bar and the main region every signed-in screen lives in. */
export function renderShell(navigate: Navigate, options: ShellOptions, content: Node[]): HTMLElement {
	const rail = el('nav', { class: 'dock', 'aria-label': 'Primary' }, [
		brandLogo('dock-logo'),
		...SECTIONS.map(([id, label, glyph]) => {
			const item = el('button', { class: 'dock-item', type: 'button', 'aria-label': label }, [
				icon(glyph),
				el('span', { class: 'dock-label', 'aria-hidden': 'true', text: label }),
			]);
			if (id === options.active) {
				item.classList.add('active');
				item.setAttribute('aria-current', 'page');
			}
			on(item, 'click', () => navigate(`#/${id}`));
			return item;
		}),
	]);
	const tabs = options.tabs === undefined ? [] : [
		el(
			'nav',
			{ class: 'page-tabs', 'aria-label': `${options.title} views` },
			options.tabs.items.map((tab) => {
				const current = tab.id === options.tabs?.active;
				return el('a', {
					class: current ? 'page-tab active' : 'page-tab',
					href: tab.route,
					'aria-current': current ? 'page' : undefined,
					'data-tab': tab.id,
					text: tab.label,
				});
			}),
		),
	];
	const bar = el('header', { class: 'contextbar' }, [
		el('h1', { class: 'sr-only', text: options.title }),
		...tabs,
		el('span', { class: 'grow' }),
		...(options.actions ?? []),
		themeButton(),
		userMenu(navigate),
	]);
	const main = el(
		'main',
		{ class: options.flush ? 'main flush' : 'main' },
		options.flush ? content : [el('div', { class: 'page' }, content)],
	);
	return el('div', { class: 'app-shell' }, [rail, bar, main]);
}
