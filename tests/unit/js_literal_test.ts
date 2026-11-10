/**
 * `jsLiteral` (tests/support/js_literal.ts): the literal the e2e fixtures write into `<script>` elements, handler
 * attributes and evaluated expressions (CodeQL js/bad-code-sanitization). It must read back as the same string and
 * hold nothing the HTML parser or an older script grammar acts on.
 */
import { assert, assertEquals } from '@std/assert';
import { jsLiteral } from '../support/js_literal.ts';

Deno.test('jsLiteral: the value reads back unchanged, and no markup or line separator is left in the literal', () => {
	const separators = String.fromCharCode(0x2028, 0x2029);
	const values = [
		'',
		'plain',
		'http://127.0.0.1:8080/landing?code=abc&next=/x',
		`</script><script>alert(1)</script>`,
		`it's "quoted" & <b>bold</b>`,
		`line${separators}ends\n\\ and \u{1F600}`,
	];
	for (const value of values) {
		const literal = jsLiteral(value);
		// Every JSON string escape is a JavaScript string escape with the same meaning, so this is the script's reading.
		assertEquals(JSON.parse(literal), value);
		for (const char of ['<', '>', '&', "'", ...separators]) {
			assert(!literal.includes(char), `${JSON.stringify(char)} is left in ${literal}`);
		}
	}
	assertEquals(jsLiteral('</script>'), '"\\u003c/script\\u003e"');
});
