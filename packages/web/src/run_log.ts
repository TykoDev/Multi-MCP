/**
 * A task's run log in words (`GET /api/v1/agent/tasks/{id}/log`, the Tasks view's Run history): one line per entry —
 * a glyph, what happened, and its key facts — plus the facts left over for the entry's detail. Pure: no DOM, so the
 * wording is tested on its own.
 */
import type { RunLogEntry } from './api.ts';
import type { IconName } from './icons.ts';
import { lookOf } from './task_states.ts';

/** One run-log entry as the timeline shows it. */
export interface RunLogLine {
	readonly glyph: IconName;
	/** A tone class for the glyph: `ok`, `failed`, or `''`. */
	readonly tone: string;
	readonly title: string;
	/** Short facts after the title (duration, tokens, stop reason), each a few words. */
	readonly facts: readonly string[];
	/** What the entry carries beyond its line (arguments, a result's text, a raw ACP update), or `null`. */
	readonly detail: unknown;
}

/** A duration in milliseconds as people read it: `850 ms`, `1.2 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** The time of an entry relative to the task's creation: `+0.0 s`, `+12.4 s`; empty when either does not parse. */
export function offsetOf(at: string, createdAt: string): string {
	const ms = Date.parse(at) - Date.parse(createdAt);
	return Number.isFinite(ms) ? `+${(Math.max(0, ms) / 1000).toFixed(1)} s` : '';
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One entry as a line of the timeline. Unknown kinds keep every fact as their detail. */
export function runLogLine(entry: RunLogEntry): RunLogLine {
	const { at: _at, kind, ...rest } = entry;
	const duration = num(entry.duration_ms);
	const took = duration === null ? [] : [formatDuration(duration)];
	switch (kind) {
		case 'received': {
			const backend = [str(entry.agent), str(entry.provider), str(entry.model)].filter(Boolean).join(' · ');
			const via = str(entry.via) === 'a2a' ? 'over A2A' : '';
			return {
				glyph: 'inbox',
				tone: '',
				title: `Request received${str(entry.task_kind) === '' ? '' : ` · ${str(entry.task_kind)} task`}`,
				facts: [backend, str(entry.backend) === 'acp' ? 'ACP agent' : '', via].filter(Boolean),
				detail: null,
			};
		}
		case 'state': {
			const look = lookOf(str(entry.state));
			return {
				glyph: look.glyph ?? 'activity',
				tone: look.tone === 'failed' ? 'failed' : look.tone === 'done' ? 'ok' : '',
				title: `State: ${look.label}`,
				facts: [],
				detail: str(entry.text) === '' ? null : entry.text,
			};
		}
		case 'model_request': {
			const usage = entry.usage as { input?: unknown; output?: unknown } | undefined;
			const input = num(usage?.input);
			const output = num(usage?.output);
			const calls = num(entry.tool_calls);
			const error = str(entry.error);
			return {
				glyph: 'model',
				tone: error === '' ? '' : 'failed',
				title: `Model request${num(entry.step) === null ? '' : ` · step ${entry.step}`}${
					str(entry.provider) === '' ? '' : ` → ${str(entry.provider)}`
				}`,
				facts: [
					str(entry.model),
					...took,
					input === null || output === null ? '' : `${input.toLocaleString()} in / ${output.toLocaleString()} out`,
					str(entry.stop) === '' ? '' : `stop: ${str(entry.stop)}`,
					calls === null || calls === 0 ? '' : calls === 1 ? '1 tool call' : `${calls} tool calls`,
					num(entry.tools) === null ? '' : `${entry.tools} tools offered`,
				].filter(Boolean),
				detail: error === '' ? null : error,
			};
		}
		case 'tool_call':
			return {
				glyph: 'wrench',
				tone: '',
				title: `Tool call · ${str(entry.name)}`,
				facts: num(entry.step) === null ? [] : [`step ${entry.step}`],
				detail: entry.arguments ?? null,
			};
		case 'tool_result':
			return {
				glyph: entry.isError === true ? 'circle-x' : 'circle-check',
				tone: entry.isError === true ? 'failed' : 'ok',
				title: `Tool result · ${str(entry.name)}${entry.isError === true ? ' · error' : ''}`,
				facts: took,
				detail: str(entry.text) === '' ? null : entry.text,
			};
		case 'acp':
			return {
				glyph: 'terminal',
				tone: '',
				title: `Agent ${str(entry.update).replaceAll('_', ' ')}${
					str(entry.title) === '' ? '' : ` · ${str(entry.title)}`
				}`,
				facts: str(entry.status) === '' ? [] : [str(entry.status)],
				detail: entry.detail ?? null,
			};
		case 'peer_request':
			return {
				glyph: 'delegate',
				tone: '',
				title: duration === null ? `Request to peer ${str(entry.peer)}` : `Peer ${str(entry.peer)} answered`,
				facts: took,
				detail: null,
			};
		case 'artifact': {
			const bytes = num(entry.bytes);
			return {
				glyph: 'file',
				tone: '',
				title: `Artifact · ${str(entry.name)}`,
				facts: bytes === null ? [] : [`${bytes.toLocaleString()} bytes`],
				detail: null,
			};
		}
		case 'truncated':
			return {
				glyph: 'scissors',
				tone: '',
				title: 'The run log reached its size bound; later events were not kept',
				facts: [],
				detail: null,
			};
		default:
			return { glyph: 'circle-dashed', tone: '', title: kind, facts: [], detail: rest };
	}
}
