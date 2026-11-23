/** Password fields, and the signed-in operator's own password change (from the account menu). */
import { api, ApiError, hasSession, type UserInfo } from './api.ts';
import { el, on } from './dom.ts';
import { busy, button, field, messageOf, openModal, toast } from './ui.ts';

export function passwordInput(id: string, label: string, autocomplete: string, placeholder?: string): {
	node: HTMLElement;
	input: HTMLInputElement;
} {
	const input = el('input', { type: 'password', id, autocomplete, minlength: 8, maxlength: 256, placeholder });
	return { node: field(id, label, input), input };
}

/**
 * Whether this sign-in may change its account's password: an account's password sign-in, or one of the account's
 * own API keys (the server accepts either with the current password). Never a configured key's sign-in.
 */
export function canChangeOwnPassword(user: UserInfo | null, signedIn: boolean = hasSession()): boolean {
	if (!signedIn || user === null) return false;
	if (user.backing !== undefined) return user.backing === 'user' || user.backing === 'user-key';
	return user.username !== undefined || user.id.startsWith('admin:');
}

/** What the dialog says after a change: a key's sign-in ends no sign-in of its own, only the password ones. */
export function passwordChangedText(user: UserInfo | null): string {
	return user?.backing === 'user-key'
		? "Password changed; the account's password sign-ins have ended"
		: 'Password changed; your other sign-ins have ended';
}

/** The dialog that changes the signed-in operator's own password. */
export function openOwnPassword(user: UserInfo | null): void {
	const current = passwordInput('current-password', 'Current password', 'current-password');
	const next = passwordInput('next-password', 'New password', 'new-password');
	const again = passwordInput('again-password', 'New password again', 'new-password');
	const change = button({ label: 'Change password', variant: 'primary', type: 'submit' });
	const form = el('form', { class: 'form' }, [
		current.node,
		next.node,
		again.node,
		el('div', { class: 'actions' }, [
			change,
		]),
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
		}).catch((cause) =>
			toast(
				cause instanceof ApiError && cause.status === 401 ? 'The current password is wrong' : messageOf(cause),
				'error',
			)
		);
	});
	current.input.focus();
}
