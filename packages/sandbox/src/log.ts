/**
 * JSON lines on stdout, in the shape the API writes (`ts`, `level`, `event`, then fields), so one
 * `docker compose logs` reads the same for both. The token is cut out of every line by value.
 */
type Level = 'info' | 'warn' | 'error';

/** Guarded values, cut in registration order (a credential before the `Basic …` holding it keeps the scheme). */
const guarded = new Set<string>();

/**
 * Registers a value that must never appear in a log line, in its JSON-escaped form too (a token may hold `"` or
 * `\`). Values under eight characters are not registered: they would cut ordinary text out of every line.
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
