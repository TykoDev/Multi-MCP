/**
 * The sandbox container's seccomp profile: Docker's vendored default (scripts/sandbox_seccomp.ts writes
 * docker/seccomp-sandbox.json) with the CAP_SYS_ADMIN-conditional rules for the seven calls bubblewrap needs replaced
 * by one unconditional rule (the container holds no capability). Nothing else of Docker's profile changes.
 */

/** What bubblewrap calls to make a cage, and nothing more. */
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
