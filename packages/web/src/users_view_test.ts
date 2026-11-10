/// <reference lib="deno.ns" />
/**
 * `users_view.ts`: the new key's scope picker (D-146) against the fake document. It offers every scope the account
 * holds — the explicit grants included — and none it does not, and follows the account when its scopes change under
 * an open dialog. The server's check (`buildKey` in `packages/gateway/src/users.ts`) stays the authority; the
 * picker only offers what it would accept.
 *
 * The fake keeps an input's `value` as a plain property and `el()` writes the attribute, so a box is named by its
 * `value` attribute here, not by `read()`.
 */
import { assert, assertEquals, assertStrictEquals } from '@std/assert';
import type { PublicUser, ScopeInfo } from './api.ts';
import { adoptVocabulary, keyScopePicker } from './users_view.ts';
import { byClass, fake, type FakeElement, withDocument } from './test_document.ts';

/** The vocabulary as `GET /api/v1/users` declares it (`SCOPES`, `DEFAULT_SCOPES`, `EXPLICIT_SCOPES` in scopes.ts). */
const DEFAULTS = ['mcp:invoke', 'view:watch', 'view:control', 'files:read'];
const VOCABULARY: ScopeInfo[] = [
	'mcp:invoke',
	'view:watch',
	'view:control',
	'task',
	'admin',
	'evaluate',
	'sandbox:execute',
	'agent:invoke',
	'a2ui:publish',
	'files:read',
	'files:write',
	'metrics:read',
	'network:read',
	'model:invoke',
].map((scope) => ({
	scope,
	grants: `grants ${scope}`,
	default: DEFAULTS.includes(scope),
	explicit: !DEFAULTS.includes(scope),
}));
const EVERY = VOCABULARY.map((entry) => entry.scope).sort();

/** What `setup`'s administrator holds (the stack scopes plus `admin`): no `task`, `evaluate`, `metrics:read`, `network:read`. */
const SETUP_ADMIN = [
	...DEFAULTS,
	'files:write',
	'sandbox:execute',
	'agent:invoke',
	'model:invoke',
	'a2ui:publish',
	'admin',
];

function account(scopes: string[]): PublicUser {
	return {
		username: 'admin',
		scopes,
		disabled: false,
		created_at: '2026-10-01T00:00:00.000Z',
		updated_at: '2026-10-01T00:00:00.000Z',
		sessions: 1,
		self: true,
		keys: [],
	};
}

/** The scopes the picker under `root` offers, and the ones ticked, sorted (it lists the explicit group last). */
function offered(root: FakeElement): { offered: string[]; ticked: string[] } {
	const boxes = byClass(root, 'acct-scope-box');
	const names = (list: FakeElement[]): string[] => list.map((box) => box.getAttribute('value') ?? '').sort();
	return { offered: names(boxes), ticked: names(boxes.filter((box) => box.checked)) };
}

Deno.test('users (D-146): a new key is offered every scope its account holds, the explicit grants included', () => {
	withDocument(() => {
		adoptVocabulary(VOCABULARY);
		const picker = offered(fake(keyScopePicker(account(EVERY)).node));
		assertEquals(picker.offered, EVERY);
		assertEquals(picker.ticked, EVERY);
		for (const scope of ['evaluate', 'task', 'metrics:read', 'network:read']) assert(picker.offered.includes(scope));
	});
});

Deno.test('users (D-146): a new key is offered nothing its account does not hold', () => {
	withDocument(() => {
		adoptVocabulary(VOCABULARY);
		const picker = offered(fake(keyScopePicker(account(SETUP_ADMIN)).node));
		assertEquals(picker.offered, EVERY.filter((scope) => SETUP_ADMIN.includes(scope)));
	});
});

Deno.test('users (D-146): the key picker follows a grant saved while the account dialog is open', () => {
	withDocument((document) => {
		adoptVocabulary(VOCABULARY);
		// The account as its dialog opened; then the Scopes tab saves every scope and the dialog re-reads it.
		const picker = keyScopePicker(account(SETUP_ADMIN));
		const form = document.createElement('form');
		form.append(fake(picker.node));
		picker.follow(account(EVERY));
		assertEquals(offered(form).offered, EVERY, 'the four explicit grants made since the dialog opened are offered');
		assertEquals(offered(form).ticked, EVERY);
		assertEquals(byClass(form, 'acct-picker').length, 1, 'the picker is replaced, not stacked');
		assertStrictEquals(form.children[0], fake(picker.node), 'node names the picker on offer');
	});
});

Deno.test('users (D-146): the key picker stops offering a scope its account no longer holds', () => {
	withDocument((document) => {
		adoptVocabulary(VOCABULARY);
		const picker = keyScopePicker(account(EVERY));
		const form = document.createElement('form');
		form.append(fake(picker.node));
		picker.follow(account(SETUP_ADMIN));
		assertEquals(offered(form).offered, EVERY.filter((scope) => SETUP_ADMIN.includes(scope)));
	});
});

Deno.test('users (D-146): a re-read that leaves the scopes alone (a key minted, a key revoked) keeps the selection', () => {
	withDocument((document) => {
		adoptVocabulary(VOCABULARY);
		const picker = keyScopePicker(account(EVERY));
		const form = document.createElement('form');
		form.append(fake(picker.node));
		const evaluate = byClass(form, 'acct-scope-box').find((box) => box.getAttribute('value') === 'evaluate')!;
		evaluate.checked = false;
		picker.follow(account([...EVERY].reverse()));
		assertEquals(offered(form).ticked, EVERY.filter((scope) => scope !== 'evaluate'));
	});
});
