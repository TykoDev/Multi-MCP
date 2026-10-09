/**
 * D-158 (owner-requested): the agents' settings on the control plane — `GET` and `PUT /api/v1/system/agents`.
 *
 * The settings themselves (`AgentSettings`: a default model, the A2A / ACP / A2UI switches and the memory switch per
 * agent) are defined and enforced by `@tykotech/agents`; this module keeps them in the database's `settings` table
 * (one JSON row, `agents.settings`) and judges a change against the providers in force: a default model must be one
 * a provider in force lists. Nothing here is a secret, so nothing is sealed.
 *
 * Without a data directory there is no database: the defaults apply and a `PUT` is `409 persistence-required`.
 * Node-local in a cluster, like the providers.
 */
import {
	AGENT_APPLIES,
	AGENT_IDS,
	type AgentId,
	type AgentRuntime,
	type AgentSetting,
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	parseAgentSettings,
	SLOPLORD,
} from '@tykotech/agents';
import type { Database } from './database.ts';
import type { ModelProvidersConfig } from './model_providers.ts';
import { HttpProblem } from './problem.ts';

/** The `settings` row that holds the document. */
export const AGENT_SETTINGS_KEY = 'agents.settings';

/** The `PUT` body cap: five fields for three agents fit in far less. */
export const AGENT_SETTINGS_BODY_BYTES = 8192;

/** One agent as the control plane lists it. */
export interface AgentView {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** `builtin`: the built-in model agent; `profile`: a built-in profile; `acp`: the bridge; `peer`: an A2A peer. */
	readonly kind: 'builtin' | 'profile' | 'acp' | 'peer';
	/** Whether this deployment can run it now; `reason` says what is missing. */
	readonly available: boolean;
	readonly reason?: string;
	/** Which settings mean something for it; a peer has none (it is configured where it runs). */
	readonly applies: Readonly<Record<keyof AgentSetting, boolean>>;
	/** Its settings; `null` for a peer. */
	readonly settings: AgentSetting | null;
	/** The default model names a provider or model no longer in force: the providers' default is used instead. */
	readonly stale?: boolean;
}

/** One model a default may name. */
export interface AgentModelOption {
	readonly provider: string;
	readonly provider_label: string;
	readonly model: string;
	readonly reachable: boolean;
}

/** `GET /api/v1/system/agents` (and the `PUT` answer). */
export interface AgentsDocument {
	/** Whether a `PUT` can be honoured; `reason` says why not. */
	readonly store: { readonly writable: boolean; readonly reason?: string };
	/** What a `null` default model resolves to now: the default provider and its default model. */
	readonly default_model: { readonly provider: string; readonly model: string } | null;
	readonly models: readonly AgentModelOption[];
	/** Whether the agent memory exists here (`TTK_DATA_DIR`); without it the memory switch changes nothing. */
	readonly memory_available: boolean;
	readonly agents: readonly AgentView[];
}

const NO_DATABASE = 'TTK_DATA_DIR is not set, so there is no database for agent settings; the defaults apply';

const NO_FIELDS: Readonly<Record<keyof AgentSetting, boolean>> = {
	model: false,
	a2a: false,
	acp: false,
	a2ui: false,
	memory: false,
};

/** The settings in force and their one writer. */
export class AgentSettingsStore {
	readonly #db: Database | null;
	#current: AgentSettings = DEFAULT_AGENT_SETTINGS;

	/**
	 * Reads the stored document. A row that no longer parses (a hand edit, a field removed) is logged by phrase and
	 * the defaults apply until a write replaces it — never fatal.
	 */
	constructor(db: Database | null, logger?: { warn(message: string): void }) {
		this.#db = db;
		const raw = db?.setting(AGENT_SETTINGS_KEY) ?? null;
		if (raw === null) return;
		try {
			this.#current = parseAgentSettings(JSON.parse(raw));
		} catch (cause) {
			logger?.warn(
				`the stored agent settings are not admitted (${
					cause instanceof Error ? cause.message : 'unreadable'
				}); the defaults apply until they are saved again`,
			);
		}
	}

	/** The settings in force; the runtime reads this at every use. */
	current(): AgentSettings {
		return this.#current;
	}

	get writable(): boolean {
		return this.#db !== null;
	}

