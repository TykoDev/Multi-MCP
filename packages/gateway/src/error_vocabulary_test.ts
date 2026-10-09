/**
 * §8's "one documented error code list", reconciled against the three vocabularies that ship.
 *
 * `needed-browser-functions.md` §8 asks for eleven names. Three vocabularies already existed when it
 * was written and each is frozen — tool error codes, RFC 7807 problem slugs, and WebSocket error
 * codes — so several of the eleven already shipped under this repository's own spellings. Renaming
 * one would break every client that matches on it; adding a synonym would be worse, because two names
 * for one fact means neither is authoritative.
 *
 * **So this test is the mapping, executable.** Every spelling §8 asks for resolves here to exactly
 * one shipped member of exactly one vocabulary, and the table in
 * `SPECS/CONNECTORS-MCP-A2A-A2UI.md` §1.5 says the same thing in prose. A code renamed, removed, or
 * duplicated across vocabularies fails here — which is the drift the published table could otherwise
 * suffer silently.
 *
 * It lives in `packages/gateway` because that is the only package that can see all three: the tool
 * codes come from `@tykotech/mcp`, the WS codes from `@tykotech/wire`, and the problem slugs are
 * local.
 */
import { assert, assertEquals } from '@std/assert';
import { TOOL_ERROR_CODES } from '@tykotech/mcp';
import { WS_ERROR_CODES } from '@tykotech/wire';
import { PROBLEM_SLUGS } from './problem.ts';

type Vocabulary = 'tool-error' | 'problem-slug' | 'ws-error';

/**
 * The published mapping. Left column is exactly what §8 asks for; right column is what ships.
 *
 * A row whose `shipped` differs from the `asked` name is a deliberate non-rename, and the reason is
 * always the same one: the condition already had a name on the wire before §8 was written.
 */
const MAPPING: ReadonlyArray<{ asked: string; shipped: string; vocabulary: Vocabulary; note: string }> = [
	{
		asked: 'human-has-control',
		shipped: 'human-has-control',
		vocabulary: 'tool-error',
		note: 'unchanged; gained a second producer when G-2 moved the all-sessions-locked case off the protocol error',
	},
	{
		asked: 'session-not-found',
		shipped: 'unknown-session',
		vocabulary: 'tool-error',
		note:
			'already exists with exactly this meaning, and in the problem-slug vocabulary too; a synonym would be a second name for one fact',
	},
	{ asked: 'session-limit', shipped: 'session-limit', vocabulary: 'tool-error', note: 'unchanged' },
	{
		asked: 'origin-not-allowed',
		shipped: 'origin-forbidden',
		vocabulary: 'problem-slug',
		note: 'defined before this delivery; B1.10 gave it its first live emitter (the per-token origin overlay)',
	},
	{ asked: 'ticket-expired', shipped: 'ticket-expired', vocabulary: 'problem-slug', note: 'unchanged' },
	{
		asked: 'input-rejected',
		shipped: 'input-rejected',
		vocabulary: 'ws-error',
		note: 'new in 0.2.0 (B1.11, G-7), with a closed reason enum',
	},
	{
		asked: 'element-not-found',
		shipped: 'element-not-found',
		vocabulary: 'tool-error',
		note: 'new in 0.2.0 (B1.4); alongside unknown-index, which keeps its exact meaning',
	},
	{
		asked: 'element-not-interactable',
		shipped: 'element-not-interactable',
		vocabulary: 'tool-error',
		note: 'new in 0.2.0 (B2.5)',
	},
	{
		asked: 'download-failed',
		shipped: 'download-failed',
		vocabulary: 'tool-error',
		note:
			'new in 0.2.0 (B3.2); a download that STARTS and then fails is a success result with status failed, and an off-allowlist one keeps navigation-blocked',
	},
	{
		asked: 'dialog-open',
		shipped: 'dialog-open',
		vocabulary: 'tool-error',
		note: 'new in 0.2.0 (B3.2); raised only while manual dialog handling is armed',
	},
	{
		asked: 'rate-limited',
		shipped: 'rate-limited',
		vocabulary: 'problem-slug',
		note: 'unchanged; also answers the SSE connection caps',
	},
];

