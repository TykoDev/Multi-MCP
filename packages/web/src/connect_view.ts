/**
 * The sign-in screen (D-073, D-078, D-089).
 *
 * One identity field takes a username or an API key. A value that starts with
 * `ttk_` is recognised as a key as it is typed: the glyph turns into a key and
 * the password field folds away, so the screen needs no paragraph explaining
 * the two methods. The fold is presentation only; `attempt()` decides by the
 * same rule it always has.
 */
import { api, ApiError, clearSession, setSession } from './api.ts';
import { el, mount, on } from './dom.ts';
import { icon } from './icons.ts';
import { signOut } from './lifecycle.ts';
import type { Navigate } from './shell.ts';
import { busy, button, messageOf, tip } from './ui.ts';

const KEY_PREFIX = 'ttk_';

function field(
	id: string,
	label: string,
	input: HTMLInputElement,
	role: 'identity' | 'secret',
): { node: HTMLElement; glyph: HTMLElement } {
	const glyph = el('span', { class: 'field-glyph', 'aria-hidden': 'true' });
	const node = el('div', { class: `login-field ${role}` }, [
		el('label', { class: 'sr-only', for: id, text: label }),
		glyph,
		input,
	]);
	return { node, glyph };
}

export function connectView(navigate: Navigate): void {
	const identity = el('input', {
		type: 'text',
		id: 'username',
		placeholder: 'Username or ttk_ key',
		autocomplete: 'username',
		spellcheck: 'false',
		autocapitalize: 'off',
	});
	const password = el('input', {
		type: 'password',
		id: 'password',
		placeholder: 'Password',
		autocomplete: 'current-password',
	});
	const who = field('username', 'Username or API key', identity, 'identity');
	const secret = field('password', 'Password', password, 'secret');
	who.glyph.append(icon('user'));
	secret.glyph.append(icon('lock'));

	const errorText = el('span');
	const error = el('wa-callout', { class: 'login-error', variant: 'danger', role: 'alert', hidden: true }, [
		(() => {
			const glyph = icon('alert');
			glyph.setAttribute('slot', 'icon');
			return glyph;
		})(),
		errorText,
	]);
	const showError = (text: string): void => {
		errorText.textContent = text;
		error.hidden = text === '';
	};

	const submit = button({ label: 'Connect', icon: 'login', variant: 'primary', type: 'submit' });
	submit.classList.add('block');

	const stay = tip(
		el('span', { class: 'login-chip' }, [icon('clock'), el('span', { text: '7 days' })]),
		'You stay signed in on this browser for up to seven days',
		'top',
	);
	const methods = tip(
		el('span', { class: 'login-chip' }, [icon('user'), el('span', { text: '/' }), icon('key')]),
		'An account (username and password) or an API key — paste the key in the first field',
		'top',
	);

	const form = el('form', { class: 'login-card', novalidate: true }, [
		// The wordmark already spells the name; the visually hidden h1 keeps the page's one heading for screen readers.
		el('div', { class: 'login-brand' }, [
			el('img', { class: 'login-wordmark', src: '/assets/brand/multi-mcp-wordmark.png', alt: '', draggable: 'false' }),
			el('h1', { class: 'sr-only', text: 'Multi-MCP' }),
		]),
		who.node,
		secret.node,
		error,
		submit,
		el('div', { class: 'login-foot' }, [methods, stay]),
	]);

	/** A `ttk_` value is a key: the password field folds away and the glyph says so. */
	const reflectKind = (): void => {
		const isKey = identity.value.trim().startsWith(KEY_PREFIX);
		form.classList.toggle('key-mode', isKey);
		who.glyph.replaceChildren(icon(isKey ? 'key' : 'user'));
		secret.node.setAttribute('aria-hidden', String(isKey));
		password.tabIndex = isKey ? -1 : 0;
	};
	on(identity, 'input', reflectKind);

	/**
	 * Where a fresh sign-in lands: the sessions list when it can watch, the agents screen when it can prompt,
	 * otherwise the Tools console — a credential narrowed to `mcp:invoke` alone is a valid sign-in (D-074).
	 */
	async function home(): Promise<void> {
		const forbidden = (cause: unknown): boolean => cause instanceof ApiError && cause.status === 403;
		try {
			await api.mintTicket();
			navigate('#/sessions');
			return;
		} catch (cause) {
			if (!forbidden(cause)) throw cause;
		}
		try {
			await api.listAgentTasks();
			navigate('#/agents');
		} catch (cause) {
			if (!forbidden(cause)) throw cause;
			navigate('#/resources/tools');
		}
	}

	let throttledUntil = 0;
	const countdown = (): void => {
		const left = Math.ceil((throttledUntil - Date.now()) / 1000);
		if (left <= 0) {
			submit.disabled = false;
			showError('');
			return;
		}
		submit.disabled = true;
		showError(`Too many failed sign-ins. Try again in ${left} s.`);
		setTimeout(countdown, 1000);
	};

	async function attempt(): Promise<void> {
		showError('');
		const userVal = identity.value.trim();
		const passVal = password.value.trim();
		if (userVal === '' && passVal === '') {
			showError('Enter a username and password, or an API key.');
			identity.focus();
			return;
		}
		// A new credential must not inherit the last one's cached tool list or call history.
		signOut();
		await busy(submit, async () => {
			try {
				// Both kinds go through the login route, which opens a sign-in session in an HttpOnly cookie (B4):
				// the password never leaves this form again, an API key is exchanged rather than kept, and the page
				// is handed only the CSRF value it echoes on every change.
				const withPassword = passVal !== '' && !userVal.startsWith(KEY_PREFIX);
				const res = withPassword
					? await api.login({ username: userVal, password: passVal })
					: await api.login({ apiKey: userVal !== '' ? userVal : passVal });
				if (typeof res.csrf !== 'string') throw new Error('the server did not open a sign-in session');
				// D-146: a key that belongs to an account signs in as the account (an `admin:` id); the account menu still
				// says it was a key, and offers no password change the server would refuse.
				const backing = withPassword ? 'user' : res.user.id.startsWith('admin:') ? 'user-key' : 'api-key';
				setSession({ csrf: res.csrf, user: { ...res.user, backing } });
				await home();
			} catch (cause) {
				clearSession();
				form.classList.remove('shake');
				void form.offsetWidth;
				form.classList.add('shake');
				if (cause instanceof ApiError && cause.status === 429) {
					// D-078: repeated failures are slowed down; count the wait down rather than show a bare status.
					throttledUntil = Date.now() + Math.max(1000, cause.retryAfterMs ?? 1000);
					setTimeout(countdown, 0);
					return;
				}
				showError(
					cause instanceof ApiError && cause.status === 401 ? 'That credential was rejected.' : messageOf(cause),
				);
			}
		});
	}

	on(form, 'submit', (event) => {
		event.preventDefault();
		// Enter in the identity field moves on to the password unless the value is plainly an API key.
		if (
			document.activeElement === identity && password.value.trim() === '' &&
			!identity.value.trim().startsWith(KEY_PREFIX)
		) {
			password.focus();
			return;
		}
		void attempt();
	});

	mount(el('div', { class: 'login-screen' }, [el('div', { class: 'login-aura', 'aria-hidden': 'true' }), form]));
	identity.focus();
}
