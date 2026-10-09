import { assert, assertEquals } from '@std/assert';
import { NAMESPACE_CALLS, NAMESPACE_RULE_COMMENT, sandboxProfile, type SeccompProfile } from './docker_profile.ts';

/** The shape of Docker's default profile, cut down to the rules that matter here. */
const DOCKER: SeccompProfile = {
	defaultAction: 'SCMP_ACT_ERRNO',
	defaultErrnoRet: 1,
	archMap: [{ architecture: 'SCMP_ARCH_X86_64', subArchitectures: ['SCMP_ARCH_X86'] }],
	syscalls: [
		{ names: ['read', 'write', 'execve'], action: 'SCMP_ACT_ALLOW' },
		{
			names: ['bpf', 'clone', 'clone3', 'mount', 'setns', 'umount2', 'unshare', 'sethostname'],
			action: 'SCMP_ACT_ALLOW',
			includes: { caps: ['CAP_SYS_ADMIN'] },
		},
		{
			names: ['clone'],
			action: 'SCMP_ACT_ALLOW',
			args: [{ index: 0, value: 2114060288, op: 'SCMP_CMP_MASKED_EQ' }],
			excludes: { caps: ['CAP_SYS_ADMIN'], arches: ['s390', 's390x'] },
		},
		{
			names: ['clone3'],
			action: 'SCMP_ACT_ERRNO',
			errnoRet: 38,
			excludes: { caps: ['CAP_SYS_ADMIN'] },
		},
		{ names: ['reboot'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_BOOT'] } },
	],
};

Deno.test("seccomp: Docker's default, with the seven namespace calls allowed outright", () => {
	const profile = sandboxProfile(DOCKER);
	assertEquals(profile.defaultAction, 'SCMP_ACT_ERRNO');
	assertEquals(profile.archMap, DOCKER.archMap);
	assertEquals(profile.syscalls, [
		{ names: ['read', 'write', 'execve'], action: 'SCMP_ACT_ALLOW' },
		// The rest of the CAP_SYS_ADMIN group stays conditional.
		{
			names: ['bpf', 'sethostname'],
			action: 'SCMP_ACT_ALLOW',
			includes: { caps: ['CAP_SYS_ADMIN'] },
		},
		{ names: ['reboot'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_BOOT'] } },
		{
			names: ['clone', 'clone3', 'mount', 'pivot_root', 'setns', 'umount2', 'unshare'],
			action: 'SCMP_ACT_ALLOW',
			comment: NAMESPACE_RULE_COMMENT,
		},
	]);
	// The input is left as it was.
	assertEquals(DOCKER.syscalls.length, 5);
});

Deno.test('seccomp: the committed profile is that, and nothing more', async () => {
	const profile = JSON.parse(
		await Deno.readTextFile(new URL('../../../docker/seccomp-sandbox.json', import.meta.url)),
	) as SeccompProfile;
	assertEquals(profile.defaultAction, 'SCMP_ACT_ERRNO');
	const mentioning = profile.syscalls.filter((rule) =>
		rule.names.some((name) => (NAMESPACE_CALLS as readonly string[]).includes(name))
	);
	assertEquals(mentioning.length, 1);
	assertEquals(mentioning[0], {
		names: [...NAMESPACE_CALLS],
		action: 'SCMP_ACT_ALLOW',
		comment: NAMESPACE_RULE_COMMENT,
	});
	// Still Docker's: the architecture map and the conditional rules are there.
	assert(Array.isArray(profile.archMap));
	assert(profile.syscalls.some((rule) => rule.includes && 'caps' in rule.includes));
	const unconditional = new Set(
		profile.syscalls.filter((r) => r.action === 'SCMP_ACT_ALLOW' && !r.args && !r.includes)
			.flatMap((r) => r.names),
	);
	for (const call of ['bpf', 'keyctl', 'kexec_load', 'init_module', 'open_by_handle_at']) {
		assert(!unconditional.has(call), call);
	}
});
