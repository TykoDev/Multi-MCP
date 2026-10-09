/**
 * Console-formatting helpers for the bus.
 *
 * All console formatting lives here behind `_log`-prefixed helpers (AGENTS.md §3) so the dispatch
 * path stays free of presentation logic.
 */

import type { BusLogger } from './types.ts';

function _logFormat(level: string, message: string, fields?: Record<string, unknown>): string {
	const suffix = fields === undefined || Object.keys(fields).length === 0 ? '' : ` ${_logFields(fields)}`;
	return `[bua.bus] ${level} ${message}${suffix}`;
}

function _logFields(fields: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		parts.push(`${key}=${_logValue(value)}`);
	}
	return parts.join(' ');
}

function _logValue(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Default logger: warnings and errors go to stderr, debug is dropped.
 *
 * Library import MUST NOT install `@std/log` handlers as a side effect (OBSERVABILITY §1.2), so the
 * bus writes through `console` and lets embedders inject `@tykotech/browser`'s facade instead.
 */
export const consoleBusLogger: BusLogger = {
	debug(_message, _fields) {
		// Intentionally silent: debug output is opt-in via an injected logger.
	},
	warn(message, fields) {
		console.warn(_logFormat('WARN', message, fields));
	},
	error(message, fields) {
		console.error(_logFormat('ERROR', message, fields));
	},
};

/** Drops everything. Useful in tests that assert on behaviour rather than output. */
export const silentBusLogger: BusLogger = {
	debug() {},
	warn() {},
	error() {},
};
