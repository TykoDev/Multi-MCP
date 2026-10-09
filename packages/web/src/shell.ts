/**
 * The app shell every authenticated screen lives in (D-089): a floating dock of
 * section icons on the left, a context bar along the top, one scrolling main
 * region. Words appear only where a glyph cannot carry the meaning: each dock
 * item and tool is named by its tooltip and accessible name.
 *
 * Every control has one home (D-092): the dock navigates, the screen's own
 * actions sit at the right of the context bar, and account matters (theme
 * aside, which is one click in the bar) live in the account popover. The
 * logo at the top of the dock widens it to show each section's name beside its
 * icon and narrows it again (D-093); the page title is the highlighted dock
 * item, so the bar does not repeat it (it stays as the page's hidden heading).
 *
 * A section with more than one view names them as page tabs at the left of the
 * context bar (D-147): Sessions holds the browser sessions, the Live View and
 * the coding workspaces, each still its own route, so a link or a reload lands
 * on the tab it names.
 */
import { api, endSession, getUser, hasSession, loadUser, type UserInfo } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { onLeave, onSignOut, signOut } from './lifecycle.ts';
import { openPalette } from './palette.ts';
import { canChangeOwnPassword, openOwnPassword } from './password_dialog.ts';
import { currentTheme, dockOpen, onThemeChange, setDockOpen, setTheme, type Theme, THEMES } from './theme.ts';
import { avatar, brandLogo, button, iconButton, poll, relabel, scopeChips, tag, tip, toast } from './ui.ts';

export type Navigate = (route: string) => void;

export type Section =
	| 'sessions'
	| 'resources'
	| 'agents'
	| 'users'
	| 'system';

/**
 * The dock, in order: section, name (tooltip and accessible name), glyph. Five items: the Library (files, skills,
 * prompts) and the Tools console (D-152) are absorbed by Resources as groups of its one tree — `#/library` and
 * `#/tools` redirect there (`app.ts`); the Live View and the Workspaces are tabs of Sessions (D-147), whose routes
 * still answer.
 */
export const SECTIONS: ReadonlyArray<readonly [Section, string, IconName]> = [
	['sessions', 'Sessions', 'sessions'],
	['resources', 'Resources', 'resources'],
	['agents', 'Agents', 'agents'],
	['users', 'Users', 'users'],
	['system', 'System', 'system'],
];

/** The route a section's dock item opens. */
export function sectionRoute(section: Section): string {
	return `#/${section}`;
}

/** One page tab (D-147): a view of the section with a route of its own. */
export interface PageTab {
	readonly id: string;
	readonly label: string;
	readonly glyph: IconName;
	readonly route: string;
}

export interface ShellOptions {
	readonly active: Section;
	/** The page's heading for assistive technology; the highlighted dock item is its visible name. */
	readonly title: string;
	/** The heading's description for assistive technology. */
	readonly subtitle?: string;
	readonly actions?: Node[];
	/** The section's views as tabs at the left of the context bar, and the one on screen (D-147). */
	readonly tabs?: { readonly label: string; readonly items: readonly PageTab[]; readonly active: string };
	/** The viewer fills the frame itself instead of scrolling a padded page. */
	readonly flush?: boolean;
	/** The page uses the whole width instead of a centred column. */
	readonly wide?: boolean;
}

/**
 * The page tabs: links, not a tablist — each view is a route, so the address bar, Back and a reload agree with the
 * tab that is lit. The current one is `aria-current="page"`; a click on it changes nothing, as on any link to itself.
 */
function pageTabs(tabs: NonNullable<ShellOptions['tabs']>): HTMLElement {
	return el(
		'nav',
		{ class: 'page-tabs', 'aria-label': tabs.label },
		tabs.items.map((tab) => {
			const current = tab.id === tabs.active;
			return el('a', {
				class: current ? 'page-tab active' : 'page-tab',
				href: tab.route,
				'aria-current': current ? 'page' : undefined,
				'data-tab': tab.id,
			}, [
				icon(tab.glyph),
				el('span', { class: 'page-tab-label', text: tab.label }),
			]);
		}),
	);
}

/** Counts shown on dock items (live sessions, running tasks), kept across screens. */
const dockCounts = new Map<Section, number>();
const dockListeners = new Set<() => void>();

/** Sets (or, with null / 0, clears) the count badge on a dock item. */
export function setDockBadge(section: Section, count: number | null): void {
	if (count === null || count <= 0) dockCounts.delete(section);
	else dockCounts.set(section, count);
	for (const listener of dockListeners) listener();
}

/** Where the dock indicator stood on the previous screen, so the next one slides it from there. */
let dockIndex = -1;

