/**
 * R12 (design §2.19, D-131, D-132): a workspace from a git remote — what a clone may ask for, checked before anything
 * touches the disk or the network, and the one fixed script that runs it.
 *
 * The clone runs where `git init` used to: in the workspace's provisioning cage (bwrap) or container (Docker), the
 * only moment its `.git` is writable; every later cage mounts `.git` read-only (sandbox.ts, docker_spec.ts). The
 * service never runs git itself — its only run grant is bwrap, and the Docker backend has none.
 *
 * The script is fixed: no caller text is ever part of it. The URL, the ref and the depth reach it through the
 * environment (`TTK_GIT_URL`, `TTK_GIT_REF`, `TTK_GIT_DEPTH`), each checked here first, and the URL comes after `--`.
 * git reads no system or global configuration, prompts for nothing, runs no hook (`core.hooksPath=/dev/null`, an
 * empty `--template`), follows no redirect, speaks https only (`protocol.allow=never` refuses file, ext, git and ssh),
 * checks every object it receives, and fetches no submodule, tag or other branch. Each setting is a `git -c`, never
 * `git clone -c`, which would write it into the new repository's own configuration.
 *
 * Two transports, chosen by the service and never by the caller:
 *
 * - public (`url`): the host must be on `TTK_SANDBOX_GIT_HOSTS`; git reaches it through the registry proxy opened with
 *   the git hosts only (proxy.ts), TLS end to end, for this one step;
 * - credentialed (`remote`): an operator-fixed remote from the remotes file; git talks plain http to the service's
 *   forwarder (git_forwarder.ts), which adds the credential service-side and makes its own TLS connection, so no
 *   credential ever enters the cage. The clone's `origin` is then set to the remote's public URL.
 */
import { PROXY_PORT } from './cage.ts';
import { LIMITS } from './limits.ts';
import type { HostSet } from './proxy.ts';
import { RequestError } from './request.ts';

/** Where a credentialed clone's git sends its requests: the forwarder, through the cage's socat on the proxy port. */
export const FORWARD_URL = `http://127.0.0.1:${PROXY_PORT}/r`;
/** The path prefix the forwarder serves (`/r/info/refs`, `/r/git-upload-pack`). */
export const FORWARD_PATH = '/r';

/** The most hosts `TTK_SANDBOX_GIT_HOSTS` may name. */
export const MAX_GIT_HOSTS = 64;
/** A clone's depth: shallow by default (owner decision 4), never a full history past this. */
export const DEPTH = { default: 1, min: 1, max: 1000 } as const;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_SHAPE = /^https:\/\/([A-Za-z0-9.-]{1,253})(?::443)?(\/[A-Za-z0-9._~\/-]{0,1023})$/;
const REF = /^[A-Za-z0-9._\/-]{1,200}$/;

/**
 * An exact DNS name a git host may be: lower-case labels, at least two of them, the last starting with a letter — so
 * no wildcard, no single-label name and no IPv4 or IPv6 literal.
 */
export function isGitHostName(host: string): boolean {
	if (host.length === 0 || host.length > 253) return false;
	const labels = host.split('.');
	return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && /^[a-z]/.test(labels.at(-1)!);
}

/**
 * `TTK_SANDBOX_GIT_HOSTS`: a comma list of exact DNS names, port 443 implied, lower-cased. Unset or blank is no public
 * clone at all. Throws, naming the variable but never its value, on an entry that is not a host name.
 */
export function parseGitHosts(raw: string | undefined): ReadonlySet<string> {
	const text = raw?.trim() ?? '';
	const hosts = new Set<string>();
	if (text === '') return hosts;
	for (const entry of text.split(',')) {
		const host = entry.trim().toLowerCase();
		if (!isGitHostName(host)) {
			throw new Error(
				'TTK_SANDBOX_GIT_HOSTS must be a comma list of exact host names (no wildcard, address, port or scheme).',
			);
		}
		hosts.add(host);
	}
	if (hosts.size > MAX_GIT_HOSTS) throw new Error(`TTK_SANDBOX_GIT_HOSTS may name at most ${MAX_GIT_HOSTS} hosts.`);
	return hosts;
}

/** A checked https origin: its canonical URL, host and repository path (no trailing slash). */
export interface GitOrigin {
	readonly url: string;
	readonly host: string;
	readonly path: string;
}

/**
 * The shape every clone URL must have (design §2.19), or why not: `https:`, a host name, port 443 only, no
 * user-info, query or fragment, and a path of `[A-Za-z0-9._~/-]` of at most 1024 characters with no empty, `.` or
 * `..` segment. The raw text is checked, not what `URL` would normalise it to, so nothing is resolved away unseen.
 */
export function gitOrigin(value: unknown): GitOrigin | { refused: string } {
	if (typeof value !== 'string' || value.length > 2048) return { refused: 'must be an https URL' };
	const match = URL_SHAPE.exec(value);
	if (match === null) {
		return {
			refused: 'must be https://host/path on port 443, without credentials, query or fragment, and with a plain path',
		};
	}
	const host = match[1]!.toLowerCase();
	if (!isGitHostName(host)) return { refused: 'must name its host by a DNS name' };
	const path = match[2]!.endsWith('/') ? match[2]!.slice(0, -1) : match[2]!;
	const segments = path.split('/').slice(1);
	if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return { refused: 'must name a repository path without empty, . or .. segments' };
	}
	return { url: `https://${host}${path}`, host, path };
}

