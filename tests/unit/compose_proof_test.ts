/**
 * R3-4 / K-6: the Compose proofs' guards (`tests/support/compose_proof.ts`), held in the unit tier. The proofs
 * themselves need Docker and run by hand (`deno task test:compose --tag <t>`, `deno task test:agents:compose --tag <t>`);
 * what decides whether they touch the operator's images or secrets is here, and is checked without Docker.
 */
import { assert, assertEquals, assertThrows } from '@std/assert';
import { join, resolve } from '@std/path';
import { readAdminUser } from '../../packages/gateway/src/admin_auth.ts';
import {
	assertIsolated,
	type ComposeConfig,
	deployedTags,
	isInside,
	ProofRefused,
	proofTag,
	writeSyntheticAdmin,
} from '../support/compose_proof.ts';

Deno.test('R3-4: the deployed tags are the release version and every tag the shipped compose files name', async () => {
	const tags = await deployedTags();
	const { version } = JSON.parse(await Deno.readTextFile('deno.json'));
	assert(tags.has(version), `deno.json version ${version}`);
	assert(tags.has('0.2.0'));
	// Only image references: `tykotech-mcp:8787` in a URL is a port, not a tag.
	assert(!tags.has('8787'), [...tags].join());
});

Deno.test('R3-4: --tag is required, well formed, single, and never a deployed tag', () => {
	const deployed = new Set(['0.2.0']);
	assertEquals(proofTag(['--tag', 'verify-fxc'], deployed), 'verify-fxc');
	assertEquals(proofTag(['--tag=verify-int'], deployed), 'verify-int');
	for (
		const [args, why] of [
			[[], 'is required'],
			[['--tag'], 'must be a Docker tag'],
			[['--tag', ''], 'must be a Docker tag'],
			[['--tag', '0.2.0'], 'is a deployed tag'],
			[['--tag=0.2.0'], 'is a deployed tag'],
			[['--tag', 'a b'], 'must be a Docker tag'],
			[['--tag', '../x'], 'must be a Docker tag'],
			[['--tag', 'x:y'], 'must be a Docker tag'],
			[['--tag', '-x'], 'must be a Docker tag'],
			[['--tag', 'x'.repeat(101)], 'must be a Docker tag'],
			[['--tag', 'a', '--tag', 'b'], 'more than once'],
		] as const
	) {
		assertThrows(() => proofTag(args, deployed), ProofRefused, why, JSON.stringify(args));
	}
});

Deno.test('R3-4: the synthetic admin record is one the gateway accepts, and holds no password', async () => {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const dir = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'compose-proof-' });
	try {
		const path = join(dir, 'admin-user.json');
		await writeSyntheticAdmin(path);
		const raw = await Deno.readTextFile(path);
		// The gateway's own parser, the one that refuses startup on a malformed record (C6 / D-099).
		const record = readAdminUser(raw);
		assertEquals(record.username, 'compose-admin');
		assertEquals(Object.keys(JSON.parse(raw)).sort(), ['hash', 'iterations', 'salt', 'username']);
		assertEquals(record.iterations, 100_000);
		// A fresh salt and hash every time.
		await writeSyntheticAdmin(path);
		assert(readAdminUser(await Deno.readTextFile(path)).hash !== record.hash);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test('R3-4: a path is inside the scratch folder only when it really is', () => {
	const scratch = resolve('tests/.scratch/sandbox-compose-x');
	assert(isInside(scratch, join(scratch, 'admin-user.json')));
	assert(isInside(scratch, join(scratch, 'nested', 'keys.json')));
	assert(!isInside(scratch, scratch));
	assert(!isInside(scratch, resolve('secrets/ttk_admin_user.json')));
	assert(!isInside(scratch, join(scratch, '..', 'sandbox-compose-y', 'keys.json')));
	assert(!isInside(scratch, `${scratch}-sibling/keys.json`));
});

/** A resolved configuration as `docker compose config --format json` gives it, for the sandbox proof's stack. */
function resolved(scratch: string, over: Partial<ComposeConfig> = {}): ComposeConfig {
	return {
		services: {
			'tykotech-mcp': { image: 'tykotech-mcp:verify-fxc' },
			sandbox: { image: 'tykotech-sandbox:verify-fxc' },
		},
		secrets: {
			ttk_api_keys: { file: join(scratch, 'keys.json') },
			ttk_sandbox_token: { file: join(scratch, 'sandbox-token') },
			ttk_admin_user: { file: join(scratch, 'admin-user.json') },
		},
		...over,
	};
}

Deno.test('R3-4: the resolved stack runs only the tag and mounts only the scratch folder', () => {
	const scratch = resolve('tests/.scratch/sandbox-compose-x');
	const expected = {
		scratch,
		images: { 'tykotech-mcp': 'tykotech-mcp:verify-fxc', sandbox: 'tykotech-sandbox:verify-fxc' },
		required: ['ttk_admin_user'],
	};
	assertIsolated(resolved(scratch), expected);
	const refusals: [ComposeConfig, string][] = [
		// The fixture before R3-4: the shipped file's images and the checkout's own admin record.
		[
			resolved(scratch, { services: { ...resolved(scratch).services, sandbox: { image: 'tykotech-sandbox:0.2.0' } } }),
			'not tykotech-sandbox:verify-fxc',
		],
		[
			resolved(scratch, {
				services: { ...resolved(scratch).services, 'tykotech-mcp': { image: 'tykotech-mcp:0.2.0' } },
			}),
			'not tykotech-mcp:verify-fxc',
		],
		[
			resolved(scratch, {
				secrets: { ...resolved(scratch).secrets, ttk_admin_user: { file: resolve('secrets/ttk_admin_user.json') } },
			}),
			'ttk_admin_user resolves to',
		],
		[
			resolved(scratch, {
				secrets: { ...resolved(scratch).secrets, ttk_api_keys: { file: resolve('secrets/ttk_api_keys.json') } },
			}),
			'ttk_api_keys resolves to',
		],
		// A service nobody pinned, and a required secret nobody declared.
		[
			resolved(scratch, { services: { ...resolved(scratch).services, extra: { image: 'tykotech-mcp:0.2.0' } } }),
			'does not pin',
		],
		[
			resolved(scratch, { secrets: { ttk_api_keys: { file: join(scratch, 'keys.json') } } }),
			'ttk_admin_user is not declared',
		],
	];
	for (const [config, why] of refusals) assertThrows(() => assertIsolated(config, expected), ProofRefused, why);
});
