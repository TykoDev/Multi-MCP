/**
 * The colour theme, dark or light, remembered per browser. The only thing this app stores: `ttk.theme` holds a theme
 * literal and nothing else (`web_test.ts` holds every module to that).
 */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'ttk.theme';

function stored(): Theme | null {
	try {
		const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
		return value === 'dark' || value === 'light' ? value : null;
	} catch {
		return null;
	}
}

let fallback: Theme = 'dark';

export function currentTheme(): Theme {
	return stored() ?? fallback;
}

function apply(theme: Theme): void {
	const root = document.documentElement;
	root.classList.toggle('wa-dark', theme === 'dark');
	root.classList.toggle('wa-light', theme === 'light');
	root.dataset.theme = theme;
	document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

export function initTheme(): void {
	apply(currentTheme());
}

/** Switches to the other theme, remembers it when storage allows, and returns it. */
export function toggleTheme(): Theme {
	const theme: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
	fallback = theme;
	try {
		globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Not remembered; still applied for this page.
	}
	apply(theme);
	return theme;
}
