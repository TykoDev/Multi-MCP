/**
 * A seccomp filter for inside each cage: no new user namespaces.
 *
 * The container's own profile has to let bubblewrap create namespaces, and a program inside a cage
 * would otherwise inherit that. A new user namespace hands its creator every capability inside it,
 * which reaches parts of the kernel (netfilter, filesystem mounts) an unprivileged process never
 * touches, and that is where most namespace escapes have been found. So bubblewrap installs this
 * filter just before it starts the command, and from then on:
 *
 * - `clone` and `unshare` with CLONE_NEWUSER fail with EPERM;
 * - `clone3` fails with ENOSYS, because its flags sit in memory a filter cannot read, and every C
 *   library then falls back to `clone` (Docker's default profile does the same without
 *   CAP_SYS_ADMIN);
 * - the x32 ABI is closed on x86-64 (ENOSYS), since its syscall numbers would slip past the checks;
 * - everything else is left to the container's profile.
 *
 * Other namespaces need CAP_SYS_ADMIN, which a cage never has, so the kernel refuses them itself.
 * Programs that want namespaces of their own, such as Chrome's sandbox, need their fallback
 * (`--no-sandbox`), as they do in any Docker container.
 *
 * The program is classic BPF for the host's architecture, handed to bubblewrap on standard input
 * (`--seccomp 0`). Hosts other than x86-64 and arm64 get no filter, and the sandbox says so when it
 * starts.
 */

const LD_W_ABS = 0x20;
const JEQ = 0x15;
const JGE = 0x35;
const JSET = 0x45;
const RET = 0x06;

export const RET_ALLOW = 0x7fff0000;
export const RET_ERRNO = 0x00050000;
export const EPERM = 1;
export const ENOSYS = 38;
export const CLONE_NEWUSER = 0x10000000;
const X32_SYSCALL_BIT = 0x40000000;

/** Offsets into `struct seccomp_data`: syscall number, audit architecture, first argument (low). */
const NR = 0;
const ARCH = 4;
const ARG0 = 16;

interface Abi {
	name: string;
	audit: number;
	clone: number;
	unshare: number;
	clone3: number;
	x32?: boolean;
}

/** The ABIs a process can use on each host, with their syscall numbers. */
export const ABIS: Record<string, Abi[]> = {
	x86_64: [
		{ name: 'x86_64', audit: 0xc000003e, clone: 56, unshare: 272, clone3: 435, x32: true },
		{ name: 'i386', audit: 0x40000003, clone: 120, unshare: 310, clone3: 435 },
	],
	aarch64: [
		{ name: 'aarch64', audit: 0xc00000b7, clone: 220, unshare: 97, clone3: 435 },
		{ name: 'arm', audit: 0x40000028, clone: 120, unshare: 337, clone3: 435 },
	],
};

interface Insn {
	code: number;
	k: number;
	/** Labels (or 0 for the next instruction) a jump goes to when true and when false. */
	jt?: string;
	jf?: string;
	label?: string;
}

/** The filter for a host architecture as Deno names it, or null where there is none. */
export function userNamespaceFilter(arch: string): Uint8Array | null {
	const abis = ABIS[arch];
	if (!abis) return null;
	const program: Insn[] = [{ code: LD_W_ABS, k: ARCH }];
	for (const abi of abis) program.push({ code: JEQ, k: abi.audit, jt: abi.name });
	// A process cannot run under an ABI its kernel does not offer, so this is never reached; it is
	// here because a filter must end every path with a verdict.
	program.push({ code: RET, k: RET_ALLOW });
	for (const abi of abis) {
		program.push({ code: LD_W_ABS, k: NR, label: abi.name });
		if (abi.x32) program.push({ code: JGE, k: X32_SYSCALL_BIT, jt: 'enosys' });
		program.push({ code: JEQ, k: abi.clone3, jt: 'enosys' });
		program.push({ code: JEQ, k: abi.clone, jt: 'flags' });
		program.push({ code: JEQ, k: abi.unshare, jt: 'flags' });
		program.push({ code: RET, k: RET_ALLOW });
	}
	program.push({ code: LD_W_ABS, k: ARG0, label: 'flags' });
	program.push({ code: JSET, k: CLONE_NEWUSER, jt: 'eperm' });
	program.push({ code: RET, k: RET_ALLOW });
	program.push({ code: RET, k: RET_ERRNO | ENOSYS, label: 'enosys' });
	program.push({ code: RET, k: RET_ERRNO | EPERM, label: 'eperm' });
	return assemble(program);
}

function assemble(program: Insn[]): Uint8Array {
	const at = new Map<string, number>();
	program.forEach((insn, i) => insn.label && at.set(insn.label, i));
	const offset = (from: number, label: string | undefined): number => {
		if (label === undefined) return 0;
		const target = at.get(label);
		const jump = target === undefined ? -1 : target - from - 1;
		if (jump < 0 || jump > 255) throw new Error(`filter: cannot jump from ${from} to ${label}`);
		return jump;
	};
	// struct sock_filter { __u16 code; __u8 jt; __u8 jf; __u32 k; }, in the host's byte order,
	// which is little-endian on both architectures above.
	const out = new Uint8Array(program.length * 8);
	const view = new DataView(out.buffer);
	program.forEach((insn, i) => {
		view.setUint16(i * 8, insn.code, true);
		view.setUint8(i * 8 + 2, offset(i, insn.jt));
		view.setUint8(i * 8 + 3, offset(i, insn.jf));
		view.setUint32(i * 8 + 4, insn.k >>> 0, true);
	});
	return out;
}
