/**
 * Users: every password account, managed through `/api/v1/users` (needs `admin`). An account opens in a dialog:
 * its scopes, its API keys (each a subset of the account's scopes), its password and sign-ins, and its state. A
 * generated password or a minted key is shown exactly once: the server keeps only a hash.
 */
import { api, ApiError, type MintedKey, type PublicUser, type ScopeInfo, type UsersResponse } from './api.ts';
import { el, mount, on } from './dom.ts';
import { passwordInput } from './password_dialog.ts';
import { type Navigate, renderShell } from './shell.ts';
import {
	badge,
	busy,
	button,
	confirmButton,
	copyButton,
	empty,
	field,
	input,
	messageOf,
	notice,
	openModal,
	poll,
	relativeTime,
	toast,
} from './ui.ts';

/** The scope vocabulary as the server declares it: the SPA never restates the list. */
let vocabulary: ScopeInfo[] = [];

export function adoptVocabulary(declared: ScopeInfo[]): void {
	vocabulary = declared;
}

let pickerSerial = 0;

/**
 * The scopes as check boxes, each with what it grants; explicit grants (held only when named) are marked. `within`
 * narrows the offer: a key holds only what its account holds (the server checks it too).
 */
export function scopePicker(initial: readonly string[], within?: readonly string[]): {
	node: HTMLElement;
	read(): string[];
} {
	const serial = ++pickerSerial;
	const offered = within === undefined ? vocabulary : vocabulary.filter((entry) => within.includes(entry.scope));
	const boxes = offered.map(({ scope }) => {
		const box = el('input', {
			type: 'checkbox',
			id: `scope-${serial}-${scope}`,
			value: scope,
			class: 'acct-scope-box',
		});
		box.checked = initial.includes(scope);
		return box;
	});
	const rows = offered.map(({ scope, grants, explicit }, index) =>
		el('label', { class: `acct-scope${explicit ? ' explicit' : ''}`, for: `scope-${serial}-${scope}`, title: grants }, [
			boxes[index]!,
			el('span', { class: 'mono', text: scope }),
			el('span', { class: 'muted', text: explicit ? `${grants} (explicit)` : grants }),
		])
	);
	return {
		node: el('fieldset', { class: 'acct-picker' }, [el('legend', { text: 'Scopes' }), ...rows]),
		read: () => offered.filter((_, index) => boxes[index]!.checked).map((entry) => entry.scope),
	};
}

/** The one-time reveal of what the server generated. */
function reveal(title: string, secrets: { password?: string; key?: MintedKey }): void {
	const rows: HTMLElement[] = [];
	if (secrets.password !== undefined) rows.push(secretRow('Password', secrets.password));
	if (secrets.key !== undefined) {
		rows.push(
			secretRow('API key', secrets.key.secret),
			el('p', {
				class: 'muted mono',
				text: `Authorization: Bearer ${secrets.key.key.prefix}…`,
			}),
		);
	}
	if (rows.length > 0) openModal(title, [notice('Shown once. Copy it now: the server keeps only a hash.'), ...rows]);
}

function secretRow(label: string, value: string): HTMLElement {
	return el('div', { class: 'acct-secret' }, [
		el('span', { text: label }),
		el('code', { class: 'mono', text: value }),
		copyButton(() => value, `Copy ${label.toLowerCase()}`),
	]);
}

function statusOf(user: PublicUser): string {
	return user.disabled ? 'Disabled' : user.sessions > 0 ? 'Active' : 'Idle';
}