function displayName(user: UserInfo): string {
	return user.username ?? user.label ?? user.id;
}

/** How this browser is signed in: an account sign-in, or a sign-in opened with an API key (both are sessions, B4). */
function signInKind(user: UserInfo): { text: string; glyph: IconName } {
	// D-146: an account's own key names the account; its backing says it was still a key.
	if (user.backing === 'user-key') return { text: 'Signed in with an account API key', glyph: 'key' };
	if (hasSession() && user.username !== undefined && (user.backing ?? 'user') === 'user') {
		return { text: 'Account sign-in', glyph: 'user' };
	}
	return { text: 'Signed in with an API key', glyph: 'key' };
}

/** R1-3: how many times an unconfirmed sign-out is tried on its own before the page waits for the user. */
const SIGN_OUT_ATTEMPTS = 4;
/** R1-3: the wait before the next try, when the server named none (it grows with each try). */
const SIGN_OUT_RETRY_MS = 5_000;
/** The pending retry of a sign-out the server has not confirmed yet. */
let signOutRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * R1-3: while a sign-out is unconfirmed, a reload or a closed tab asks first. The HttpOnly cookie is still in the
 * browser, so a reload would sign straight back in; the user must not walk away from a shared screen believing the
 * opposite of what the browser holds.
 */
function holdUnload(event: BeforeUnloadEvent): void {
	event.preventDefault();
}

// However the sign-in ends — confirmed here, or refused by the server on any other request — a pending retry and
// the unload guard go with it, so a retry left over from the old sign-in can never end the next one.
onSignOut(() => {
	if (signOutRetry !== null) clearTimeout(signOutRetry);
	signOutRetry = null;
	globalThis.removeEventListener('beforeunload', holdUnload);
});

function doSignOut(navigate: Navigate): void {
	void attemptSignOut(navigate, 1);
}

/**
 * Asks the server to end the sign-in, and shows the Connect screen only once it has (R1-3). Until then the page
 * stays signed in — as the browser still is — says why, and tries again: after the server's `Retry-After` when it
 * sent one, otherwise after a growing pause, a few times on its own and then whenever the user presses Sign out.
 */
async function attemptSignOut(navigate: Navigate, attempt: number): Promise<void> {
	if (signOutRetry !== null) clearTimeout(signOutRetry);
	signOutRetry = null;
	const outcome = await endSession();
	if (outcome.kind === 'signed-out') {
		signOut();
		navigate('#/connect');
		return;
	}
	// The same listener object, so adding it on every failed try registers it once.
	globalThis.addEventListener('beforeunload', holdUnload);
	if (attempt >= SIGN_OUT_ATTEMPTS) {
		toast(
			`Sign-out did not complete: ${outcome.message}. You are still signed in; choose Sign out to try again.`,
			'error',
		);
		return;
	}
	const wait = Math.max(outcome.retryAfterMs ?? 0, SIGN_OUT_RETRY_MS * attempt);
	toast(
		`Sign-out did not complete: ${outcome.message}. You are still signed in; trying again in ${
			Math.ceil(wait / 1000)
		} s.`,
		'error',
	);
	signOutRetry = setTimeout(() => void attemptSignOut(navigate, attempt + 1), wait);
}

/** The avatar in the context bar and the identity popover it opens. */
function userMenu(navigate: Navigate): HTMLElement {
	const trigger = el('button', {
		class: 'user-trigger',
		type: 'button',
		id: 'ttk-user-trigger',
		'aria-label': 'Account',
		'aria-haspopup': 'dialog',
	});
	const card = el('div', { class: 'user-card' });
	const popover = el('wa-popover', { class: 'user-popover', for: 'ttk-user-trigger', placement: 'bottom-end' }, [card]);

	const fill = (user: UserInfo | null): void => {
		trigger.replaceChildren(avatar(user === null ? '?' : displayName(user), 'sm'));
		card.replaceChildren();
		if (user === null) {
			card.append(el('div', { class: 'user-name', text: 'Signed in' }));
			return;
		}
		const kind = signInKind(user);
		tip(trigger, `${displayName(user)} · ${kind.text}`, 'bottom');
		const signOutButton = button({ label: 'Sign out', icon: 'logout', small: true, variant: 'danger' });
		on(signOutButton, 'click', () => doSignOut(navigate));
		const passwordButton = button({ label: 'Password', icon: 'key', small: true });
		on(passwordButton, 'click', () => {
			popover.open = false;
			openOwnPassword(user);
		});
		card.append(
			el('div', { class: 'user-head' }, [
				avatar(displayName(user), 'lg'),
				el('div', { class: 'user-id' }, [
					el('div', { class: 'user-name', text: displayName(user) }),
					tag(kind.text, kind.glyph),
				]),
			]),
			scopeChips(user.scopes),
			el('div', { class: 'user-actions' }, [
				...(canChangeOwnPassword(user) ? [passwordButton] : []),
				el('span', { class: 'grow' }),
				signOutButton,
			]),
		);
	};

	const user = getUser();
	fill(user);
	if (user === null) void loadUser().then(fill);
	return el('div', { class: 'user-menu' }, [trigger, popover]);
}

