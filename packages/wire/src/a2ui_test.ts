import { assertEquals, assertThrows } from '@std/assert';
import {
	A2UI_CATALOG_ID,
	A2UI_MEDIA_MAX_BYTES,
	a2uiChildren,
	A2uiComponentSchema,
	A2uiMessageSchema,
	parseA2uiMediaUrl,
	pointerSegments,
	readA2uiPointer,
	updateA2uiModel,
	validateA2uiJson,
	validateA2uiTree,
} from './a2ui.ts';

Deno.test('A2UI pointers escape segments and refuse prototype or malformed paths', () => {
	assertEquals(pointerSegments('/a~1b/~0c'), ['a/b', '~c']);
	assertEquals(readA2uiPointer({ 'a/b': { '~c': 'value' } }, '/a~1b/~0c'), 'value');
	assertEquals(readA2uiPointer({}, '/missing'), undefined);
	for (const path of ['relative', '/__proto__', '/prototype', '/constructor', '/bad~2', '/a//b']) {
		assertThrows(() => pointerSegments(path));
	}
	assertThrows(() => updateA2uiModel({ items: [] }, '/items/999999/x', 'bad'));
	assertEquals(updateA2uiModel({ old: 1 }, '/old'), {});
	assertEquals(updateA2uiModel({}, '/profile/name', 'A'), { profile: { name: 'A' } });
});
Deno.test('A2UI envelope validates exactly one versioned command and rejects functions/themes', () => {
	for (
		const message of [
			{ version: 'v0.8', deleteSurface: { surfaceId: 'a' } },
			{ version: 'v0.9', deleteSurface: { surfaceId: 'a' }, updateDataModel: { surfaceId: 'a' } },
			{
				version: 'v0.9',
				updateComponents: {
					surfaceId: 'a',
					components: [{ id: 'root', component: 'Text', text: { call: 'openUrl', args: {} } }],
				},
			},
		]
	) assertEquals(A2uiMessageSchema.safeParse(message).success, false);
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	assertThrows(() => validateA2uiJson(cycle));
	assertThrows(() => validateA2uiJson({ data: 'x'.repeat(262144) }));
	assertThrows(() => validateA2uiJson({ data: NaN }));
	assertThrows(() => validateA2uiJson({ data: () => 0 }));
	let deep: unknown = 'end';
	for (let n = 0; n < 33; n++) deep = { next: deep };
	assertThrows(() => validateA2uiJson(deep));
	assertThrows(() =>
		validateA2uiTree(
			Array.from(
				{ length: 33 },
				(_, n) => ({
					id: n === 0 ? 'root' : `c${n}`,
					component: 'Column' as const,
					children: n === 32 ? [] : [`c${n + 1}`],
				}),
			),
		)
	);
	validateA2uiTree([{ id: 'root', component: 'Column', children: ['missing'] }]);
});

// --- D-111: the v0.9 basic catalog, the Html extension, media URLs and themes -------------------------------------

const PNG = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n')}`;
const MP4 = `data:video/mp4;base64,${btoa('ftypisom')}`;
const MP3 = `data:audio/mpeg;base64,${btoa('ID3')}`;

