/**
 * Screen stylesheets that load with their screen (D-159 amendment): `dist/app.css` holds the shell, the shared
 * components and the three first-paint screens (Connect, Sessions, Live View); each lazy screen's rules are their own
 * file under `/assets/screens/`, fetched beside the screen's JavaScript chunk and applied before it renders, so a first
 * paint downloads none of them.
 *
 * Several screens share families of rules (the Resources frame `rx-*`/`tc-*`, the A2UI renderer and agent states,
 * the workspace and file rules), so each screen names every sheet it draws from; a sheet is fetched once per page and
 * kept. `style-src 'self'` admits them: they are same-origin files, never inline.
 */

/** The stylesheets under `/assets/screens/`, one per former partial of `app.css`. */
export type ScreenSheet = 'tools' | 'resources' | 'agents' | 'users' | 'system';

/** What each lazy screen draws from — derived from the classes its modules use (`tests` pin the files exist). */
export const SCREEN_SHEETS = {
	resources: ['tools', 'resources', 'agents'],
	workspaces: ['tools', 'resources', 'agents'],
	agents: ['agents', 'system', 'tools'],
	tasks: ['tools', 'resources', 'agents'],
	users: ['users'],
	system: ['system', 'tools'],
} as const satisfies Record<string, readonly ScreenSheet[]>;

const loading = new Map<ScreenSheet, Promise<void>>();

/** The URL of one sheet. */
export function sheetUrl(sheet: ScreenSheet): string {
	return `/assets/screens/${sheet}.css`;
}

/**
 * Applies `sheets`, each once per page; resolves when every one has loaded. A sheet that fails to load resolves too
 * (the screen renders unstyled rather than not at all) and is tried again by the next screen that needs it.
 */
export function loadSheets(sheets: readonly ScreenSheet[]): Promise<void> {
	return Promise.all(sheets.map((sheet) => {
		const known = loading.get(sheet);
		if (known !== undefined) return known;
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = sheetUrl(sheet);
		link.dataset.sheet = sheet;
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

/** A lazy screen's module and its stylesheets, together: the module resolves once both have arrived. */
export function withSheets<T>(module: Promise<T>, screen: keyof typeof SCREEN_SHEETS): Promise<T> {
	return Promise.all([module, loadSheets(SCREEN_SHEETS[screen])]).then(([loaded]) => loaded);
}
