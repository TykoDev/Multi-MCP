/**
 * The service token is read once at start-up and the read grant revoked, so nothing later in this process can
 * reach it by path. Deno revokes the whole covering grant, so the kept folders are checked afterwards and a token
 * inside one is refused. The file is operator-made (`deno task setup`) and never created here. Imports nothing, so
 * the Linux tier runs it with exactly the production grants.
 */

/** The image's default `TTK_SANDBOX_TOKEN_FILE`, where `docker-compose.yml` mounts the `ttk_sandbox_token` secret. */
export const SECRET_TOKEN_FILE = '/run/secrets/ttk_sandbox_token';

/** Reads the token at `path` once and gives up the read grant on it; each `keep` folder must stay readable. */
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

/** The permissions API, narrowed to what {@linkcode releaseTokenGrant} uses, so a test can stand in for it. */
export type TokenPermissions = Pick<Deno.Permissions, 'query' | 'revoke'>;

/** After {@linkcode readServiceToken}: revokes the image's default token location too. */
export async function releaseTokenGrant(
	secretFile: string = SECRET_TOKEN_FILE,
	permissions: TokenPermissions = Deno.permissions,
): Promise<void> {
	const descriptor: Deno.ReadPermissionDescriptor = { name: 'read', path: secretFile };
	await permissions.revoke(descriptor);
	if ((await permissions.query(descriptor)).state === 'granted') {
		throw new Error(`The sandbox token location ${secretFile} still has read access.`);
	}
}
