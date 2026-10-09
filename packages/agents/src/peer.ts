import type { AgentMessage } from './runtime.ts';
import { AgentError, identifier, object, readJson, serviceUrl } from './util.ts';

/** Peer destinations and bearer references are operator-fixed configuration. */
export interface AgentPeer {
	id: string;
	url: string;
	token?: string;
}

/** Strict A2A 1.0 client; named peers cannot become general SSRF endpoints. */
export class A2aPeerClient {
	#base: URL;
	constructor(private readonly peer: AgentPeer) {
		identifier(peer.id);
		this.#base = serviceUrl(peer.url);
	}
	async #interface(signal: AbortSignal): Promise<URL> {
		const cardUrl = new URL('/.well-known/agent-card.json', this.#base);
		const response = await fetch(cardUrl, {
			redirect: 'error',
			signal,
			headers: this.peer.token ? { authorization: `Bearer ${this.peer.token}` } : {},
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AgentError(-32006, 'Peer card unavailable');
		}
		const card = object(await readJson(response.body, 256 * 1024));
		const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces.map(object) : [];
		const supported = interfaces.find((item) => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0');
		if (!supported || typeof supported.url !== 'string') {
			throw new AgentError(-32009, 'Peer does not support A2A 1.0 JSONRPC');
		}
		const endpoint = serviceUrl(supported.url);
		if (endpoint.origin !== this.#base.origin) {
			throw new AgentError(-32006, 'Peer card endpoint origin differs from configured origin');
		}
		return endpoint;
	}
	async #rpc(
		url: URL,
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const id = crypto.randomUUID();
		const response = await fetch(url, {
			method: 'POST',
			redirect: 'error',
			signal: signal ?? AbortSignal.timeout(10_000),
			headers: {
				'content-type': 'application/json',
				'a2a-version': '1.0',
				...(this.peer.token ? { authorization: `Bearer ${this.peer.token}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AgentError(-32006, 'Peer request failed');
		}
		const raw = await readJson(response.body, 1024 * 1024);
		const envelope = object(
			this.peer.token ? JSON.parse(JSON.stringify(raw).split(this.peer.token).join('[REDACTED]')) : raw,
		);
		if (envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error !== undefined) {
			throw new AgentError(-32006, 'Peer returned an invalid or failed response');
		}
		return object(envelope.result);
	}
	/** Poll the returned remote task, propagating local cancellation to CancelTask. */
	async send(message: AgentMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
		const endpoint = await this.#interface(signal);
		let remoteId: string | undefined;
		const cancel = (): void => {
			if (remoteId) void this.#rpc(endpoint, 'CancelTask', { id: remoteId }).catch(() => {});
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			// Local task/context ids have no meaning at the peer and never leave this owner boundary.
			const result = await this.#rpc(endpoint, 'SendMessage', {
				message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: message.parts },
				configuration: { returnImmediately: true },
			}, signal);
			if (result.message !== undefined) return result;
			let task = object(result.task);
			remoteId = identifier(task.id);
			while (true) {
				signal.throwIfAborted();
				const state = object(task.status).state;
				if (state === 'TASK_STATE_COMPLETED') return { task };
				if (['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(String(state))) {
					throw new AgentError(-32006, 'Delegated task did not complete');
				}
				if (['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(String(state))) {
					throw new AgentError(-32004, 'Peer requires an interactive decision');
				}
				await new Promise<void>((resolve, reject) => {
					const abort = (): void => {
						clearTimeout(timer);
						reject(signal.reason);
					};
					const timer = setTimeout(() => {
						signal.removeEventListener('abort', abort);
						resolve();
					}, 500);
					signal.addEventListener('abort', abort, { once: true });
				});
				task = await this.#rpc(endpoint, 'GetTask', { id: remoteId }, signal);
			}
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	}
}
