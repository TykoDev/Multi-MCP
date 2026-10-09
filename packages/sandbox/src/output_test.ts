import { assert, assertEquals } from '@std/assert';
import { clean, completeLength, OutputCapture } from './output.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const ESC = String.fromCharCode(27);
const EURO = String.fromCharCode(0x20ac); // three bytes in UTF-8
const REPLACEMENT = String.fromCharCode(0xfffd);

Deno.test('output: what fits is returned whole, however it arrives', () => {
	const capture = new OutputCapture(64);
	for (const piece of ['hello ', 'wor', 'ld\n']) capture.push(bytes(piece));
	assertEquals(capture.result(), {
		output: 'hello world\n',
		truncated: false,
		omittedBytes: 0,
		outputBytes: 12,
	});
	const exact = new OutputCapture(8);
	exact.push(bytes('12345678'));
	assertEquals(exact.result().output, '12345678');
	assertEquals(exact.result().truncated, false);
});

Deno.test('output: past the limit the head and the tail stay, and the cut is counted', () => {
	const capture = new OutputCapture(20);
	const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
	// In uneven pieces, so the tail ring wraps more than once.
	for (let i = 0; i < text.length; i += 7) capture.push(bytes(text.slice(i, i + 7)));
	const result = capture.result();
	assertEquals(result.truncated, true);
	assertEquals(result.outputBytes, 100);
	assertEquals(result.omittedBytes, 80);
	assertEquals(
		result.output,
		`${text.slice(0, 10)}\n[... 80 bytes of output left out ...]\n${text.slice(90)}`,
	);
});

Deno.test('output: one large piece keeps its first and last bytes', () => {
	const capture = new OutputCapture(10);
	capture.push(bytes('0123456789abcdefghij'));
	assertEquals(capture.result().output, '01234\n[... 10 bytes of output left out ...]\nfghij');
});

Deno.test('output: a cut never splits a character', () => {
	// 13 bytes. The head's 3 bytes end inside the first euro sign, and the tail's 4 begin inside
	// the third: both partial characters are left out, and counted.
	const capture = new OutputCapture(7);
	capture.push(bytes(`a${EURO}${EURO}${EURO}${EURO}`));
	const result = capture.result();
	assertEquals(result.output, `a\n[... 9 bytes of output left out ...]\n${EURO}`);
	assertEquals(result.omittedBytes, 9);
	assert(!result.output.includes(REPLACEMENT));

	assertEquals(completeLength(bytes(`ab${EURO}`)), 5);
	assertEquals(completeLength(bytes(`ab${EURO}`).subarray(0, 4)), 2);
	assertEquals(completeLength(bytes(`ab${EURO}`).subarray(0, 3)), 2);
	assertEquals(completeLength(new Uint8Array()), 0);
});

Deno.test('output: bytes that are not text become U+FFFD, and so does NUL', () => {
	const capture = new OutputCapture(64);
	capture.push(new Uint8Array([0x6f, 0x6b, 0xff, 0xfe, 0x00, 0x21]));
	assertEquals(capture.result().output, `ok${REPLACEMENT}${REPLACEMENT}${REPLACEMENT}!`);
});

Deno.test('output: terminal colours and titles are removed', () => {
	const coloured = `${ESC}[31mFAIL${ESC}[0m test ${ESC}[1;32mok${ESC}[m`;
	assertEquals(clean(coloured), 'FAIL test ok');
	assertEquals(clean(`${ESC}]0;title${String.fromCharCode(7)}done`), 'done');
	assertEquals(clean(`${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\`), 'link');
	assertEquals(clean(`line\r\nnext\ttab`), 'line\r\nnext\ttab');
});

Deno.test('output: a megabyte limit holds against much more output', () => {
	const capture = new OutputCapture(1024 * 1024);
	const chunk = new Uint8Array(64 * 1024).fill(0x78);
	for (let i = 0; i < 64; i++) capture.push(chunk); // 4 MB
	const result = capture.result();
	assertEquals(result.outputBytes, 4 * 1024 * 1024);
	assertEquals(result.omittedBytes, 3 * 1024 * 1024);
	assert(result.output.length < 1024 * 1024 + 100);
});