/** Gateway liveness from the public `/healthz`: a dot, with the words in its tooltip. */
function healthDot(): HTMLElement {
	const dot = el('span', {
		class: 'health',
		role: 'img',
		'aria-label': 'Gateway: checking',
		'data-tip': 'Gateway: checking',
	});
	const check = (): void => {
		api.health().then((health) => {
			dot.className = 'health up';
			const text = `Gateway online · v${health.version}`;
			dot.setAttribute('aria-label', text);
			dot.setAttribute('data-tip', text);
		}).catch(() => {
			dot.className = 'health down';
			dot.setAttribute('aria-label', 'Gateway offline');
			dot.setAttribute('data-tip', 'Gateway offline');
		});
	};
	check();
	poll(dot, 20_000, check);
	return dot;
}

/** The glyph each theme is drawn with, in the bar and in the picker. */
export const THEME_GLYPHS: Readonly<Record<Theme, IconName>> = {
	dark: 'moon',
	shade: 'cloud-moon',
	light: 'sun',
	dawn: 'sunrise',
};

/**
 * The theme picker (D-152): one button in the bar drawing the current theme's glyph, opening a small menu of the four
 * themes — each a swatch of its canvas, card and brand, its name and one line on its character. The menu is a
 * `role=menu` of `role=menuitemradio` buttons; Up/Down move between them and a choice applies and closes.
 */
function themePicker(): HTMLElement {
	const trigger = iconButton(THEME_GLYPHS[currentTheme()], 'Theme', undefined, {});
	trigger.id = 'ttk-theme-trigger';
	trigger.setAttribute('aria-haspopup', 'menu');
	const items = THEMES.map((theme) => {
		const item = el('button', {
			type: 'button',
			class: 'theme-item',
			role: 'menuitemradio',
			'data-theme-id': theme.id,
		}, [
			el('span', { class: `theme-swatch swatch-${theme.id}`, 'aria-hidden': 'true' }, [
				el('span', { class: 'sw-card' }),
				el('span', { class: 'sw-brand' }),
			]),
			el('span', { class: 'theme-text' }, [
				el('span', { class: 'theme-name', text: theme.label }),
				el('span', { class: 'theme-hint', text: theme.hint }),
			]),
			icon('check', 'theme-check'),
		]);
		on(item, 'click', () => {
			setTheme(theme.id);
			popover.open = false;
		});
		return item;
	});
	const menu = el('div', { class: 'theme-menu', role: 'menu', 'aria-label': 'Theme' }, items);
	on(menu, 'keydown', (event) => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const at = items.findIndex((item) => item === document.activeElement);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		items[(at + step + items.length) % items.length]?.focus();
	});
	const popover = el('wa-popover', { class: 'theme-popover', for: 'ttk-theme-trigger', placement: 'bottom-end' }, [
		menu,
	]);
	const paint = (): void => {
		const current = currentTheme();
		const label = THEMES.find((theme) => theme.id === current)?.label ?? 'Dark';
		relabel(trigger, `Theme · ${label}`, THEME_GLYPHS[current]);
		for (const item of items) item.setAttribute('aria-checked', String(item.dataset.themeId === current));
	};
	popover.addEventListener('wa-after-show', () => {
		(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
	});
	paint();
	onLeave(onThemeChange(paint));
	return el('div', { class: 'theme-picker' }, [trigger, popover]);
}

function paletteTrigger(): HTMLButtonElement {
	const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
	const node = el('button', {
		class: 'palette-trigger',
		type: 'button',
		'aria-label': 'Search and commands',
		'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K',
		'data-tip': 'Search and commands',
	}, [icon('search'), el('kbd', { text: mac ? '⌘K' : 'Ctrl K' })]);
	on(node, 'click', () => openPalette());
	return node;
}

