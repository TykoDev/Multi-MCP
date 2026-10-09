import { assert, assertEquals } from '@std/assert';
import { LIMITS } from './limits.ts';
import { SessionState } from './sessions.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

Deno.test('sessions: a reader collects output in order, resumes from its offset, and sees the end', async () => {
	const session = new SessionState('run', 'owner');
	session.push(encode('hello '));
	session.push(encode('world\n'));
	const first = await session.read(0, 0);
	assertEquals(first.output, 'hello world\n');
	assertEquals(first.seq, 12);
	assertEquals(first.gap, false);
	assertEquals(first.ended, false);
	// Nothing new: an empty answer at the deadline, not a hang.
	const started = Date.now();
	const nothing = await session.read(first.seq, 50);
	assert(Date.now() - started >= 45 && nothing.output === '');
	// A waiter wakes when output arrives.
	const pending = session.read(first.seq, 5_000);
	session.push(encode('more'));
	assertEquals((await pending).output, 'more');
	session.end(0, null);
	const last = await session.read(16, 0);
	assertEquals(last, { output: '', seq: 16, gap: false, ended: true, exit_code: 0, killed: null });
});

Deno.test('sessions: the ring drops the oldest output past its size and reports the gap', async () => {
	const session = new SessionState('run', 'owner');
	const chunk = new Uint8Array(64 * 1024).fill(0x61);
	for (let i = 0; i < 6; i += 1) session.push(chunk);
	const read = await session.read(0, 0);
	assert(read.gap, 'the first chunks are gone');
	assert(read.output.length <= LIMITS.sessionOutputBytes);
	assertEquals(read.seq, 6 * 64 * 1024);
});

Deno.test('sessions: a code point split across chunks is carried to the next read', async () => {
	const session = new SessionState('run', 'owner');
	const bytes = encode('é');
	session.push(bytes.subarray(0, 1));
	const partial = await session.read(0, 0);
	assertEquals(partial.output, '');
	assertEquals(partial.seq, 0);
	session.push(bytes.subarray(1));
	assertEquals((await session.read(partial.seq, 0)).output, 'é');
});

Deno.test('sessions: input is counted against the session total and the clocks follow activity', () => {
	const session = new SessionState('run', 'owner');
	assert(session.countInput(10, 100));
	assert(!session.countInput(91, 100), 'over the total');
	assert(session.idleMs < 1_000 && session.ageMs < 1_000);
});
