/**
 * R12 (design §2.19, AC31): what a clone may ask for is refused before any network, and the one script it runs is
 * fixed — no caller text in it, every hardening flag present, the values only through the environment.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import {
	CLONE_GIT_FLAGS,
	cloneEnv,
	cloneOutcome,
	cloneScript,
	FORWARD_URL,
	gitOrigin,
	isGitHostName,
	parseCloneTimeout,
	parseCloneUrl,
	parseDepth,
	parseGitHosts,
	parseGitRef,
} from './clone.ts';
import { LIMITS } from './limits.ts';
import { RequestError } from './request.ts';

const HOSTS = new Set(['github.com', 'git.example.test']);

Deno.test('R12 clone: a URL is https on 443 to a listed host, with a plain path, or it is refused before any network', () => {
	assertEquals(parseCloneUrl('https://github.com/acme/app.git', HOSTS), {
		url: 'https://github.com/acme/app.git',
		host: 'github.com',
		path: '/acme/app.git',
	});
	// Spelled with an explicit 443, a capital host or a trailing slash, it is the same origin.
	assertEquals(parseCloneUrl('https://GitHub.com:443/acme/app/', HOSTS).url, 'https://github.com/acme/app');
	const refused: [string, string][] = [
		['https://gitlab.com/acme/app.git', 'not on the sandbox git host list'],
		['https://evil.github.com/acme/app.git', 'not on the sandbox git host list'],
		['https://github.com.evil.example/acme/app.git', 'not on the sandbox git host list'],
		['http://github.com/acme/app.git', 'https://host/path'],
		['git://github.com/acme/app.git', 'https://host/path'],
		['ssh://git@github.com/acme/app.git', 'https://host/path'],
		['file:///etc/passwd', 'https://host/path'],
		['ext::sh -c touch% /tmp/x', 'https://host/path'],
		['https://user:token@github.com/acme/app.git', 'https://host/path'],
		['https://token@github.com/acme/app.git', 'https://host/path'],
		['https://github.com/acme/app.git?x=1', 'https://host/path'],
		['https://github.com/acme/app.git#main', 'https://host/path'],
		['https://github.com:8443/acme/app.git', 'https://host/path'],
		['https://github.com:80/acme/app.git', 'https://host/path'],
		['https://140.82.112.3/acme/app.git', 'DNS name'],
		['https://[2606:50c0::1]/acme/app.git', 'https://host/path'],
		['https://github.com/acme/../other.git', 'without empty'],
		['https://github.com/acme/./app.git', 'without empty'],
		['https://github.com//acme/app.git', 'without empty'],
		['https://github.com/', 'without empty'],
		['https://github.com', 'https://host/path'],
		['https://github.com/acme/app%2egit', 'https://host/path'],
		['https://github.com/acme/app git', 'https://host/path'],
		['https://github.com/acme/app.git\n', 'https://host/path'],
		[` https://github.com/acme/app.git`, 'https://host/path'],
		[`https://github.com/${'a'.repeat(1024)}`, 'https://host/path'],
	];
	for (const [url, why] of refused) {
		const error = assertThrows(() => parseCloneUrl(url, HOSTS), RequestError);
		assertEquals(error.field, 'url', url);
		assertStringIncludes(error.message, why, url);
	}
	assertThrows(() => parseCloneUrl(42, HOSTS), RequestError);
	assertThrows(() => parseCloneUrl(`https://github.com/${'a'.repeat(2048)}`, HOSTS), RequestError);
	// The shape alone, for the remotes file: its hosts need not be on the list.
	assert('url' in gitOrigin('https://gitlab.example.org/team/repo.git'));
	assert('refused' in gitOrigin('https://gitlab.example.org:8443/team/repo.git'));
});

Deno.test('R12 clone: refs, depth and the time limit are bounded; a ref can never be an option', () => {
	assertEquals(parseGitRef(undefined), null);
	for (const ref of ['main', 'release/2.0', 'v1.2.3', 'feature_x-y', 'a'.repeat(200)]) {
		assertEquals(parseGitRef(ref), ref);
	}
	for (
		const ref of [
			'',
			'-b',
			'--upload-pack=touch /tmp/x',
			'main..other',
			'refs/heads/x.lock',
			'a'.repeat(201),
			'with space',
			'semi;colon',
			'$(id)',
			'`id`',
			'ma~in',
			'ma^in',
			'ma:in',
			'@{-1}',
			'/main',
			'main/',
			'a//b',
			'.hidden',
			'a/.hidden',
			'trailing.',
			'new\nline',
			42,
		]
	) {
		const error = assertThrows(() => parseGitRef(ref), RequestError);
		assertEquals(error.field, 'ref', String(ref));
	}
	assertEquals(parseDepth(undefined), 1);
	assertEquals([parseDepth(1), parseDepth(1000)], [1, 1000]);
	for (const depth of [0, 1001, 1.5, -1, '1', Number.NaN]) {
		assertThrows(() => parseDepth(depth), RequestError);
	}
	assertEquals(parseCloneTimeout(undefined), LIMITS.defaultTimeoutMs);
	assertEquals(parseCloneTimeout(LIMITS.maxTimeoutMs), LIMITS.maxTimeoutMs);
	for (const timeout of [LIMITS.minTimeoutMs - 1, LIMITS.maxTimeoutMs + 1, 1.5, '1000']) {
		assertThrows(() => parseCloneTimeout(timeout), RequestError);
	}
});

Deno.test('R12 clone: TTK_SANDBOX_GIT_HOSTS holds exact host names only', () => {
	assertEquals(parseGitHosts(undefined), new Set());
	assertEquals(parseGitHosts(' github.com ,GITLAB.COM'), new Set(['github.com', 'gitlab.com']));
	for (const host of ['github.com', 'a.b.c.example', 'xn--bcher-kva.example']) assert(isGitHostName(host), host);
	for (
		const host of ['', 'localhost', '*.github.com', '1.2.3.4', 'github.com.', 'github..com', '-a.com', 'a.123', 'A.com']
	) {
		assert(!isGitHostName(host), host);
	}
	assertThrows(() => parseGitHosts(Array.from({ length: 65 }, (_, i) => `h${i}.example`).join(',')), Error, '64');
});

Deno.test('R12 clone: the script is fixed, hardened, and carries no caller text', () => {
	const hostile = {
		url: 'https://github.com/acme/app.git',
		ref: 'main',
		depth: 7,
	};
	for (const transport of ['public', 'forwarded'] as const) {
		const script = cloneScript(transport);
		// The same text whatever the request: values reach it through the environment only.
		assertEquals(script, cloneScript(transport));
		assert(!script.includes(hostile.url) && !script.includes('acme'), script);
		for (const flag of CLONE_GIT_FLAGS) assertStringIncludes(script, flag);
		for (
			const flag of [
				'-c protocol.allow=never',
				'-c protocol.https.allow=always',
				'-c http.followRedirects=false',
				'-c core.hooksPath=/dev/null',
				'-c transfer.fsckObjects=true',
				'-c credential.helper=',
				'--template=',
				'--no-recurse-submodules',
				'--single-branch',
				'--no-tags',
				'--depth "$TTK_GIT_DEPTH"',
				'--branch "$TTK_GIT_REF"',
			]
		) {
			assertStringIncludes(script, flag, transport);
		}
		// `git -c` (one call), never `git clone -c` (written into the repository's own configuration).
		assert(!/clone[^\n]*\s-c\s/.test(script), script);
		// The source comes after `--`, so a URL can never be read as an option.
		assertStringIncludes(script, ' -- ');
	}
	const pub = cloneScript('public');
	assertStringIncludes(pub, '-- "$TTK_GIT_URL" .');
	assert(!pub.includes('protocol.http.allow'), 'plain http is for the forwarder only');
	assert(!pub.includes('remote set-url'));
	const fwd = cloneScript('forwarded');
	assertStringIncludes(fwd, `-c protocol.http.allow=always`);
	assertStringIncludes(fwd, `-- '${FORWARD_URL}' .`);
	// The workspace's origin is the remote's public URL, not the forwarder's.
	assertStringIncludes(fwd, 'remote set-url origin "$TTK_GIT_URL"');
	assertEquals(FORWARD_URL, 'http://127.0.0.1:3128/r');
});

Deno.test('R12 clone: the environment names no configuration, no prompt, no askpass, and the checked values', () => {
	assertEquals(cloneEnv({ url: 'https://github.com/a/b', ref: null, depth: 1 }), {
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: '/bin/false',
		TTK_GIT_URL: 'https://github.com/a/b',
		TTK_GIT_REF: '',
		TTK_GIT_DEPTH: '1',
	});
	assertEquals(cloneEnv({ url: 'https://github.com/a/b', ref: 'v1', depth: 3 }).TTK_GIT_REF, 'v1');
});

Deno.test("R12 clone: the outcome is read from the script's own last lines, never from remote text", () => {
	const sha = 'a'.repeat(40);
	assertEquals(cloneOutcome(`ttk-clone-commit ${sha}\nttk-clone-ref main\n`), { commit: sha, ref: 'main' });
	assertEquals(cloneOutcome(`ttk-clone-commit ${'b'.repeat(64)}\nttk-clone-ref v1.0\n`)?.commit, 'b'.repeat(64));
	// git prefixes a remote's own messages, so they cannot pose as the outcome.
	assertEquals(cloneOutcome(`remote: ttk-clone-commit ${sha}\nremote: ttk-clone-ref x\n`), null);
	assertEquals(cloneOutcome(`fatal: repository not found\n`), null);
	assertEquals(cloneOutcome(`ttk-clone-commit nothex\nttk-clone-ref main\n`), null);
	assertEquals(cloneOutcome(`ttk-clone-commit ${sha}\n`), null);
});
