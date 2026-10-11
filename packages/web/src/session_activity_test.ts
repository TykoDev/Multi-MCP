/// <reference lib="deno.ns" />
import { assertEquals } from '@std/assert';
import { activityOf, duration, meterTone, share } from './session_activity.ts';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

Deno.test('activity: watched, held or recently used is active; otherwise idle, with when the reaper closes it', () => {
	const base = { viewer_count: 0, human_has_control: false };
	assertEquals(activityOf({ ...base, last_used_at: ago(30) }, undefined, now).active, true);
	assertEquals(activityOf({ ...base, viewer_count: 1, last_used_at: ago(4000) }, undefined, now).active, true);
	assertEquals(
		activityOf({ ...base, human_has_control: true, last_used_at: ago(4000) }, undefined, now).reason,
		'A person holds control',
	);
	const idle = activityOf({ ...base, last_used_at: ago(600) }, { idle_seconds: 600, idle_timeout_s: 1800 }, now);
	assertEquals([idle.active, idle.idleSeconds, idle.closesIn], [false, 600, 1200]);
	// The server's idle time wins over the browser's clock; a watched session is never reaped.
	assertEquals(
		activityOf({ ...base, last_used_at: ago(10) }, { idle_seconds: 900, idle_timeout_s: 1800 }, now).active,
		false,
	);
	assertEquals(
		activityOf({ ...base, viewer_count: 2, last_used_at: ago(10) }, { idle_seconds: 900, idle_timeout_s: 1800 }, now)
			.closesIn,
		null,
	);
});

Deno.test('meters: share is clamped and unknown is empty; tones follow the fill; durations read naturally', () => {
	assertEquals(share(512, 1024), 0.5);
	assertEquals(share(2048, 1024), 1);
	assertEquals(share(null, 1024), 0);
	assertEquals(share(5, null), 0);
	assertEquals([meterTone(0.2), meterTone(0.75), meterTone(0.95)], ['ok', 'warn', 'danger']);
	assertEquals([duration(45), duration(720), duration(7500), duration(7200)], ['45 s', '12 min', '2 h 5 min', '2 h']);
});