/** A public clone's `url`: the shape above, and a host on `TTK_SANDBOX_GIT_HOSTS`. Checked before any network. */
export function parseCloneUrl(value: unknown, hosts: HostSet): GitOrigin {
	const origin = gitOrigin(value);
	if ('refused' in origin) throw new RequestError('url', origin.refused);
	if (!hosts.has(origin.host)) throw new RequestError('url', 'names a host that is not on the sandbox git host list');
	return origin;
}

/**
 * A clone's `ref` (a branch or tag), or null for the remote's default branch: `[A-Za-z0-9._/-]`, at most 200, no
 * `..`, not leading `-` (never an option), not ending `.lock`, and — as git itself requires — no empty segment and
 * none starting or ending with `.`.
 */
export function parseGitRef(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || !REF.test(value)) {
		throw new RequestError('ref', 'must be a branch or tag name of letters, digits and . _ / -');
	}
	if (value.includes('..') || value.startsWith('-') || value.endsWith('.lock')) {
		throw new RequestError('ref', 'must not hold .., start with - or end with .lock');
	}
	if (value.split('/').some((segment) => segment === '' || segment.startsWith('.') || segment.endsWith('.'))) {
		throw new RequestError('ref', 'must not have an empty segment or one starting or ending with .');
	}
	return value;
}

/** A clone's `depth`: whole commits, default 1. */
export function parseDepth(value: unknown): number {
	if (value === undefined || value === null) return DEPTH.default;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < DEPTH.min || value > DEPTH.max) {
		throw new RequestError('depth', `must be a whole number from ${DEPTH.min} to ${DEPTH.max}`);
	}
	return value;
}

/** A clone's `timeout_ms`: the command limits (5 min by default, at most 15). */
export function parseCloneTimeout(value: unknown): number {
	if (value === undefined || value === null) return LIMITS.defaultTimeoutMs;
	if (
		typeof value !== 'number' || !Number.isInteger(value) || value < LIMITS.minTimeoutMs ||
		value > LIMITS.maxTimeoutMs
	) {
		throw new RequestError(
			'timeout_ms',
			`must be whole milliseconds from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}`,
		);
	}
	return value;
}

/**
 * The settings every git call of the clone carries, as `git -c` (never written into the repository):
 * https only, no redirect, no hook, no fsmonitor, every received object checked, no submodule, no credential helper.
 */
export const CLONE_GIT_FLAGS = [
	'-c protocol.allow=never',
	'-c protocol.https.allow=always',
	'-c http.followRedirects=false',
	'-c core.hooksPath=/dev/null',
	'-c core.fsmonitor=false',
	'-c transfer.fsckObjects=true',
	'-c submodule.recurse=false',
	'-c credential.helper=',
] as const;

/** What the clone prints last: its commit and its ref, on lines no git output can start with. */
const COMMIT_LINE = 'ttk-clone-commit';
const REF_LINE = 'ttk-clone-ref';

/**
 * The clone step's script: fixed, with no part from the request. `forwarded` clones the forwarder's loopback URL
 * (plain http, allowed for that one call) and then points `origin` at the remote's public URL; `public` clones
 * `$TTK_GIT_URL` through the git-host proxy. Both end by printing the commit and the ref they landed on.
 */
export function cloneScript(transport: 'public' | 'forwarded'): string {
	const git = ['git', ...CLONE_GIT_FLAGS].join(' ');
	const after = `${git} -c safe.directory='*'`;
	const clone = [
		git,
		// Plain http for the forwarder's loopback URL only; https stays the one protocol for anything else.
		...(transport === 'forwarded' ? ['-c protocol.http.allow=always'] : []),
		'clone --quiet --template= --no-recurse-submodules --single-branch --no-tags --depth "$TTK_GIT_DEPTH" "$@" --',
		transport === 'forwarded' ? `'${FORWARD_URL}'` : '"$TTK_GIT_URL"',
		'.',
	].join(' ');
	return [
		'set -eu',
		'if [ -n "${TTK_GIT_REF:-}" ]; then set -- --branch "$TTK_GIT_REF"; else set --; fi',
		clone,
		...(transport === 'forwarded' ? [`${after} remote set-url origin "$TTK_GIT_URL"`] : []),
		`commit=$(${after} rev-parse HEAD)`,
		`ref=$(${after} symbolic-ref -q --short HEAD) || ref="\${TTK_GIT_REF:-HEAD}"`,
		`echo "${COMMIT_LINE} $commit"`,
		`echo "${REF_LINE} $ref"`,
	].join('\n');
}

/**
 * The clone step's environment, on top of the cage's own: no system or global git configuration, no prompt, no
 * askpass program, and the checked values the fixed script reads.
 */
export function cloneEnv(input: { url: string; ref: string | null; depth: number }): Record<string, string> {
	return {
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: '/bin/false',
		TTK_GIT_URL: input.url,
		TTK_GIT_REF: input.ref ?? '',
		TTK_GIT_DEPTH: String(input.depth),
	};
}

/** The commit and ref the clone script printed last, or null when it did not get that far. */
export function cloneOutcome(output: string): { commit: string; ref: string } | null {
	let commit: string | null = null;
	let ref: string | null = null;
	for (const line of output.split('\n')) {
		const said = new RegExp(`^${COMMIT_LINE} ([0-9a-f]{40}|[0-9a-f]{64})$`).exec(line);
		if (said) commit = said[1]!;
		// A default branch is the remote's name for it; anything printable fits, cut to what a reply should carry.
		const named = new RegExp(`^${REF_LINE} ([^\\x00-\\x1f\\x7f]{1,255})$`).exec(line);
		if (named) ref = named[1]!;
	}
	return commit !== null && ref !== null ? { commit, ref } : null;
}
