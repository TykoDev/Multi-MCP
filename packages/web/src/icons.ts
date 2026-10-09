/**
 * Icons for the SPA: the vocabulary from `icon_names.ts` and `icon()`, which
 * renders one glyph as `<svg><use href="/assets/icons.svg#name">` with
 * `createElementNS` — no markup string reaches the DOM.
 */
import { type IconName, SPRITE_URL } from './icon_names.ts';

export * from './icon_names.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** One icon as an `<svg class="icon">` referencing the sprite, hidden from assistive technology. */
export function icon(name: IconName, extraClass = ''): SVGSVGElement {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', extraClass === '' ? 'icon' : `icon ${extraClass}`);
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const use = document.createElementNS(SVG, 'use');
	use.setAttribute('href', `${SPRITE_URL}#${name}`);
	svg.append(use);
	return svg;
}
