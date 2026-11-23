/**
 * The component kit: the Web Awesome 3 (MIT) elements the app uses, registered before the first render, one module at
 * a time — never the library entry, whose autoloader fetches component code by URL. `kit_overlay.ts` and
 * `kit_forms.ts` hold the overlays and the form controls, so each emitted chunk stays within the per-file budget.
 *
 * Both icon libraries (`default`, and `system` for the kit's own chevrons and close glyphs) point at the same-origin
 * sprite in sprite-sheet mode: `wa-icon` renders `<svg><use href>` and never fetches and parses an icon file.
 */
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { SPRITE_URL } from './icons.ts';

// Sprite-sheet mode renders `<svg><use>` without a viewBox, which defaults to 300 px wide.
const square = (svg: SVGElement): void => svg.setAttribute('viewBox', '0 0 24 24');
registerIconLibrary('default', {
	resolver: (name: string) => `${SPRITE_URL}#${name}`,
	mutator: square,
	spriteSheet: true,
});
registerIconLibrary('system', {
	resolver: (name: string) => `${SPRITE_URL}#wa-${name}`,
	mutator: square,
	spriteSheet: true,
});
