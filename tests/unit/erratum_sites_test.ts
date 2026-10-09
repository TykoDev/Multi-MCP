/**
 * AC28 (containment-otel-links design §2.0 item 8, V2 / F7): every erratum in `SPECS/DECISION-REGISTER.md` is marked
 * at its site with `ERRATUM(E-nn)`, so a reader of the code finds the deviation without the register, and a reader of
 * the register can grep for the code.
 *
 * The table is written out here rather than parsed from the register: a site that loses its marker must fail this file,
 * and a register row edited to drop a file must not quietly shrink what is checked. One row per erratum id; each later
 * erratum appends its own row with its own sites (WS-B adds E-114–E-116).
 */
import { assert } from '@std/assert';

/** Erratum id → the files that must carry `ERRATUM(<id>)`, relative to the repository root. */
const ERRATUM_SITES: Readonly<Record<string, readonly string[]>> = {
	// K-6 / review R3-4: the Compose proofs run images built from this tree, by tag, with scratch secrets.
	'E-112': [
		'tests/sandbox/verify_compose.ts',
		'tests/support/compose_proof.ts',
		'tests/agents/verify_compose.ts',
		'tests/agents/Dockerfile.fixture',
	],
	// Review RV-3: the recommendation tiles' glyphs depart from design §5's table under D-092.
	'E-113': ['packages/web/src/system_facts.ts'],
	// D-138: the request scope — `BrowserProfile.requestScope`, carried by the session into the manager's answerer.
	'E-114': [
		'packages/browser/src/types.ts',
		'packages/browser/src/browser/session.ts',
		'packages/browser/src/browser/session_manager.ts',
	],
	// D-139: hints (Sec-Purpose prefetch) refused in both scopes; Document + Fetch patterns, the prerender host armed.
	'E-115': ['packages/browser/src/browser/session_manager.ts'],
	// D-138: the SecurityWatchdog ignores subresource and hint E0 reports.
	'E-116': ['packages/browser/src/watchdogs/security.ts'],
};

for (const [id, files] of Object.entries(ERRATUM_SITES)) {
	Deno.test(`AC28: every ${id} site carries ERRATUM(${id})`, async () => {
		assert(files.length > 0, `${id} names no site`);
		for (const file of files) {
			const text = await Deno.readTextFile(file);
			assert(text.includes(`ERRATUM(${id})`), `${file} lacks ERRATUM(${id})`);
		}
	});
}
