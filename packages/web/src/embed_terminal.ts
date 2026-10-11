/**
 * The terminal embed, `ui://tykotech/terminal`: one live sandbox shell session, framed by an MCP Apps host the way
 * the live view frames a browser session (R9, design §2.20).
 *
 * The session comes from the `sandbox_session_open` result the host relays (`ui/notifications/tool-result`,
 * `structuredContent.result.session_id`). Nothing connects until the user presses **Attach**: the press mints a
 * single-use, origin-bound ticket through the app-only `sandbox_session_ticket` tool and opens the terminal socket
 * (`embed_stream.ts`), which replays the output the session still holds and then streams the rest. A line typed
 * into the prompt is sent to the shell with its newline — the session is line mode, like `sandbox_session_input`.
 * A reconnect resumes after the last byte shown (`after`), so nothing is printed twice.
 *
 * Output is text only: it is written with `textContent`, never parsed as markup, and terminal escape sequences are
 * stripped rather than interpreted. The held output is bounded so a chatty shell cannot grow the frame without limit.
 */
// First, before anything builds a schema: no `new Function` probe under the embed's CSP (jitless.ts).
import './jitless.ts';
import { el, on } from './dom.ts';
import { applyHostContext, EmbedBridge, embedIcon, type EmbedToolResult, toolErrorOf } from './embed_bridge.ts';
import { EmbedStream, type StreamMessage } from './embed_stream.ts';

/** The most output the embed keeps on screen; older text is dropped from the top. */
export const TERMINAL_SCREEN_MAX_CHARS = 200_000;

/** `bye` reasons that mean the shell is gone, so reconnecting would only fail. */
const FINAL_REASONS = new Set(['session-ended', 'session-closed', 'server-shutdown', 'unauthorized']);

/**
 * Terminal output as plain text: CSI and OSC escape sequences and other control characters are removed (a tab, a
 * newline and a carriage return stay meaningful), so a coloured prompt reads as its words.
 */