/** One accepted and one refused instance per new component; the refused one differs in one property. */
const CATALOG_CASES: Array<{ ok: Record<string, unknown>; bad: Record<string, unknown>; why: string }> = [
	{
		ok: { id: 'i', component: 'Image', url: PNG, description: 'logo', fit: 'contain', variant: 'avatar' },
		bad: { id: 'i', component: 'Image', url: 'https://example.com/a.png' },
		why: 'a remote image URL',
	},
	{
		ok: { id: 'i', component: 'Image', url: 'ttk://share/reports/q3%20chart.png' },
		bad: { id: 'i', component: 'Image', url: 'ttk://share/../secrets/key.png' },
		why: 'a share path that climbs out',
	},
	{
		ok: { id: 'i', component: 'Image', url: `data:image/webp;base64,${btoa('RIFF')}` },
		bad: { id: 'i', component: 'Image', url: `data:image/svg+xml;base64,${btoa('<svg onload=alert(1)>')}` },
		why: 'an SVG data URL, which is a document',
	},
	{
		ok: { id: 'n', component: 'Icon', name: 'shield-check' },
		bad: { id: 'n', component: 'Icon', name: 'Shield Check' },
		why: 'a name outside the sprite vocabulary shape',
	},
	{
		ok: { id: 'l', component: 'List', children: ['a', 'b'], direction: 'horizontal' },
		bad: { id: 'l', component: 'List', children: ['a'], direction: 'diagonal' },
		why: 'an unknown direction',
	},
	{
		ok: { id: 't', component: 'Tabs', tabs: [{ title: 'One', child: 'a' }, { title: { path: '/t' }, child: 'b' }] },
		bad: { id: 't', component: 'Tabs', tabs: [] },
		why: 'no tabs',
	},
	{
		ok: { id: 'm', component: 'Modal', trigger: 'open', content: 'body' },
		bad: { id: 'm', component: 'Modal', trigger: 'open' },
		why: 'a modal without content',
	},
	{
		ok: { id: 's', component: 'Slider', label: 'Volume', min: 0, max: 10, step: 0.5, value: { path: '/v' } },
		bad: { id: 's', component: 'Slider', min: 10, max: 10, value: { path: '/v' } },
		why: 'an empty range',
	},
	{
		ok: {
			id: 'd',
			component: 'DateTimeInput',
			label: 'When',
			value: { path: '/when' },
			enableDate: true,
			enableTime: true,
			min: '2026-01-01T00:00',
			max: '2026-12-31T23:59',
		},
		bad: { id: 'd', component: 'DateTimeInput', value: { path: '/when' }, min: 'tomorrow; color:red' },
		why: 'a bound that is not an ISO moment',
	},
	{
		ok: {
			id: 'c',
			component: 'ChoicePicker',
			label: 'Pick',
			variant: 'multipleSelection',
			options: [{ label: 'A', value: 'a' }, { label: { path: '/b' }, value: 'b' }],
			value: { path: '/picked' },
		},
		bad: {
			id: 'c',
			component: 'ChoicePicker',
			options: [{ label: 'A', value: 'a' }, { label: 'A again', value: 'a' }],
			value: { path: '/picked' },
		},
		why: 'duplicate option values',
	},
	{
		ok: { id: 'v', component: 'Video', url: MP4 },
		bad: { id: 'v', component: 'Video', url: PNG },
		why: 'an image where a video belongs',
	},
	{
		ok: { id: 'a', component: 'AudioPlayer', url: MP3, description: 'Briefing' },
		bad: { id: 'a', component: 'AudioPlayer', url: 'blob:https://example.com/x' },
		why: 'a blob URL from elsewhere',
	},
	{
		ok: { id: 'h', component: 'Html', html: '<p style="color:red">hi</p>', height: 120, title: 'Report' },
		bad: { id: 'h', component: 'Html', html: 'x'.repeat(128 * 1024 + 1) },
		why: 'a document over 128 KiB',
	},
	{
		ok: { id: 'h', component: 'Html', html: '<p>ok</p>' },
		bad: { id: 'h', component: 'Html', html: '<p>ok</p>', height: 39 },
		why: 'a frame shorter than 40 px',
	},
	{
		ok: { id: 'x', component: 'Text', text: 'Title', variant: 'h2' },
		bad: { id: 'x', component: 'Text', text: 'Title', variant: 'h7' },
		why: 'an unknown text variant',
	},
];

Deno.test('D-111: every v0.9 basic catalog component and Html validates, and each refuses its unsafe variant', () => {
	const seen = new Set<string>();
	for (const { ok, bad, why } of CATALOG_CASES) {
		const accepted = A2uiComponentSchema.safeParse(ok);
		assertEquals(accepted.success, true, `${ok.component} should validate: ${JSON.stringify(accepted.error)}`);
		assertEquals(A2uiComponentSchema.safeParse(bad).success, false, `${bad.component} accepted ${why}`);
		// Strictness: an unknown property is refused rather than carried to the renderer.
		assertEquals(A2uiComponentSchema.safeParse({ ...ok, onClick: 'x' }).success, false);
		seen.add(String(ok.component));
	}
	assertEquals([...seen].sort(), [
		'AudioPlayer',
		'ChoicePicker',
		'DateTimeInput',
		'Html',
		'Icon',
		'Image',
		'List',
		'Modal',
		'Slider',
		'Tabs',
		'Text',
		'Video',
	]);
});

