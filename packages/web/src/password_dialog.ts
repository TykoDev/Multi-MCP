/**
 * Password fields and the signed-in operator's own password change.
 *
 * The change lives in the account popover (D-092), so any account sign-in — a
 * password's, or since D-148 one of the account's own API keys' — can reach it
 * from every screen; the Users screen shares the field helpers.
 */
import { api, ApiError, hasSession, type UserInfo } from './api.ts';
import { el, on } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { avatar, busy, button, iconButton, messageOf, openModal, relabel, toast } from './ui.ts';

/** A labelled field with a leading glyph. */
export function field(
	id: string,
	label: string,
	leading: IconName,
	input: HTMLInputElement,
	extra: Node[] = [],
): HTMLElement {
	return el('div', { class: 'acct-field' }, [
		el('label', { class: 'acct-label', for: id, text: label }),
		el('div', { class: 'acct-input' }, [icon(leading), input, ...extra]),
	]);
}

export function passwordInput(
	id: string,
	label: string,
	autocomplete: string,
	leading: IconName = 'lock',
	placeholder?: string,
): { node: HTMLElement; input: HTMLInputElement } {
	const input = el('input', { type: 'password', id, autocomplete, minlength: 8, maxlength: 256, placeholder });
	const reveal = iconButton('eye', 'Show password', undefined, { small: true, tip: 'left' });
	on(reveal, 'click', () => {
		const shown = input.type === 'password';
		input.type = shown ? 'text' : 'password';
		relabel(reveal, shown ? 'Hide password' : 'Show password', shown ? 'eye-off' : 'eye');
	});
	return { node: field(id, label, leading, input, [reveal]), input };
}

export function formActions(submit: HTMLButtonElement): HTMLElement {
	return el('div', { class: 'acct-form-actions' }, [submit]);
}

/**
 * Whether this browser's sign-in may change its account's password (`POST /api/v1/auth/password`): a sign-in to an
 * account — with its password, or (D-148) with one of the account's own API keys, which the server lets change the
 * account's password given the current one. Not a configured API key's sign-in (no account, no password), and not a
 * page with no sign-in. `signedIn` is the page's sign-in state, a parameter so the decision can be tested alone.
 */
export function canChangeOwnPassword(user: UserInfo | null, signedIn: boolean = hasSession()): boolean {
	if (!signedIn || user === null) return false;
	// D-146: an account's own key names the account too, so the backing — when known — decides.
	if (user.backing !== undefined) return user.backing === 'user' || user.backing === 'user-key';
	return user.username !== undefined || user.id.startsWith('admin:');
}

/** What the dialog says after a change: a key's sign-in ends no sign-in of its own, only the password ones (D-148). */
export function passwordChangedText(user: UserInfo | null): string {
	return user?.backing === 'user-key'
		? "Password changed; the account's password sign-ins have ended"
		: 'Password changed; your other sign-ins have ended';
}

/** The dialog that changes the signed-in operator's own password; `done` runs after a change. */
export function openOwnPassword(user: UserInfo | null, done?: () => void): void {
	const name = user === null ? 'Signed in' : user.username ?? user.label ?? user.id;
	const current = passwordInput('current-password', 'Current password', 'current-password', 'lock');
	const next = passwordInput('next-password', 'New password', 'new-password', 'key');
	const again = passwordInput('again-password', 'New password again', 'new-password', 'check');
	const change = button({ label: 'Change password', icon: 'key', variant: 'primary', type: 'submit' });
	const form = el('form', { class: 'acct-form' }, [
		el('div', { class: 'acct-me' }, [avatar(name, 'md'), el('span', { class: 'acct-name', text: name })]),
		current.node,
		next.node,
		again.node,
		formActions(change),
	]);
	const dialog = openModal('Change your password', [form]);
	on(form, 'submit', (event) => {
		event.preventDefault();
		if (next.input.value !== again.input.value) {
			toast('The new passwords do not match', 'error');
			return;
		}
		void busy(change, async () => {
			await api.changePassword(current.input.value, next.input.value);
			form.reset();
			dialog.close();
			toast(passwordChangedText(user), 'ok');
			done?.();
		}).catch((cause) =>
			toast(
				cause instanceof ApiError && cause.status === 401 ? 'The current password is wrong' : messageOf(cause),
				'error',
			)
		);
	});
	current.input.focus();
}
