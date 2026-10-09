/**
 * D-158 (owner-requested): per-agent settings an administrator manages on System › Agents — which model an agent runs
 * on by default, which protocols it is offered over (A2A, ACP, A2UI) and whether it may use the agent memory.
 *
 * The agents are the ones this gateway runs or routes to: the built-in model agent, each built-in profile (SlopLord),
 * and the operator's ACP coding agent. A setting only ever **narrows or chooses** within what the deployment already
 * offers: a model must be one a provider in force lists, a protocol switched on still needs its backend (a bridge, a
 * reachable provider, the sandbox), and a tool switched on still needs the caller's own scope at every call (GW-1).
 * The one widening is SlopLord's A2UI switch, which adds the `a2ui_*` tools to its allowlist — off by default, and
 * still intersected with the caller's rights like every profile tool.
 *
 * The runtime reads the settings at every use (`AgentRuntimeOptions.agents`), so a change applies to the next task
 * without a restart; a task already running keeps what it started with.
 */
import { AgentError } from './util.ts';

/** The agents a setting can name. Wire-frozen once merged (the settings document's keys). */
export const AGENT_IDS = ['builtin', 'sloplord', 'acp'] as const;
export type AgentId = typeof AGENT_IDS[number];

/** The model an agent runs on when a request names none: a provider id and one of its models. */
export interface AgentModelChoice {
	readonly provider: string;
	readonly model: string;
}

/** One agent's settings. A field that does not apply to the agent (`AGENT_APPLIES`) is kept but never read. */
export interface AgentSetting {
	/** The default model; `null` follows the providers' default (the default provider and its default model). */
	readonly model: AgentModelChoice | null;
	/** Offered over A2A: its skill on the card and its tasks accepted from the A2A bindings. */
	readonly a2a: boolean;
	/** ACP agent only: text tasks that name no provider are routed to the bridge. */
	readonly acp: boolean;
	/** May publish A2UI surfaces: the `a2ui_*` tools are in its tool list. */
	readonly a2ui: boolean;
	/** May use the agent memory: the `memory_*` tools are in its tool list. */
	readonly memory: boolean;
}

export type AgentSettings = Readonly<Record<AgentId, AgentSetting>>;

/** Which settings mean something for each agent; the control plane offers only these. */
export const AGENT_APPLIES: Readonly<Record<AgentId, Readonly<Record<keyof AgentSetting, boolean>>>> = {
	builtin: { model: true, a2a: true, acp: false, a2ui: true, memory: true },
	sloplord: { model: true, a2a: true, acp: false, a2ui: true, memory: true },
	// The external agent chooses its own model and tools; the gateway decides only whether to route to it.
	acp: { model: false, a2a: true, acp: true, a2ui: false, memory: false },
};

/** The settings before an administrator changes any: exactly the behaviour before D-158. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({
	builtin: Object.freeze({ model: null, a2a: true, acp: false, a2ui: true, memory: true }),
	// SlopLord's allowlist has the memory tools and not the A2UI ones (`profiles.ts`).
	sloplord: Object.freeze({ model: null, a2a: true, acp: false, a2ui: false, memory: true }),
	acp: Object.freeze({ model: null, a2a: true, acp: true, a2ui: false, memory: false }),
});

/** The memory tools a `memory: false` agent is not offered. */
export const MEMORY_TOOLS: ReadonlySet<string> = new Set([
	'memory_save',
	'memory_search',
	'memory_list',
	'memory_delete',
]);

/** Whether `name` is one of the A2UI tools an `a2ui: false` agent is not offered. */
export function isA2uiTool(name: string): boolean {
	return name.startsWith('a2ui_');
}

/** Whether an agent with `setting` may be offered the tool `name` (before its allowlist and the caller's rights). */
export function settingAllows(setting: AgentSetting, name: string): boolean {
	if (!setting.memory && MEMORY_TOOLS.has(name)) return false;
	if (!setting.a2ui && isA2uiTool(name)) return false;
	return true;
}

function flag(value: unknown, fallback: boolean, field: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== 'boolean') throw new AgentError(-32602, `must be true or false, field ${field}`);
	return value;
}

function modelChoice(value: unknown, field: string): AgentModelChoice | null {
	if (value === null) return null;
	const entry = value as Record<string, unknown> | undefined;
	const text = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0 && raw.length <= 256;
	if (
		entry === undefined || typeof entry !== 'object' || Array.isArray(entry) ||
		Object.keys(entry).some((key) => key !== 'provider' && key !== 'model') ||
		!text(entry.provider) || !text(entry.model)
	) throw new AgentError(-32602, `must be null or {provider, model}, field ${field}`);
	return { provider: entry.provider, model: entry.model };
}

/**
 * A settings document parsed onto `base`: each agent's object may name any of the five fields, and an agent or a
 * field left out keeps its `base` value. Unknown agents and fields are refused (`-32602`, the field named, never the
 * value), so a typo never silently does nothing. Whether a model exists is the caller's to judge (the gateway knows
 * the providers in force).
 */
export function parseAgentSettings(value: unknown, base: AgentSettings = DEFAULT_AGENT_SETTINGS): AgentSettings {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new AgentError(-32602, 'must be an object, field agents');
	}
	const out: Record<string, AgentSetting> = { ...base };
	for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!(AGENT_IDS as readonly string[]).includes(id)) throw new AgentError(-32602, `unknown agent, field ${id}`);
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new AgentError(-32602, `must be an object, field ${id}`);
		}
		const entry = raw as Record<string, unknown>;
		const known = ['model', 'a2a', 'acp', 'a2ui', 'memory'];
		const extra = Object.keys(entry).find((key) => !known.includes(key));
		if (extra !== undefined) throw new AgentError(-32602, `unknown setting, field ${id}.${extra}`);
		const prior = base[id as AgentId];
		out[id] = Object.freeze({
			model: entry.model === undefined ? prior.model : modelChoice(entry.model, `${id}.model`),
			a2a: flag(entry.a2a, prior.a2a, `${id}.a2a`),
			acp: flag(entry.acp, prior.acp, `${id}.acp`),
			a2ui: flag(entry.a2ui, prior.a2ui, `${id}.a2ui`),
			memory: flag(entry.memory, prior.memory, `${id}.memory`),
		});
	}
	return Object.freeze(out) as AgentSettings;
}
