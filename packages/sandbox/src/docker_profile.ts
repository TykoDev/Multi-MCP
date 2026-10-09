/**
 * The sandbox container's seccomp profile: Docker's default, plus the seven calls bubblewrap needs
 * to build a cage. scripts/sandbox_seccomp.ts reads the default profile vendored at the commit pinned in
 * docker/seccomp-sandbox-source.json (docker/seccomp-sandbox-base.json) and writes the result to
 * docker/seccomp-sandbox.json; this is the part that changes it, kept here so the tests can check it.
 *
 * Docker's default allows these calls only to a container holding CAP_SYS_ADMIN (and `clone` only
 * without namespace flags). The sandbox holds no capability at all, so the conditional rules that
 * mention them are taken out and one unconditional rule allows all seven. Nothing else changes: the
 * other rules, the default action and the architectures are Docker's.
 */

/** What bubblewrap calls to make a cage, and nothing more (the research proved these suffice). */
export const NAMESPACE_CALLS = [
	'clone',
	'clone3',
	'mount',
	'pivot_root',
	'setns',
	'umount2',
	'unshare',
] as const;

export const NAMESPACE_RULE_COMMENT =
	'Harbour sandbox: bubblewrap gives each command its own user, pid, mount and network ' +
	"namespaces. Added to Docker's default profile by scripts/sandbox_seccomp.ts.";

export interface SeccompRule {
	names: string[];
	action: string;
	args?: unknown[];
	includes?: Record<string, unknown>;
	excludes?: Record<string, unknown>;
	errnoRet?: number;
	comment?: string;
	[key: string]: unknown;
}

export interface SeccompProfile {
	defaultAction: string;
	syscalls: SeccompRule[];
	[key: string]: unknown;
}

export function sandboxProfile(docker: SeccompProfile): SeccompProfile {
	const wanted = new Set<string>(NAMESPACE_CALLS);
	const syscalls: SeccompRule[] = [];
	for (const rule of docker.syscalls) {
		const names = rule.names.filter((name) => !wanted.has(name));
		if (names.length === rule.names.length) syscalls.push(rule);
		else if (names.length > 0) syscalls.push({ ...rule, names });
	}
	syscalls.push({
		names: [...NAMESPACE_CALLS],
		action: 'SCMP_ACT_ALLOW',
		comment: NAMESPACE_RULE_COMMENT,
	});
	return { ...docker, syscalls };
}
