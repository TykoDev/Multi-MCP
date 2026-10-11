import { assertEquals, assertStringIncludes } from '@std/assert';
import * as z from 'zod';
import { A2uiMessageSchema } from '@tykotech/wire';
import { type ArgumentIssue, describeIssues, repairArguments } from './arguments.ts';
import { parseArguments } from './dispatch.ts';

/** The validator shape `repairArguments` takes, from a Zod schema. */
function parserOf(schema: z.ZodType) {
	return (value: unknown) => {
		const result = schema.safeParse(value);
		return result.success
			? { success: true as const, data: result.data }
			: { success: false as const, issues: result.error.issues as readonly ArgumentIssue[] };
	};
}

function issuesOf(schema: z.ZodType, value: unknown): readonly ArgumentIssue[] {
	const result = schema.safeParse(value);
	if (result.success) throw new Error('expected a failure');
	return result.error.issues as readonly ArgumentIssue[];
}

const CREATE = {
	version: 'v0.9',
	createSurface: { surfaceId: 's1', catalogId: 'https://tykotech.eu/a2ui/catalog/v0.9' },
};
const PUBLISH = z.object({ message: A2uiMessageSchema }).strict();

Deno.test('arguments: a number sent as text is read as the number it spells', () => {
	const schema = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
	const args = { limit: '5' };
	const repaired = repairArguments(args, issuesOf(schema, args), parserOf(schema));
	assertEquals(repaired, { ok: true, data: { limit: 5 } });
});

Deno.test('arguments: an object sent as JSON text is read as the object (a2ui_publish)', () => {
	const args = { message: JSON.stringify(CREATE) };
	const repaired = repairArguments(args, issuesOf(PUBLISH, args), parserOf(PUBLISH));
	assertEquals(repaired, { ok: true, data: { message: CREATE } });
});

Deno.test('arguments: a repaired value still has to pass the schema, and its own issue is reported', () => {
	const wrong = { ...CREATE, createSurface: { ...CREATE.createSurface, surfaceId: 'has spaces' } };
	const args = { message: JSON.stringify(wrong) };
	const repaired = repairArguments(args, issuesOf(PUBLISH, args), parserOf(PUBLISH));
	assertEquals(repaired.ok, false);
	if (!repaired.ok) {
		assertStringIncludes(describeIssues(repaired.issues), 'message.createSurface.surfaceId');
	}
});

Deno.test('arguments: a string refused for its content is never re-read as JSON', () => {
	const schema = z.object({ name: z.string().regex(/^[a-z]+$/) }).strict();
	const args = { name: '123' };
	const repaired = repairArguments(args, issuesOf(schema, args), parserOf(schema));
	assertEquals(repaired.ok, false);
	if (!repaired.ok) assertStringIncludes(describeIssues(repaired.issues), 'name: ');
});

Deno.test('arguments: text that is not JSON structure stays a refusal', () => {
	const schema = z.object({ limit: z.number() }).strict();
	for (const value of ['five', '"5"', 'null', '']) {
		const args = { limit: value };
		assertEquals(repairArguments(args, issuesOf(schema, args), parserOf(schema)).ok, false, value);
	}
});

Deno.test('arguments: a union failure names the field of the closest branch, not "Invalid input"', () => {
	const args = {
		message: {
			version: 'v0.9',
			createSurface: { surfaceId: 's1', catalogId: 'https://example.test/other-catalog' },
		},
	};
	const text = describeIssues(issuesOf(PUBLISH, args));
	assertStringIncludes(text, 'message.createSurface.catalogId');
	assertEquals(text.includes('Invalid input;'), false);
});

Deno.test('arguments: a value of the wrong type for every branch reads as one plain line', () => {
	const text = describeIssues(issuesOf(PUBLISH, { message: 42 }));
	assertStringIncludes(text, 'message: ');
	assertEquals(text.split(';').length, 1, text);
});

Deno.test('parseArguments: a tool normalization runs before the schema and again after a repair', () => {
	const tool = {
		inputSchema: z.object({ value: z.object({ version: z.literal('v1'), n: z.number() }).strict() }).strict(),
		normalizeArguments: (args: unknown) => {
			const value = (args as { value?: unknown }).value;
			return typeof value === 'object' && value !== null && !('version' in value)
				? { value: { version: 'v1', ...value } }
				: args;
		},
	};
	assertEquals(parseArguments(tool, { value: { n: 1 } }), { success: true, data: { value: { version: 'v1', n: 1 } } });
	assertEquals(parseArguments(tool, { value: '{"n":2}' }), {
		success: true,
		data: { value: { version: 'v1', n: 2 } },
	});
	const refused = parseArguments(tool, { value: '{"n":"x"}' });
	assertEquals(refused.success, false);
});
