/**
 * Structured logging.
 *
 * On stdio the protocol owns stdout, so every line goes to stderr there; the
 * HTTP server logs to stdout where a container collector expects it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	/** Derives a logger that stamps additional fields on every line. */
	with(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
	readonly level?: LogLevel;
	readonly format?: 'json' | 'pretty';
	/** `stderr` is mandatory for the stdio transport. */
	readonly sink?: 'stdout' | 'stderr';
	readonly fields?: Record<string, unknown>;
	/** Injected for tests. */
	readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const level = options.level ?? 'info';
	const format = options.format ?? 'json';
	const base = options.fields ?? {};
	const encoder = new TextEncoder();
	const write = options.write ?? ((line: string) => {
		const target = options.sink === 'stderr' ? Deno.stderr : Deno.stdout;
		target.writeSync(encoder.encode(`${line}\n`));
	});

	function emit(entry: LogLevel, message: string, fields?: Record<string, unknown>): void {
		if (ORDER[entry] < ORDER[level]) return;
		const merged = { ...base, ...fields };
		if (format === 'pretty') {
			const suffix = Object.keys(merged).length === 0 ? '' : ` ${JSON.stringify(merged)}`;
			write(`${entry.toUpperCase().padEnd(5)} ${message}${suffix}`);
			return;
		}
		write(JSON.stringify({ ts: new Date().toISOString(), level: entry, msg: message, ...merged }));
	}

	return {
		debug: (message, fields) => emit('debug', message, fields),
		info: (message, fields) => emit('info', message, fields),
		warn: (message, fields) => emit('warn', message, fields),
		error: (message, fields) => emit('error', message, fields),
		with: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
	};
}
