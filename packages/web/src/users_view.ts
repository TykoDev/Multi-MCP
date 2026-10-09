/**
 * The Users screen: every password account as a card, managed in place (D-074).
 * The signed-in operator's own password is changed from the account popover.
 *
 * Everything here goes through `/api/v1/users`, which needs the `admin` scope;
 * a narrowed credential sees the refusal and nothing else. A generated password
 * and a minted API key are each shown exactly once, in a dialog with a copy
 * button, because the server keeps only their hashes and cannot show them again.
 *
 * D-146: every account can hold API keys — a new account is issued its first one
 * with it — each carrying a subset of the account's scopes, managed from the card.
 */
import {
	type AccountKey,
	api,
	ApiError,
	type MintedKey,
	type PublicUser,
	type ScopeInfo,
	type UsersResponse,
} from './api.ts';
import { clear, el, mount, on } from './dom.ts';
import { icon, type IconName, scopeIcon } from './icons.ts';
import { onLeave } from './lifecycle.ts';
import { clearCommands, registerCommands } from './palette.ts';
import { field, formActions, passwordInput } from './password_dialog.ts';
import {
	avatar,
	busy,
	button,
	confirmButton,
	copyButton,
	empty,
	iconButton,
	messageOf,
	openModal,
	poll,
	relativeTime,
	scopeChips,
	skeleton,
	statTile,
	tag,
	tip,
	toast,
} from './ui.ts';
import { type Navigate, renderShell } from './shell.ts';

/**
 * The scope vocabulary as the server declares it, read from the users response: the SPA never restates the list
 * (its one declaration is `scopes.ts`), and the explicit-only grants are marked by the server (D-065).
 */
let vocabulary: ScopeInfo[] = [];

function isExplicit(scope: string): boolean {
	return vocabulary.find((entry) => entry.scope === scope)?.explicit === true;
}

/** A glyph whose meaning is its tooltip and accessible name. */
function glyph(name: IconName, meaning: string, className: string): HTMLElement {
	return el('span', { class: className, role: 'img', 'aria-label': meaning, 'data-tip': meaning }, [icon(name)]);
}

/** A one-click selection the picker offers in its header ("Defaults", "Clear", "All"). */
interface PickerPreset {
	readonly label: string;
	readonly scopes: () => readonly string[];
}

/** Picker ids are per instance: two pickers can be open at once (the key manager over a card's scopes dialog). */
let pickerSerial = 0;

/**
 * The scopes as two groups of toggle rows — the standard grants, then the explicit ones (held only when named, D-065)
 * under an amber heading — each row a glyph, the scope's name and what it grants, and a check box. The rows are
 * outlined, not filled: a held scope is the only tinted one, so the selection reads at a glance. `within` narrows
 * the offer to a subset (an account key holds only what its account holds); `presets` are the header's shortcuts.
 */
