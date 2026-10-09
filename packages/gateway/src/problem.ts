/**
 * RFC 7807 `application/problem+json` responses.
 *
 * Every non-MCP error leaves the gateway in this shape, carrying the request
 * id so a report from the field can be joined to a log line.
 * See SPECS/API-CONTRACT.md §6.
 */

export const PROBLEM_TYPE_BASE = 'https://tykotech.eu/problems/';

export const PROBLEM_SLUGS = [
	'unauthenticated',
	'forbidden-scope',
	'origin-forbidden',
	'host-forbidden',
	'rate-limited',
	'unknown-session',
	'ticket-expired',
	'ticket-consumed',
	/**
	 * F2: a live-view ticket this server never issued, or one minted for another session than the path names. The
	 * contract answers every bad ticket 403 before the upgrade; `unauthenticated` (401) wrongly asked for a credential
	 * the socket cannot send.
	 */
	'ticket-invalid',
	'payload-too-large',
	'not-found',
	/**
	 * A caller-supplied REST body that is malformed or refused by policy (B1.10).
	 *
	 * There was no generic 400 slug before this: `host-forbidden` is a 400 but
	 * names one specific cause, and every other refusal here is 401/403/404/429.
	 * `PUT /api/v1/live/origins` is the first route in the product that validates
	 * a caller-supplied body against a policy, and "the body was wrong" is not
	 * "you may not do this".
	 */
	'invalid-request',
	/**
	 * A write on a deployment with no `TTK_DATA_DIR` (B1.10).
	 *
	 * D-A3 degrades such a deployment to read-only rather than pretending a write
	 * succeeded, and 409 says the request conflicts with the server's state
	 * rather than with the caller's authority — which a 403 would wrongly imply.
	 */
	'persistence-required',
	/**
	 * A write the server's own state refuses (D-074): a duplicate username, deleting or disabling the account that
	 * is making the request, or leaving no enabled account with the `admin` scope. The caller is authorized; the
	 * request cannot be honoured as the state stands.
	 */
	'conflict',
	/**
	 * F5: the server is shutting down (BACKEND §7, stage 1). New sessions, tickets and live-view sockets are refused
	 * with `Retry-After`; `/healthz` and work already in flight keep answering until their stage ends.
	 */
	'service-unavailable',
	/**
	 * B4 / D-097: a request authenticated by the sign-in cookie that changes state (`POST`, `PUT`, `PATCH`, `DELETE`)
	 * without the `x-ttk-csrf` value derived from that session, or without an allowed `Origin`. 403 because the
	 * credential is fine and the request is not proven to come from the control plane's own page.
	 */
	'csrf-failed',
	'internal',
] as const;

export type ProblemSlug = (typeof PROBLEM_SLUGS)[number];

interface ProblemSpec {
	readonly status: number;
	readonly title: string;
}

const REGISTRY: Record<ProblemSlug, ProblemSpec> = {
	'unauthenticated': { status: 401, title: 'Authentication required' },
	'forbidden-scope': { status: 403, title: 'Insufficient scope' },
	'origin-forbidden': { status: 403, title: 'Origin not allowed' },
	'host-forbidden': { status: 400, title: 'Host header not allowed' },
	'rate-limited': { status: 429, title: 'Rate limit exceeded' },
	'unknown-session': { status: 404, title: 'Unknown session' },
	'ticket-expired': { status: 403, title: 'Ticket expired' },
	'ticket-consumed': { status: 403, title: 'Ticket already used' },
	'ticket-invalid': { status: 403, title: 'Ticket not valid for this session' },
	'payload-too-large': { status: 413, title: 'Payload too large' },
	'not-found': { status: 404, title: 'Not found' },
	'invalid-request': { status: 400, title: 'Invalid request' },
	'persistence-required': { status: 409, title: 'Persistence is not configured' },
	'conflict': { status: 409, title: 'Conflict' },
	'service-unavailable': { status: 503, title: 'Service unavailable' },
	'csrf-failed': { status: 403, title: 'CSRF check failed' },
	'internal': { status: 500, title: 'Internal server error' },
};

/** An error that carries its own HTTP rendering. */
export class HttpProblem extends Error {
	readonly slug: ProblemSlug;
	readonly detail: string | undefined;
	readonly headers: Record<string, string>;

	constructor(slug: ProblemSlug, detail?: string, headers: Record<string, string> = {}) {
		super(detail ?? REGISTRY[slug].title);
		this.name = 'HttpProblem';
		this.slug = slug;
		this.detail = detail;
		this.headers = headers;
	}

	get status(): number {
		return REGISTRY[this.slug].status;
	}
}

/** Renders a problem as a `Response`. */
export function problemResponse(
	slug: ProblemSlug,
	requestId: string,
	detail?: string,
	headers: Record<string, string> = {},
): Response {
	const spec = REGISTRY[slug];
	const body: Record<string, unknown> = {
		type: `${PROBLEM_TYPE_BASE}${slug}`,
		title: spec.title,
		status: spec.status,
		'x-request-id': requestId,
	};
	if (detail !== undefined) body.detail = detail;
	return new Response(JSON.stringify(body), {
		status: spec.status,
		headers: {
			'content-type': 'application/problem+json',
			'x-request-id': requestId,
			...headers,
		},
	});
}
