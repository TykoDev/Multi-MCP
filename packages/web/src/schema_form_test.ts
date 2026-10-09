/// <reference lib="deno.ns" />
/**
 * `schemaForm` (run model-providers-ui): the Tools console's argument form, moved to its own module so the task
 * composer and the configuration composer render the same way. The form was untested at the unit tier before the
 * move; these pin what each schema shape builds and what `read()` sends back, against the fake document in
 * `test_document.ts`. Real Chromium drives the form in `tests/e2e/`.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import type { JsonSchema } from './mcp.ts';
import { schemaForm } from './schema_form.ts';
import { byClass, byRole, byTag, fake, type FakeElement, withDocument } from './test_document.ts';

function form(properties: Record<string, JsonSchema>, required: string[] = []) {
	const built = schemaForm({ type: 'object', properties, required }, 'arg-');
	return { ...built, root: fake(built.node) };
}

/** The control of the field named `name`: the element whose id is `arg-<name>`. */
function control(root: FakeElement, name: string): FakeElement {
	for (const candidate of [root, ...descendants(root)]) if (candidate.id === `arg-${name}`) return candidate;
	throw new Error(`no control for ${name}`);
}

function descendants(node: FakeElement): FakeElement[] {
	const out: FakeElement[] = [];
	for (const child of node.children) out.push(child, ...descendants(child));
	return out;
}

Deno.test('schema form: a string is a kit input, labelled and described for assistive technology, sent only when set', () => {
	withDocument(() => {
		const { root, read } = form({ url: { type: 'string', format: 'uri', description: 'Where to go.' } }, ['url']);
		const input = control(root, 'url');
		assertEquals(input.tagName, 'wa-input');
		assertEquals(input.getAttribute('type'), 'text');
		assertEquals(input.getAttribute('placeholder'), 'https://');
		assertEquals(input.getAttribute('label'), 'url (required)');
		assertEquals(input.getAttribute('hint'), 'Where to go.');
		assert(input.classList.contains('tc-kit'));
		// The visible head: a label pointing at the control, the required mark, the description as a tooltip.
		const label = byTag(root, 'label')[0]!;
		assertEquals(label.getAttribute('for'), 'arg-url');
		assertEquals(label.id, 'arg-url-label');
		assertEquals(byClass(root, 'tc-req').length, 1);
		assertEquals(byClass(root, 'tc-info')[0]!.getAttribute('data-tip'), 'Where to go.');
		assertEquals(byTag(byClass(root, 'tc-label')[0]!, 'use')[0]!.getAttribute('href'), '/assets/icons.svg#link');
		assertThrows(() => read(), Error, 'url is required');
		input.value = 'https://example.test/';
		assertEquals(read(), { url: 'https://example.test/' });
	});
});

Deno.test('schema form: an enum is a select over indices, cleared to omit when optional, started on its default', () => {
	withDocument(() => {
		const { root, read } = form({
			mode: { type: 'string', enum: ['fast', 'slow'], default: 'slow' },
			level: { type: 'integer', enum: [1, 2, 3] },
		}, ['level']);
		const mode = control(root, 'mode');
		assertEquals(mode.tagName, 'wa-select');
		assertEquals(byTag(mode, 'wa-option').map((option) => option.getAttribute('value')), ['0', '1']);
		assertEquals(byTag(mode, 'wa-option').map((option) => option.textContent), ['fast', 'slow']);
		assertEquals(mode.getAttribute('value'), '1', 'the default picks its index');
		assert(mode.hasAttribute('with-clear'), 'an optional enum can be cleared');
		const level = control(root, 'level');
		assertEquals(level.getAttribute('value'), '0', 'a required enum starts on its first value');
		assert(!level.hasAttribute('with-clear'));
		assertEquals(level.getAttribute('placeholder'), 'choose…');
		// read() maps the chosen index back to the value, typed as the schema declares it.
		mode.value = '0';
		level.value = '2';
		assertEquals(read(), { mode: 'fast', level: 3 });
		mode.value = '';
		assertEquals(read(), { level: 3 }, 'a cleared optional enum is omitted');
	});
});

