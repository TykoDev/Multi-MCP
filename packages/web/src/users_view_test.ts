/// <reference lib="deno.ns" />
/**
 * The Users screen's scope picker over the vocabulary the server declares: an account is offered every scope, a new
 * key exactly the scopes its account holds (the server checks it too).
 */
import { assertEquals } from '@std/assert';
import type { ScopeInfo } from './api.ts';
import { adoptVocabulary, scopePicker } from './users_view.ts';
import { byClass, fake, withDocument } from './test_document.ts';

const DEFAULTS = ['mcp:invoke', 'view:watch', 'files:read'];
const VOCABULARY: ScopeInfo[] = ['mcp:invoke', 'view:watch', 'admin', 'evaluate', 'agent:invoke', 'files:read'].map((
	scope,
) => ({ scope, grants: `grants ${scope}`, default: DEFAULTS.includes(scope), explicit: !DEFAULTS.includes(scope) }));

Deno.test('users: an account is offered every scope; a key only what its account holds, all ticked', () => {
	withDocument(() => {
		adoptVocabulary(VOCABULARY);
		const offered = (node: HTMLElement): { offered: string[]; ticked: string[] } => {
			const boxes = byClass(fake(node), 'acct-scope-box');
			const names = (list: typeof boxes): string[] => list.map((box) => box.getAttribute('value') ?? '').sort();
			return { offered: names(boxes), ticked: names(boxes.filter((box) => box.checked)) };
		};
		const account = scopePicker(DEFAULTS);
		assertEquals(offered(account.node).offered, VOCABULARY.map((entry) => entry.scope).sort());
		assertEquals(account.read().sort(), [...DEFAULTS].sort());
		const held = ['mcp:invoke', 'evaluate', 'admin'];
		assertEquals(offered(scopePicker(held, held).node), { offered: held.sort(), ticked: held.sort() });
	});
});
