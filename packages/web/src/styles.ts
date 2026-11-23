/**
 * Screen stylesheets that load with their screen: `dist/app.css` holds the shell, the shared components and the
 * first-paint screens (Connect, Sessions, Live View); each lazy screen's rules are a file under `/assets/screens/`,
 * fetched beside its chunk and applied before it renders. Same-origin files, so `style-src 'self'` admits them.
 */

/** The stylesheets under `/assets/screens/`. `tools` holds the coding workspace's rules. */
export type ScreenSheet = 'tools' | 'resources' | 'agents' | 'users' | 'system';

/** What each lazy screen draws from. */
export const SCREEN_SHEETS = {
	resources: ['resources'],
	workspaces: ['tools'],
	agents: ['agents'],
	users: ['users'],
	system: ['system'],
} as const satisfies Record<string, readonly ScreenSheet[]>;

const loading = new Map<ScreenSheet, Promise<void>>();

/** Applies `sheets`, each once per page; a sheet that fails resolves too (unstyled beats blank) and is retried later. */
function loadSheets(sheets: readonly ScreenSheet[]): Promise<void> {
	return Promise.all(sheets.map((sheet) => {
		const known = loading.get(sheet);
		if (known !== undefined) return known;
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = `/assets/screens/${sheet}.css`;
		const loaded = new Promise<void>((resolve) => {
			link.addEventListener('load', () => resolve(), { once: true });
			link.addEventListener('error', () => {
				loading.delete(sheet);
				link.remove();
				resolve();
			}, { once: true });
		});
		loading.set(sheet, loaded);
		document.head.append(link);
		return loaded;
	})).then(() => undefined);
}

/** A lazy screen's module and its stylesheets, together. */
export function withSheets<T>(module: Promise<T>, screen: keyof typeof SCREEN_SHEETS): Promise<T> {
	return Promise.all([module, loadSheets(SCREEN_SHEETS[screen])]).then(([loaded]) => loaded);
}
