/**
 * D-143 W2 (backend §2.4, design §3.12 / gate F12): the provider key never reaches a task's events, artifacts,
 * history or `tasks.json`. This is the AG-8 mechanism the ACP path applies to delegation tokens (`sensitive()` /
 * `visible()` in `runtime.ts`), lifted out so the model clients can apply it to their own key: a client builds a
 * redactor over its key once and the loop pipes every string it is about to emit through it.
 *
 * The threshold is the one the runtime applies to delegation tokens: a secret shorter than 16 characters is not
 * redacted, because splitting ordinary text on a short token would mangle output that merely contains it (`abc123`),
 * and the providers-file parser warns the operator once about such a key ("short key: not redacted from task output").
 */

/** The shortest secret that is redacted; equal to the delegation-token threshold in `runtime.ts` `sensitive()`. */
export const REDACTION_MIN_LENGTH = 16;

/** What a redacted secret is replaced with, the same marker the ACP path emits. */
export const REDACTED = '[REDACTED]';

/** The secrets among `candidates` that are long enough to be redacted; `null`/`undefined`/short ones are dropped. */
export function redactable(candidates: Iterable<string | null | undefined>): string[] {
	const secrets: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length >= REDACTION_MIN_LENGTH) secrets.push(candidate);
	}
	return secrets;
}

/**
 * A function that replaces every occurrence of every secret in a string with {@linkcode REDACTED}. With no secrets it
 * is the identity, so a keyless local provider pays nothing per emitted string.
 */
export function redactor(secrets: readonly string[]): (text: string) => string {
	if (secrets.length === 0) return (text: string): string => text;
	// Longest first, so a secret that contains another is replaced whole rather than leaving its edges behind.
	const ordered = [...secrets].sort((a, b) => b.length - a.length);
	return (text: string): string => {
		let out = text;
		for (const secret of ordered) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
		return out;
	};
}

/**
 * Redacts every string inside a JSON value (tool arguments, a tool's structured result) by redacting its serialized
 * form and parsing it back, as the ACP path does for forwarded session updates. The value must be JSON-serializable;
 * a secret split across two strings cannot occur in one value, so no held-back tail is needed here.
 */
export function redactJson(value: unknown, redact: (text: string) => string): unknown {
	const json = JSON.stringify(value);
	if (json === undefined) return value;
	const clean = redact(json);
	return clean === json ? value : JSON.parse(clean);
}
