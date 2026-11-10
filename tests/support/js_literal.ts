/**
 * A string as a JavaScript literal for script text a test builds: a `<script>` element, an inline event-handler
 * attribute, or an expression handed to `Runtime.evaluate` / `browser_evaluate`.
 *
 * `JSON.stringify` alone is not enough there. It leaves `<` and `>` as they are, so a value holding `</script>` ends
 * the element it is written into; it leaves `'` and `&`, which end or rewrite a quoted attribute; and it leaves the
 * line and paragraph separators (2028 and 2029), which older script grammars read as line ends inside a string. Each
 * becomes its four-digit unicode escape, which means the same character inside the string literal and nothing to the
 * HTML parser.
 */
export function jsLiteral(value: string): string {
	return JSON.stringify(value).replace(
		/[<>&'\u{2028}\u{2029}]/gu,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
}
