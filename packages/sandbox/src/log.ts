/**
 * JSON lines on stdout, in the shape the API writes (`ts`, `level`, `event`, then fields), so one
 * `docker compose logs` reads the same for both. The token is cut out of every line by value.
 */
type Level = 'info' | 'warn' | 'error';

/**
 * Every form a guarded value can take in a line, cut in the order the values were registered: the forwarder registers
 * a credential before the `Basic …` value that holds it, so a line keeps the scheme and reads `Basic [redacted]`.
 */
const guarded = new Set<string>();

/**
 * Registers a value that must never appear in a log line.
 *
 * R3-8: the line is matched as written, which is JSON, where a `"`, a `\` or a control character in the value is
 * escaped; a remote's token may hold the first two (git_forwarder.ts admits printable ASCII). So the escaped form is
 * guarded beside the raw one (the raw form of such a value cannot occur in a JSON line, the escaped one can). Values
 * under eight characters are not registered: they would cut ordinary text out of every line.
 */
export function guardSecret(value: string): void {
	if (value.length < 8) return;
	guarded.add(JSON.stringify(value).slice(1, -1));
	guarded.add(value);
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
	let line = JSON.stringify(
		{ ts: new Date().toISOString(), level, event, ...fields },
		(_, v) => v instanceof Error ? { name: v.name, message: v.message } : v,
	);
	for (const secret of guarded) line = line.replaceAll(secret, '[redacted]');
	if (level === 'error') console.error(line);
	else console.log(line);
}
