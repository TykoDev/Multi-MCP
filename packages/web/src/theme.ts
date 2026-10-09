/**
 * Display preferences: the colour theme (D-089, four themes since D-152), the dock width (D-093) and (D-158) the
 * Agents screen's settings panel and New-chat boundary.
 *
 * A theme is one of four literals. Each sits on one of the kit's two base schemes — `wa-dark` for Dark and Shade,
 * `wa-light` for Light and Dawn — so every kit component already has a correct palette, and `data-theme` on `<html>`
 * names the variant whose overrides `tokens.css` applies on top. The choice is remembered per browser under
 * `ttk.theme`.
 *
 * Only the four literal values are ever written or honoured; the key holds no credential and nothing else is stored
 * here. Storage can be absent or throw (private mode, blocked site data), so every access is guarded.
 */

export type Theme = 'dark' | 'shade' | 'light' | 'dawn';

/** The themes in the order the picker offers them: name, glyph, the kit scheme it sits on, one line on its character. */
export const THEMES: ReadonlyArray<
	{ readonly id: Theme; readonly label: string; readonly scheme: 'dark' | 'light'; readonly hint: string }
> = [
	{ id: 'dark', label: 'Dark', scheme: 'dark', hint: 'Deep ink; the screencast stands out most' },
	{ id: 'shade', label: 'Shade', scheme: 'dark', hint: 'Dimmed slate; softer contrast for long sessions' },
	{ id: 'light', label: 'Light', scheme: 'light', hint: 'Crisp white on cool grey' },
	{ id: 'dawn', label: 'Dawn', scheme: 'light', hint: 'Warm paper and rose accents' },
];

export const THEME_STORAGE_KEY = 'ttk.theme';
const listeners: Array<(theme: Theme) => void> = [];

function isTheme(value: unknown): value is Theme {
	return value === 'dark' || value === 'shade' || value === 'light' || value === 'dawn';
}

function stored(): Theme | null {
	try {
		const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
		return isTheme(value) ? value : null;
	} catch {
		return null;
	}
}

/** This page's choice when storage is unavailable, so a pick still holds until the page is left. */
let themeFallback: Theme | null = null;

/**
 * The theme in effect: the stored choice, else dark. Dark is the default rather than the system preference
 * because the live screencast is the brightest thing on screen and the chrome around it should recede (D-089).
 */
export function currentTheme(): Theme {
	return stored() ?? themeFallback ?? 'dark';
}

/** The kit scheme a theme sits on. */
export function schemeOf(theme: Theme): 'dark' | 'light' {
	return THEMES.find((entry) => entry.id === theme)?.scheme ?? 'dark';
}

function apply(theme: Theme): void {
	const root = document.documentElement;
	const scheme = schemeOf(theme);
	root.classList.toggle('wa-dark', scheme === 'dark');
	root.classList.toggle('wa-light', scheme === 'light');
	root.dataset.theme = theme;
	document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
}

/** Applies the theme in effect; called once before the first render. */
export function initTheme(): void {
	apply(currentTheme());
}

export function setTheme(theme: Theme): void {
	themeFallback = theme;
	try {
		globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Not remembered; still applied for this page.
	}
	apply(theme);
	for (const listener of listeners) listener(theme);
}

/** Moves to the next theme in picker order (the palette's "Next theme"); returns it. */
export function cycleTheme(): Theme {
	const at = THEMES.findIndex((entry) => entry.id === currentTheme());
	const next = THEMES[(at + 1) % THEMES.length]?.id ?? 'dark';
	setTheme(next);
	return next;
}

/** Subscribes to theme changes; returns the unsubscribe (screens call it on leave). */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
	listeners.push(listener);
	return () => {
		const index = listeners.indexOf(listener);
		if (index >= 0) listeners.splice(index, 1);
	};
}

/**
 * Whether the dock shows section names beside its icons (D-093), remembered under `ttk.dock` as the literal
 * `open` or `closed`. Like the theme it is a display preference and holds nothing else.
 */
export const DOCK_STORAGE_KEY = 'ttk.dock';
type DockState = 'open' | 'closed';
/** The state for this page when storage is unavailable. */
let dockFallback: DockState = 'closed';

export function dockOpen(): boolean {
	try {
		const value = globalThis.localStorage?.getItem(DOCK_STORAGE_KEY) ?? null;
		if (value === 'open' || value === 'closed') return value === 'open';
	} catch {
		// Fall through to this page's own choice.
	}
	return dockFallback === 'open';
}

export function setDockOpen(open: boolean): void {
	const state: DockState = open ? 'open' : 'closed';
	dockFallback = state;
	try {
		globalThis.localStorage?.setItem(DOCK_STORAGE_KEY, state);
	} catch {
		// Not remembered; still applied for this page.
	}
}

/**
 * D-158: whether the Agents screen's settings panel is open, under `ttk.agents.side` as the literal `open` or `closed`
 * — a display preference like the dock's.
 */
export const AGENTS_SIDE_STORAGE_KEY = 'ttk.agents.side';
let sideFallback: DockState = 'closed';

export function agentsSideOpen(): boolean {
	try {
		const value = globalThis.localStorage?.getItem(AGENTS_SIDE_STORAGE_KEY) ?? null;
		if (value === 'open' || value === 'closed') return value === 'open';
	} catch {
		// Fall through to this page's own choice.
	}
	return sideFallback === 'open';
}

export function setAgentsSideOpen(open: boolean): void {
	const state: DockState = open ? 'open' : 'closed';
	sideFallback = state;
	try {
		globalThis.localStorage?.setItem(AGENTS_SIDE_STORAGE_KEY, state);
	} catch {
		// Not remembered; still applied for this page.
	}
}

/**
 * D-158: where this browser's current agent chat starts — a server creation time in milliseconds, under
 * `ttk.agents.chat` as decimal digits only, or absent for the whole history. It hides turns from this browser's view,
 * nothing on the server, and holds nothing else; anything but digits read back is ignored.
 */
export const CHAT_SINCE_STORAGE_KEY = 'ttk.agents.chat';
let chatFallback: number | null = null;

export function chatSince(): number | null {
	try {
		const value = globalThis.localStorage?.getItem(CHAT_SINCE_STORAGE_KEY) ?? null;
		if (value !== null && /^\d{1,16}$/.test(value)) return Number(value);
		if (value === null) return chatFallback;
	} catch {
		// Fall through to this page's own choice.
	}
	return chatFallback;
}

export function setChatSince(since: number | null): void {
	const digits = since === null || !Number.isSafeInteger(since) || since < 0 ? null : String(since);
	chatFallback = digits === null ? null : since;
	try {
		if (digits === null) globalThis.localStorage?.removeItem(CHAT_SINCE_STORAGE_KEY);
		else globalThis.localStorage?.setItem(CHAT_SINCE_STORAGE_KEY, digits);
	} catch {
		// Not remembered; still applied for this page.
	}
}
