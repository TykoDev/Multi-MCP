/**
 * Argument repair and argument-error wording for the `tools/call` seam.
 *
 * Two failures reached callers as unusable `invalid-arguments` results:
 *
 * 1. **Stringified values.** Some MCP clients (and the models behind them) send a nested object, an array or a number
 *    as its JSON text — `{"message": "{\"version\":\"v0.9\",…}"}` or `{"limit": "5"}`. The schema is right to refuse
 *    a string where it wants an object, but the caller meant the value the text spells, and a refusal it cannot act on
 *    ends its turn. {@linkcode repairArguments} re-reads **only** the values the schema rejected, **only** when they
 *    are strings that parse as JSON of a non-string type, and the repaired arguments are validated by the same schema
 *    again, so nothing the schema would refuse is ever admitted: the repair widens the accepted *spellings*, never the
 *    accepted *values*.
 * 2. **Union failures.** Zod reports a value that matches no branch of a union as `Invalid input` with the branches'
 *    own issues nested inside, so `a2ui_publish` with one wrong field answered `message: Invalid input` — no field
 *    named, no expectation stated. {@linkcode describeIssues} descends into the branch the value came closest to and
 *    reports that branch's issues with their full paths.
 *
 * @module
 */

/** One Zod issue, as much of it as this module reads. Zod v4's `invalid_union` carries its branches in `errors`. */
export interface ArgumentIssue {
	readonly path: readonly PropertyKey[];
	readonly message: string;
	readonly code?: string;
	/** `invalid_type`: the type the schema wanted. */
	readonly expected?: string;
	readonly errors?: readonly (readonly ArgumentIssue[])[];
}

/** How many repair rounds one call gets: one per nesting level a client stringified, which is never deep. */
const MAX_REPAIR_ROUNDS = 4;

/** The largest string the repair will try to parse; beyond any argument a tool accepts as structure. */
const MAX_REPAIR_CHARS = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `path` inside `root`, or `undefined` when the path leaves the structure. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
	let node = root;
	for (const key of path) {
		if (Array.isArray(node) && typeof key === 'number') node = node[key];
		else if (isRecord(node) && typeof key === 'string' && Object.hasOwn(node, key)) node = node[key];
		else return undefined;
	}
	return node;
}

/** A copy of `root` with the value at `path` replaced; `path` is known to resolve. */
function withValueAt(root: unknown, path: readonly PropertyKey[], value: unknown): unknown {
	if (path.length === 0) return value;
	const [head, ...rest] = path;
	if (Array.isArray(root) && typeof head === 'number') {
		const copy = [...root];
		copy[head] = withValueAt(root[head], rest, value);
		return copy;
	}
	if (isRecord(root) && typeof head === 'string') {
		return { ...root, [head]: withValueAt(root[head], rest, value) };
	}
	return root;
}

/**
 * The structured value a string spells, or `undefined` when it spells none: JSON whose top level is an object, an
 * array, a finite number or a boolean. A JSON string literal (`"\"x\""`) and `null` are not repairs — a string where
 * a string is refused is refused for some other reason, and `null` is never what a caller who typed text meant.
 */
function parsedStructure(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === '' || trimmed.length > MAX_REPAIR_CHARS) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : undefined;
	if (typeof parsed === 'boolean' || Array.isArray(parsed) || isRecord(parsed)) return parsed;
	return undefined;
}

/** True for an issue that refuses a value for being a string where the schema wanted structure. */
function refusesString(issue: ArgumentIssue): boolean {
	return issue.code === 'invalid_union' || (issue.code === 'invalid_type' && issue.expected !== 'string');
}

/**
 * Every path, from `issues` and any union branches inside them, at which the schema refused a string for its type —
 * never a string refused for its content (too long, a bad pattern), which re-reading as JSON could only make worse.
 */
function stringPaths(args: unknown, issues: readonly ArgumentIssue[], into: Map<string, PropertyKey[]>): void {
	for (const issue of issues) {
		if (refusesString(issue) && typeof valueAt(args, issue.path) === 'string') {
			into.set(JSON.stringify(issue.path.map(String)), [...issue.path]);
		}
		for (const branch of issue.errors ?? []) {
			// A branch's issue paths are relative to the union's own value.
			stringPaths(args, branch.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })), into);
		}
	}
}

/**
 * Re-reads the stringified values a schema rejected (see the module note). `parse` is the tool's own validator; the
 * result is either the repaired arguments, which `parse` accepted, or `null` when no repair made them valid — in
 * which case `issues` are those of the **last** attempt, so a stringified object with a wrong field is reported by
 * that field rather than as "expected object, received string".
 */
export function repairArguments<T>(
	args: unknown,
	firstIssues: readonly ArgumentIssue[],
	parse: (value: unknown) => { success: true; data: T } | { success: false; issues: readonly ArgumentIssue[] },
): { ok: true; data: T } | { ok: false; issues: readonly ArgumentIssue[] } {
	let current = args;
	let issues = firstIssues;
	for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
		const paths = new Map<string, PropertyKey[]>();
		stringPaths(current, issues, paths);
		let next = current;
		for (const path of paths.values()) {
			const structure = parsedStructure(valueAt(next, path) as string);
			if (structure !== undefined) next = withValueAt(next, path, structure);
		}
		if (next === current) break;
		current = next;
		const attempt = parse(current);
		if (attempt.success) return { ok: true, data: attempt.data };
		issues = attempt.issues;
	}
	return { ok: false, issues };
}

/** How far a union branch got: fewer issues is closer, and among equals the deeper first issue is. */
function branchDistance(branch: readonly ArgumentIssue[]): [number, number] {
	const depth = branch.reduce((deepest, issue) => Math.max(deepest, issue.path.length), 0);
	return [branch.length, -depth];
}

/**
 * The issues to report for one issue: itself, or — for a union no branch of which matched — the issues of the branch
 * the value came closest to, with the union's path in front, recursively. A branch that refused the value's very
 * shape (a key it does not know, a key it lacks) is further than one that refused a single field inside it, which is
 * the branch the caller was writing.
 */
function flatten(issue: ArgumentIssue): ArgumentIssue[] {
	const branches = issue.errors?.filter((branch) => branch.length > 0) ?? [];
	if (issue.code !== 'invalid_union' || branches.length === 0) return [issue];
	let best = branches[0]!;
	let bestDistance = branchDistance(best);
	for (const branch of branches.slice(1)) {
		const distance = branchDistance(branch);
		if (distance[0] < bestDistance[0] || (distance[0] === bestDistance[0] && distance[1] < bestDistance[1])) {
			best = branch;
			bestDistance = distance;
		}
	}
	return best.flatMap((inner) => flatten({ ...inner, path: [...issue.path, ...inner.path] }));
}

/** Renders validation issues as `<path>: <issue>`, joined, unions resolved to their closest branch; root is `(root)`. */
export function describeIssues(issues: readonly ArgumentIssue[]): string {
	const lines = issues.flatMap(flatten).map((issue) =>
		`${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`
	);
	return [...new Set(lines)].join('; ');
}
