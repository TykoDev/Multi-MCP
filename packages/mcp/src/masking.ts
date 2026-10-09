/**
 * @module
 * The `browser_type` sensitive-text heuristic (CONNECTORS-MCP-A2A-A2UI.md §2.3).
 *
 * This is explicitly **not** the secrets pipeline. Real secrets travel through the `sensitiveData`
 * contract (D-SEC2, SECURITY-AUTH.md §5), where the LLM only ever sees `<secret>key</secret>` and
 * substitution happens post-validation inside `registry.executeAction`. The heuristic exists for the
 * other case: an interactive MCP client with no secrets map at all, where the operator types a
 * password into a tool call by hand. Without it, that value would appear verbatim in the tool result,
 * in the server's logs, and in any telemetry the operator later opts into.
 *
 * Classification (§2.3, preserved as written): sensitive when `length >= 6` AND (email-shaped OR
 * `length >= 16` and composed of alphanumerics plus `.-_`). Consequences: the type event is
 * dispatched with `isSensitive: true` and a `sensitiveKeyName` of `'email'` or `'credential'`, and
 * the result echoes the mask — the raw value must not reach the result, the logs, or telemetry.
 *
 * It is a heuristic and it is one-directional by design: it can over-mask (a long product SKU reads
 * as a credential) but it does not under-mask the two shapes it names. Over-masking costs the model
 * a little context; under-masking costs a credential.
 */

/** §2.3's minimum length — below it nothing is classified. */
export const SENSITIVE_MIN_LENGTH = 6;

/** §2.3's threshold for the credential-shaped branch. */
export const CREDENTIAL_MIN_LENGTH = 16;

/**
 * Email shape. Deliberately loose: this is a masking trigger, not an address validator, and a
 * false positive costs nothing.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Alphanumerics plus the three punctuation characters §2.3 names. */
const CREDENTIAL_SHAPE = /^[A-Za-z0-9.\-_]+$/;

/** What the classifier decided, and the name the mask and the type event both carry. */
export type SensitiveKind = 'email' | 'credential';

export interface MaskedText {
	readonly sensitive: boolean;
	/** `null` when not sensitive. Feeds `TypeTextEvent.sensitiveKeyName`. */
	readonly kind: SensitiveKind | null;
	/** What may be shown: the raw text when safe, `<email>` / `<credential>` when not. */
	readonly display: string;
}

/** Classifies one `browser_type` input per §2.3. Pure; never logs. */
export function classifySensitiveText(text: string): MaskedText {
	if (text.length < SENSITIVE_MIN_LENGTH) return { sensitive: false, kind: null, display: text };
	if (EMAIL_SHAPE.test(text)) return { sensitive: true, kind: 'email', display: '<email>' };
	if (text.length >= CREDENTIAL_MIN_LENGTH && CREDENTIAL_SHAPE.test(text)) {
		return { sensitive: true, kind: 'credential', display: '<credential>' };
	}
	return { sensitive: false, kind: null, display: text };
}
