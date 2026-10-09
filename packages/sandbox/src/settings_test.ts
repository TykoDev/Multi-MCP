import { assertEquals, assertThrows } from '@std/assert';
import { DOCKER_DEFAULTS, gitSettings, grantedEnv, sandboxSettings } from './settings.ts';

/** R12: what both backends hold when neither git name is set — clone off. */
const NO_GIT = { hosts: new Set<string>(), remotesFile: null };

const env = (values: Record<string, string>) => (name: string): string | undefined => values[name];

Deno.test('D-108 settings: the default image, granting only the token file, starts the bwrap backend', () => {
	// Deno throws for a name outside --allow-env; such a name reads as unset.
	const granted = (name: string): string | undefined => {
		if (name !== 'TTK_SANDBOX_TOKEN_FILE') throw new Deno.errors.NotCapable(`Requires env access to "${name}"`);
		return '/run/secrets/ttk_sandbox_token';
	};
	assertEquals(grantedEnv('TTK_SANDBOX_BACKEND', granted), undefined);
	assertEquals(sandboxSettings((name) => grantedEnv(name, granted)), {
		backend: 'bwrap',
		tokenFile: '/run/secrets/ttk_sandbox_token',
		git: NO_GIT,
	});
	assertThrows(() => sandboxSettings(env({})), Error, 'TTK_SANDBOX_TOKEN_FILE is required');
	assertEquals(sandboxSettings(env({ TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_BACKEND: 'bwrap' })).backend, 'bwrap');
	assertEquals(sandboxSettings(env({ TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_BACKEND: ' ' })).backend, 'bwrap');
	assertThrows(
		() => sandboxSettings(env({ TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_BACKEND: 'podman' })),
		Error,
		'bwrap or docker',
	);
});

Deno.test('D-108 settings: the Docker backend, with its defaults and overrides', () => {
	assertEquals(sandboxSettings(env({ TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_BACKEND: 'Docker' })), {
		backend: 'docker',
		tokenFile: '/t',
		docker: { ...DOCKER_DEFAULTS },
		git: NO_GIT,
	});
	assertEquals(DOCKER_DEFAULTS, {
		socket: '/var/run/docker.sock',
		image: 'tykotech-sandbox-workspace:0.2.0',
		volume: 'ttk-code',
		sockVolume: 'ttk-sandbox-sock',
	});
	const digest = `sha256:${'a'.repeat(64)}`;
	for (const image of ['registry.local:5000/team/workspace:1.2', `workspace@${digest}`, `workspace:1@${digest}`]) {
		const parsed = sandboxSettings(env({
			TTK_SANDBOX_TOKEN_FILE: '/t',
			TTK_SANDBOX_BACKEND: 'docker',
			TTK_SANDBOX_WORKSPACE_IMAGE: image,
			TTK_SANDBOX_DOCKER_SOCKET: '/run/docker.sock',
			TTK_SANDBOX_DOCKER_VOLUME: 'proj_code',
			TTK_SANDBOX_DOCKER_SOCK_VOLUME: 'proj_sock',
		}));
		assertEquals(parsed.backend === 'docker' && parsed.docker, {
			socket: '/run/docker.sock',
			image,
			volume: 'proj_code',
			sockVolume: 'proj_sock',
		});
	}
});

Deno.test('D-108 settings: what the Docker backend cannot use is refused, naming the variable', () => {
	const base = { TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_BACKEND: 'docker' };
	for (
		const [name, value] of [
			['TTK_SANDBOX_WORKSPACE_IMAGE', 'workspace'],
			['TTK_SANDBOX_WORKSPACE_IMAGE', 'Workspace:1'],
			['TTK_SANDBOX_WORKSPACE_IMAGE', 'workspace:1 --privileged'],
			['TTK_SANDBOX_DOCKER_SOCKET', 'docker.sock'],
			['TTK_SANDBOX_DOCKER_SOCKET', 'tcp://10.0.0.1:2375'],
			['TTK_SANDBOX_DOCKER_VOLUME', '/var/lib/docker'],
			['TTK_SANDBOX_DOCKER_VOLUME', 'x'],
			['TTK_SANDBOX_DOCKER_SOCK_VOLUME', '../code'],
		] as const
	) {
		assertThrows(() => sandboxSettings(env({ ...base, [name]: value })), Error, name);
	}
	assertThrows(
		() => sandboxSettings(env({ ...base, TTK_SANDBOX_DOCKER_SOCK_VOLUME: 'ttk-code' })),
		Error,
		'different volumes',
	);
});

Deno.test('R12 settings: the git hosts are exact lower-cased names, and the remotes file is the compose secret only', () => {
	assertEquals(gitSettings(env({})), NO_GIT);
	assertEquals(gitSettings(env({ TTK_SANDBOX_GIT_HOSTS: '  ' })), NO_GIT);
	assertEquals(
		gitSettings(env({ TTK_SANDBOX_GIT_HOSTS: 'GitHub.com, gitlab.example.org' })).hosts,
		new Set(['github.com', 'gitlab.example.org']),
	);
	for (
		const hosts of [
			'*.github.com',
			'github.com:443',
			'https://github.com',
			'140.82.112.3',
			'[2606:50c0::1]',
			'localhost',
			'github.com,,gitlab.com',
			'github.com.',
			'git hub.com',
			'-github.com',
		]
	) {
		assertThrows(() => gitSettings(env({ TTK_SANDBOX_GIT_HOSTS: hosts })), Error, 'TTK_SANDBOX_GIT_HOSTS', hosts);
	}
	// A refusal names the variable, never the value it refused.
	assertThrows(
		() => gitSettings(env({ TTK_SANDBOX_GIT_HOSTS: 'secret-looking-entry:1' })),
		Error,
		'TTK_SANDBOX_GIT_HOSTS must be',
	);
	assertEquals(
		gitSettings(env({ TTK_SANDBOX_GIT_REMOTES_FILE: '/run/secrets/ttk_git_remotes' })).remotesFile,
		'/run/secrets/ttk_git_remotes',
	);
	for (const path of ['/etc/passwd', '/run/secrets/ttk_sandbox_token', 'ttk_git_remotes', '/work/remotes.json']) {
		assertThrows(
			() => gitSettings(env({ TTK_SANDBOX_GIT_REMOTES_FILE: path })),
			Error,
			'TTK_SANDBOX_GIT_REMOTES_FILE must be /run/secrets/ttk_git_remotes',
		);
	}
	// Both backends carry them; an image that does not grant the names reads them as unset (clone off).
	const parsed = sandboxSettings(env({ TTK_SANDBOX_TOKEN_FILE: '/t', TTK_SANDBOX_GIT_HOSTS: 'github.com' }));
	assertEquals(parsed.git.hosts, new Set(['github.com']));
	const ungranted = (name: string): string | undefined => {
		if (name !== 'TTK_SANDBOX_TOKEN_FILE') throw new Deno.errors.NotCapable(`Requires env access to "${name}"`);
		return '/t';
	};
	assertEquals(sandboxSettings((name) => grantedEnv(name, ungranted)).git, NO_GIT);
});