/** The dock, the context bar and the main region every authenticated screen lives in. */
export function renderShell(navigate: Navigate, options: ShellOptions, content: Node[]): HTMLElement {
	const index = SECTIONS.findIndex(([id]) => id === options.active);
	const indicator = el('span', { class: 'dock-indicator', 'aria-hidden': 'true' });
	const badges = new Map<Section, { count: HTMLElement; item: HTMLElement; label: string }>();
	const items = SECTIONS.map(([id, label, glyph]) => {
		const item = el('button', {
			class: 'dock-item',
			type: 'button',
			'aria-label': label,
			'data-tip': label,
			'data-tip-placement': 'right',
		}, [icon(glyph), el('span', { class: 'dock-label', 'aria-hidden': 'true', text: label })]);
		const count = el('span', { class: 'dock-count', 'aria-hidden': 'true', hidden: true });
		item.append(count);
		badges.set(id, { count, item, label });
		if (id === options.active) {
			item.classList.add('active');
			item.setAttribute('aria-current', 'page');
		}
		on(item, 'click', () => navigate(sectionRoute(id)));
		return item;
	});
	const paintCounts = (): void => {
		for (const [section, { count: node, item, label }] of badges) {
			const count = dockCounts.get(section);
			node.hidden = count === undefined;
			node.textContent = count === undefined ? '' : count > 99 ? '99+' : String(count);
			// The badge itself is decorative; the count is part of the item's name.
			item.setAttribute('aria-label', count === undefined ? label : `${label} (${count})`);
		}
	};
	paintCounts();
	dockListeners.add(paintCounts);
	onLeave(() => dockListeners.delete(paintCounts));

	// The indicator starts where it was and transitions to where it is now (a CSSOM write the CSP allows).
	indicator.style.setProperty('--y', String(dockIndex < 0 ? index : dockIndex));
	requestAnimationFrame(() => requestAnimationFrame(() => indicator.style.setProperty('--y', String(index))));
	dockIndex = index;

	// The logo widens the dock to show the section names and narrows it again (D-093). It is outlined, not filled,
	// so the dock's only highlighted square is still the screen you are on.
	const brand = el('button', {
		class: 'dock-brand',
		type: 'button',
		'aria-controls': 'ttk-dock-items',
		'data-tip-placement': 'right',
	}, [
		// Raster brand marks are served from `packages/web/static/brand/` (`/assets/brand/…`), which CSP `img-src 'self'`
		// admits. Decorative: the button's own label names what it does.
		brandLogo('dock-logo'),
		el('span', { class: 'dock-label dock-wordmark', 'aria-hidden': 'true', text: 'Multi-MCP' }),
	]);
	const itemList = el('div', { class: 'dock-items', id: 'ttk-dock-items' }, [indicator, ...items]);
	// The maker's mark at the dock's foot: the full logo while the dock shows names, its lettering alone while it is
	// narrow (the full logo at icon width would be unreadable).
	const maker = el('div', { class: 'dock-maker', role: 'img', 'aria-label': 'TykoTech' }, [
		el('img', { class: 'dock-maker-full', src: '/assets/brand/tykotech-logo.png', alt: '', draggable: 'false' }),
		el('img', { class: 'dock-maker-mark', src: '/assets/brand/tykotech-mark.png', alt: '', draggable: 'false' }),
	]);
	const dock = el('nav', { class: 'dock', 'aria-label': 'Primary' }, [brand, itemList, maker]);

	let shellNode: HTMLElement | null = null;
	const paintDock = (open: boolean): void => {
		shellNode?.classList.toggle('dock-open', open);
		const label = open ? 'Collapse menu' : 'Expand menu';
		brand.setAttribute('aria-label', label);
		brand.setAttribute('data-tip', label);
		brand.setAttribute('aria-expanded', String(open));
		// With the names showing, a tooltip would only repeat them.
		for (const { item, label: name } of badges.values()) {
			if (open) item.removeAttribute('data-tip');
			else item.setAttribute('data-tip', name);
		}
	};
	on(brand, 'click', () => {
		const open = !dockOpen();
		setDockOpen(open);
		paintDock(open);
	});

	// The highlighted dock item names the screen; the heading stays for assistive technology only.
	const heading = el('h1', { class: 'sr-only', text: options.title });
	if (options.subtitle !== undefined) heading.setAttribute('aria-description', options.subtitle);
	const actions = options.actions ?? [];
	const contextbar = el('header', { class: 'contextbar' }, [
		el('div', { class: 'ctx-title' }, [heading, ...(options.tabs === undefined ? [] : [pageTabs(options.tabs)])]),
		el('div', { class: 'ctx-actions', hidden: actions.length === 0 }, actions),
		el('div', { class: 'ctx-tools' }, [paletteTrigger(), healthDot(), themePicker(), userMenu(navigate)]),
	]);

	const main = el(
		'main',
		{ class: options.flush ? 'main flush' : 'main' },
		options.flush ? content : [el('div', { class: options.wide ? 'page wide' : 'page' }, content)],
	);
	shellNode = el('div', { class: 'app-shell' }, [dock, contextbar, main]);
	paintDock(dockOpen());
	return shellNode;
}