export function usersView(navigate: Navigate): void {
	const status = el('div');
	const list = el('div', { class: 'acct-list' });
	let latest: PublicUser[] = [];
	let signature = '';
	const add = button({ label: 'Add user', icon: 'user-plus', variant: 'primary', onClick: () => openCreate() });

	function openCreate(): void {
		const username = input('new-username', '', { maxlength: 64, required: true });
		const password = passwordInput('new-password', 'Password', 'new-password', 'Blank: generate one');
		const scopes = scopePicker(vocabulary.filter((entry) => entry.default).map((entry) => entry.scope));
		const keyLabel = input('new-key-label', '', { maxlength: 64, placeholder: 'default' });
		const submit = button({ label: 'Create account', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'form' }, [
			field('new-username', 'Username', username),
			password.node,
			scopes.node,
			field('new-key-label', 'First API key label', keyLabel, 'Issued with the account, holding its scopes.'),
			el('div', { class: 'actions' }, [submit]),
		]);
		const dialog = openModal('New account', [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const label = keyLabel.value.trim();
				const result = await api.createUser({
					username: username.value.trim(),
					...(password.input.value === '' ? {} : { password: password.input.value }),
					scopes: scopes.read(),
					api_key: label === '' ? {} : { label },
				});
				dialog.close();
				toast(`Account ${result.user.username} created`, 'ok');
				reveal(`Credentials for ${result.user.username}`, { password: result.password, key: result.api_key });
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		username.focus();
	}

	/** One account in one dialog, its body rebuilt from what the server holds after every change. */
	function openAccount(username: string): void {
		const body = el('div', { class: 'acct-body' });
		const dialog = openModal(username, [body], true);
		const changed = async (): Promise<void> => {
			await load();
			const next = latest.find((entry) => entry.username === username);
			if (next === undefined) dialog.close();
			else paint(next);
		};
		const run = (node: HTMLButtonElement, work: () => Promise<unknown>): void =>
			void busy(node, work).then(changed).catch((cause) => toast(messageOf(cause), 'error'));

		function paint(user: PublicUser): void {
			const scopes = scopePicker(user.scopes);
			const saveScopes = button({ label: 'Save scopes', variant: 'primary' });
			on(saveScopes, 'click', () => run(saveScopes, () => api.updateUser(user.username, { scopes: scopes.read() })));

			const keyScopes = scopePicker(user.scopes, user.scopes);
			const keyLabel = input('key-label', '', { maxlength: 64, placeholder: 'Label (optional)' });
			const mint = button({ label: 'Create key', icon: 'plus', variant: 'primary' });
			on(mint, 'click', () =>
				run(mint, async () => {
					const label = keyLabel.value.trim();
					const minted = await api.createUserKey(user.username, {
						...(label === '' ? {} : { label }),
						scopes: keyScopes.read(),
					});
					reveal(`API key for ${user.username}`, { key: minted });
				}));
			const keys = (user.keys ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map((key) => {
				const name = key.label ?? `${key.prefix}…`;
				return el('li', { class: 'acct-key' }, [
					el('strong', { text: name }),
					el('code', { class: 'mono', text: `${key.prefix}…` }),
					el('span', { class: 'muted', text: `${key.scopes.join(' ')} · ${relativeTime(key.created_at)}` }),
					confirmButton({ label: `Revoke ${name}`, icon: 'trash', iconOnly: true, small: true }, async () => {
						await api.deleteUserKey(user.username, key.id);
						await changed();
					}),
				]);
			});

			const password = passwordInput('reset-password', 'New password', 'new-password', 'Blank: generate one');
			const reset = button({ label: 'Reset password' });
			on(reset, 'click', () =>
				run(reset, async () => {
					const result = await api.resetPassword(user.username, password.input.value || undefined);
					toast(`Password for ${user.username} reset`, 'ok');
					if (result.password !== undefined) reveal(`New password for ${user.username}`, result);
				}));
			const signOut = button({ label: `Sign out everywhere (${user.sessions})`, icon: 'logout' });
			signOut.disabled = user.sessions === 0;
			on(signOut, 'click', () => run(signOut, () => api.signOutEverywhere(user.username)));

			const toggle = button({ label: user.disabled ? 'Enable account' : 'Disable account' });
			on(toggle, 'click', () => run(toggle, () => api.updateUser(user.username, { disabled: !user.disabled })));
			const remove = confirmButton({ label: `Delete ${user.username}`, icon: 'trash' }, async () => {
				await api.deleteUser(user.username);
				toast(`${user.username} deleted`, 'ok');
				dialog.close();
				await load();
			});
			// Nobody disables or deletes the account they are signed in with.
			toggle.disabled = remove.disabled = user.self;

			body.replaceChildren(
				el('p', {
					class: 'muted',
					text: `${statusOf(user)} · created ${relativeTime(user.created_at)} · updated ${
						relativeTime(user.updated_at)
					}`,
				}),
				el('section', {}, [el('h3', { text: 'Scopes' }), scopes.node, el('div', { class: 'actions' }, [saveScopes])]),
				el('section', {}, [
					el('h3', { text: 'API keys' }),
					...(user.keys === undefined ? [notice('This gateway predates account keys.', 'info')] : [
						el('ul', { class: 'acct-keys' }, keys.length === 0 ? [el('li', { text: 'No API keys yet.' })] : keys),
						field('key-label', 'New key label', keyLabel),
						keyScopes.node,
						el('div', { class: 'actions' }, [mint]),
					]),
				]),
				el('section', {}, [
					el('h3', { text: 'Password and sign-ins' }),
					password.node,
					el('div', { class: 'actions' }, [reset, signOut]),
				]),
				el('section', {}, [el('h3', { text: 'Account state' }), el('div', { class: 'actions' }, [toggle, remove])]),
			);
		}
		const user = latest.find((entry) => entry.username === username);
		if (user !== undefined) paint(user);
	}

	function render(data: UsersResponse): void {
		adoptVocabulary(data.vocabulary);
		latest = data.users;
		add.disabled = !data.store.writable;
		status.replaceChildren(
			...(data.store.writable ? [] : [notice(
				data.store.status === 'unreadable'
					? 'The user store on disk is unreadable; repair or remove it, then restart the gateway.'
					: 'This deployment has no TTK_DATA_DIR, so accounts can be used but not changed.',
			)]),
		);
		const next = JSON.stringify(data.users);
		if (next === signature) return;
		signature = next;
		const sorted = data.users.slice().sort((a, b) => a.username.localeCompare(b.username));
		list.replaceChildren(
			...(sorted.length === 0
				? [empty('users', 'No accounts', 'Seed one with doctor --new-admin, or add one here.')]
				: []),
			...sorted.map((user) => {
				const row = el('button', {
					type: 'button',
					class: `acct-row${user.disabled ? ' disabled' : ''}`,
					'data-user': user.username,
				}, [
					el('strong', { text: user.username }),
					...(user.self ? [badge('you', 'ok')] : []),
					el('span', { text: user.scopes.includes('admin') ? 'Administrator' : 'Member' }),
					el('span', { class: 'muted', text: statusOf(user) }),
					el('span', { class: 'muted', text: `${user.sessions} sign-ins · ${user.keys?.length ?? 0} keys` }),
				]);
				on(row, 'click', () => openAccount(user.username));
				return row;
			}),
		);
	}

	async function load(): Promise<void> {
		try {
			render(await api.listUsers());
		} catch (cause) {
			add.disabled = true;
			status.replaceChildren(notice(
				cause instanceof ApiError && cause.status === 403
					? 'Access denied. Managing accounts requires the admin scope.'
					: `Could not load accounts: ${messageOf(cause)}`,
			));
		}
	}

	mount(renderShell(navigate, { active: 'users', title: 'Users', actions: [add] }, [status, list]));
	void load();
	poll(list, 15_000, () => void load());
}
