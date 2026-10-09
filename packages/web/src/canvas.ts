/**
 * The screencast surface: renders JPEG frames and, while the viewer holds
 * control, translates pointer and keyboard events into wire input messages.
 */
import type { ClientMsg, FrameMeta } from '@tykotech/wire';
import { el, on } from './dom.ts';

/** Pointer moves are throttled to roughly one per animation frame. */
const MOVE_INTERVAL_MS = 16;

/** CDP modifier bitmask. */
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

function modifiersOf(event: KeyboardEvent | MouseEvent): number {
	return (event.altKey ? MOD.alt : 0) |
		(event.ctrlKey ? MOD.ctrl : 0) |
		(event.metaKey ? MOD.meta : 0) |
		(event.shiftKey ? MOD.shift : 0);
}

function buttonOf(event: MouseEvent): 'left' | 'middle' | 'right' {
	return event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left';
}

/** Keys we forward as key events rather than as typed text. */
function isPrintable(event: KeyboardEvent): boolean {
	return event.key.length === 1 && !event.ctrlKey && !event.metaKey;
}

/**
 * The off-screen element that receives keystrokes and IME composition (R13).
 *
 * A `<canvas>` cannot host a composition: the browser's input method needs a
 * real editable target to attach its candidate window to, and without one every
 * CJK keystroke arrives as the raw Latin key (the `keyCode === 229` case) and
 * the remote page receives gibberish. So keyboard focus lives on a hidden
 * `<textarea>` positioned over the canvas, and the canvas keeps the pointer.
 *
 * It is positioned rather than `display:none` because a hidden element cannot
 * be focused, and it is `opacity:0` rather than off-screen so the IME's
 * candidate window appears where the user is looking.
 */
function createKeyboardTarget(): HTMLTextAreaElement {
	const node = el('textarea', {
		'aria-hidden': 'true',
		tabindex: -1,
		autocapitalize: 'off',
		autocomplete: 'off',
		autocorrect: 'off',
		spellcheck: false,
	});
	node.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;' +
		'border:0;padding:0;margin:0;resize:none;overflow:hidden;z-index:-1';
	return node;
}

export interface CanvasSurface {
	readonly element: HTMLCanvasElement;
	/** Draws one frame. */
	draw(meta: FrameMeta, jpeg: Uint8Array): void;
	/** Enables or disables input capture. */
	setInteractive(interactive: boolean): void;
	/** Releases listeners and any retained bitmap. */
	destroy(): void;
}

