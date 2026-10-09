/**
 * The in-cage filter, run through a small classic-BPF interpreter: the kernel's verdict for each
 * system call a cage might make, without needing Linux to ask.
 */
import { assertEquals, assertThrows } from '@std/assert';
import { ABIS, CLONE_NEWUSER, ENOSYS, EPERM, RET_ALLOW, RET_ERRNO, userNamespaceFilter } from './filter.ts';

const CLONE_NEWNS = 0x00020000;
const SIGCHLD = 17;
const CLONE_THREAD_FLAGS = 0x003d0f00; // what glibc passes to create a thread

/** Runs a filter on one system call: the value it returns. */
function run(program: Uint8Array, call: { arch: number; nr: number; arg0?: number }): number {
	const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
	const data = new DataView(new ArrayBuffer(64));
	data.setUint32(0, call.nr, true);
	data.setUint32(4, call.arch, true);
	data.setUint32(16, call.arg0 ?? 0, true);
	let a = 0;
	let pc = 0;
	for (let steps = 0; steps < 1000; steps++) {
		const code = view.getUint16(pc * 8, true);
		const jt = view.getUint8(pc * 8 + 2);
		const jf = view.getUint8(pc * 8 + 3);
		const k = view.getUint32(pc * 8 + 4, true);
		switch (code) {
			case 0x20: // ld [k]
				a = data.getUint32(k, true);
				pc++;
				break;
			case 0x15: // jeq #k
				pc += 1 + (a === k ? jt : jf);
				break;
			case 0x35: // jge #k
				pc += 1 + (a >>> 0 >= k ? jt : jf);
				break;
			case 0x45: // jset #k
				pc += 1 + ((a & k) !== 0 ? jt : jf);
				break;
			case 0x06: // ret #k
				return k;
			default:
				throw new Error(`unknown instruction ${code.toString(16)} at ${pc}`);
		}
		if (pc * 8 >= program.length) throw new Error('ran off the end of the program');
	}
	throw new Error('did not finish');
}

const denied = (errno: number) => (RET_ERRNO | errno) >>> 0;

Deno.test('filter: no new user namespace, by any of the calls that make one', () => {
	for (const [host, abis] of Object.entries(ABIS)) {
		const program = userNamespaceFilter(host)!;
		for (const abi of abis) {
			const call = (nr: number, arg0 = 0) => run(program, { arch: abi.audit, nr, arg0 });
			assertEquals(call(abi.unshare, CLONE_NEWUSER), denied(EPERM), `${abi.name} unshare`);
			assertEquals(call(abi.unshare, CLONE_NEWUSER | CLONE_NEWNS), denied(EPERM));
			assertEquals(call(abi.clone, CLONE_NEWUSER | SIGCHLD), denied(EPERM), `${abi.name} clone`);
			assertEquals(call(abi.clone3), denied(ENOSYS), `${abi.name} clone3`);
			// Everything else a program does is the container's profile's business.
			assertEquals(call(abi.clone, SIGCHLD), RET_ALLOW, `${abi.name} fork`);
			assertEquals(call(abi.clone, CLONE_THREAD_FLAGS), RET_ALLOW, `${abi.name} thread`);
			assertEquals(call(abi.unshare, CLONE_NEWNS), RET_ALLOW, `${abi.name} other namespaces`);
			assertEquals(call(0), RET_ALLOW);
			assertEquals(call(59), RET_ALLOW);
		}
	}
});

Deno.test('filter: the x32 ABI is closed on x86-64', () => {
	const program = userNamespaceFilter('x86_64')!;
	const x86_64 = ABIS.x86_64![0]!.audit;
	// x32's unshare is 272 with the x32 bit set.
	assertEquals(
		run(program, { arch: x86_64, nr: 0x40000000 + 272, arg0: CLONE_NEWUSER }),
		denied(ENOSYS),
	);
	assertEquals(run(program, { arch: x86_64, nr: 0x40000000 }), denied(ENOSYS));
});

Deno.test('filter: a host it is not written for gets none, and says so', () => {
	assertEquals(userNamespaceFilter('riscv64'), null);
	assertEquals(userNamespaceFilter('s390x'), null);
	// An ABI the host does not run falls through to allow rather than off the end.
	assertEquals(run(userNamespaceFilter('x86_64')!, { arch: 0x12345678, nr: 272 }), RET_ALLOW);
	assertThrows(() => run(new Uint8Array(8), { arch: 0, nr: 0 }), Error, 'unknown instruction');
});

Deno.test('filter: the program is whole instructions, and short', () => {
	for (const host of Object.keys(ABIS)) {
		const program = userNamespaceFilter(host)!;
		assertEquals(program.length % 8, 0);
		assertEquals(program.length / 8 <= 32, true);
	}
});
