/// <reference lib="deno.ns" />
/**
 * `surface_builder.ts` and `surface_templates.ts`: every template's defaults publish as valid A2UI, Import reads
 * an export back into the same values, the raw JSON path validates, and `A2UI_MAX_BYTES` is honoured.
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { A2UI_MAX_BYTES, A2uiMessageSchema, validateA2uiJson, validateA2uiTree } from '@tykotech/wire';
import {
	buildSurfaceMessages,
	openSurfaceBuilder,
	parseSurfaceMessages,
	themeFields,
	themeOf,
} from './surface_builder.ts';
import { matchTemplate, PLACEHOLDER_PNG, slug, SURFACE_TEMPLATES, templateMessages } from './surface_templates.ts';
import { ICONS } from './icon_names.ts';
import { byClass, withDocument } from './test_document.ts';

Deno.test('surface_templates: five templates, each with a drawn glyph, a blurb and at least one field', () => {
	assertEquals(SURFACE_TEMPLATES.map((template) => template.id), ['status', 'form', 'table', 'image', 'note']);
	for (const template of SURFACE_TEMPLATES) {
		assert(template.glyph in ICONS, `${template.id} → ${template.glyph}`);
		assert(template.blurb.length > 10 && template.fields.length > 0, template.id);
		for (const field of template.fields) assert(field.key in template.defaults, `${template.id}.${field.key} default`);
	}
});

Deno.test('surface_templates: every template × default values passes the message schema and the tree check', () => {
	for (const template of SURFACE_TEMPLATES) {
		const messages = templateMessages(template, `${template.id}-1`, template.defaults);
		assert(messages.length >= 2, template.id);
		for (const message of messages) {
			const parsed = A2uiMessageSchema.safeParse(message);
			assert(parsed.success, `${template.id}: ${JSON.stringify(parsed.error?.issues[0])}`);
			validateA2uiJson(message);
			if ('updateComponents' in message) {
				validateA2uiTree(message.updateComponents.components);
				// A surface starts at `root`; every component is reachable from it (nothing published for nothing).
				assert(message.updateComponents.components.some((component) => component.id === 'root'), template.id);
			}
		}
		// The same through the builder's checked path.
		assertEquals(buildSurfaceMessages(template, `${template.id}-1`, template.defaults).length, messages.length);
	}
});

Deno.test('surface_templates: import round-trip — an export reads back into the same template and values', () => {
	for (const template of SURFACE_TEMPLATES) {
		const theme = { primaryColor: '#2a9d8f', radius: 6 } as const;
		const messages = buildSurfaceMessages(template, `rt-${template.id}`, template.defaults, theme);
		const match = matchTemplate(messages);
		assert(match !== null, `${template.id} not recognised`);
		assertEquals(match.template.id, template.id);
		assertEquals(match.surfaceId, `rt-${template.id}`);
		assertEquals(match.values, template.defaults);
		assertEquals(match.theme, theme);
		// And through the Advanced tab's text, as Export writes it.
		const again = matchTemplate(parseSurfaceMessages(JSON.stringify(messages)));
		assertEquals(again?.values, template.defaults);
	}
});

Deno.test('surface_templates: optional parts are left out and still round-trip', () => {
	const status = SURFACE_TEMPLATES[0]!;
	const bare = buildSurfaceMessages(status, 's', { title: 'Only a title', body: '', buttons: [] });
	const components = bare.flatMap((m) => 'updateComponents' in m ? m.updateComponents.components : []);
	assertEquals(components.map((c) => c.id), ['root', 'layout', 'title']);
	assertEquals(matchTemplate(bare)?.values, { title: 'Only a title', body: '', buttons: [] });
	const note = SURFACE_TEMPLATES[4]!;
	const untitled = buildSurfaceMessages(note, 'n', { title: '', body: 'one\n\n\ntwo' });
	assertEquals(matchTemplate(untitled)?.values, { title: '', body: 'one\n\ntwo' });
	const table = SURFACE_TEMPLATES[2]!;
	const headless = buildSurfaceMessages(table, 't', { title: '', columns: ['A'], rows: '' });
	assertEquals(matchTemplate(headless)?.values, { title: '', columns: ['A'], rows: '' });
	const image = SURFACE_TEMPLATES[3]!;
	const plain = buildSurfaceMessages(image, 'i', { url: PLACEHOLDER_PNG, description: '', caption: '' });
	assertEquals(matchTemplate(plain)?.values, { url: PLACEHOLDER_PNG, description: '', caption: '' });
});

Deno.test('surface_templates: the Form binds every input to the model and sends the model with the submit', () => {
	const form = SURFACE_TEMPLATES[1]!;
	const messages = buildSurfaceMessages(form, 'f', form.defaults);
	const model = messages.find((m) => 'updateDataModel' in m);
	assert(model !== undefined && 'updateDataModel' in model);
	assertEquals(model.updateDataModel.value, { service: '', version: '', 'notify-the-channel': false, environment: [] });
	const components = messages.flatMap((m) => 'updateComponents' in m ? m.updateComponents.components : []);
	const submit = components.find((c) => c.id === 'submit');
	assert(submit !== undefined && submit.component === 'Button');
	assertEquals(submit.action.event.name, 'requestDeployment');
	assertEquals(Object.keys(submit.action.event.context ?? {}), [
		'service',
		'version',
		'notify-the-channel',
		'environment',
	]);
	assertEquals(slug('Notify the channel!', 'x'), 'notify-the-channel');
	assertEquals(slug('***', 'field-3'), 'field-3');
});

Deno.test('surface_builder: a template value the catalog refuses is caught before publish, naming the problem', () => {
	const status = SURFACE_TEMPLATES[0]!;
	assertThrows(() => buildSurfaceMessages(status, 's', { ...status.defaults, title: '' }), Error, 'Title is required');
	assertThrows(() => buildSurfaceMessages(status, 'bad id!', status.defaults), Error, 'Surface id');
	// A button whose action name is not an identifier fails the schema (`event.name`), not the server.
	assertThrows(
		() => buildSurfaceMessages(status, 's', { ...status.defaults, buttons: [{ label: 'Go', action: 'not valid' }] }),
		Error,
		'Not a valid A2UI message',
	);
	const image = SURFACE_TEMPLATES[3]!;
	assertThrows(
		() => buildSurfaceMessages(image, 'i', { ...image.defaults, url: 'https://example.test/x.png' }),
		Error,
		'Not a valid A2UI message',
	);
});

Deno.test('surface_builder: A2UI_MAX_BYTES is honoured — an oversized surface is refused here', () => {
	const note = SURFACE_TEMPLATES[4]!;
	// Each paragraph is within the per-text limit; together they pass the whole-message size (256 KiB).
	const paragraph = 'x'.repeat(60_000);
	const body = Array.from({ length: Math.ceil(A2UI_MAX_BYTES / paragraph.length) + 1 }, () => paragraph).join('\n\n');
	assertThrows(() => buildSurfaceMessages(note, 'big', { title: '', body }), Error, 'size');
	const small = buildSurfaceMessages(note, 'ok', { title: '', body: paragraph });
	assert(new TextEncoder().encode(JSON.stringify(small[1])).length < A2UI_MAX_BYTES);
});

Deno.test('surface_builder: the Advanced text is one message or an array, each validated', () => {
	assertThrows(() => parseSurfaceMessages('nope'), Error, 'Not JSON');
	assertThrows(() => parseSurfaceMessages('[]'), Error, 'No message');
	assertThrows(() => parseSurfaceMessages('{"version":"v0.9"}'), Error, 'Not a valid A2UI message');
	const one = parseSurfaceMessages('{"version":"v0.9","deleteSurface":{"surfaceId":"x"}}');
	assertEquals(one.length, 1);
	const two = parseSurfaceMessages(JSON.stringify([
		{ version: 'v0.9', createSurface: { surfaceId: 'x', catalogId: 'https://tykotech.eu/a2ui/catalog/v0.9' } },
		{ version: 'v0.9', updateComponents: { surfaceId: 'x', components: [{ id: 'root', component: 'Divider' }] } },
	]));
	assertEquals(two.length, 2);
	assertEquals(matchTemplate(two), null, 'not a template: published raw');
	assertThrows(
		() =>
			parseSurfaceMessages(
				JSON.stringify([{
					version: 'v0.9',
					updateComponents: { surfaceId: 'x', components: [{ id: 'a', component: 'Card', child: 'a' }] },
				}]),
			),
		Error,
		'cycle',
	);
});

Deno.test('surface_builder: the theme fields become a createSurface.theme, or nothing, or a named error', () => {
	assertEquals(themeOf({ primaryColor: '', font: '', radius: '', density: '' }), undefined);
	assertEquals(themeOf({ primaryColor: ' #2A9D8F ', font: 'mono', radius: '4', density: 'compact' }), {
		primaryColor: '#2A9D8F',
		font: 'mono',
		radius: 4,
		density: 'compact',
	});
	assertThrows(() => themeOf({ primaryColor: 'teal', font: '', radius: '', density: '' }), Error, 'primaryColor');
	assertThrows(() => themeOf({ primaryColor: '', font: '', radius: '40', density: '' }), Error, 'radius');
	assertEquals(themeFields({ primaryColor: '#000000', radius: 0 }), {
		primaryColor: '#000000',
		font: '',
		radius: '0',
		density: '',
	});
	assertEquals(themeFields(undefined), { primaryColor: '', font: '', radius: '', density: '' });
});

Deno.test('surface_builder: the one New-surface action is constructed once in the screen (D-092)', async () => {
	// The home it is offered in is decided by `newSurfaceHome`; a second construction would be a second home.
	const view = await Deno.readTextFile(new URL('./workspace_surfaces.ts', import.meta.url));
	assertEquals(view.match(/label: 'New surface'/g)?.length, 1, 'one New surface button');
	assert(view.includes('newSurfaceHome('), 'the screen asks where it lives');
	assert(!view.includes("iconButton('plus', 'Publish a declarative surface'"), 'the old publish toggle is gone');
});

Deno.test('surface_builder: close() takes the drawer out of the document at once, and twice is harmless (BUG-2)', () => {
	withDocument((document) => {
		const handle = openSurfaceBuilder({
			publish: () => Promise.resolve(),
			actionNames: () => Promise.resolve([]),
			fetchShare: () => Promise.reject(new Error('not in this test')),
			onPublished: () => {},
		});
		// The drawer is appended to `document.body`, outside any screen's nodes: the screen cannot drop it by leaving.
		assertEquals(byClass(document.body, 'ag-builder').length, 1);
		assertEquals((handle.node as unknown as { open: boolean }).open, true, 'the opening frame ran');
		handle.close();
		assertEquals(byClass(document.body, 'ag-builder').length, 0, 'stop() must not leave it over the next screen');
		handle.close();
		assertEquals(document.body.childNodes.length, 0);
	});
});

Deno.test('surface_builder: the surfaces panel closes an open builder when it stops (BUG-2)', async () => {
	const view = await Deno.readTextFile(new URL('./workspace_surfaces.ts', import.meta.url));
	const stop = view.slice(view.indexOf('stop: (): void => {'));
	assert(stop.slice(0, stop.indexOf('},')).includes('builder?.close()'), 'stop() closes the builder drawer');
	assert(view.includes('let builder:'), 'one module-level handle');
});
