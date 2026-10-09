/**
 * SB-5: the service token is read once, at start-up, and the service then gives up the right to
 * read that file again, so nothing that later runs in this process (a bug in a file operation, say)
 * can reach it by path. Deno revokes a grant that covers the path, not just the path, so the file
 * must be granted on its own: the folders the service still needs are checked afterwards, and a
 * token kept inside one of them is refused rather than silently costing the service its work.
 *
 * D-151: under `docker-compose.yml` the token is no longer an operator-made file. The service
 * creates it on its first start in {@linkcode GENERATED_TOKEN_DIR}, a named volume that only this
 * service (read-write) and the gateway (read-only) mount, and both read it from there. Only that
 * exact path is ever created: any other `TTK_SANDBOX_TOKEN_FILE` is the operator's, and a missing
 * one still refuses the start. Once the token is read, the grants to both token locations — the
 * write grant on the volume included — are given up the same way.
 *
 * It imports nothing, so the Linux tier can run it in a process with exactly the production grants.
 */

/** The compose secret an operator-provided token is mounted at (`docker-compose.sandbox.yml`, the image's default). */
export const SECRET_TOKEN_FILE = '/run/secrets/ttk_sandbox_token';

/**
 * D-151: where `docker-compose.yml` mounts the `ttk-sandbox-token` volume in this service. `docker/Dockerfile.sandbox`
 * creates it owned by 1993 with mode 0700, so a fresh volume takes that owner and mode; the image's `CMD` grants read
 * and write on the folder (not the file) because the token is written beside it first and renamed into place, and
 * Deno's rename needs read access to the file it moves.
 */
export const GENERATED_TOKEN_DIR = '/run/ttk-sandbox-token';

/** D-151: the one `TTK_SANDBOX_TOKEN_FILE` the service creates when it is absent. */
export const GENERATED_TOKEN_FILE = `${GENERATED_TOKEN_DIR}/token`;

/** Random bytes in a generated token: 256 bits, written as 64 hex characters (the floor is 32 characters). */
const GENERATED_TOKEN_BYTES = 32;

/** A fresh service token from `crypto.getRandomValues`: lower-case hex, so it has no whitespace to trim. */
export function generateServiceToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_TOKEN_BYTES));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * D-151: creates the service token at `path` when nothing is there yet, and says whether it did. Anything already at
 * the path — a token from an earlier start, a symlink, a file that is not a token — is left exactly as it is for
 * {@linkcode readServiceToken} to judge: a token is never replaced, so the gateway's copy can never go stale.
 *
 * The token is written to `<path>.tmp` (exclusive create, mode 0400, synced) and renamed into place, so a crash leaves
 * either no token or a whole one, never a truncated file that would refuse every later start. A `.tmp` a crash left
 * behind is discarded first. One service writes this volume; two racing on it is outside the compose deployment.
 */
export async function provisionServiceToken(path: string): Promise<boolean> {
	try {
		await Deno.lstat(path);
		return false;
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) throw error;
	}
	const temporary = `${path}.tmp`;
	try {
		await Deno.remove(temporary);
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) throw error;
	}
	const bytes = new TextEncoder().encode(`${generateServiceToken()}\n`);
	// `createNew` is O_EXCL: it never follows a symlink planted at the temporary name.
	const file = await Deno.open(temporary, { write: true, createNew: true, mode: 0o400 });
	try {
		for (let written = 0; written < bytes.length;) written += await file.write(bytes.subarray(written));
		await file.sync();
	} finally {
		file.close();
	}
	await Deno.rename(temporary, path);
	return true;
}

/** SB-5: reads the token at `path` once and gives up the read grant on it; each `keep` folder must stay readable. */
export async function readServiceToken(path: string, keep: string[]): Promise<string> {
	const info = await Deno.lstat(path);
	if (!info.isFile || info.isSymlink || info.size > 4096) throw new Error('Invalid sandbox token file.');
	const token = (await Deno.readTextFile(path)).trim();
	if (token.length < 32 || /\s/.test(token)) {
		throw new Error('Sandbox token must contain at least 32 non-whitespace characters.');
	}
	await Deno.permissions.revoke({ name: 'read', path });
	if ((await Deno.permissions.query({ name: 'read', path })).state === 'granted') {
		throw new Error('The sandbox token file is still readable after its grant was revoked.');
	}
	for (const folder of keep) {
		if ((await Deno.permissions.query({ name: 'read', path: folder })).state !== 'granted') {
			throw new Error(`Grant read access to the sandbox token file on its own, outside ${folder}.`);
		}
	}
	return token;
}

/** The two token locations a matrix grants; the defaults are the shipped ones, a test passes its own. */
export interface TokenLocations {
	/** Read-granted: the operator's compose secret. */
	readonly secretFile: string;
	/** Read- and write-granted: the generated token's folder. */
	readonly generatedDir: string;
}

/** The permissions API, narrowed to what {@linkcode releaseTokenGrants} uses, so a test can stand in for it. */
export type TokenPermissions = Pick<Deno.Permissions, 'query' | 'revoke'>;

/**
 * D-151, after {@linkcode readServiceToken}: gives up every grant to either token location, whichever one was used —
 * the unused one is as much a path nothing should read again as the used one — and the write grant on the generated
 * token's folder, so the service can neither read nor replace its token for the rest of its life. Then, as SB-5 does
 * for reads, each `keep` folder must still be writable: a token folder granted inside one would have cost the service
 * that folder, and is refused rather than discovered later as a failed write.
 */
export async function releaseTokenGrants(
	keep: string[],
	locations: TokenLocations = { secretFile: SECRET_TOKEN_FILE, generatedDir: GENERATED_TOKEN_DIR },
	permissions: TokenPermissions = Deno.permissions,
): Promise<void> {
	const released: Array<Deno.ReadPermissionDescriptor | Deno.WritePermissionDescriptor> = [
		{ name: 'read', path: locations.secretFile },
		{ name: 'read', path: locations.generatedDir },
		{ name: 'write', path: locations.generatedDir },
	];
	for (const descriptor of released) await permissions.revoke(descriptor);
	for (const descriptor of released) {
		if ((await permissions.query(descriptor)).state === 'granted') {
			throw new Error(`The sandbox token location ${descriptor.path} still has ${descriptor.name} access.`);
		}
	}
	for (const folder of keep) {
		if ((await permissions.query({ name: 'write', path: folder })).state !== 'granted') {
			throw new Error(`Grant write access to the sandbox token folder on its own, outside ${folder}.`);
		}
	}
}
