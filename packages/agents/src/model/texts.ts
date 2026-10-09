/**
 * D-143 (model-providers-ui, fix round CR-7 / SEC-1 / CR-1): the refusal texts the runtime and the model loop share,
 * defined once so the two paths cannot drift. The loop imports nothing else from the runtime at run time (the
 * runtime imports the loop), which is why they live here rather than in `runtime.ts`.
 */

/** GW-1: a structured tool call, or a tool call the model asked for, without `mcp:invoke` on the credential as it stands now. */
export const MCP_INVOKE_SCOPE_REQUIRED = 'mcp:invoke scope required';

/**
 * §3.10 row 2 at submit, and SEC-1 before every provider call: the scope that spends the operator's key. A credential
 * that keeps `agent:invoke` but loses `model:invoke` mid-task fails before the next dial.
 */
export const MODEL_INVOKE_SCOPE_REQUIRED = 'model:invoke scope required';

/**
 * CR-1 / BUG-6: a `model` selection without a `provider` names nothing to run it on — refused `-32602` in every
 * binding (runtime, A2A, REST as `400 invalid-request` with this text as `detail`), bridge or no bridge, before any
 * task exists.
 */
export const MODEL_REQUIRES_PROVIDER = 'model requires provider';

/** D-156: a SlopLord text task submitted by a credential that cannot run the coding sandbox. */
export const SANDBOX_EXECUTE_SCOPE_REQUIRED = 'sandbox:execute scope required';