export function plainTerminalText(raw: string): string {
	return raw
		// deno-lint-ignore no-control-regex
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
		// deno-lint-ignore no-control-regex
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
		// deno-lint-ignore no-control-regex
		.replace(/\u001b[@-Z\\-_]/g, '')
		.replace(/\r\n/g, '\n')
		// deno-lint-ignore no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** The session id a `sandbox_session_open` result names, or `null`. */
export function sessionIdOf(result: EmbedToolResult): string | null {
	const inner = result.structuredContent?.result as Record<string, unknown> | undefined;
	return typeof inner?.session_id === 'string' ? inner.session_id : null;
}

function main(): void {
	const app = document.getElementById('app');
	if (app === null) return;

	const dot = el('span', { class: 'e-dot', role: 'img' });
	const caption = el('span', { class: 'e-title' });
	const detail = el('span', { class: 'e-origin mono' });
	const attachButton = el('button', { class: 'e-btn primary', type: 'button', hidden: true });
	const screen = el('pre', { class: 'e-term mono', 'aria-live': 'off', tabindex: '0' });
	const prompt = el('input', {
		class: 'e-term-input mono',
		type: 'text',
		autocomplete: 'off',
		spellcheck: 'false',
		'aria-label': 'Send a line to the shell',
		placeholder: 'Type a command and press Enter',
	}) as HTMLInputElement;
	const form = el('form', { class: 'e-term-form', hidden: true }, [prompt]);
	const notice = el('p', { class: 'e-notice', role: 'status', 'aria-live': 'polite' });
	const shell = el('main', { class: 'embed terminal', 'data-phase': 'waiting' }, [
		el('header', { class: 'e-bar' }, [
			dot,
			el('span', { class: 'e-glyph', 'aria-hidden': 'true' }, [embedIcon('terminal')]),
			el('span', { class: 'e-ident' }, [caption, detail]),
			el('span', { class: 'e-actions' }, [attachButton]),
		]),
		screen,
		form,
		notice,
	]);

	let sessionId: string | null = null;
	/** The byte offset after the last output shown: where a reconnect resumes. */
	let after = 0;
	let ended = false;
	let phase: 'waiting' | 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended' = 'waiting';

	function write(text: string): void {
		const next = (screen.textContent ?? '') + plainTerminalText(text);
		screen.textContent = next.length > TERMINAL_SCREEN_MAX_CHARS ? next.slice(-TERMINAL_SCREEN_MAX_CHARS) : next;
		screen.scrollTop = screen.scrollHeight;
	}

	function render(): void {
		shell.setAttribute('data-phase', phase);
		const tone = phase === 'live'
			? 'live'
			: phase === 'connecting' || phase === 'reconnecting'
			? 'busy'
			: phase === 'ended'
			? 'dead'
			: 'idle';
		const meaning = tone === 'live' ? 'Attached' : tone === 'busy' ? 'Connecting' : 'Not attached';
		dot.className = `e-dot ${tone}`;
		dot.setAttribute('aria-label', meaning);
		dot.title = meaning;
		const streaming = phase === 'connecting' || phase === 'live' || phase === 'reconnecting';
		attachButton.hidden = sessionId === null || ended;
		attachButton.className = streaming ? 'e-btn quiet' : 'e-btn primary';
		attachButton.replaceChildren(
			embedIcon(streaming ? 'stop' : 'play'),
			el('span', { text: streaming ? 'Detach' : 'Attach' }),
		);
		form.hidden = phase !== 'live';
	}

	const bridge = new EmbedBridge({
		onToolResult: (result) => {
			const refused = toolErrorOf(result);
			if (refused !== null) {
				notice.textContent = `The shell session could not be opened — ${refused.code}: ${refused.message}`;
				return;
			}
			const next = sessionIdOf(result);
			if (next === null || next === sessionId) return;
			stream.stop();
			sessionId = next;
			after = 0;
			ended = false;
			screen.textContent = '';
			caption.textContent = 'Shell session';
			detail.textContent = next;
			phase = 'idle';
			notice.textContent = 'Press Attach to stream this shell here and type into it.';
			render();
		},
		onHostContext: applyHostContext,
		onTeardown: (): void => stream.stop(),
	});

	const stream = new EmbedStream({
		bridge,
		ticketTool: 'sandbox_session_ticket',
		ticketArgs: () => ({ session_id: sessionId }),
		query: () => ({ after: String(after) }),
		finalReasons: FINAL_REASONS,
		handlers: {
			onPhase: (next, why) => {
				if (ended) return;
				phase = next === 'idle' ? (sessionId === null ? 'waiting' : 'idle') : next;
				if (next === 'live') notice.textContent = '';
				else if (next === 'reconnecting' && why !== undefined) notice.textContent = `Reconnecting — ${why}`;
				render();
				if (next === 'live') prompt.focus();
			},
			onMessage: (message: StreamMessage) => {
				switch (message.type) {
					case 'output': {
						if (message.gap === true) write('\n[… earlier output was dropped …]\n');
						if (typeof message.data === 'string') write(message.data);
						if (typeof message.seq === 'number') after = message.seq;
						return;
					}
					case 'end': {
						ended = true;
						phase = 'ended';
						const code = typeof message.exit_code === 'number' ? ` with exit code ${message.exit_code}` : '';
						const killed = typeof message.killed === 'string' ? ` (${message.killed})` : '';
						notice.textContent = `The shell ended${code}${killed}.`;
						render();
						return;
					}
					case 'error':
						notice.textContent = `${String(message.code)}: ${String(message.message)}`;
						return;
				}
			},
			onEnded: (code, text) => {
				if (!ended) {
					phase = 'idle';
					notice.textContent = `${code}: ${text}`;
				}
				render();
			},
		},
	});

	on(attachButton, 'click', () => {
		if (stream.active) {
			stream.stop();
			notice.textContent = 'Detached. Press Attach to stream again.';
			return;
		}
		notice.textContent = '';
		stream.start();
	});

	on(form, 'submit', (event: Event) => {
		event.preventDefault();
		const line = prompt.value;
		if (!stream.send({ type: 'input', data: `${line}\n` })) {
			notice.textContent = 'Not attached: the line was not sent.';
			return;
		}
		prompt.value = '';
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden' && stream.active) {
			stream.stop();
			notice.textContent = 'Paused while the view was hidden. Press Attach to stream again.';
		}
	});

	app.append(shell);
	caption.textContent = 'Shell session';
	notice.textContent = 'Waiting for the host to name the session to show.';
	render();
	bridge.watchSize(shell);
	void bridge.connect({ name: 'tykotech-terminal', version: '1' }).catch(() => {
		notice.textContent = 'This view must be opened by an MCP Apps host.';
	});
}

// Not on import: the helpers above are unit-tested without a document.
if (typeof document !== 'undefined') main();