function scopePicker(
	initial: readonly string[],
	options: { within?: readonly string[]; presets?: readonly PickerPreset[]; legend?: string } = {},
): { node: HTMLElement; read(): string[] } {
	const serial = ++pickerSerial;
	const offered = options.within === undefined
		? vocabulary
		: vocabulary.filter((entry) => options.within!.includes(entry.scope));
	const count = el('span', { class: 'acct-picker-count' });
	const boxes = offered.map(({ scope, grants: hint, explicit }) => {
		const id = `scope-${serial}-${scope}`;
		const box = el('input', { type: 'checkbox', id, value: scope, class: 'acct-scope-box' });
		box.checked = initial.includes(scope);
		const row = el('label', {
			class: `acct-scope${explicit ? ' explicit' : ''}`,
			for: id,
			'data-tip': explicit ? `${hint} · Explicit: held only when named` : hint,
			'data-tip-placement': 'top',
		}, [
			box,
			el('span', { class: 'acct-scope-glyph', 'aria-hidden': 'true' }, [icon(scopeIcon(scope))]),
			el('span', { class: 'acct-scope-text' }, [
				el('span', { class: 'acct-scope-name mono', text: scope }),
				el('span', { class: 'acct-scope-hint', text: hint }),
			]),
			el('span', { class: 'acct-scope-check', 'aria-hidden': 'true' }, [icon('check')]),
		]);
		return { box, explicit, row };
	});
	const paint = (): void => {
		const held = boxes.filter(({ box }) => box.checked).length;
		count.textContent = `${held}/${boxes.length}`;
		count.setAttribute('aria-label', `${held} of ${boxes.length} scopes selected`);
	};
	for (const { box } of boxes) on(box, 'change', paint);
	paint();
	const shortcuts = (options.presets ?? []).map(({ label, scopes }) =>
		button({
			label,
			variant: 'ghost',
			small: true,
			onClick: () => {
				const chosen = new Set(scopes());
				for (const { box } of boxes) box.checked = chosen.has(box.value);
				paint();
			},
		})
	);
	const group = (explicit: boolean): HTMLElement[] => {
		const rows = boxes.filter((entry) => entry.explicit === explicit).map(({ row }) => row);
		if (rows.length === 0) return [];
		return [
			// A named group, so the explicit heading is heard with its rows, not only seen above them.
			el('div', {
				class: `acct-scope-group${explicit ? ' explicit' : ''}`,
				role: 'group',
				'aria-label': explicit ? 'Explicit grants, held only when named' : 'Standard scopes',
			}, [
				el('div', { class: 'acct-scope-group-head' }, [
					...(explicit ? [icon('shield-alert')] : []),
					el('span', { text: explicit ? 'Explicit grants' : 'Standard' }),
					...(explicit ? [el('span', { class: 'acct-scope-group-hint', text: 'held only when named' })] : []),
				]),
				el('div', { class: 'acct-scopes' }, rows),
			]),
		];
	};
	return {
		node: el('fieldset', { class: 'acct-picker' }, [
			el('legend', { class: 'acct-picker-legend' }, [
				el('span', { class: 'acct-picker-head' }, [
					icon('shield-check'),
					el('span', { text: options.legend ?? 'Scopes' }),
					count,
					el('span', { class: 'grow' }),
					...shortcuts,
				]),
			]),
			...(boxes.length === 0
				? [el('p', { class: 'acct-picker-none', text: 'The account holds no scope a key could carry.' })]
				: [...group(false), ...group(true)]),
		]),
		read: () => boxes.filter(({ box }) => box.checked).map(({ box }) => box.value),
	};
}

/** The defaults and "none" shortcuts every account picker offers; the vocabulary is read when they are pressed. */
const ACCOUNT_PRESETS: readonly PickerPreset[] = [
	{ label: 'Defaults', scopes: () => vocabulary.filter((entry) => entry.default).map((entry) => entry.scope) },
	{ label: 'Clear', scopes: () => [] },
];

/** One secret in a one-time reveal: what it is, the value in mono, and its copy button. */
function secretRow(
	glyphName: IconName,
	label: string,
	value: string,
	hint?: string,
	copyLabel = `Copy ${label.toLowerCase()}`,
): HTMLElement {
	return el('div', { class: 'acct-secret-block' }, [
		el('div', { class: 'acct-secret-label' }, [icon(glyphName), el('span', { text: label })]),
		el('div', { class: 'acct-secret' }, [
			el('code', { class: 'mono', text: value }),
			copyButton(() => value, copyLabel),
		]),
		...(hint === undefined ? [] : [el('p', { class: 'acct-secret-hint mono', text: hint })]),
	]);
}

/** The bearer header an API key is presented in, with the key elided: the reveal shows how it is used. */
function bearerHint(key: MintedKey): string {
	return `Authorization: Bearer ${key.key.prefix}…`;
}

/** The warning above every one-time reveal: the server keeps only a hash. */
function shownOnce(text = 'Shown once. Copy it now.'): HTMLElement {
	return el('div', {
		class: 'acct-once',
		'data-tip': 'The server keeps only a hash and cannot show it again.',
	}, [icon('alert'), el('span', { text })]);
}

/**
 * The one-time reveal of what the server generated: a password, an API key, or both for a new account (D-146).
 * Nothing here is kept: closing the dialog is the last time the page holds either value.
 */