	/**
	 * Applies `body` (`{ agents: { <id>: { …fields } } }`, each agent and field optional) onto the settings in force,
	 * judges every default model against `providers`, writes the row and returns the new settings. Refusals are
	 * {@linkcode HttpProblem}s naming the field, never a value.
	 */
	replace(body: unknown, providers: ModelProvidersConfig | null): AgentSettings {
		if (this.#db === null) throw new HttpProblem('persistence-required', NO_DATABASE);
		const entry = body as Record<string, unknown> | null;
		if (
			entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
			Object.keys(entry).some((key) => key !== 'agents')
		) throw new HttpProblem('invalid-request', 'must be an object with one field, field agents');
		let next: AgentSettings;
		try {
			next = parseAgentSettings(entry.agents, this.#current);
		} catch (cause) {
			throw new HttpProblem('invalid-request', cause instanceof Error ? cause.message : 'malformed, field agents');
		}
		for (const id of AGENT_IDS) {
			const chosen = next[id].model;
			// Only a choice that changes is judged: one that went stale when a provider was removed may be kept as is.
			if (chosen === null || sameChoice(chosen, this.#current[id].model)) continue;
			if (!AGENT_APPLIES[id].model) throw new HttpProblem('invalid-request', `does not apply, field ${id}.model`);
			if (!listed(providers, chosen.provider, chosen.model)) {
				throw new HttpProblem('invalid-request', `names no model of a provider in force, field ${id}.model`);
			}
		}
		this.#db.setSetting(AGENT_SETTINGS_KEY, JSON.stringify(next));
		this.#current = next;
		return next;
	}

	/** The read-back: every agent this gateway runs or routes to, what applies to each, and the model choices. */
	document(runtime: AgentRuntime, providers: ModelProvidersConfig | null, memoryAvailable: boolean): AgentsDocument {
		const settings = this.#current;
		const reachable = runtime.reachableProviders > 0;
		const defaultProvider = providers?.providers.find((entry) => entry.id === providers.default);
		const view = (
			id: AgentId,
			name: string,
			description: string,
			kind: AgentView['kind'],
			available: boolean,
			reason: string,
		): AgentView => {
			const chosen = settings[id].model;
			return {
				id,
				name,
				description,
				kind,
				available,
				...(available ? {} : { reason }),
				applies: AGENT_APPLIES[id],
				settings: settings[id],
				...(chosen !== null && !listed(providers, chosen.provider, chosen.model) ? { stale: true } : {}),
			};
		};
		return {
			store: { writable: this.writable, ...(this.writable ? {} : { reason: NO_DATABASE }) },
			default_model: defaultProvider === undefined
				? null
				: { provider: defaultProvider.id, model: defaultProvider.defaultModel },
			models: (providers?.providers ?? []).flatMap((provider) =>
				provider.models.map((model) => ({
					provider: provider.id,
					provider_label: provider.label,
					model,
					reachable: runtime.providerReachable(provider.id),
				}))
			),
			memory_available: memoryAvailable,
			agents: [
				view(
					'builtin',
					'Built-in model agent',
					'Runs text tasks on a model provider with the caller’s taskable tools.',
					'builtin',
					reachable,
					'No reachable model provider',
				),
				view(
					SLOPLORD.id,
					SLOPLORD.name,
					SLOPLORD.description,
					'profile',
					runtime.profileReady(SLOPLORD.id),
					SLOPLORD.unavailable,
				),
				view(
					'acp',
					'Coding agent (ACP)',
					'The operator’s external coding agent, reached over the ACP bridge.',
					'acp',
					runtime.hasBridge,
					'No bridge: TTK_AGENT_BRIDGE_URL is not set',
				),
				...runtime.peerIds.map((id): AgentView => ({
					id: `peer:${id}`,
					name: id,
					description: 'A remote A2A agent from TTK_AGENT_PEERS_FILE; it is configured where it runs.',
					kind: 'peer',
					available: true,
					applies: NO_FIELDS,
					settings: null,
				})),
			],
		};
	}
}

function sameChoice(
	a: { provider: string; model: string } | null,
	b: { provider: string; model: string } | null,
): boolean {
	return a !== null && b !== null && a.provider === b.provider && a.model === b.model;
}

/** Whether a provider in force lists `model`. */
function listed(providers: ModelProvidersConfig | null, provider: string, model: string): boolean {
	return providers?.providers.some((entry) => entry.id === provider && entry.models.includes(model)) === true;
}