Deno.test('D-111: media URLs are inline data of a fixed type or a plain share path, nothing that fetches elsewhere', () => {
	assertEquals(parseA2uiMediaUrl(PNG, 'image'), { kind: 'data', mime: 'image/png' });
	assertEquals(parseA2uiMediaUrl('ttk://share/a/b%20c.png', 'image'), { kind: 'share', path: 'a/b c.png' });
	for (
		const url of [
			'http://example.com/a.png',
			'https://example.com/a.png',
			'//example.com/a.png',
			'/api/v1/share/file?path=a.png',
			'javascript:alert(1)',
			'data:image/png,raw-not-base64',
			'data:image/png;base64,***',
			'data:text/html;base64,PGI+',
			'data:image/svg+xml;base64,PHN2Zz4=',
			'ttk://share/',
			'ttk://share/a//b',
			'ttk://share/a/%2e%2e/b',
			'ttk://share/a%2Fb',
			'ttk://share/a%5Cb',
			'ttk://share/a%00b',
			'ttk://share/%E0%A4%A',
			`data:image/png;base64,${'A'.repeat(A2UI_MEDIA_MAX_BYTES)}`,
		]
	) assertThrows(() => parseA2uiMediaUrl(url, 'image'), Error, undefined, url);
	assertThrows(() => parseA2uiMediaUrl(MP4, 'audio'));
	assertEquals(parseA2uiMediaUrl(`data:audio/mp4;base64,${btoa('m4a')}`, 'audio').kind, 'data');
});

Deno.test('D-111: createSurface takes a closed theme, and nothing in it can carry CSS of its own', () => {
	const create = (theme: unknown) => ({
		version: 'v0.9',
		createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID, theme },
	});
	const full = { primaryColor: '#1A2b3c', font: 'serif', radius: 12, density: 'compact' };
	assertEquals(A2uiMessageSchema.safeParse(create(full)).success, true);
	assertEquals(A2uiMessageSchema.safeParse(create({})).success, true);
	for (
		const theme of [
			{ primaryColor: 'red' },
			{ primaryColor: '#123456; background: url(x)' },
			{ font: 'Comic Sans' },
			{ radius: 25 },
			{ radius: -1 },
			{ density: 'cozy' },
			{ iconUrl: 'https://example.com/i.png' },
			{ css: 'body{display:none}' },
		]
	) assertEquals(A2uiMessageSchema.safeParse(create(theme)).success, false, JSON.stringify(theme));
});

Deno.test('D-111: tabs and modals are adjacency — cycles, depth and the rendered-node bound see them', () => {
	assertEquals(
		a2uiChildren({ id: 't', component: 'Tabs', tabs: [{ title: 'a', child: 'x' }, { title: 'b', child: 'y' }] }),
		['x', 'y'],
	);
	assertEquals(a2uiChildren({ id: 'm', component: 'Modal', trigger: 'open', content: 'body' }), ['open', 'body']);
	assertEquals(a2uiChildren({ id: 'l', component: 'List', children: ['a'] }), ['a']);
	assertEquals(a2uiChildren({ id: 'h', component: 'Html', html: '<p>x</p>' }), []);
	assertThrows(() =>
		validateA2uiTree([
			{ id: 'root', component: 'Modal', trigger: 'open', content: 'root' },
			{ id: 'open', component: 'Text', text: 'open' },
		])
	);
	assertThrows(() => validateA2uiTree([{ id: 'root', component: 'Tabs', tabs: [{ title: 'loop', child: 'root' }] }]));
	// A shared subtree reached through many tabs still counts every rendered node.
	const tabs = Array.from({ length: 32 }, (_, n) => ({ title: `t${n}`, child: 'wide' }));
	assertThrows(() =>
		validateA2uiTree([
			{ id: 'root', component: 'Tabs', tabs },
			{ id: 'wide', component: 'List', children: Array.from({ length: 16 }, (_, n) => `leaf${n}`) },
		])
	);
});
