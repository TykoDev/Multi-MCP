/**
 * The sign-in screen. One field takes a username or an API key: a value starting with `ttk_` is a key, and the
 * password field folds away as it is typed.
 */
import { api, ApiError, clearSession, setSession } from './api.ts';
import { el, mount, on } from './dom.ts';
import { signOut } from './lifecycle.ts';
import type { Navigate } from './shell.ts';
import { busy, button, messageOf } from './ui.ts';

const KEY_PREFIX = 'ttk_';

export function connectView(navigate: Navigate): void {
	const identity = el('input', {
		type: 'text',
		id: 'username',
		placeholder: 'Username or ttk_ key',
		autocomplete: 'username',
		spellcheck: 'false',
		autocapitalize: 'off',
		'aria-label': 'Username or API key',
	});
	const password = el('input', {
		type: 'password',
		id: 'password',
		placeholder: 'Password',
		autocomplete: 'current-password',
		'aria-label': 'Password',
	});
	const secret = el('div', { class: 'login-field secret' }, [password]);
	const error = el('p', { class: 'login-error', role: 'alert', hidden: true });
	const showError = (text: string): void => {
		error.textContent = text;
		error.hidden = text === '';
	};
	const submit = button({ label: 'Connect', icon: 'login', variant: 'primary', type: 'submit' });
	const form = el('form', { class: 'login-card', novalidate: true }, [
		el('img', { class: 'login-wordmark', src: '/assets/brand/multi-mcp-wordmark.png', alt: '', draggable: 'false' }),
		el('h1', { class: 'sr-only', text: 'Multi-MCP' }),
		el('div', { class: 'login-field identity' }, [identity]),
		secret,
		error,
		submit,
		el('p', { class: 'login-foot', text: 'An account, or an API key in the first field. Signed in for up to 7 days.' }),
	]);
	on(identity, 'input', () => {
		const isKey = identity.value.trim().startsWith(KEY_PREFIX);
		form.classList.toggle('key-mode', isKey);
		password.tabIndex = isKey ? -1 : 0;
	});

	/** Where a fresh sign-in lands: Sessions when it can watch, Agents when it can prompt, otherwise Resources. */
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
			navigate('#/resources');
		}
	}

	let throttledUntil = 0;
	const countdown = (): void => {
		const left = Math.ceil((throttledUntil - Date.now()) / 1000);
		submit.disabled = left > 0;
		showError(left > 0 ? `Too many failed sign-ins. Try again in ${left} s.` : '');
		if (left > 0) setTimeout(countdown, 1000);
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
		signOut();
		await busy(submit, async () => {
			try {
				const withPassword = passVal !== '' && !userVal.startsWith(KEY_PREFIX);
				const res = withPassword
					? await api.login({ username: userVal, password: passVal })
					: await api.login({ apiKey: userVal !== '' ? userVal : passVal });
				if (typeof res.csrf !== 'string') throw new Error('the server did not open a sign-in session');
				const backing = withPassword ? 'user' : res.user.id.startsWith('admin:') ? 'user-key' : 'api-key';
				setSession({ csrf: res.csrf, user: { ...res.user, backing } });
				await home();
			} catch (cause) {
				clearSession();
				if (cause instanceof ApiError && cause.status === 429) {
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
		// Enter in the username moves on to the password, unless the field holds a key.
		if (
			document.activeElement === identity && password.value.trim() === '' &&
			!identity.value.trim().startsWith(KEY_PREFIX)
		) {
			password.focus();
			return;
		}
		void attempt();
	});

	mount(el('div', { class: 'login-screen' }, [form]));
	identity.focus();
}