Deno.test('schema form: a boolean has three states as glyph buttons — omitted, true, false', () => {
	withDocument(() => {
		const { root, read } = form({ wait: { type: 'boolean', description: 'Block until done.' } });
		const group = control(root, 'wait');
		assertEquals(group.getAttribute('role'), 'group');
		assertEquals(group.getAttribute('aria-labelledby'), 'arg-wait-label');
		assertEquals(group.getAttribute('aria-describedby'), 'arg-wait-info');
		assert(group.classList.contains('tc-tri'));
		const buttons = byTag(group, 'button');
		assertEquals(buttons.map((node) => node.getAttribute('aria-label')), ['Default (omit)', 'true', 'false']);
		assertEquals(buttons.map((node) => node.getAttribute('aria-pressed')), ['true', 'false', 'false']);
		assertEquals(read(), {}, 'unset is omitted');
		buttons[1]!.fire('click');
		assertEquals(buttons.map((node) => node.getAttribute('aria-pressed')), ['false', 'true', 'false']);
		assertEquals(read(), { wait: true });
		buttons[2]!.fire('click');
		assertEquals(read(), { wait: false });
		// A schema default starts the switch there; a required boolean names its unset state differently.
		const seeded = form({ on: { type: 'boolean', default: false } }, ['on']);
		const seededButtons = byTag(control(seeded.root, 'on'), 'button');
		assertEquals(seededButtons.map((node) => node.getAttribute('aria-pressed')), ['false', 'false', 'true']);
		assertEquals(seededButtons[0]!.getAttribute('aria-label'), 'Not set');
		// The group is named by its head, so the label carries no `for`.
		assertEquals(byTag(root, 'label')[0]!.getAttribute('for'), null);
	});
});

Deno.test('schema form: an integer is a number input with its bounds; a non-number is refused with the field named', () => {
	withDocument(() => {
		const { root, read } = form({
			count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
			ratio: { type: 'number' },
		});
		const count = control(root, 'count');
		assertEquals(count.tagName, 'wa-input');
		assertEquals(count.getAttribute('type'), 'number');
		assertEquals(count.getAttribute('step'), '1');
		assertEquals(count.getAttribute('min'), '1');
		assertEquals(count.getAttribute('max'), '10');
		assertEquals(count.getAttribute('placeholder'), 'default 3');
		const ratio = control(root, 'ratio');
		assertEquals(ratio.getAttribute('step'), 'any');
		assertEquals(ratio.getAttribute('min'), null);
		assertEquals(read(), {});
		count.value = '7';
		ratio.value = '0.5';
		assertEquals(read(), { count: 7, ratio: 0.5 });
		count.value = 'seven';
		assertThrows(() => read(), Error, 'count: not a number');
	});
});

Deno.test('schema form: a list of scalars is one value per line, typed by the item schema', () => {
	withDocument(() => {
		const { root, read } = form({
			names: { type: 'array', items: { type: 'string' } },
			ports: { type: 'array', items: { type: 'integer' } },
		});
		const names = control(root, 'names');
		assertEquals(names.tagName, 'wa-textarea');
		assertEquals(names.getAttribute('placeholder'), 'one value per line');
		assert(names.parentNode!.classList.contains('wide'), 'a list spans the form row');
		assertEquals(read(), {});
		names.value = ' a \n\nb\n';
		control(root, 'ports').value = '80\n443';
		assertEquals(read(), { names: ['a', 'b'], ports: [80, 443] });
	});
});

Deno.test('schema form: a nested object is a fieldset of its own fields, omitted when nothing inside is set', () => {
	withDocument(() => {
		const { root, read } = form({
			viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
		});
		const nested = control(root, 'viewport');
		assertEquals(nested.tagName, 'fieldset');
		assert(nested.classList.contains('tc-nested'));
		assertEquals(nested.getAttribute('aria-labelledby'), 'arg-viewport-label');
		assert(nested.parentNode!.classList.contains('wide'));
		const width = control(root, 'viewport-width');
		assertEquals(width.getAttribute('type'), 'number', 'inner ids are prefixed by the outer field');
		assertEquals(read(), {}, 'an untouched optional object is omitted');
		control(root, 'viewport-height').value = '600';
		assertEquals(read(), { viewport: { height: 600 } });
		width.value = '800';
		assertEquals(read(), { viewport: { width: 800, height: 600 } });
		// A required member inside is required whenever the form is read — as the Tools console has always behaved.
		const strict = form({
			viewport: { type: 'object', properties: { width: { type: 'integer' } }, required: ['width'] },
		});
		assertThrows(() => strict.read(), Error, 'width is required');
		control(strict.root, 'viewport-width').value = '1';
		assertEquals(strict.read(), { viewport: { width: 1 } });
	});
});

