/** Live sandbox sessions over HTTP, for the Workspaces screen: open, feed, follow as server-sent events, close. */
import type { Context, Hono, Next } from 'hono';
import type { SandboxClient } from '@tykotech/sandbox';
import { SandboxClientError } from '@tykotech/sandbox';
import type { AppVariables } from './app.ts';
import { expansionOwner, type Principal } from './auth.ts';
import type { StreamGuard } from './a2ui.ts';
import { problemResponse } from './problem.ts';

/** The sandbox's error codes, mapped onto the gateway's problem vocabulary. */
function sandboxProblem(c: Context, cause: unknown): Response {
	if (cause instanceof SandboxClientError) {
		const slug = cause.code === 'no_workspace' || cause.code === 'no_session' || cause.code === 'not_found'
			? 'not-found'
			: cause.code === 'invalid_request'
			? 'invalid-request'
			: cause.code === 'busy' || cause.code === 'run_busy' || cause.code === 'session_open' ||
					cause.code === 'session_ended'
			? 'conflict'
			: 'internal';
		return problemResponse(slug, c.get('requestId'), `sandbox: ${cause.code}`);
	}
	throw cause;
}

export function attachSandboxSessionRoutes(
	app: Hono<{ Variables: AppVariables }>,
	sandbox: SandboxClient | undefined,
	streams: StreamGuard,
	authorized: (principal: Principal) => boolean,
): void {
	/** Route middleware: `sandbox:execute`, then a configured sandbox. */
	const needs = () => async (c: Context, next: Next): Promise<Response | void> => {
		const principal = c.get('principal') as Principal | undefined;
		if (principal === undefined) return problemResponse('unauthenticated', c.get('requestId'));
		if (!principal.scopes.has('sandbox:execute')) {
			return problemResponse('forbidden-scope', c.get('requestId'), 'the sandbox:execute scope is required');
		}
		if (sandbox === undefined) {
			return problemResponse('not-found', c.get('requestId'), 'no coding sandbox is configured');
		}
		await next();
	};
	const owner = (c: Context): string => expansionOwner(c.get('principal') as Principal);

	app.post('/api/v1/sandbox/sessions', needs(), async (c: Context) => {
		try {
			const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
			const args: Record<string, unknown> = { workspace_id: body.workspace_id };
			if (body.network !== undefined) args.network = body.network;
			return c.json(await sandbox!.call(owner(c), 'session_open', args), 201);
		} catch (cause) {
			return sandboxProblem(c, cause);
		}
	});

	app.post('/api/v1/sandbox/sessions/:id/input', needs(), async (c: Context) => {
		try {
			const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
			return c.json(await sandbox!.call(owner(c), 'session_input', { session_id: c.req.param('id'), data: body.data }));
		} catch (cause) {
			return sandboxProblem(c, cause);
		}
	});

	app.delete('/api/v1/sandbox/sessions/:id', needs(), async (c: Context) => {
		try {
			await sandbox!.call(owner(c), 'session_close', { session_id: c.req.param('id') });
			return c.body(null, 204);
		} catch (cause) {
			return sandboxProblem(c, cause);
		}
	});

	app.get('/api/v1/sandbox/sessions/:id/events', needs(), (c: Context) => {
		const principal = c.get('principal') as Principal;
		const sessionId = c.req.param('id') ?? '';
		const who = expansionOwner(principal);
		let after = Number(c.req.query('after') ?? '0');
		if (!Number.isInteger(after) || after < 0) after = 0;
		const encoder = new TextEncoder();
		let closed = false;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller): Promise<void> {
				if (closed) return;
				try {
					const read = await sandbox!.call(who, 'session_read', { session_id: sessionId, after, wait_ms: 10_000 });
					const output = String(read.output ?? '');
					const seq = Number(read.seq ?? after);
					if (output !== '' || read.gap === true) {
						controller.enqueue(encoder.encode(
							`event: output\ndata: ${JSON.stringify({ seq, data: output, gap: read.gap === true })}\n\n`,
						));
					} else {
						// Nothing in ten seconds: a comment keeps the connection alive through proxies.
						controller.enqueue(encoder.encode(': keepalive\n\n'));
					}
					after = seq;
					if (read.ended === true) {
						controller.enqueue(encoder.encode(
							`event: end\ndata: ${
								JSON.stringify({ exit_code: read.exit_code ?? null, killed: read.killed ?? null })
							}\n\n`,
						));
						closed = true;
						controller.close();
					}
				} catch (cause) {
					const code = cause instanceof SandboxClientError ? cause.code : 'unavailable';
					controller.enqueue(encoder.encode(`event: end\ndata: ${JSON.stringify({ error: code })}\n\n`));
					closed = true;
					controller.close();
				}
			},
			cancel(): void {
				closed = true;
			},
		});
		return new Response(streams.wrap(body, () => authorized(principal)), {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			},
		});
	});
}
