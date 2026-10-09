/**
 * `parseAction` — reading one browser action out of whatever a model replied.
 *
 * The cases here are not invented. Every "a model really does this" test below
 * is a reply shape observed from a real model against the R2 prompt, which is
 * the point: this function's whole job is to be robust to how models actually
 * answer rather than to how the system prompt asked them to.
 */
import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { MAX_TASK_STEPS, parseAction } from './agent.ts';
import { ToolError } from './errors.ts';

Deno.test('parseAction: a clean single object', () => {
	const action = parseAction('{"thought":"the only control","action":"click","index":16}');
	assertEquals(action.action, 'click');
	assertEquals(action.index, 16);
	assertEquals(action.thought, 'the only control');
});

Deno.test('parseAction: prose and code fences around the object are ignored', () => {
	const action = parseAction(
		'Sure! Here is the action:\n```json\n{"action":"done","answer":"hello"}\n```\nHope that helps.',
	);
	assertEquals(action.action, 'done');
	assertEquals(action.answer, 'hello');
});

Deno.test('parseAction: a model really does split thought and action across two objects', () => {
	// ERRATUM(E-28), measured verbatim from gemma-4-e4b: the first object has no
	// `action` at all, and the old parser stopped there and threw the step away.
	const action = parseAction(
		'{"thought":"The task is to press the button and report the text the page then shows. ' +
			"The button has the text 'Press me' at index 16. I will click it.\"}\n" +
			'{"action":"click","index":16}',
	);
	assertEquals(action.action, 'click');
	assertEquals(action.index, 16);
});

Deno.test('parseAction: an unparseable object before a good one does not end the turn', () => {
	// The larger model does this whenever a quoted phrase lands in its thought:
	// the inner quotes are unescaped, so the object is balanced but not JSON.
	const action = parseAction(
		'{"thought":"I need to click the "Press me" button."}\n{"action":"click","index":16}',
	);
	assertEquals(action.action, 'click');
});

Deno.test('parseAction: a truncated object does not hide a later complete one', () => {
	const action = parseAction('{"thought":"cut off mid-str\n{"action":"done","answer":"ok"}');
	assertEquals(action.action, 'done');
});

Deno.test('parseAction: nested objects inside the action survive', () => {
	const action = parseAction('{"action":"type","index":2,"text":"{\\"not\\":\\"an action\\"}"}');
	assertEquals(action.action, 'type');
	assertEquals(action.text, '{"not":"an action"}');
});

Deno.test('parseAction: the first object with an action wins, not the last', () => {
	const action = parseAction('{"action":"click","index":1}\n{"action":"done","answer":"no"}');
	assertEquals(action.action, 'click');
});

Deno.test('parseAction: pure prose is refused, and says so', () => {
	const error = assertThrows(
		() => parseAction('Sure! I would be happy to help with that.'),
		ToolError,
	);
	assertStringIncludes(error.message, 'no JSON object');
});

Deno.test('parseAction: objects with no action report that, not a parse error', () => {
	// The distinction matters: it is what the model is told in the next round.
	const error = assertThrows(() => parseAction('{"thought":"thinking"}\n{"still":"thinking"}'), ToolError);
	assertStringIncludes(error.message, 'no "action"');
});

Deno.test('parseAction: an action wrapped in a JSON array is still read', () => {
	// The one case where E-28's widening changes an old answer. The array itself
	// is not an action, but its element is a balanced object carrying one and the
	// model's intent is unambiguous — so it is taken rather than thrown away.
	assertEquals(parseAction('[{"action":"click","index":3}]').index, 3);
});

Deno.test('parseAction: an empty action string is refused', () => {
	const error = assertThrows(() => parseAction('{"action":""}'), ToolError);
	assertStringIncludes(error.message, 'no "action"');
});

Deno.test('the step ceiling is a real bound, whatever a caller asks for', () => {
	assertEquals(MAX_TASK_STEPS, 25);
});