Deno.test('schema form: a const is a switch that sends the literal; long text and session ids get their own controls', () => {
	withDocument(() => {
		const { root, read } = form({
			kind: { const: 'literal' },
			script: { type: 'string', maxLength: 5000 },
			session_id: { type: 'string', description: 'A session.' },
		});
		const kind = control(root, 'kind');
		assertEquals(kind.tagName, 'wa-switch');
		assertEquals(kind.textContent, 'send "literal"');
		assertEquals(read(), {});
		kind.checked = true;
		assertEquals(read(), { kind: 'literal' });
		const script = control(root, 'script');
		assertEquals(script.tagName, 'wa-textarea', 'a long or code-like string is a text area');
		assertEquals(script.getAttribute('maxlength'), '5000');
		assert(script.parentNode!.classList.contains('wide'));
		const session = control(root, 'session_id');
		assertEquals(session.tagName, 'input', 'a native input, for the live session ids in its datalist');
		assertEquals(session.getAttribute('list'), 'session-ids');
		assertEquals(session.getAttribute('aria-describedby'), 'arg-session_id-info');
		assertEquals(byTag(byClass(root, 'tc-label')[2]!, 'use')[0]!.getAttribute('href'), '/assets/icons.svg#sessions');
	});
});

Deno.test('schema form: what the generator does not model is a JSON editor, never dropped; bad JSON names the field', () => {
	withDocument(() => {
		const { root, read } = form({
			anything: {},
			matrix: { type: 'array', items: { type: 'array' } },
			bag: { type: 'object' },
		});
		const anything = control(root, 'anything');
		assertEquals(anything.tagName, 'wa-textarea');
		assert(anything.classList.contains('tc-code'));
		assertEquals(anything.getAttribute('placeholder'), '{ … }');
		assertEquals(control(root, 'matrix').getAttribute('placeholder'), '[ … ]');
		assertEquals(control(root, 'bag').tagName, 'wa-textarea', 'an object without properties is edited as JSON');
		assertEquals(read(), {});
		anything.value = '{"a": [1, 2]}';
		assertEquals(read(), { anything: { a: [1, 2] } });
		anything.value = '{nope';
		assertThrows(() => read(), Error, 'anything: not valid JSON');
	});
});

Deno.test('schema form: an optional-nullable field (anyOf with null) is unwrapped and keeps the outer description', () => {
	withDocument(() => {
		const { root, read } = form({
			timeout: { description: 'Seconds to wait.', anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
		});
		const timeout = control(root, 'timeout');
		assertEquals(timeout.getAttribute('type'), 'number');
		assertEquals(timeout.getAttribute('min'), '0');
		assertEquals(timeout.getAttribute('hint'), 'Seconds to wait.');
		timeout.value = '30';
		assertEquals(read(), { timeout: 30 });
	});
});

Deno.test('schema form: fields come in schema order, each in a grid cell with its head; no property is skipped', () => {
	withDocument(() => {
		const { root } = form({ b: { type: 'string' }, a: { type: 'integer' }, c: { type: 'boolean' } });
		assert(root.classList.contains('tc-grid'));
		const cells = root.children;
		assert(cells.every((cell) => cell.classList.contains('tc-field')));
		assertEquals(cells.map((cell) => byClass(cell, 'mono')[0]!.textContent), ['b', 'a', 'c']);
		assertEquals(byRole(root, 'group').length, 1, 'the boolean is the one grouped control');
		assertStringIncludes(byClass(root, 'tc-field-head')[0]!.className, 'tc-field-head');
	});
});
