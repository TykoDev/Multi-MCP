/**
 * What a request may ask for, checked before anything touches the disk. Everything here is pure, so
 * the tests run it on any machine.
 *
 * Unknown fields are refused rather than ignored: a caller that misspells `timeoutMs` should hear
 * about it, not get five minutes it did not ask for.
 */
import { LIMITS } from './limits.ts';
import type { OpenEgress } from './proxy.ts';

/** A run id as the API writes it: a lowercase UUID, which is also its checkout's folder name. */
export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `none` and `registries` are what a request may ask for. `git` is internal (R12, design §2.19): only the workspace
 * service's clone step uses it, with the egress it built (the git-host proxy or the credentialed forwarder);
 * `parseExec` never returns it, so no caller can reach a git host from a command.
 */
export type Network = 'none' | 'registries' | 'git';

export interface ExecRequest {
	runId: string;
	command: string;
	/** Relative to the workspace, normalised: "" is its root, never "." or a leading slash. */
	cwd: string;
	timeoutMs: number;
	network: Network;
	env: Record<string, string>;
	/** Given to the command on its standard input; null means it reads nothing. */
	stdin: string | null;
	/** R12: with `network: 'git'` only, what serves the clone step's proxy socket. Never set from a request. */
	egress?: OpenEgress;
}

/** A request the caller has to change: answered with 400 and these words. */
export class RequestError extends Error {
	constructor(readonly field: string, message: string) {
		super(`${field}: ${message}`);
		this.name = 'RequestError';
	}
}

/**
 * Environment variables that describe the cage itself, which a request may not replace (compared
 * without regard to case). The proxy's are here whatever the network, so a command never meets one
 * pointing somewhere unexpected. The cage's other defaults — `CI`, `LANG`, `NO_COLOR` and the like —
 * may be overridden.
 */
export const RESERVED_ENV: ReadonlySet<string> = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'PWD',
	'OLDPWD',
	'TMPDIR',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'NPM_CONFIG_PROXY',
	'NPM_CONFIG_HTTPS_PROXY',
	'NPM_CONFIG_NOPROXY',
	'PIP_PROXY',
	'CARGO_HTTP_PROXY',
	'YARN_HTTP_PROXY',
	'YARN_HTTPS_PROXY',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXEC_FIELDS = new Set([
	'runId',
	'command',
	'cwd',
	'timeoutMs',
	'network',
	'env',
	'stdin',
]);

const bytes = (text: string) => new TextEncoder().encode(text).length;

function object(body: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new RequestError('body', 'send a JSON object');
	}
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) throw new RequestError(key, 'is not a field this endpoint takes');
	}
	return body as Record<string, unknown>;
}

export function parseRunId(value: unknown): string {
	if (typeof value !== 'string' || !RUN_ID.test(value)) {
		throw new RequestError('runId', "must be the run's id, a lowercase UUID");
	}
	return value;
}

/**
 * A directory inside the workspace, as a relative path. Absolute paths, `..`, backslashes and the
 * `.git` directory are refused here; whether the directory exists, and that no part of it is a
 * symbolic link, is checked on disk before the command starts.
 */
export function parseCwd(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string' || value.length > LIMITS.cwdChars) {
		throw new RequestError('cwd', `must be a path of at most ${LIMITS.cwdChars} characters`);
	}
	if (value.startsWith('/') || /[\0\\]/.test(value)) {
		throw new RequestError('cwd', 'must be relative to the workspace, with / between names');
	}
	const segments = value.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.includes('..')) throw new RequestError('cwd', 'cannot leave the workspace');
	// Any .git on the way, as the API's file tools refuse it: the top one is read-only in the cage
	// anyway, but a command has no business starting inside a repository's own bookkeeping.
	if (segments.some((s) => s.toLowerCase() === '.git')) {
		throw new RequestError('cwd', 'the .git directory is off limits');
	}
	return segments.join('/');
}

function parseEnv(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new RequestError('env', 'must be an object of names and string values');
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > LIMITS.envEntries) {
		throw new RequestError('env', `may name at most ${LIMITS.envEntries} variables`);
	}
	const env: Record<string, string> = {};
	for (const [name, v] of entries) {
		if (!ENV_NAME.test(name)) throw new RequestError('env', `${name} is not a variable name`);
		if (RESERVED_ENV.has(name.toUpperCase())) {
			throw new RequestError('env', `${name} is set by the sandbox itself`);
		}
		if (typeof v !== 'string' || v.includes('\0') || bytes(v) > LIMITS.envValueBytes) {
			throw new RequestError(
				'env',
				`${name} must be a string of at most ${LIMITS.envValueBytes} bytes, without NUL`,
			);
		}
		env[name] = v;
	}
	return env;
}

export function parseExec(body: unknown): ExecRequest {
	const b = object(body, EXEC_FIELDS);
	const runId = parseRunId(b.runId);
	if (typeof b.command !== 'string' || b.command.trim() === '') {
		throw new RequestError('command', 'must be a shell command line');
	}
	if (b.command.includes('\0') || bytes(b.command) > LIMITS.commandBytes) {
		throw new RequestError('command', `must be at most ${LIMITS.commandBytes} bytes, without NUL`);
	}
	let timeoutMs: number = LIMITS.defaultTimeoutMs;
	if (b.timeoutMs !== undefined && b.timeoutMs !== null) {
		if (
			typeof b.timeoutMs !== 'number' || !Number.isInteger(b.timeoutMs) ||
			b.timeoutMs < LIMITS.minTimeoutMs || b.timeoutMs > LIMITS.maxTimeoutMs
		) {
			throw new RequestError(
				'timeoutMs',
				`must be whole milliseconds from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}`,
			);
		}
		timeoutMs = b.timeoutMs;
	}
	const network = b.network ?? 'none';
	if (network !== 'none' && network !== 'registries') {
		throw new RequestError('network', `must be "none" or "registries"`);
	}
	let stdin: string | null = null;
	if (b.stdin !== undefined && b.stdin !== null) {
		if (typeof b.stdin !== 'string' || bytes(b.stdin) > LIMITS.stdinBytes) {
			throw new RequestError('stdin', `must be a string of at most ${LIMITS.stdinBytes} bytes`);
		}
		stdin = b.stdin;
	}
	return {
		runId,
		command: b.command,
		cwd: parseCwd(b.cwd),
		timeoutMs,
		network,
		env: parseEnv(b.env),
		stdin,
	};
}

export function parseDiff(body: unknown): { runId: string } {
	const b = object(body, new Set(['runId']));
	return { runId: parseRunId(b.runId) };
}