function revealCredentials(title: string, secrets: { password?: string; apiKey?: MintedKey }): void {
	const rows: HTMLElement[] = [];
	if (secrets.password !== undefined) rows.push(secretRow('lock', 'Password', secrets.password));
	if (secrets.apiKey !== undefined) {
		rows.push(secretRow('key', 'API key', secrets.apiKey.secret, bearerHint(secrets.apiKey)));
	}
	if (rows.length === 0) return;
	openModal(title, [shownOnce(rows.length > 1 ? 'Shown once. Copy both now.' : undefined), ...rows]);
}

/** A key's name for lists and confirmations: its label, else its prefix. */
function keyName(key: AccountKey): string {
	return key.label ?? `${key.prefix}…`;
}

export function usersView(navigate: Navigate): void {
	const noticeText = el('span');
	const noticeGlyph = icon('alert');
	noticeGlyph.setAttribute('slot', 'icon');
	const notice = el('wa-callout', { class: 'acct-notice', variant: 'warning', size: 's', hidden: true }, [
		noticeGlyph,
		noticeText,
	]);
	const showNotice = (text: string | null): void => {
		notice.hidden = text === null;
		noticeText.textContent = text ?? '';
	};
	const list = el('div', { class: 'acct-grid' }, [skeleton(3)]);
	const tiles = {
		users: statTile('users', 'Accounts', 'accent'),
		admins: statTile('shield', 'Administrators', 'agent'),
		sessions: statTile('login', 'Open sign-ins', 'live'),
		store: statTile('save', 'Store'),
	};
	/** The card each username is drawn as, for the command palette to select. */
	const cards = new Map<string, HTMLElement>();

	/** The list as last drawn, so a poll that finds nothing new leaves the cards (and any open popover) alone. */
	let signature = '';
	const add = iconButton('user-plus', 'Add user', () => openCreate(), { variant: 'primary' });

	function openCreate(): void {
		const username = el('input', {
			type: 'text',
			id: 'new-username',
			autocomplete: 'off',
			maxlength: 64,
			required: true,
			autofocus: true,
		});
		const password = passwordInput('new-password', 'Password', 'new-password', 'lock', 'Blank: generate one');
		const scopes = scopePicker(vocabulary.filter((entry) => entry.default).map((entry) => entry.scope), {
			presets: ACCOUNT_PRESETS,
		});
		// D-146: every new account is issued its first API key, holding the account's scopes; only its label is asked.
		const keyLabel = el('input', {
			type: 'text',
			id: 'new-key-label',
			autocomplete: 'off',
			maxlength: 64,
			placeholder: 'default',
		});
		const keyBox = el('section', { class: 'acct-keybox', 'aria-label': 'API key' }, [
			el('span', { class: 'acct-keybox-glyph', 'aria-hidden': 'true' }, [icon('key')]),
			el('div', { class: 'acct-keybox-text' }, [
				el('span', { class: 'acct-keybox-title', text: 'API key' }),
				el('span', {
					class: 'acct-keybox-hint',
					text: 'Issued with the account, holding its scopes. Shown once after creation.',
				}),
			]),
			el('div', { class: 'acct-keybox-field' }, [
				el('label', { class: 'sr-only', for: 'new-key-label', text: 'API key label' }),
				icon('tag'),
				keyLabel,
			]),
		]);
		const submit = button({ label: 'Create account', icon: 'user-plus', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'acct-form roomy' }, [
			el('div', { class: 'acct-form-row' }, [field('new-username', 'Username', 'user', username), password.node]),
			scopes.node,
			keyBox,
			formActions(submit),
		]);
		const dialog = openModal('New account', [form]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const chosen = password.input.value;
				const label = keyLabel.value.trim();
				const result = await api.createUser({
					username: username.value.trim(),
					...(chosen === '' ? {} : { password: chosen }),
					scopes: scopes.read(),
					api_key: label === '' ? {} : { label },
				});
				dialog.close();
				toast(`Account ${result.user.username} created`, 'ok');
				revealCredentials(`Credentials for ${result.user.username}`, {
					...(result.password === undefined ? {} : { password: result.password }),
					...(result.api_key === undefined ? {} : { apiKey: result.api_key }),
				});
				await load();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		username.focus();
	}

	/** The users as last listed, so an open account modal can re-read its account after a change. */
	let latest: PublicUser[] = [];

	/** The account's role in words: what its scopes make it. */
	function roleOf(user: PublicUser): string {
		return user.scopes.includes('admin') ? 'Administrator' : 'Member';
	}

	/** The account's state in words and tone: disabled, signed in somewhere, or idle. */
	function statusOf(user: PublicUser): { text: string; tone: string } {
		if (user.disabled) return { text: 'Disabled', tone: 'danger' };
		if (user.sessions > 0) return { text: 'Active', tone: 'live' };
		return { text: 'Idle', tone: '' };
	}

	/** Scopes as glyphs: held ones tinted, the rest dimmed, explicit grants in amber. */
	function scopeCluster(user: PublicUser, heldOnly = false): HTMLElement {
		const declared = vocabulary.map((entry) => entry.scope);
		const all = [...declared, ...user.scopes.filter((scope) => !declared.includes(scope))];
		const shown = heldOnly ? all.filter((scope) => user.scopes.includes(scope)) : all;
		return scopeChips(user.scopes, shown, shown.filter(isExplicit));
	}

	/** The API keys panel (D-146): each key's label, prefix, scopes and age with revoke, and the form for another. */
	function keysPanel(start: PublicUser, changed: () => Promise<PublicUser | null>): {
		node: HTMLElement;
		update(user: PublicUser): void;
	} {
		let current = start;
		const reveal = el('div', { class: 'acct-reveal', hidden: true });
		const list = el('ul', { class: 'acct-keys', 'aria-label': `API keys of ${start.username}` });
		const label = el('input', {
			type: 'text',
			id: 'key-label',
			autocomplete: 'off',
			maxlength: 64,
			placeholder: 'Label (optional)',
		});
		const scopes = scopePicker(start.scopes, {
			within: start.scopes,
			legend: 'Key scopes',
			presets: [
				{ label: 'All', scopes: () => current.scopes },
				{ label: 'Clear', scopes: () => [] },
			],
		});
		const submit = button({ label: 'Create key', icon: 'plus', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'acct-form acct-key-form' }, [
			el('div', { class: 'acct-key-form-head' }, [
				el('span', { class: 'acct-keybox-title', text: 'New key' }),
				el('div', { class: 'acct-keybox-field' }, [
					el('label', { class: 'sr-only', for: 'key-label', text: 'Key label' }),
					icon('tag'),
					label,
				]),
			]),
			scopes.node,
			formActions(submit),
		]);

		function paint(): void {
			const keys = current.keys ?? [];
			clear(list);
			if (keys.length === 0) {
				list.append(el('li', { class: 'acct-key none' }, [
					icon('key'),
					el('span', { text: 'No API keys yet. Create one below.' }),
				]));
				return;
			}
			const sorted = keys.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
			for (const key of sorted) {
				const revoke = confirmButton(
					{ label: `Revoke ${keyName(key)}`, icon: 'trash', small: true, iconOnly: true },
					async () => {
						await api.deleteUserKey(current.username, key.id);
						toast(`Key ${keyName(key)} revoked`, 'ok');
						await changed();
					},
				);
				list.append(el('li', { class: 'acct-key' }, [
					el('span', { class: 'acct-key-glyph', 'aria-hidden': 'true' }, [icon('key')]),
					el('div', { class: 'acct-key-main' }, [
						el('div', { class: 'acct-key-name' }, [
							el('span', { class: 'acct-key-label', text: key.label ?? 'Unnamed key' }),
							el('code', { class: 'acct-key-prefix mono', text: `${key.prefix}…` }),
						]),
						el('div', { class: 'acct-key-facts' }, [
							scopeChips(key.scopes, key.scopes, key.scopes.filter(isExplicit)),
							el('span', { class: 'acct-fact', 'data-tip': new Date(key.created_at).toLocaleString() }, [
								icon('clock'),
								el('span', { text: relativeTime(key.created_at) }),
							]),
						]),
					]),
					revoke,
				]));
			}
		}

		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const text = label.value.trim();
				const minted = await api.createUserKey(current.username, {
					...(text === '' ? {} : { label: text }),
					scopes: scopes.read(),
				});
				label.value = '';
				reveal.replaceChildren(
					shownOnce(),
					secretRow('key', keyName(minted.key), minted.secret, bearerHint(minted), 'Copy API key'),
				);
				reveal.hidden = false;
				toast(`Key ${keyName(minted.key)} created`, 'ok');
				await changed();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});

		paint();
		const unsupported = start.keys === undefined;
		return {
			node: el('div', { class: 'acct-panel' }, [
				reveal,
				...(unsupported
					? [
						el('div', { class: 'acct-once' }, [
							icon('info'),
							el('span', { text: 'This gateway predates account keys.' }),
						]),
					]
					: [list, form]),
			]),
			update(user: PublicUser) {
				current = user;
				paint();
			},
		};
	}

	/** The Scopes panel: the picker over the server's vocabulary, saved in one PATCH. */
	function scopesPanel(user: PublicUser, changed: () => Promise<PublicUser | null>): HTMLElement {
		const scopes = scopePicker(user.scopes, { presets: ACCOUNT_PRESETS });
		const submit = button({ label: 'Save scopes', icon: 'check', variant: 'primary', type: 'submit' });
		const form = el('form', { class: 'acct-form acct-panel' }, [scopes.node, formActions(submit)]);
		on(form, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				await api.updateUser(user.username, { scopes: scopes.read() });
				toast(`Scopes for ${user.username} saved`, 'ok');
				await changed();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		return form;
	}

	/** The Security panel: reset the password (a generated one is shown once), and end every open sign-in. */
	function securityPanel(start: PublicUser, changed: () => Promise<PublicUser | null>): {
		node: HTMLElement;
		update(user: PublicUser): void;
	} {
		let current = start;
		const password = passwordInput('reset-password', 'New password', 'new-password', 'lock', 'Blank: generate one');
		const submit = button({ label: 'Reset password', icon: 'lock', variant: 'primary', type: 'submit' });
		const reset = el('form', { class: 'acct-form acct-section' }, [
			el('div', { class: 'acct-section-head' }, [
				el('span', { class: 'acct-section-glyph', 'aria-hidden': 'true' }, [icon('lock')]),
				el('div', { class: 'acct-section-text' }, [
					el('h3', { text: 'Reset password' }),
					el('p', { text: 'Every open sign-in of this account ends; it signs in again with the new password.' }),
				]),
			]),
			password.node,
			formActions(submit),
		]);
		on(reset, 'submit', (event) => {
			event.preventDefault();
			void busy(submit, async () => {
				const chosen = password.input.value;
				const result = await api.resetPassword(current.username, chosen === '' ? undefined : chosen);
				password.input.value = '';
				toast(`Password for ${current.username} reset`, 'ok');
				if (result.password !== undefined) {
					revealCredentials(`New password for ${current.username}`, { password: result.password });
				}
				await changed();
			}).catch((cause) => toast(messageOf(cause), 'error'));
		});
		const count = el('span', { class: 'acct-section-count' });
		const signOut = button({ label: 'Sign out everywhere', icon: 'logout' });
		on(signOut, 'click', () =>
			void busy(signOut, async () => {
				const { closed } = await api.signOutEverywhere(current.username);
				toast(
					closed === 0
						? `${current.username} had no open sign-ins`
						: `Ended ${closed} sign-in${closed === 1 ? '' : 's'}`,
					'ok',
				);
				await changed();
			}).catch((cause) => toast(messageOf(cause), 'error')));
		const sessions = el('section', { class: 'acct-section row' }, [
			el('div', { class: 'acct-section-head' }, [
				el('span', { class: 'acct-section-glyph', 'aria-hidden': 'true' }, [icon('login')]),
				el('div', { class: 'acct-section-text' }, [
					el('h3', {}, [el('span', { text: 'Open sign-ins ' }), count]),
					el('p', {
						text: 'Ends every sign-in of this account in every browser. API keys keep working.',
					}),
				]),
			]),
			signOut,
		]);
		const paint = (): void => {
			count.textContent = String(current.sessions);
			signOut.disabled = current.sessions === 0;
		};
		paint();
		return {
			node: el('div', { class: 'acct-panel' }, [reset, sessions]),
			update(user: PublicUser) {
				current = user;
				paint();
			},
		};
	}

	/** The Overview panel: the account's facts, and its state controls — enable or disable, and delete. */
	function overviewPanel(user: PublicUser, changed: () => Promise<PublicUser | null>, close: () => void): HTMLElement {
		const status = statusOf(user);
		const fact = (glyphName: IconName, label: string, value: string | Node, tipText?: string): HTMLElement => {
			const node = el('div', { class: 'acct-stat' }, [
				el('span', { class: 'acct-stat-label' }, [icon(glyphName), el('span', { text: label })]),
				typeof value === 'string' ? el('span', { class: 'acct-stat-value', text: value }) : value,
			]);
			return tipText === undefined ? node : tip(node, tipText, 'top');
		};
		const toggle = button({
			label: user.disabled ? 'Enable account' : 'Disable account',
			icon: user.disabled ? 'play' : 'circle-pause',
			variant: user.disabled ? 'success' : undefined,
		});
		on(toggle, 'click', () =>
			void busy(toggle, async () => {
				await api.updateUser(user.username, { disabled: !user.disabled });
				toast(`${user.username} ${user.disabled ? 'enabled' : 'disabled'}`, 'ok');
				await changed();
			}).catch((cause) => toast(messageOf(cause), 'error')));
		const remove = confirmButton({ label: `Delete ${user.username}`, icon: 'trash' }, async () => {
			await api.deleteUser(user.username);
			toast(`${user.username} deleted`, 'ok');
			close();
			await load();
		});
		remove.classList.replace('wa-plain', 'wa-outlined');
		const selfReason = (verb: string): HTMLElement =>
			el('p', { class: 'acct-danger-note', text: `You cannot ${verb} your own account.` });
		if (user.self) {
			toggle.disabled = true;
			remove.disabled = true;
		}
		return el('div', { class: 'acct-panel' }, [
			el('div', { class: 'acct-stats' }, [
				fact('activity', 'Status', el('span', { class: `acct-status ${status.tone}`, text: status.text })),
				fact('shield', 'Role', roleOf(user)),
				fact('login', 'Open sign-ins', String(user.sessions)),
				fact('key', 'API keys', String(user.keys?.length ?? 0)),
				fact('calendar', 'Created', relativeTime(user.created_at), new Date(user.created_at).toLocaleString()),
				fact('clock', 'Updated', relativeTime(user.updated_at), new Date(user.updated_at).toLocaleString()),
			]),
			el('section', { class: 'acct-section' }, [
				el('div', { class: 'acct-section-head' }, [
					el('span', { class: 'acct-section-glyph', 'aria-hidden': 'true' }, [icon('shield-check')]),
					el('div', { class: 'acct-section-text' }, [
						el('h3', {}, [
							el('span', { text: 'Scopes ' }),
							el('span', { class: 'acct-section-count', text: `${user.scopes.length}/${vocabulary.length}` }),
						]),
						el('p', { text: 'What this account may do. Amber marks explicit grants.' }),
					]),
				]),
				scopeCluster(user),
			]),
			el('section', { class: 'acct-section danger' }, [
				el('div', { class: 'acct-section-head' }, [
					el('span', { class: 'acct-section-glyph', 'aria-hidden': 'true' }, [icon('alert')]),
					el('div', { class: 'acct-section-text' }, [
						el('h3', { text: 'Account state' }),
						el('p', {
							text: 'Disabling ends its sign-ins and stops its keys until enabled again. Deleting is permanent.',
						}),
					]),
				]),
				el('div', { class: 'acct-danger-actions' }, [toggle, remove]),
				...(user.self ? [selfReason('disable or delete')] : []),
			]),
		]);
	}

	type AccountTab = 'overview' | 'scopes' | 'keys' | 'security';
	const ACCOUNT_TABS: ReadonlyArray<readonly [AccountTab, string, IconName]> = [
		['overview', 'Overview', 'id-card'],
		['scopes', 'Scopes', 'shield-check'],
		['keys', 'API keys', 'key'],
		['security', 'Security', 'lock'],
	];

	/**
	 * One account in one dialog (D-152): its identity on top, then four tabs — Overview (facts, enable/disable,
	 * delete), Scopes, API keys and Security (password, sign-ins). Every change re-reads the account, so each tab
	 * shows what the server now holds; a minted key or a generated password is still revealed once.
	 */
	function openAccount(user: PublicUser, tab: AccountTab = 'overview'): void {
		let current = user;
		const head = el('header', { class: 'acct-modal-head' });
		const overview = el('div');
		const scopesSlot = el('div');
		let dialog: ReturnType<typeof openModal> | null = null;
		/** Re-reads the account after a change; closes the dialog when it no longer exists. */
		const changed = async (): Promise<PublicUser | null> => {
			await load();
			const next = latest.find((entry) => entry.username === current.username) ?? null;
			if (next === null) {
				dialog?.close();
				return null;
			}
			current = next;
			paint();
			keys.update(next);
			security.update(next);
			return next;
		};
		const keys = keysPanel(user, changed);
		const security = securityPanel(user, changed);
		function paint(): void {
			const status = statusOf(current);
			head.replaceChildren(
				el('div', { class: 'acct-avatar' }, [
					avatar(current.username, 'lg'),
					...(current.scopes.includes('admin') ? [glyph('shield', 'Administrator', 'acct-admin')] : []),
				]),
				el('div', { class: 'acct-who' }, [
					el('div', { class: 'acct-name-row' }, [
						el('span', { class: 'acct-name', text: current.username }),
						...(current.self ? [tag('you', 'user', 'ok')] : []),
					]),
					el('div', { class: 'acct-role' }, [
						el('span', { text: roleOf(current) }),
						el('span', { class: `acct-status ${status.tone}`, text: status.text }),
					]),
				]),
			);
			overview.replaceChildren(overviewPanel(current, changed, () => dialog?.close()));
			scopesSlot.replaceChildren(scopesPanel(current, changed));
		}
		paint();
		const panels: Record<AccountTab, Node> = {
			overview,
			scopes: scopesSlot,
			keys: keys.node,
			security: security.node,
		};
		const group = el('wa-tab-group', { class: 'acct-tabs', active: tab }, [
			...ACCOUNT_TABS.map(([name, label, glyphName]) =>
				el('wa-tab', { panel: name, slot: 'nav' }, [icon(glyphName), el('span', { text: label })])
			),
			...ACCOUNT_TABS.map(([name]) => el('wa-tab-panel', { name }, [panels[name]])),
		]);
		dialog = openModal('Account', [head, group]);
		dialog.node.classList.add('acct-modal');
	}

	/**
	 * One account as a card (D-152): the identity, the role and state, three numbers, and the held scopes. The whole
	 * card is one button that opens the account; it carries no actions of its own.
	 */
	function card(user: PublicUser, index: number): HTMLElement {
		const admin = user.scopes.includes('admin');
		const status = statusOf(user);
		const keyCount = user.keys?.length ?? 0;
		const stat = (value: string, label: string, live = false): HTMLElement =>
			el('span', { class: `acct-card-stat${live ? ' live' : ''}` }, [
				el('span', { class: 'acct-card-stat-value', text: value }),
				el('span', { class: 'acct-card-stat-label', text: label }),
			]);
		const node = el('button', {
			type: 'button',
			class: `acct-card${user.disabled ? ' disabled' : ''}${user.self ? ' self' : ''}`,
			'aria-label': `${user.username}, ${roleOf(user)}, ${status.text}. Open account`,
			'data-user': user.username,
		}, [
			el('span', { class: 'acct-card-head' }, [
				el('span', { class: 'acct-avatar' }, [
					avatar(user.username, 'lg'),
					...(admin ? [glyph('shield', 'Administrator', 'acct-admin')] : []),
				]),
				el('span', { class: 'acct-who' }, [
					el('span', { class: 'acct-name-row' }, [
						el('span', { class: 'acct-name', text: user.username }),
						...(user.self ? [el('span', { class: 'acct-you', text: 'You' })] : []),
					]),
					el('span', { class: 'acct-role', text: roleOf(user) }),
				]),
				el('span', { class: `acct-status ${status.tone}`, text: status.text }),
			]),
			el('span', { class: 'acct-card-stats' }, [
				stat(String(user.sessions), user.sessions === 1 ? 'sign-in' : 'sign-ins', user.sessions > 0),
				stat(String(keyCount), keyCount === 1 ? 'API key' : 'API keys'),
				stat(relativeTime(user.updated_at), 'updated'),
			]),
			el('span', { class: 'acct-card-scopes' }, [
				el('span', { class: 'acct-card-scopes-label', text: `${user.scopes.length}/${vocabulary.length} scopes` }),
				scopeCluster(user, true),
			]),
			el('span', { class: 'acct-card-open', 'aria-hidden': 'true' }, [icon('chevron')]),
		]);
		on(node, 'click', () => openAccount(user));
		node.style.setProperty('--i', String(Math.min(index, 12)));
		return node;
	}

	/** Brings one card into view and marks it (the command palette's "select"). */
	function select(username: string): void {
		const node = cards.get(username);
		if (node === undefined || !node.isConnected) return;
		node.scrollIntoView({ behavior: 'smooth', block: 'center' });
		node.focus({ preventScroll: true });
		node.classList.remove('picked');
		void node.offsetWidth;
		node.classList.add('picked');
	}

	function render(data: UsersResponse): void {
		vocabulary = data.vocabulary;
		latest = data.users;
		const admins = data.users.filter((user) => user.scopes.includes('admin') && !user.disabled).length;
		tiles.users.set(String(data.users.length), `${data.users.filter((user) => user.disabled).length} disabled`);
		tiles.admins.set(String(admins), 'enabled');
		tiles.sessions.set(
			String(data.users.reduce((sum, user) => sum + user.sessions, 0)),
			`up to ${Math.round(data.login_ttl_s / 86_400)} days`,
		);
		tiles.store.set(data.store.writable ? 'Writable' : 'Read-only', data.store.status);
		tiles.store.node.classList.toggle('warn', !data.store.writable);
		add.disabled = !data.store.writable;
		// The empty state carries the one "add" action; the header's appears once there is a list.
		add.hidden = data.users.length === 0;
		showNotice(
			data.store.writable
				? null
				: data.store.status === 'unreadable'
				? 'The user store on disk is unreadable; repair or remove it, then restart the gateway.'
				: 'This deployment has no TTK_DATA_DIR, so accounts can be used but not changed.',
		);
		const next = JSON.stringify([data.users, data.store.writable]);
		if (next === signature) return;
		signature = next;
		clear(list);
		cards.clear();
		if (data.users.length === 0) {
			const first = button({ label: 'Add user', icon: 'user-plus', variant: 'primary', onClick: () => openCreate() });
			first.disabled = !data.store.writable;
			list.append(empty('users', 'No accounts', 'Seed one with doctor --new-admin, or add one here.', first));
			clearCommands('users');
			return;
		}
		const sorted = data.users.slice().sort((a, b) => a.username.localeCompare(b.username));
		sorted.forEach((user, index) => {
			const node = card(user, index);
			cards.set(user.username, node);
			list.append(node);
		});
		registerCommands(
			'users',
			sorted.map((user) => ({
				id: `user:${user.username}`,
				label: user.username,
				icon: user.scopes.includes('admin') ? 'shield' : 'user',
				hint: user.self ? 'you' : user.disabled ? 'disabled' : undefined,
				keywords: `user account ${user.scopes.join(' ')}`,
				group: 'Users',
				run: () => {
					select(user.username);
					openAccount(user);
				},
			})),
		);
	}

	async function load(): Promise<void> {
		try {
			render(await api.listUsers());
		} catch (cause) {
			if (list.querySelector('.skeleton-group') !== null) clear(list);
			showNotice(
				cause instanceof ApiError && cause.status === 403
					? 'Access denied. Managing accounts requires the admin scope.'
					: `Could not load accounts: ${messageOf(cause)}`,
			);
			add.disabled = true;
		}
	}

	onLeave(() => clearCommands('users'));
	mount(
		renderShell(navigate, {
			active: 'users',
			title: 'Users',
			subtitle: 'Accounts, scopes, passwords and sign-ins',
			actions: [add],
		}, [
			el('div', { class: 'tiles' }, Object.values(tiles).map((tile) => tile.node)),
			notice,
			list,
		]),
	);
	void load();
	// No refresh button (D-092): the list follows changes made elsewhere on its own.
	poll(list, 15_000, () => void load());
}
