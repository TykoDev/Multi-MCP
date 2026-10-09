/**
 * R3-8: the sandbox service's log guard cuts a registered secret out of the line as it is written — the JSON line,
 * where a `"` or `\` in the value is escaped. A remote's token may hold either (`git_forwarder.ts` admits any printable
 * ASCII), so the guard must match the escaped form as well as the raw one.
 */
import { assert, assertEquals } from '@std/assert';
import { guardSecret, log } from './log.ts';

/** The lines `log` writes while `fn` runs, from both streams. */
function captured(fn: () => void): string[] {
	const lines: string[] = [];
	const out = console.log;
	const err = console.error;
	console.log = (line: string) => lines.push(line);
	console.error = (line: string) => lines.push(line);
	try {
		fn();
	} finally {
		console.log = out;
		console.error = err;
	}
	return lines;
}

Deno.test('R3-8 log: a secret with a quote or a backslash is cut out of the JSON line too', () => {
	const secrets = ['tok"en_with_quote_0123', 'tok\\en_with_backslash_0123', 'both"\\_mixed_token_0123'];
	for (const secret of secrets) guardSecret(secret);
	const lines = captured(() => {
		for (const secret of secrets) {
			log('info', 'probe', { token: secret, nested: { header: `Basic ${secret}` } });
			log('error', 'probe.failed', { error: new Error(`refused ${secret}`) });
		}
	});
	assertEquals(lines.length, secrets.length * 2);
	for (const line of lines) {
		const parsed = JSON.parse(line);
		for (const secret of secrets) {
			// Neither the escaped form the line holds nor the value it decodes to.
			assert(!line.includes(JSON.stringify(secret).slice(1, -1)), line);
			assert(!JSON.stringify(parsed).includes(JSON.stringify(secret).slice(1, -1)), line);
		}
		assert(line.includes('[redacted]'), line);
	}
	assertEquals(JSON.parse(lines[0]!).token, '[redacted]');
	assertEquals(JSON.parse(lines[0]!).nested.header, 'Basic [redacted]');
});

Deno.test('R3-8 log: values are cut in the order they were registered, so an Authorization keeps its scheme', () => {
	// As git_forwarder.ts registers a remote: the token, its Basic credential, then the header value holding it.
	const token = 'ghp_order"test\\token_0123';
	const credential = btoa(`x-access-token:${token}`);
	for (const secret of [token, credential, `Basic ${credential}`]) guardSecret(secret);
	const [line] = captured(() => log('info', 'probe', { token, authorization: `Basic ${credential}` }));
	assertEquals(JSON.parse(line!).token, '[redacted]');
	assertEquals(JSON.parse(line!).authorization, 'Basic [redacted]');
});

Deno.test('R3-8 log: a plain secret is still cut, and a value too short to guard is left alone', () => {
	guardSecret('plain_token_0123456789');
	guardSecret('short');
	const [line] = captured(() => log('info', 'probe', { a: 'plain_token_0123456789', b: 'short' }));
	assertEquals(JSON.parse(line!).a, '[redacted]');
	// Below eight characters a value is not registered at all: it would cut ordinary words out of every line.
	assertEquals(JSON.parse(line!).b, 'short');
});
