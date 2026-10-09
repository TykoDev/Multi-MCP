/**
 * CDP `Input` domain — synthesized mouse, keyboard and touch input.
 *
 * The whole interaction surface rides on this: the click cascade's move/press/release with 3 s/5 s
 * caps, per-char `keyDown`/`char`/`keyUp` typing, `insertText` for the direct-value path, and wheel
 * scrolling (SPECS/ARCHITECTURE.md §6.10, SPECS/AGENT-RUNTIME.md input-synthesis contract).
 */

import type { CdpTimestamp, EmptyResult } from './common.ts';

/** Bitfield: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
export type InputModifiers = number;

export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';

/** `Input.TouchPoint`. */
export interface TouchPoint {
	x: number;
	y: number;
	radiusX?: number;
	radiusY?: number;
	rotationAngle?: number;
	force?: number;
	tangentialPressure?: number;
	tiltX?: number;
	tiltY?: number;
	twist?: number;
	id?: number;
}

export interface InputParams {
	'Input.dispatchKeyEvent': {
		type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
		modifiers?: InputModifiers;
		timestamp?: CdpTimestamp;
		text?: string;
		unmodifiedText?: string;
		keyIdentifier?: string;
		code?: string;
		key?: string;
		windowsVirtualKeyCode?: number;
		nativeVirtualKeyCode?: number;
		autoRepeat?: boolean;
		isKeypad?: boolean;
		isSystemKey?: boolean;
		location?: number;
		commands?: string[];
	};
	'Input.dispatchMouseEvent': {
		type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
		x: number;
		y: number;
		modifiers?: InputModifiers;
		timestamp?: CdpTimestamp;
		button?: MouseButton;
		buttons?: number;
		clickCount?: number;
		force?: number;
		tangentialPressure?: number;
		tiltX?: number;
		tiltY?: number;
		twist?: number;
		deltaX?: number;
		deltaY?: number;
		pointerType?: 'mouse' | 'pen';
	};
	'Input.dispatchTouchEvent': {
		type: 'touchStart' | 'touchEnd' | 'touchMove' | 'touchCancel';
		touchPoints: TouchPoint[];
		modifiers?: InputModifiers;
		timestamp?: CdpTimestamp;
	};
	/** The direct-value path: no per-char key events, so no framework keydown handlers fire. */
	'Input.insertText': { text: string };
	/**
	 * The in-progress state of an IME composition (SPECS/ROADMAP.md R13).
	 *
	 * ERRATUM(E-22). Added to the typed surface rather than reached through
	 * `sendRaw`, because it is not an escape hatch case: composition is a first
	 * class input mode for every language that needs one, and the live view's
	 * takeover is unusable in Japanese, Chinese or Korean without it. Chrome
	 * fires `compositionstart`/`compositionupdate` from this command and
	 * `compositionend` from the `Input.insertText` that commits it, which is
	 * what a page's own IME handling listens for. Empty `text` cancels.
	 */
	'Input.imeSetComposition': {
		text: string;
		selectionStart: number;
		selectionEnd: number;
		replacementStart?: number;
		replacementEnd?: number;
	};
	'Input.setIgnoreInputEvents': { ignore: boolean };
}

export interface InputResults {
	'Input.dispatchKeyEvent': EmptyResult;
	'Input.dispatchMouseEvent': EmptyResult;
	'Input.dispatchTouchEvent': EmptyResult;
	'Input.insertText': EmptyResult;
	'Input.imeSetComposition': EmptyResult;
	'Input.setIgnoreInputEvents': EmptyResult;
}

/** `Input` is command-only. */
export type InputEvents = Record<never, never>;

export const INPUT_METHODS = [
	'dispatchKeyEvent',
	'dispatchMouseEvent',
	'dispatchTouchEvent',
	'insertText',
	'imeSetComposition',
	'setIgnoreInputEvents',
] as const;
