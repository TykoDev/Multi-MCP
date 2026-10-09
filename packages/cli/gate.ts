/**
 * The OpenTelemetry egress gate alone, as a launcher pre-step (D-137, review SEC-1W).
 *
 * `deno run --watch` runs the gated module inside the watcher's own process (measured: one pid), and the watcher logs
 * its own lines ("Watcher Process started.", "… finished …") through the runtime's OTLP exporter before and after the
 * module's gate has judged anything. No grant or variable can separate the two, because `OTEL_DENO` is read once per
 * process. So the `dev` task runs this entry first, joined by `&&`: a refusal ends the task before the watcher starts,
 * and a pass means the watcher's export goes only where the gate allows. The gated module still judges again inside.
 *
 * Imports nothing but the import-free gate. A refusal is the same one stderr line and `Deno.exitCode = 1`, with a
 * natural exit (O27); a pass prints nothing (the module's own gate prints any warning once).
 *
 * @module
 */
import { enforceOtelEgress } from './otel_gate.ts';

const encoder = new TextEncoder();
enforceOtelEgress(Deno.args, {
	write: (line) => {
		if (!line.startsWith('tykotech-mcp: refusing')) return;
		const bytes = encoder.encode(`${line}\n`);
		try {
			let written = 0;
			while (written < bytes.length) written += Deno.stderr.writeSync(bytes.subarray(written));
		} catch {
			// A closed stderr cannot be reported to; the exit code still says it.
		}
	},
});
