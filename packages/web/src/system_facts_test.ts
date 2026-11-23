/**
 * The System screen's reading of the diagnostics: an absent key is unknown, never off; values are read defensively and
 * no markup reaches a tile.
 */
import { assert, assertEquals } from '@std/assert';
import {
	CAPABILITY_INFO,
	configRowMatches,
	diagnosticsKey,
	featureState,
	NOT_REPORTED,
	OPT_IN,
	optInState,
	ownershipState,
} from './system_facts.ts';

Deno.test('system facts: an absent key is unknown, never off; every tile says what it does', () => {
	for (const [name, key, yes, no] of OPT_IN) {
		assertEquals(optInState(key, yes, no, {}, {}), { unknown: NOT_REPORTED }, key);
		assert(CAPABILITY_INFO[name] !== undefined, name);
	}
	assertEquals(featureState(Symbol('x'), 'On', 'Off'), { unknown: NOT_REPORTED });
	assertEquals(featureState('a value that is far too long to be a short word', 'On', 'Off'), { unknown: NOT_REPORTED });
});

Deno.test('system facts: booleans, null, off-words, words and objects', () => {
	const off = { on: false, yes: 'On', no: 'Off' };
	assertEquals(featureState(true, 'On', 'Off'), { on: true, yes: 'On', no: 'Off' });
	assertEquals(featureState(null, 'On', 'Off'), off);
	for (const word of ['off', 'OFF', 'none', 'disabled', '']) assertEquals(featureState(word, 'On', 'Off'), off, word);
	assertEquals(featureState('watch', 'On', 'Off'), { on: true, yes: 'On', no: 'Off', detail: 'watch' });
	// Markup never reaches a tile as a detail.
	assertEquals(featureState('<b>x</b>', 'On', 'Off'), { unknown: NOT_REPORTED });
	assertEquals(featureState({ mode: 'control' }, 'On', 'Off'), { on: true, yes: 'On', no: 'Off', detail: 'control' });
	assertEquals(featureState({ mode: 'off' }, 'On', 'Off'), off);
	assertEquals(featureState({ enabled: false, mode: 'watch' }, 'On', 'Off'), off);
	assertEquals(featureState({ provider: '1password', enabled: true }, 'On', 'None'), {
		on: true,
		yes: 'On',
		no: 'None',
		detail: '1password',
	});
});

Deno.test('system facts: session ownership reads shared or owner; a key is read from config first', () => {
	assertEquals(ownershipState('owner'), { on: true, yes: 'Per principal', no: 'Shared' });
	assertEquals(ownershipState('shared'), { on: false, yes: 'Per principal', no: 'Shared' });
	assertEquals(ownershipState('everyone'), { unknown: NOT_REPORTED });
	assertEquals(diagnosticsKey({ mcpApps: true }, { mcpApps: false }, 'mcpApps'), true);
	assertEquals(diagnosticsKey({}, { mcpApps: false }, 'mcpApps'), false);
	assertEquals(optInState('sessionOwnership', '', '', { sessionOwnership: 'owner' }, {}), ownershipState('owner'));
	assertEquals(optInState('humanHandoff', 'Enabled', 'Off', { humanHandoff: false }, {}), {
		on: false,
		yes: 'Enabled',
		no: 'Off',
	});
});

Deno.test('system facts: the configuration filter matches every word in the name or the value', () => {
	assert(configRowMatches('', 'TTK_HOST', '0.0.0.0'));
	assert(configRowMatches('sandbox', 'TTK_SANDBOX_URL', 'none (off)'));
	assert(configRowMatches('ttk_host 0.0', 'TTK_HOST', '0.0.0.0'));
	assert(!configRowMatches('host 1.2', 'TTK_HOST', '0.0.0.0'));
});