export function createCanvas(send: (message: ClientMsg) => void): CanvasSurface {
	const element = el('canvas', {
		width: 1280,
		height: 720,
		tabindex: 0,
		'aria-label': 'Remote browser view',
	});
	const context = element.getContext('2d');
	const keyboard = createKeyboardTarget();
	document.body.append(keyboard);
	let interactive = false;
	let composing = false;
	let lastMoveAt = 0;
	let frameSize = { w: 1280, h: 720 };
	let pending: ImageBitmap | null = null;
	let destroyed = false;
	/**
	 * Decode bookkeeping: frames requested, and the newest one actually painted.
	 *
	 * `createImageBitmap` is asynchronous and nothing orders its resolutions, so
	 * two decodes in flight can finish out of order and the older one would paint
	 * over the newer. The counters make the paint monotonic and let a late decode
	 * free its own bitmap instead of becoming a leak.
	 */
	let requested = 0;
	let painted = 0;

	/** Canvas-relative CSS pixels → frame coordinates. */
	function toFrame(event: MouseEvent): { x: number; y: number } {
		const rect = element.getBoundingClientRect();
		const scaleX = frameSize.w / (rect.width || 1);
		const scaleY = frameSize.h / (rect.height || 1);
		return {
			x: Math.round((event.clientX - rect.left) * scaleX),
			y: Math.round((event.clientY - rect.top) * scaleY),
		};
	}

	const offs: Array<() => void> = [];

	offs.push(on(element, 'pointerdown', (event) => {
		if (!interactive) return;
		event.preventDefault();
		// Focus goes to the keyboard target, not the canvas: that is what makes
		// the input method attach here rather than nowhere.
		keyboard.focus({ preventScroll: true });
		const { x, y } = toFrame(event);
		send({ type: 'input.mouse', kind: 'down', x, y, button: buttonOf(event) });
	}));

	offs.push(on(element, 'pointerup', (event) => {
		if (!interactive) return;
		event.preventDefault();
		const { x, y } = toFrame(event);
		send({ type: 'input.mouse', kind: 'up', x, y, button: buttonOf(event) });
	}));

	offs.push(on(element, 'pointermove', (event) => {
		if (!interactive) return;
		const now = performance.now();
		// Unthrottled moves would flood the socket with events the page cannot
		// consume any faster than it repaints.
		if (now - lastMoveAt < MOVE_INTERVAL_MS) return;
		lastMoveAt = now;
		const { x, y } = toFrame(event);
		send({ type: 'input.mouse', kind: 'move', x, y });
	}));

	offs.push(on(element, 'contextmenu', (event) => {
		if (interactive) event.preventDefault();
	}));

	offs.push(on(element, 'wheel', (event) => {
		if (!interactive) return;
		event.preventDefault();
		const { x, y } = toFrame(event);
		send({ type: 'input.wheel', x, y, deltaX: event.deltaX, deltaY: event.deltaY });
	}, { passive: false }));

	offs.push(on(keyboard, 'keydown', (event) => {
		if (!interactive) return;
		// A keystroke that belongs to an in-progress composition is the input
		// method's, not the page's. Forwarding it is the classic IME bug: the
		// remote page gets the Latin keys the user pressed to *compose* rather
		// than the characters they chose.
		if (composing || event.isComposing || event.keyCode === 229) return;
		// Held here so the page receives the key instead of the browser chrome
		// acting on it (Tab moving focus, / opening quick-find, and so on).
		event.preventDefault();
		send({
			type: 'input.key',
			kind: 'down',
			key: event.key,
			code: event.code,
			modifiers: modifiersOf(event),
			...(isPrintable(event) ? { text: event.key } : {}),
		});
	}));

	offs.push(on(keyboard, 'keyup', (event) => {
		if (!interactive) return;
		if (composing || event.isComposing) return;
		event.preventDefault();
		send({ type: 'input.key', kind: 'up', key: event.key, code: event.code, modifiers: modifiersOf(event) });
	}));

	// --- IME composition (R13) ---------------------------------------------

	offs.push(on(keyboard, 'compositionstart', () => {
		if (!interactive) return;
		composing = true;
		send({ type: 'input.composition', kind: 'update', text: '' });
	}));

	offs.push(on(keyboard, 'compositionupdate', (event) => {
		if (!interactive) return;
		const text = (event as CompositionEvent).data ?? '';
		send({ type: 'input.composition', kind: 'update', text });
	}));

	offs.push(on(keyboard, 'compositionend', (event) => {
		if (!interactive) return;
		composing = false;
		const text = (event as CompositionEvent).data ?? '';
		send({ type: 'input.composition', kind: 'commit', text });
		// The local target is only a conduit; anything left in it would be sent
		// again by the next composition's replacement range.
		keyboard.value = '';
	}));

	// Paste is the other way text arrives without keystrokes.
	offs.push(on(keyboard, 'paste', (event) => {
		if (!interactive) return;
		event.preventDefault();
		const text = (event as ClipboardEvent).clipboardData?.getData('text') ?? '';
		if (text !== '') send({ type: 'input.composition', kind: 'commit', text });
	}));

	return {
		element,
		draw(meta, jpeg) {
			if (context === null || destroyed) return;
			if (meta.w > 0 && meta.h > 0) {
				frameSize = { w: meta.w, h: meta.h };
				if (element.width !== meta.w || element.height !== meta.h) {
					element.width = meta.w;
					element.height = meta.h;
				}
			}
			const blob = new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
			const seq = ++requested;
			void createImageBitmap(blob).then((bitmap) => {
				// Two ways a decode can arrive too late to be worth painting, and
				// both of them own the bitmap they were handed: the surface was
				// destroyed while this decode was in flight (navigating away from the
				// viewer), or a newer frame has already been painted. Closing here is
				// what keeps either case from leaking a decoded frame buffer.
				if (destroyed || seq <= painted) {
					bitmap.close();
					return;
				}
				painted = seq;
				// The previous bitmap is closed explicitly: at 30fps, leaving them
				// to the collector is a steady leak of decoded frame buffers.
				pending?.close();
				pending = bitmap;
				context.drawImage(bitmap, 0, 0, element.width, element.height);
			}).catch(() => {
				// A frame that fails to decode is simply skipped; the next one redraws.
			});
		},
		setInteractive(next) {
			interactive = next;
			element.classList.toggle('driving', next);
			if (next) {
				keyboard.focus({ preventScroll: true });
			} else {
				if (composing) send({ type: 'input.composition', kind: 'cancel', text: '' });
				composing = false;
				keyboard.value = '';
				keyboard.blur();
			}
		},
		destroy() {
			// Set first: a decode already in flight checks this flag and frees its
			// own bitmap rather than painting into a canvas nobody can see.
			destroyed = true;
			for (const off of offs) off();
			keyboard.remove();
			pending?.close();
			pending = null;
		},
	};
}
