import { assertEquals, assertThrows } from '@std/assert';
import { LIMITS } from './limits.ts';
import { parseCwd, parseDiff, parseExec, parseRunId, RequestError } from './request.ts';

const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';

Deno.test('request: an exec with only a run and a command gets the defaults', () => {
	assertEquals(parseExec({ runId: RUN, command: 'npm test' }), {
		runId: RUN,
		command: 'npm test',
		cwd: '',
		timeoutMs: 300_000,
		network: 'none',
		env: {},
		stdin: null,
	});
});

Deno.test('request: a run id is a lowercase UUID and nothing else', () => {
	assertEquals(parseRunId(RUN), RUN);
	for (
		const bad of [
			RUN.toUpperCase(),
			`${RUN}/..`,
			'../0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f',
			'.sandbox',
			'',
			42,
			null,
			'0f0e8c6a3d2b4c1a9e8f7a6b5c4d3e2f',
		]
	) {
		assertThrows(() => parseRunId(bad), RequestError, 'runId');
	}
});

Deno.test('request: cwd stays inside the workspace', () => {
	assertEquals(parseCwd(undefined), '');
	assertEquals(parseCwd('.'), '');
	assertEquals(parseCwd('./packages//web/'), 'packages/web');
	for (
		const bad of [
			'/etc',
			'../x',
			'a/../../b',
			'a/..',
			'src\\x',
			'a\0b',
			'.git',
			'.GIT/hooks',
			'vendor/lib/.git',
			'sub/.Git/objects',
		]
	) {
		assertThrows(() => parseCwd(bad), RequestError, 'cwd', bad);
	}
	assertThrows(() => parseCwd('a'.repeat(LIMITS.cwdChars + 1)), RequestError);
	// A name that merely starts with dots is a name.
	assertEquals(parseCwd('..hidden/x'), '..hidden/x');
});

Deno.test('request: sizes and ranges are enforced', () => {
	const exec = (extra: Record<string, unknown>) => parseExec({ runId: RUN, command: 'true', ...extra });
	assertThrows(() => exec({ command: '' }), RequestError, 'command');
	assertThrows(() => exec({ command: '   ' }), RequestError, 'command');
	assertThrows(() => exec({ command: 'a'.repeat(LIMITS.commandBytes + 1) }), RequestError);
	// Bytes, not characters: 6000 three-byte characters are over 16 KB.
	const euro = String.fromCharCode(0x20ac);
	assertThrows(() => exec({ command: euro.repeat(6000) }), RequestError, 'command');
	assertThrows(() => exec({ command: 'echo \0' }), RequestError, 'command');
	assertEquals(exec({ timeoutMs: 1_000 }).timeoutMs, 1_000);
	assertEquals(exec({ timeoutMs: 900_000 }).timeoutMs, 900_000);
	for (const bad of [999, 900_001, 1.5, '60000', -1]) {
		assertThrows(() => exec({ timeoutMs: bad }), RequestError, 'timeoutMs');
	}
	assertEquals(exec({ network: 'registries' }).network, 'registries');
	assertThrows(() => exec({ network: 'open' }), RequestError, 'network');
	// R12: the clone step's network is internal; a request can never name it, nor bring an egress of its own.
	assertThrows(() => exec({ network: 'git' }), RequestError, 'network');
	assertThrows(() => exec({ egress: 'x' }), RequestError, 'egress');
	// C15: the donor's `scratch` mode (answer runs) was never reachable through the API, and is gone.
	assertThrows(() => exec({ scratch: true }), RequestError, 'scratch');
	assertEquals(exec({ stdin: 'print(1)' }).stdin, 'print(1)');
	assertThrows(() => exec({ stdin: 'x'.repeat(LIMITS.stdinBytes + 1) }), RequestError, 'stdin');
});

Deno.test('request: a misspelt field is refused rather than ignored', () => {
	assertThrows(
		() => parseExec({ runId: RUN, command: 'true', timeout: 5 }),
		RequestError,
		'timeout',
	);
	assertThrows(() => parseExec([RUN, 'true']), RequestError, 'body');
	assertThrows(() => parseDiff({ runId: RUN, extra: 1 }), RequestError, 'extra');
	assertEquals(parseDiff({ runId: RUN }), { runId: RUN });
});

Deno.test('request: env takes names the cage does not set itself', () => {
	const env = (value: unknown) => parseExec({ runId: RUN, command: 'true', env: value }).env;
	assertEquals(env({ NODE_ENV: 'test', CI: '', LANG: 'en_US.UTF-8' }), {
		NODE_ENV: 'test',
		CI: '',
		LANG: 'en_US.UTF-8',
	});
	for (
		const name of ['PATH', 'HOME', 'TMPDIR', 'https_proxy', 'HTTPS_PROXY', 'npm_config_proxy']
	) {
		assertThrows(() => env({ [name]: 'x' }), RequestError, 'set by the sandbox', name);
	}
	assertThrows(() => env({ 'BAD-NAME': 'x' }), RequestError, 'not a variable name');
	assertThrows(() => env({ '1X': 'x' }), RequestError, 'not a variable name');
	assertThrows(() => env({ X: 1 }), RequestError, 'string');
	assertThrows(() => env({ X: 'a\0b' }), RequestError, 'NUL');
	assertThrows(() => env({ X: 'x'.repeat(LIMITS.envValueBytes + 1) }), RequestError);
	const many = Object.fromEntries(
		Array.from({ length: LIMITS.envEntries + 1 }, (_, i) => [`V${i}`, 'x']),
	);
	assertThrows(() => env(many), RequestError, 'at most');
	assertThrows(() => env(['A=1']), RequestError, 'object');
});
