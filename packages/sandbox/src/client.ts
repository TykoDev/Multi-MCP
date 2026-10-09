import { LIMITS } from './limits.ts';

/** Which backend runs a sandbox's commands (D-108): bubblewrap cages, or a container per workspace. */
export type SandboxBackend = 'bwrap' | 'docker';

/** Operations available to an authenticated sandbox client. */
export type SandboxOperation =
	| 'create'
	| 'clone'
	| 'list'
	| 'read'
	| 'write'
	| 'exec'
	| 'diff'
	| 'remove'
	| 'session_open'
	| 'session_input'
	| 'session_read'
	| 'session_close';

/** Constructor configuration; credentials are threaded by argument only. */
export interface SandboxClientOptions {
	url: string;
	token: string;
	fetch?: typeof fetch;
}

/** Sanitized service failure; service diagnostics and credentials never escape. */
export class SandboxClientError extends Error {
	constructor(readonly code: string, readonly status: number) {
		super(`Sandbox operation failed (${code}).`);
		this.name = 'SandboxClientError';
	}
}

/** SB-6: a little more than the service ever sends (LIMITS.responseBytes, which a diff is cut to). */
const MAX_RESPONSE_BYTES = LIMITS.responseBytes + 1024 * 1024;
/**
 * SB-10: longer than the service's worst case for one call, so its own answer (a timeout, a kill)
 * arrives first: a full queue wait, the longest command, and the housekeeping cages around it
 * (emptying /tmp, measuring before and after, restoring permissions), with a minute to spare.
 */
const DEADLINE_MS = LIMITS.maxWaitMs + LIMITS.maxTimeoutMs + 4 * LIMITS.choreTimeoutMs + 60_000;
const SERVICE_ERRORS = new Set([
	'invalid_request',
	'invalid_json',
	'unauthorized',
	'no_workspace',
	'not_found',
	'method_not_allowed',
	'run_busy',
	'no_repository',
	// D-076: live sessions.
	'no_session',
	'session_open',
	'session_ended',
	'bad_checkout',
	'too_large',
	'busy',
	'diff_failed',
	'internal',
	'cage_failed',
	'diff_timeout',
	// D-077: a caged file operation (a workspace with a live session) that ran out of time or failed.
	'file_timeout',
	'file_failed',
	'disk_full',
	'over_budget',
	'cancelled',
	// R12: a clone that ran and failed (the remote refused, the ref is unknown, the transfer broke), or ran out of time.
	'clone_failed',
	'clone_timeout',
]);

/** Bounded JSON reader also handles responses without Content-Length. */
async function body(response: Response): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > MAX_RESPONSE_BYTES) throw new SandboxClientError('response_too_large', 502);
			parts.push(chunk.value);
		}
	} finally {
		await reader?.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new SandboxClientError('invalid_response', 502);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new SandboxClientError('invalid_response', 502);
	}
	return parsed as Record<string, unknown>;
}

/** Authenticated, non-redirecting client for the private sandbox service. */
export class SandboxClient {
	readonly #base: URL;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	#backend: SandboxBackend | null = null;
	#clone: boolean | null = null;

	constructor(options: SandboxClientOptions) {
		this.#base = new URL(options.url);
		if (
			!['http:', 'https:'].includes(this.#base.protocol) || this.#base.username || this.#base.password ||
			this.#base.search || this.#base.hash || this.#base.pathname !== '/'
		) {
			throw new TypeError('Sandbox URL must be an HTTP origin without credentials.');
		}
		if (options.token.length < 32 || /\s/.test(options.token)) throw new TypeError('Invalid sandbox token.');
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
	}

	/**
	 * D-108: the backend the service said it runs on its last health answer (`/healthz` → `{ok, backend}`), or null
	 * before the first answer and for a service too old to say. Only the two known names are ever kept.
	 */
	get backend(): SandboxBackend | null {
		return this.#backend;
	}

	/**
	 * R12 (design §2.19): whether the service offers `clone` (git hosts or remotes configured), from its last health
	 * answer (`/healthz` → `{ok, backend, clone}`, additive to D-110); null before the first answer and for a service
	 * too old to say. The gateway offers `sandbox_clone` only when this is `true`.
	 */
	get clone(): boolean | null {
		return this.#clone;
	}

	/** Checks cage readiness without exposing service diagnostics. */
	async ready(): Promise<boolean> {
		try {
			const response = await this.#fetch(new URL('/healthz', this.#base), {
				redirect: 'error',
				signal: AbortSignal.timeout(5000),
			});
			const data = await body(response);
			if (data.backend === 'bwrap' || data.backend === 'docker') this.#backend = data.backend;
			if (typeof data.clone === 'boolean') this.#clone = data.clone;
			return response.ok && data.ok === true;
		} catch {
			return false;
		}
	}

	/** Executes a principal-owned operation; callers cannot overwrite the owner envelope. */
	async call(
		principal: string,
		operation: SandboxOperation,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const deadline = AbortSignal.timeout(DEADLINE_MS);
		try {
			const response = await this.#fetch(new URL(`/v1/${operation}`, this.#base), {
				method: 'POST',
				redirect: 'error',
				signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
				headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ principal, args }),
			});
			const data = await body(response);
			if (!response.ok) {
				// A syntax check alone could admit a lowercase service token as an error code.
				const safeCode = typeof data.error === 'string' && SERVICE_ERRORS.has(data.error) ? data.error : 'unavailable';
				throw new SandboxClientError(safeCode, response.status);
			}
			return data;
		} catch (error) {
			if (error instanceof SandboxClientError) throw error;
			throw new SandboxClientError(signal?.aborted ? 'cancelled' : 'unavailable', 503);
		}
	}
}