const VOCABULARIES: Record<Vocabulary, readonly string[]> = {
	'tool-error': TOOL_ERROR_CODES,
	'problem-slug': PROBLEM_SLUGS,
	'ws-error': WS_ERROR_CODES,
};

Deno.test('§8: every requested error name resolves to exactly one shipped code', () => {
	// One assertion per code, by name, so a failure says which of the eleven
	// stopped resolving rather than that a count moved.
	for (const row of MAPPING) {
		const members = VOCABULARIES[row.vocabulary];
		assert(
			members.includes(row.shipped),
			`§8 asks for "${row.asked}"; this repository ships it as "${row.shipped}" in the ${row.vocabulary} ` +
				`vocabulary, and that member is gone. ${row.note}`,
		);
	}
});

Deno.test('§8: the eleven requested names are all covered, none twice', () => {
	const asked = MAPPING.map((row) => row.asked);
	assertEquals(new Set(asked).size, asked.length, 'a requested name is mapped twice');
	assertEquals(asked.length, 11, `§8 names eleven codes; the table maps ${asked.length}`);
	// And the four §8 asked for that this repository answers under a different
	// spelling are named explicitly, so a later editor cannot quietly "fix" the
	// mapping into a rename.
	const renamed = MAPPING.filter((row) => row.asked !== row.shipped).map((row) => `${row.asked}->${row.shipped}`);
	assertEquals(renamed, ['session-not-found->unknown-session', 'origin-not-allowed->origin-forbidden']);
});

Deno.test('§8: a mapped condition never has two names across the three vocabularies', () => {
	// The freeze rule's real content: `unknown-session` is allowed to exist in
	// two vocabularies because it is the same word on two different wires, but
	// no *pair* of shipped spellings for one condition may both exist. Concretely:
	// the spellings §8 asked for and this repository declined must NOT have been
	// added as synonyms somewhere while nobody was looking.
	const declined = MAPPING.filter((row) => row.asked !== row.shipped).map((row) => row.asked);
	for (const name of declined) {
		for (const [vocabulary, members] of Object.entries(VOCABULARIES)) {
			assert(
				!members.includes(name),
				`"${name}" was added to the ${vocabulary} vocabulary as a synonym; the condition already ships as ` +
					`"${MAPPING.find((row) => row.asked === name)?.shipped}"`,
			);
		}
	}
});

Deno.test('the three vocabularies are closed, and their sizes are stated by name', () => {
	// Not a count: the whole membership. A count assertion passes a build where
	// one member was renamed and another added, which is exactly the drift the
	// published §1.5 table cannot survive.
	assertEquals([...TOOL_ERROR_CODES].sort(), [
		'browser-crashed',
		'browser-error',
		'browser-unavailable',
		'dialog-open',
		'download-failed',
		'element-not-found',
		'element-not-interactable',
		'feature-unavailable',
		'file-unavailable',
		'human-has-control',
		'invalid-arguments',
		'navigation-blocked',
		'scope-required',
		'session-limit',
		'timeout',
		'unknown-file',
		'unknown-index',
		'unknown-session',
		'unknown-tab',
		// S0 (design §2.4): twenty in all, `user-declined` the newest.
		'user-declined',
	]);
	assertEquals([...PROBLEM_SLUGS].sort(), [
		'conflict',
		'csrf-failed',
		'forbidden-scope',
		'host-forbidden',
		'internal',
		'invalid-request',
		'not-found',
		'origin-forbidden',
		'payload-too-large',
		'persistence-required',
		'rate-limited',
		'service-unavailable',
		'ticket-consumed',
		'ticket-expired',
		'ticket-invalid',
		'unauthenticated',
		'unknown-session',
	]);
	assertEquals([...WS_ERROR_CODES].sort(), [
		'bad-message',
		'browser-crashed',
		'input-rejected',
		'internal',
		'lock-held',
		'navigation-blocked',
		'not-holder',
		'not-ready',
	]);
});
