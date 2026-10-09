/// <reference lib="deno.ns" />
/**
 * `agent_chat.ts` (D-147): a task read as one chat turn — its request, its answer, the artifacts the answer does not
 * already say, its title — the turn order, and the rich-text renderer, which draws a model's Markdown without ever
 * turning a string of it into markup.
 */
import { assert, assertEquals } from '@std/assert';
import {
	answerOf,
	type ChatTask,
	extraArtifacts,
	orderTurns,
	requestOf,
	richText,
	statusLineOf,
	titleOf,
} from './agent_chat.ts';
import { all, byTag, fake, withDocument } from './test_document.ts';

function task(patch: Partial<ChatTask> = {}): ChatTask {
	return {
		id: 't1',
		status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-07T10:00:00.000Z' },
		artifacts: [],
		history: [{ parts: [{ text: 'What is on the page?' }] }],
		metadata: { kind: 'text' },
		...patch,
	};
}

Deno.test('agent_chat: the request is the first message — words, a tool call, or data', () => {
	assertEquals(requestOf(task()), { kind: 'text', text: 'What is on the page?' });
	assertEquals(
		requestOf(
			task({ history: [{ parts: [{ data: { tool: 'browser_navigate', arguments: { url: 'https://a.b' } } }] }] }),
		),
		{ kind: 'tool', tool: 'browser_navigate', args: { url: 'https://a.b' } },
	);
	assertEquals(requestOf(task({ history: [{ parts: [{ data: { peer: 'x' } }] }] })), {
		kind: 'data',
		data: { peer: 'x' },
	});
	assertEquals(requestOf(task({ history: [] })), { kind: 'text', text: '' });
});

Deno.test('agent_chat: the answer is the agent’s messages in the history, else its agent-response artifact', () => {
	const spoken = task({
		history: [
			{ parts: [{ text: 'Hi' }] },
			{ role: 'ROLE_USER', parts: [{ data: { optionId: 'allow' } }] },
			{ role: 'ROLE_AGENT', parts: [{ text: 'Hello there.' }] },
		],
		artifacts: [{ name: 'agent-response', parts: [{ text: 'Hello there.' }] }],
	});
	assertEquals(answerOf(spoken), 'Hello there.', 'a permission decision is not the answer');
	assertEquals(extraArtifacts(spoken), [], 'the agent-response artifact says what the answer says');
	const artifactOnly = task({ artifacts: [{ name: 'agent-response', parts: [{ text: 'From the artifact.' }] }] });
	assertEquals(answerOf(artifactOnly), 'From the artifact.');
	const tool = task({ artifacts: [{ name: 'result', parts: [{ data: { ok: true } }] }] });
	assertEquals(answerOf(tool), '');
	assertEquals(extraArtifacts(tool).map((artifact) => artifact.name), ['result']);
});

Deno.test('agent_chat: the status line is the status message’s words; titles are short', () => {
	const failed = task({
		status: { state: 'TASK_STATE_FAILED', timestamp: 'x', message: { parts: [{ text: 'Provider unreachable' }] } },
	});
	assertEquals(statusLineOf(failed), 'Provider unreachable');
	assertEquals(statusLineOf(task()), '');
	assertEquals(
		titleOf(task({ history: [{ parts: [{ text: '\n  Summarise this page please  \nmore' }] }] })),
		'Summarise this page please',
	);
	assertEquals(titleOf(task({ history: [{ parts: [{ text: 'x'.repeat(80) }] }] }), 20), `${'x'.repeat(19)}…`);
	assertEquals(
		titleOf(
			task({ history: [{ parts: [{ data: { tool: 'sandbox_list', arguments: {} } }] }], metadata: { kind: 'tool' } }),
		),
		'sandbox_list',
	);
	assertEquals(titleOf(task({ history: [], metadata: { kind: 'delegation' } })), 'Delegation');
});

Deno.test('agent_chat: turns read oldest first by creation, then by update, ties by id', () => {
	const a = task({ id: 'a', created_at: '2026-10-07T09:00:00.000Z' });
	const b = task({ id: 'b', created_at: '2026-10-07T08:00:00.000Z' });
	const c = task({ id: 'c', created_at: '2026-10-07T08:00:00.000Z' });
	assertEquals(orderTurns([a, c, b]).map((turn) => turn.id), ['b', 'c', 'a']);
	// An older gateway sends no creation time: the last update orders them.
	const d = task({ id: 'd', status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-07T07:00:00.000Z' } });
	assertEquals(orderTurns([a, d]).map((turn) => turn.id), ['d', 'a']);
});

Deno.test('agent_chat: rich text draws fences, headings, lists, quotes and inline marks as elements, never markup', () => {
	withDocument(() => {
		const root = fake(richText([
			'# Title',
			'Some **bold**, *italic*, `code` and a [link](https://example.com).',
			'',
			'- one',
			'- two',
			'',
			'1. first',
			'2. second',
			'',
			'> quoted',
			'',
			'```ts',
			'const x = "<b>not markup</b>";',
			'```',
			'<img src=x onerror=alert(1)>',
			'[bad](javascript:alert(1))',
		].join('\n')));
		assertEquals(byTag(root, 'p')[0]?.textContent, 'Title');
		assertEquals(byTag(root, 'strong')[0]?.textContent, 'bold');
		assertEquals(byTag(root, 'em')[0]?.textContent, 'italic');
		assertEquals(byTag(root, 'code')[0]?.textContent, 'code');
		const link = byTag(root, 'a')[0];
		assertEquals(link?.getAttribute('href'), 'https://example.com');
		assertEquals(link?.getAttribute('rel'), 'noopener noreferrer');
		assertEquals(byTag(root, 'a').length, 1, 'a javascript: link stays text');
		assertEquals(byTag(byTag(root, 'ul')[0]!, 'li').map((li) => li.textContent), ['one', 'two']);
		assertEquals(byTag(byTag(root, 'ol')[0]!, 'li').map((li) => li.textContent), ['first', 'second']);
		assertEquals(byTag(root, 'blockquote')[0]?.textContent, 'quoted');
		assertEquals(byTag(root, 'figcaption')[0]?.textContent, 'ts');
		assertEquals(byTag(byTag(root, 'pre')[0]!, 'code')[0]?.textContent, 'const x = "<b>not markup</b>";');
		assert(!all(root).some((node) => node.tagName.toLowerCase() === 'img'), 'an <img> in the text stays text');
		assert(root.textContent.includes('<img src=x onerror=alert(1)>'));
		assert(root.textContent.includes('[bad](javascript:alert(1))'));
	});
});

Deno.test('agent_chat: a runaway answer is cut and says so', () => {
	withDocument(() => {
		const root = fake(richText('a'.repeat(50), 10));
		assertEquals(root.textContent, `${'a'.repeat(10)}… (truncated)`);
	});
});
