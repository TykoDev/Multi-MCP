/** Resolves the absolute Docker CLI grant for the optional-service test tier (D-066). */
import { DELIMITER, join, resolve } from '@std/path';

if (import.meta.main) {
	const executable = Deno.build.os === 'windows' ? 'docker.exe' : 'docker';
	for (const entry of (Deno.env.get('PATH') ?? '').split(DELIMITER)) {
		if (!entry) continue;
		const candidate = resolve(join(entry.replace(/^"|"$/g, ''), executable));
		try {
			if ((await Deno.stat(candidate)).isFile) {
				console.log(candidate);
				Deno.exit(0);
			}
		} catch (cause) {
			if (!(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.PermissionDenied)) throw cause;
		}
	}
	console.error('Docker CLI is not on PATH');
	Deno.exit(1);
}
