/** Public agent protocol boundary. Server-only; browser-safe A2UI contracts live in wire. */
export { AgentError } from './src/util.ts';
export {
	agentMessage,
	AgentRuntime,
	INTERRUPTED_BY_RESTART,
	SANDBOX_SLOT_WAIT_MS,
	TASK_RETENTION_MS,
	TASK_SLOTS,
	TASK_SLOTS_PER_OWNER,
	terminal,
	TEXT_TASK_TIMEOUT_MS,
	TOOL_BOUND_MARGIN_MS,
	TOOL_CALL_BOUND_MS,
	toolTaskBoundMs,
} from './src/runtime.ts';
export type {
	AgentMessage,
	AgentRuntimeOptions,
	AgentSessionMcp,
	AgentTask,
	AgentTaskMetadata,
	ModelSelection,
	SecretSealer,
	ToolInvocation,
} from './src/runtime.ts';
// D-143 (model-providers-ui): the loop–client contract (S0), the two clients, the loop and the redaction (W2).
export type {
	ModelBounds,
	ModelClientSettings,
	ModelMessage,
	ModelProviderClient,
	ModelTool,
	ModelTurn,
	ToolCall,
	ToolResultMessage,
} from './src/model/types.ts';
export { ARGUMENTS_NOT_OBJECT, openAiClient, openAiTurn } from './src/model/openai.ts';
export { ANTHROPIC_VERSION, anthropicClient, anthropicTurn } from './src/model/anthropic.ts';
export {
	DEFAULT_MODEL_BOUNDS,
	MODEL_LIST_LIMIT,
	modelIdsOf,
	ModelProviderError,
	PROVIDER_BODY_LIMIT,
	PROVIDER_CALL_TIMEOUT_MS,
	PROVIDER_RETRY_DELAY_MS,
	providerEndpoint,
} from './src/model/transport.ts';
export type { ModelClientOptions, ModelProviderErrorKind } from './src/model/transport.ts';
export {
	ELIDED,
	MODEL_EVENT_LIMIT,
	MODEL_FAILURES,
	MODEL_SYSTEM_PROMPT,
	MODEL_TOOL_RESULT_LIMIT,
	MODEL_TRANSCRIPT_LIMIT,
	runModelTask,
	trimTranscript,
} from './src/model/loop.ts';
export type { ModelEvent, ModelOutcome, ModelTaskContext } from './src/model/loop.ts';
export { redactable, REDACTED, REDACTION_MIN_LENGTH, redactJson, redactor } from './src/model/redact.ts';
export {
	MCP_INVOKE_SCOPE_REQUIRED,
	MODEL_INVOKE_SCOPE_REQUIRED,
	MODEL_REQUIRES_PROVIDER,
	SANDBOX_EXECUTE_SCOPE_REQUIRED,
} from './src/model/texts.ts';
// D-156: the built-in named agent profiles (SlopLord).
export {
	AGENT_PROFILES,
	agentProfile,
	profileA2aPath,
	SLOPLORD,
	SLOPLORD_SYSTEM_PROMPT,
	SLOPLORD_TOOLS,
} from './src/model/profiles.ts';
export type { AgentProfile, AgentProfileId } from './src/model/profiles.ts';
export {
	a2aFetch,
	a2aInvoke,
	agentCard,
	agentEventBody,
	agentEvents,
	EVENT_STREAM_HEADERS,
	extendedAgentCard,
	profileAgentCard,
	profileCardUrl,
} from './src/a2a.ts';
export type { A2aCaller, A2aFetchOptions, A2aOutcome, AgentCardOptions, AgentToolSkill } from './src/a2a.ts';
export {
	AGENT_APPLIES,
	AGENT_IDS,
	DEFAULT_AGENT_SETTINGS,
	isA2uiTool,
	MEMORY_TOOLS,
	parseAgentSettings,
	settingAllows,
} from './src/settings.ts';
export type { AgentId, AgentModelChoice, AgentSetting, AgentSettings } from './src/settings.ts';
export { DURABLE_DEBOUNCE_MS, DurableJsonFile } from './src/durable.ts';
export type { DurableLogger } from './src/durable.ts';
export { MAX_PUSH_CONFIGS_PER_TASK, PUSH_RETRIES, PUSH_TIMEOUT_MS } from './src/push.ts';
export type { PushOptions } from './src/push.ts';
export { A2aPeerClient } from './src/peer.ts';
export type { AgentPeer } from './src/peer.ts';
export { AcpClient } from './src/acp.ts';
export type { AcpCallbacks, AcpCommand } from './src/acp.ts';
export { AgentBridgeClient, AgentBridgeServer, runAcpProxy } from './src/bridge.ts';
export type { AgentBridgeOptions } from './src/bridge.ts';
