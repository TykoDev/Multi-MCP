/** `@tykotech/cli` — the composition root. */
import { parseArgs } from '@std/cli/parse-args';
import type { AppArmorHost } from './apparmor.ts';

export const VERSION = '0.2.0';

/**
 * The files `setup` manages, by the name `--only` takes, in the order it writes them. `apparmor` is the host's copy of
 * the sandbox's AppArmor profile (`packages/cli/apparmor.ts`), last because it may stop at sudo's password prompt.
 */
export const SETUP_UNITS = [
	'db-key',
	'admin',
	'api-key',
	'browser-secrets',
	'git-remotes',
	'sandbox-token',
	'env',
	'apparmor',
] as const;

/** A `setup` unit. */
export type SetupUnit = (typeof SETUP_UNITS)[number];

const SETUP_UNITS_TEXT = SETUP_UNITS.join(', ');

/** A comma-separated option as a list, blanks dropped. */
const csv = (text: string): string[] => text.split(',').map((item) => item.trim()).filter((item) => item !== '');

/** Reports the members of `named` outside `vocabulary`; `true` when there are none. */
function knownScopes(named: readonly string[], vocabulary: readonly string[]): boolean {
	const unknown = named.filter((scope) => !vocabulary.includes(scope));
	if (unknown.length > 0) {
		console.error(`unknown scopes: ${unknown.join(', ')}\nvalid scopes: ${vocabulary.join(', ')}`);
	}
	return unknown.length === 0;
}

const USAGE = `tykotech-mcp ${VERSION}

USAGE:
  tykotech-mcp <command> [options]

COMMANDS:
  serve            Run the HTTP gateway (MCP over Streamable HTTP + live view)
  stdio            Run MCP over stdio for a local client
  setup            Create every missing file in secrets/ the compose files mount, and .env; --force replaces
  seed             Copy the providers file and browser secrets into the database; --force replaces
  doctor           Diagnose the environment; generate an API key
  healthcheck      Probe a running server on loopback; exit 0 when healthy
  version          Print the version

SERVE OPTIONS:
  --host <addr>    Bind address        (default 127.0.0.1, env TTK_HOST)
  --port <n>       Bind port           (default 8787, env TTK_PORT)

CHECKOUT OPTIONS (serve, stdio, doctor, seed; the deno tasks pass it):
  --local-defaults Use what setup wrote for each variable left unset: TTK_DATA_DIR=data, TTK_DB_KEY_FILE,
                   TTK_API_KEYS_FILE (not stdio, seed), TTK_SECRETS_FILE, and TTK_SANDBOX_TOKEN_FILE beside
                   TTK_SANDBOX_URL — each only when its file in secrets/ exists

SETUP OPTIONS:
  --only <list>        Only these files: ${SETUP_UNITS_TEXT}
  --force, -Force      Replace the generated files that exist (with --only: exactly the named ones, your own
                       files included). A new database key makes every stored secret unreadable.
  --admin <user>       Administrator username (default admin)
  --key-id <id>        API key id (default client)
  --scopes <list>      The API key's scopes (default: every one the stack's features need; see secrets/README.md)

SEED OPTIONS:
  --force, -Force      Replace what the database holds with the sources (default: only an empty, never-seeded one)
  --only <list>        providers, secrets (default both)

DOCTOR OPTIONS:
  --new-key <id>       Print a new API key and its hashed record
  --save               With --new-key: also add the record to secrets/ttk_api_keys.json (same id: replaced)
  --scopes <list>      Comma-separated scopes for --new-key, --new-admin or --grant
                       (--new-key default: the default grant; --new-admin always adds admin)
  --new-key-set <pfx>  Mint one single-scope key per scope in the vocabulary (ids <pfx>-<scope>)
  --new-admin <user>   Generate a new admin user record with password and save to secrets/ (--force to replace)
  --password <pass>    Optional explicit password for --new-admin
  --new-db-key         Write a new database key to secrets/ttk_db_key (--force to replace: stored secrets are lost)
  --grant <user>       Set an account's scopes to --scopes, offline, in <TTK_DATA_DIR>/users.json
  --data-dir <path>    The data directory for --grant (default: TTK_DATA_DIR)

Configuration is read from TTK_* environment variables; see docs/reference/environment-variables.md.
`;

/** The command line, parsed; `-Force` (the PowerShell spelling) is `--force`. */
function parseCli(argv: readonly string[]) {
	// parseArgs would read `-Force` as `-F -o -r -c -e`.
	const normalized = argv.map((arg) => /^-force$/i.test(arg) ? '--force' : arg);
	return parseArgs(normalized, {
		string: [
			'host',
			'port',
			'new-key',
			'scopes',
			'new-key-set',
			'new-admin',
			'password',
			'grant',
			'data-dir',
			'only',
			'admin',
			'key-id',
		],
		boolean: ['help', 'force', 'new-db-key', 'save', 'local-defaults'],
		alias: { h: 'help' },
	});
}

type CliArgs = ReturnType<typeof parseCli>;

/**
 * Where a generated credential is shown: the standard streams themselves, never `console`, which is the process's log
 * (a host's log collector reads it). `err` carries `--new-key-set`'s raw keys, whose stdout is the record file.
 */
export interface CredentialStreams {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}

const streamWriter = (stream: () => { writeSync(bytes: Uint8Array): number }) => (text: string): void => {
	const bytes = new TextEncoder().encode(text);
	let written = 0;
	while (written < bytes.length) written += stream().writeSync(bytes.subarray(written));
};

const CREDENTIAL_STREAMS: CredentialStreams = {
	out: streamWriter(() => Deno.stdout),
	err: streamWriter(() => Deno.stderr),
};

/**
 * A URL for a diagnostic line: without the username and password a URL may carry (`https://user:pass@host/`), which no
 * configuration check refuses and the doctor's output — pasted into issues — must not repeat.
 */
export function redactedUrl(url: URL): string {
	if (url.username === '' && url.password === '') return url.href;
	const shown = new URL(url.href);
	shown.username = '';
	shown.password = '';
	return shown.href;
}

export async function main(argv: string[], show: CredentialStreams = CREDENTIAL_STREAMS): Promise<number> {
	const args = parseCli(argv);
	const command = String(args._[0] ?? '');

	if (args.help || command === '' || command === 'help') {
		console.log(USAGE);
		return command === '' && !args.help ? 1 : 0;
	}

	try {
		return await dispatch(command, args, show);
	} catch (cause) {
		// A refusal written for the operator — a variable, a path and a fixed phrase, never a value — is the whole
		// message; anything else is a fault and keeps its stack.
		if (cause instanceof Error && OPERATOR_ERRORS.has(cause.name)) {
			console.error(`error: ${cause.message}`);
			return 1;
		}
		throw cause;
	}
}

/** Errors whose message is written for the operator: configuration, secret, seed, vault and database refusals. */
const OPERATOR_ERRORS = new Set(['ConfigError', 'SecretError', 'SeedError', 'VaultError', 'DatabaseError']);

async function dispatch(command: string, args: CliArgs, show: CredentialStreams): Promise<number> {
	switch (command) {
		case 'version':
			console.log(VERSION);
			return 0;
		case 'serve':
			return await runServe(args);
		case 'stdio':
			return await runStdio(args);
		case 'setup':
			return await runSetup(args, '.', undefined, show);
		case 'seed':
			return await runSeed(args);
		case 'doctor':
			return await runDoctor(args, show);
		case 'healthcheck':
			return await runHealthcheck();
		default:
			console.error(`unknown command: ${command}\n`);
			console.log(USAGE);
			return 1;
	}
}

/** The environment a command runs with: the process's `TTK_*` names, plus `--local-defaults` when it was passed. */
async function commandEnv(
	args: { 'local-defaults'?: boolean },
	apiKeys: boolean,
): Promise<{ env: Record<string, string | undefined>; defaults: LocalDefaults | null }> {
	const { ENV_NAMES, processEnv } = await import('@tykotech/gateway');
	const defaults = args['local-defaults'] === true ? await localDefaults(processEnv(ENV_NAMES), { apiKeys }) : null;
	return { env: { ...(defaults?.env ?? processEnv(ENV_NAMES)) }, defaults };
}

async function runServe(args: { host?: string; port?: string; 'local-defaults'?: boolean }): Promise<number> {
	const { createLogger, loadConfig, loadModelProviders, resolveSecrets, secretReader, startGateway } = await import(
		'@tykotech/gateway'
	);
	const { env, defaults } = await commandEnv(args, true);
	// Flags outrank the environment.
	if (args.host !== undefined) env.TTK_HOST = args.host;
	if (args.port !== undefined) env.TTK_PORT = args.port;

	// Secrets are resolved first and threaded by argument; they are never written back into the environment Chromium
	// will inherit.
	const read = secretReader();
	const secrets = await resolveSecrets({ env, readFile: read });
	const providerWarnings: string[] = [];
	const modelProviders = await loadModelProviders(env, { readFile: read, warn: (line) => providerWarnings.push(line) });
	const config = loadConfig(env, { secrets, modelProviders });
	const logger = createLogger({ level: config.logLevel, format: config.logFormat });
	logLocalDefaults(defaults, logger);
	for (const line of providerWarnings) logger.warn(line);

	const gateway = await startGateway({ config, version: VERSION, logger });

	let stopping = false;
	const stop = () => {
		if (stopping) {
			// A second signal means "now", not "again".
			logger.warn('second interrupt; exiting immediately');
			Deno.exit(130);
		}
		stopping = true;
		void gateway.shutdown();
	};
	Deno.addSignalListener('SIGINT', stop);
	if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', stop);

	await gateway.finished;
	return 0;
}

async function runStdio(args: { 'local-defaults'?: boolean }): Promise<number> {
	const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
	const {
		createBuildServer,
		probeEgressGrant,
		refreshToolAvailability,
		SecretStore,
		serverSessionAccess,
		SessionRegistry,
		watchResourceChanges,
	} = await import('@tykotech/mcp');
	const {
		createLogger,
		createExpansionServices,
		loadConfig,
		loadModelProviders,
		MemoryStore,
		ModelProvidersAdmin,
		openDataStore,
		resolveSecrets,
		secretReader,
		ServiceHealth,
	} = await import('@tykotech/gateway');
	const { SandboxClient } = await import('@tykotech/sandbox');

	const { env, defaults } = await commandEnv(args, false);
	const read = secretReader();
	const providerWarnings: string[] = [];
	const config = loadConfig(env, {
		secrets: await resolveSecrets({ env, readFile: read }),
		modelProviders: await loadModelProviders(env, { readFile: read, warn: (line) => providerWarnings.push(line) }),
	});
	// On stdio the protocol owns stdout, so every log line goes to stderr.
	const logger = createLogger({ level: config.logLevel, format: 'json', sink: 'stderr' });
	logLocalDefaults(defaults, logger);
	for (const line of providerWarnings) logger.warn(line);

	// A local agent on stdio reads the same database `serve` writes — providers added in the web app, keys and browser
	// secrets opened from the vault — so it needs the same TTK_DATA_DIR and TTK_DB_KEY_FILE.
	const data = await openDataStore(config, { logger });
	const providers = await ModelProvidersAdmin.load({ operator: config.modelProviders, store: data.store, logger });

	// One `SecretStore` for the registry's redaction and the tools' `secrets`, so the two can never diverge.
	const secrets = new SecretStore(data.secrets);
	const registry = new SessionRegistry({
		maxSessions: config.limits.maxSessions,
		sessionTtlMs: config.limits.sessionTtlMs,
		browserPath: config.browser.path,
		dataDir: config.dataDir,
		browserArgs: config.browser.args,
		headless: config.browser.headless,
		// `TTK_CHROMIUM_NO_SANDBOX`, as on the HTTP mount.
		chromiumSandbox: config.browser.chromiumSandbox,
		// The ledger gate reads the same list the tools gate on, and so does the browser.
		allowedDomains: config.allowedDomains,
		// `TTK_ALLOWED_DOMAINS_SCOPE`: which requests the registry holds to the list.
		allowedDomainsScope: config.allowedDomainsScope,
		// `TTK_SESSION_OWNERSHIP`. On stdio every call is the one anonymous-loopback owner, so `owner` changes only the
		// `default` session's id.
		ownership: config.sessionOwnership,
		// The configured secrets are redacted before the request log and the console ring cap their text — by the very
		// store the tools read (`core.secrets` below), built once.
		redact: (text) => secrets.redact(text),
		logger,
	});
	// The library is served on stdio too, on the same data directory and the same scopes.
	const library = await stdioLibrary(config);
	const core = {
		registry,
		version: VERSION,
		...(library === undefined ? {} : { library }),
		allowedDomains: config.allowedDomains,
		// stdio has no credential to carry a grant, so the anonymous scopes are all it holds.
		anonScopes: config.anonScopes,
		secrets,
		persistence: config.dataDir !== null,
		// `browser_head`'s egress is proven through the permissions API, never declared.
		egress: await probeEgressGrant(config.allowedDomains),
		logger,
		// `TTK_CONFIRM_DESTRUCTIVE`, as on HTTP. No `viewUrl`: stdio has no public URL, so `TTK_HUMAN_HANDOFF` is
		// ignored here and `browser_request_human` is never offered.
		confirmations: config.confirmDestructive,
	};
	const sandbox = config.expansion.sandbox === null ? undefined : new SandboxClient(config.expansion.sandbox);
	// The services' health is watched for the connection's life, as on HTTP; the pinned instance re-reads its tools on
	// each change.
	const health = new ServiceHealth({
		...(sandbox === undefined ? {} : { sandbox: () => sandbox.ready() }),
	}, { logger });
	await health.start();
	const services = health.watching ? { services: () => health.states() } : {};
	// `sandbox_clone` only while the sandbox's `/healthz` says it clones, as on HTTP.
	const clone = sandbox === undefined ? {} : { sandboxClone: () => sandbox.clone === true };
	// stdio composes the built-in model agent exactly as serve does; the providers in force (the database's) reach the
	// runtime by argument, and the anonymous principal needs `model:invoke` in TTK_ANON_SCOPES.
	const expansion = createExpansionServices(
		config.expansion,
		{ ...core, ...services, ...clone },
		sandbox,
		undefined,
		{
			modelProviders: providers.effective(),
			logger,
			// A local agent's memory is the same store `serve` uses (same owner on the credential-less mounts).
			...(data.store === null ? {} : {
				memory: new MemoryStore(data.store.db, { providers: () => providers.effective()?.providers ?? [] }),
			}),
		},
	);
	// The one instance pinned to this connection pushes the registry's changes, per the protocol era it serves.
	const build = createBuildServer({
		...core,
		...services,
		extraTools: expansion.tools,
		// `capabilities.tykotech.sandbox` on stdio too.
		...(sandbox === undefined ? {} : { sandboxBackend: () => sandbox.backend }),
		...clone,
		// Tool groups (`TTK_MCP_TOOL_GROUPS`): the one server pinned to this connection remembers the groups it opens.
		toolGroups: config.mcpToolGroups,
	});
	const watches: Array<{ close(): void }> = [];
	const handle = serveStdio(async (context) => {
		const server = await build(context) as import('@modelcontextprotocol/server').McpServer;
		watches.push(
			watchResourceChanges(
				server,
				registry,
				context.era === 'modern' ? 'modern' : 'legacy',
				serverSessionAccess(server),
			),
		);
		watches.push({ close: health.onChange(() => refreshToolAvailability(server)) });
		return server;
	});

	const shutdown = async () => {
		await expansion.close();
		for (const watch of watches) watch.close();
		health.stop();
		await handle.close().catch(() => {});
		await registry.shutdown('server-shutdown');
		data.close();
		Deno.exit(0);
	};
	Deno.addSignalListener('SIGINT', () => void shutdown());
	if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', () => void shutdown());

	// Block forever. `serveStdio` owns the transport, and its pending stdin read is what holds the runtime open; when
	// the client closes stdin that op completes, the event loop drains and the process exits on its own.
	await new Promise<never>(() => {});
	return 0;
}

/**
 * stdio's file share, on the data directory (none without one), held to the disk budget `TTK_DISK_BUDGET_MB` the
 * gateway's app gives its own — the share and the recordings together — so `file_write` and `browser_save_to_share`
 * over stdio cannot fill the volume the budget guards. stdio records nothing, but recordings a gateway left on the same
 * data directory fill the same volume, so they count.
 */
export async function stdioLibrary(
	config: { readonly dataDir: string | null; readonly limits: { readonly diskBudgetBytes: number } },
): Promise<import('@tykotech/mcp').LibraryStore | undefined> {
	if (config.dataDir === null) return undefined;
	const { LibraryStore } = await import('@tykotech/mcp');
	const { DiskBudget } = await import('@tykotech/gateway');
	const library = new LibraryStore({ dataDir: config.dataDir });
	await library.initialize();
	library.setWriteBudget(
		new DiskBudget({
			limitBytes: config.limits.diskBudgetBytes,
			roots: [library.share, `${config.dataDir}/recordings`],
		}),
	);
	return library;
}

/** Liveness probe, as a subcommand. */
async function runHealthcheck(): Promise<number> {
	let port = '8787';
	try {
		port = Deno.env.get('TTK_PORT') ?? '8787';
	} catch {
		// A narrower --allow-env than expected; the default is still right.
	}
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
		const body = await response.json() as { status?: string };
		if (!response.ok || body.status !== 'ok') {
			console.error(`unhealthy: ${response.status} ${JSON.stringify(body)}`);
			return 1;
		}
		return 0;
	} catch (cause) {
		console.error(`unhealthy: ${cause instanceof Error ? cause.message : String(cause)}`);
		return 1;
	}
}

async function runDoctor(
	args: {
		'new-key'?: string;
		scopes?: string;
		'new-key-set'?: string;
		'new-admin'?: string;
		password?: string;
		grant?: string;
		'data-dir'?: string;
		force?: boolean;
		'new-db-key'?: boolean;
		save?: boolean;
		'local-defaults'?: boolean;
	},
	show: CredentialStreams,
): Promise<number> {
	const { DEFAULT_SCOPES, generateAdminUser, generateApiKey, generateDbKey, loadConfig, SCOPES } = await import(
		'@tykotech/gateway'
	);
	const { ADMIN_SCOPES } = await import('@tykotech/mcp');

	/** The scopes a minted credential carries: DEFAULT_SCOPES unless `--scopes` names others from the vocabulary. */
	const requestedScopes = (): typeof DEFAULT_SCOPES | null => {
		const requested = args.scopes === undefined
			? DEFAULT_SCOPES
			: args.scopes.split(',').map((s) => s.trim()).filter((s) => s !== '');
		return knownScopes(requested, SCOPES) ? requested as typeof DEFAULT_SCOPES : null;
	};

	const grantUser = args.grant;
	if (grantUser !== undefined && grantUser !== '') return await runGrant(grantUser, args);

	if (args['new-db-key'] === true) {
		const written = await writeSecretFile(DB_KEY_FILE, `${generateDbKey()}\n`, { force: args.force === true });
		if (written === 'exists') {
			console.error(`${DB_KEY_FILE} exists; --force replaces it, and every secret sealed with it becomes unreadable`);
			return 1;
		}
		console.log(`Wrote ${DB_KEY_FILE}. Set TTK_DB_KEY_FILE to it; keep it off the data volume and backed up.`);
		return 0;
	}

	const adminUsername = args['new-admin'];
	if (adminUsername !== undefined && adminUsername !== '') {
		// Validated before anything is generated or written: a typo must never replace a working admin record.
		const named = args.scopes === undefined ? null : requestedScopes();
		if (args.scopes !== undefined && named === null) return 1;
		// An existing record is never replaced without --force.
		if (args.force !== true && await exists(ADMIN_USER_FILE)) {
			console.error(`${ADMIN_USER_FILE} exists; pass --force to replace it`);
			return 1;
		}
		// `admin` is not part of the default grant, so an administrator record names it — the default grant plus
		// `admin` without --scopes, and `admin` added to whatever --scopes names.
		const adminScopes = named === null ? [...ADMIN_SCOPES] : [...new Set([...named, 'admin' as const])];
		const { record, password } = await generateAdminUser(adminUsername, args.password, adminScopes);
		console.log('====================================================');
		console.log('Admin User Generated Successfully');
		console.log('====================================================');
		console.log(`Username: ${record.username}`);
		// A password given with --password is the operator's already and is not repeated. A generated one is shown
		// once, on the stream itself (see CredentialStreams).
		if (args.password === undefined) show.out(`Password: ${password}\n`);
		else console.log('Password: the one given with --password (not repeated here)');
		console.log('====================================================\n');

		try {
			await writeSecretFile(ADMIN_USER_FILE, JSON.stringify(record, null, 2) + '\n', { force: true });
			console.log(`Saved admin user record to ${ADMIN_USER_FILE}`);
		} catch (cause) {
			console.log(`Could not write to ${ADMIN_USER_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`);
			console.log(`Add this record to ${ADMIN_USER_FILE}:\n`);
			console.log(JSON.stringify(record, null, 2));
		}
		return 0;
	}

	const keySetPrefix = args['new-key-set'];
	if (keySetPrefix !== undefined && keySetPrefix !== '') {
		// One key per scope, each holding exactly that one scope.
		const records: unknown[] = [];
		console.error('New API keys (each shown once — store them now):\n');
		for (const scope of SCOPES) {
			const id = `${keySetPrefix}-${scope.replace(/:/g, '-')}`;
			const { key, record } = await generateApiKey(id, [scope]);
			console.error(`  ${id}`);
			show.err(`    ${key}\n\n`);
			records.push(record);
		}
		// The raw keys go to stderr, the hashed records to stdout as one array, so `doctor --new-key-set web >
		// keys.json` yields a file ready for TTK_API_KEYS_FILE without the secrets leaking into it.
		console.log(JSON.stringify(records, null, 2));
		return 0;
	}

	const keyId = args['new-key'];
	if (keyId !== undefined && keyId !== '') {
		// The record names its scopes, so the verifier's `DEFAULT_SCOPES` fallback never applies: without --scopes it is
		// given the default grant explicitly.
		const requested = requestedScopes();
		if (requested === null) return 1;
		const { key, record } = await generateApiKey(keyId, requested);
		console.log('New API key (shown once — store it now):\n');
		show.out(`  ${key}\n\n`);
		if (args.save !== true) {
			console.log(
				'Add this record to TTK_API_KEYS (or the file TTK_API_KEYS_FILE points at), or run again with --save:\n',
			);
			console.log(JSON.stringify([record], null, 2));
			return 0;
		}
		// The record list `setup` wrote, with this id's record replaced or appended — rewritten in place, not replaced:
		// the compose secret is a bind mount of this very file, so a running gateway's key-file watcher sees the new
		// record without a restart, where a new file would leave the container reading the old one until recreated.
		const records = await readKeyRecords(API_KEYS_FILE);
		if (records === null) {
			console.error(`${API_KEYS_FILE} is not a JSON list of key records; fix it or run setup --only api-key --force`);
			return 1;
		}
		const kept = records.filter((entry) => (entry as { id?: unknown } | null)?.id !== keyId);
		const text = `${JSON.stringify([...kept, record], null, 2)}\n`;
		if (await exists(API_KEYS_FILE)) {
			await Deno.writeTextFile(API_KEYS_FILE, text);
			await repairSecretMode(API_KEYS_FILE);
		} else await writeSecretFile(API_KEYS_FILE, text, { force: false });
		console.log(
			`${kept.length < records.length ? 'Replaced' : 'Added'} key ${keyId} in ${API_KEYS_FILE} (${
				requested.join(', ')
			}).`,
		);
		return 0;
	}

	console.log(`tykotech-mcp ${VERSION}`);
	console.log(`deno            ${Deno.version.deno}`);
	console.log(`platform        ${Deno.build.os}/${Deno.build.arch}`);

	let ok = true;
	try {
		const {
			configuredAccounts,
			configuredSecretRefs,
			describeSecretRefs,
			databaseDoctorLine,
			loadModelProviders,
			providerNetHost,
			resolveSecrets,
			secretReader,
		} = await import('@tykotech/gateway');
		// With the task's `--local-defaults`, the configuration `dev` would run with.
		const { env, defaults } = await commandEnv(args, true);
		if (defaults !== null) {
			const { info, warn } = localDefaultsLines(defaults);
			for (const line of info) console.log(line);
			for (const line of warn) console.log(`warning: ${line}`);
		}
		// Every `*_REF` and provider setting is checked, but no provider is contacted and no token read — this task
		// holds no net grant, and a diagnostic must not be the thing that pulls a secret.
		const read = secretReader();
		// The providers file is parsed exactly as `serve` parses it (a key file is read, never printed), so a refused
		// entry is reported here with its field rather than by a failed start.
		const providerWarnings: string[] = [];
		const config = loadConfig(env, {
			secrets: await resolveSecrets({ env, readFile: read, contactProviders: false }),
			modelProviders: await loadModelProviders(env, {
				readFile: read,
				warn: (line) => providerWarnings.push(line),
			}),
		});
		const refs = configuredSecretRefs(env);
		const keysRef = refs.find((ref) => ref.variable === 'TTK_API_KEYS_REF');
		console.log(`bind            ${config.host}:${config.port}`);
		console.log(`public url      ${redactedUrl(config.publicUrl)}`);
		// Counted rather than read: the number on this line is derived from no value of the credential list, which is
		// how the clear-text-logging analysis (CodeQL) can tell that nothing of a key record reaches the output.
		let keyRecords = 0;
		for (const _record of config.apiKeys) keyRecords += 1;
		console.log(
			`api keys        ${keysRef === undefined ? keyRecords : `from ${keysRef.provider} (not contacted)`}`,
		);
		console.log(
			`allowed domains ${config.allowedDomains.length === 0 ? '(unrestricted)' : config.allowedDomains.join(', ')}`,
		);
		console.log(`scope           ${config.allowedDomainsScope}`);
		// Under a proxy the browser bypasses the resolver layer, and no CDP control pauses a WebSocket handshake.
		if (
			config.allowedDomainsScope === 'all' &&
			config.browser.args.some((arg) => /^--proxy-(?:server|pac-url|auto-detect)(?:=|$)/.test(arg))
		) {
			console.log(
				'warning: under a proxy, WebSockets to off-list hosts are not refused (no CDP control); HTTP requests still are',
			);
		}
		// An entry that carries a scheme or a port would match nothing, so `loadConfig` refuses one — an operator finds
		// it here, before a restart finds it one 403 at a time.
		console.log(`allowed origins ${config.allowedOrigins.join(', ')} (compared as bare hostnames)`);
		const secretsRef = refs.find((ref) => ref.variable === 'TTK_SECRETS_REF');
		console.log(
			`secrets         ${
				secretsRef !== undefined
					? `from ${secretsRef.provider} (not contacted)`
					: config.secrets.length === 0
					? 'none'
					: config.secrets.map((s) => s.name).join(', ')
			}`,
		);
		for (const line of describeSecretRefs(env)) console.log(line);
		console.log(`data dir        ${config.dataDir ?? '(ephemeral sessions)'}`);
		console.log(`ffmpeg          ${config.ffmpeg ?? '(recording disabled)'}`);
		console.log(`coding sandbox  ${config.expansion.sandbox?.url ?? 'disabled'}`);
		console.log(`A2A peers       ${config.expansion.peers.map((peer) => peer.id).join(', ') || 'none'}`);
		// Each provider as `id (kind, host:port, N models, key: source)`, the default, and the parser's warnings.
		const providers = config.modelProviders?.providers ?? [];
		console.log(
			providers.length === 0
				? 'model providers none'
				: `model providers ${
					providers.map((p) =>
						`${p.id} (${p.kind}, ${providerNetHost(p)}, ${p.models.length} models, key: ${p.keySource})`
					)
						.join(', ')
				}; default: ${config.modelProviders?.default ?? 'none'}`,
		);
		if (providers.length > 0) { for (const line of providerWarnings) console.log(`warning: ${line}`); }
		// The providers in force live in the database (the file above is its seed); counts only, no key opened.
		const storeLine = databaseDoctorLine(config.dataDir, config.dbKey !== null);
		if (storeLine !== null) console.log(storeLine);
		console.log(`headless        ${config.browser.headless}`);
		// The browser is resolved here the way the server will resolve it at launch, so a missing or unreadable
		// Chromium is found by `doctor` rather than by the first tool call.
		console.log(`browser         ${await describeBrowser(config.browser.path ?? undefined)}`);
		// The same count the bind policy makes — an account (the seed, or a readable users.json) is a credential.
		const accounts = configuredAccounts(config.dataDir, config.adminUser);
		console.log(`accounts        ${accounts}`);
		if (config.apiKeys.length === 0 && keysRef === undefined && accounts === 0) {
			console.log('\nwarning: no credentials configured — only loopback development mode will start.');
		}
	} catch (cause) {
		ok = false;
		console.error(`\nconfiguration error: ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	return ok ? 0 : 1;
}

/** Where `setup` and `doctor` write the deployment's files, as the compose files mount them. */
const SECRETS_DIR = 'secrets';
const DB_KEY_FILE = `${SECRETS_DIR}/ttk_db_key`;
const ADMIN_USER_FILE = `${SECRETS_DIR}/ttk_admin_user.json`;
const API_KEYS_FILE = `${SECRETS_DIR}/ttk_api_keys.json`;
const BROWSER_SECRETS_FILE = `${SECRETS_DIR}/ttk_secrets.json`;
const GIT_REMOTES_FILE = `${SECRETS_DIR}/ttk_git_remotes`;
const SANDBOX_TOKEN_FILE = `${SECRETS_DIR}/ttk_sandbox_token`;
const ENV_FILE = '.env';
/** The checkout's own data directory: the one `dev` and `stdio` are granted to write. */
const LOCAL_DATA_DIR = 'data';

/** What {@linkcode localDefaults} did. */
export interface LocalDefaults {
	/** A copy of the input environment with each default filled in; the input itself is not changed. */
	readonly env: Record<string, string | undefined>;
	/** `NAME=path` for each default applied: paths only, since no file is read here. */
	readonly applied: readonly string[];
	/** Whether a database key is in hand — `setup`'s, or a key file the operator named; without one, say to run setup. */
	readonly setUp: boolean;
}

/**
 * `--local-defaults`, which the checkout's own tasks pass (`dev`, `stdio`, `doctor`, `seed`), so they find what `deno
 * task setup` wrote without an export.
 */
export async function localDefaults(
	input: Readonly<Record<string, string | undefined>>,
	options: { readonly apiKeys: boolean },
	present: (path: string) => Promise<boolean> = exists,
): Promise<LocalDefaults> {
	const env: Record<string, string | undefined> = { ...input };
	const applied: string[] = [];
	const unset = (...names: string[]): boolean => names.every((name) => !env[name]?.trim());
	const apply = (variable: string, path: string): void => {
		env[variable] = path;
		applied.push(`${variable}=${path}`);
	};
	const offer = async (variable: string, path: string, ...others: string[]): Promise<void> => {
		if (unset(variable, ...others) && await present(path)) apply(variable, path);
	};
	const keyed = await present(DB_KEY_FILE);
	const setUp = keyed || !unset('TTK_DB_KEY_FILE');
	if (keyed && unset('TTK_DATA_DIR')) apply('TTK_DATA_DIR', LOCAL_DATA_DIR);
	await offer('TTK_DB_KEY_FILE', DB_KEY_FILE);
	if (options.apiKeys) await offer('TTK_API_KEYS_FILE', API_KEYS_FILE, 'TTK_API_KEYS', 'TTK_API_KEYS_REF');
	await offer('TTK_SECRETS_FILE', BROWSER_SECRETS_FILE, 'TTK_SECRETS', 'TTK_SECRETS_REF');
	if (!unset('TTK_SANDBOX_URL')) await offer('TTK_SANDBOX_TOKEN_FILE', SANDBOX_TOKEN_FILE, 'TTK_SANDBOX_TOKEN');
	return { env, applied, setUp };
}

/** Logs {@linkcode localDefaultsLines} once the server has its logger; nothing when the task passed no flag. */
function logLocalDefaults(
	defaults: LocalDefaults | null,
	logger: { info(message: string): void; warn(message: string): void },
): void {
	if (defaults === null) return;
	const { info, warn } = localDefaultsLines(defaults);
	for (const line of info) logger.info(line);
	for (const line of warn) logger.warn(line);
}

/** The lines a server logs about {@linkcode localDefaults}: what it applied, and how to get the files without them. */
export function localDefaultsLines(defaults: LocalDefaults): { info: string[]; warn: string[] } {
	return {
		info: defaults.applied.length === 0 ? [] : [`local defaults from deno task setup: ${defaults.applied.join(', ')}`],
		warn: defaults.setUp ? [] : [
			`${DB_KEY_FILE} not found, so this checkout's secrets are not used: run deno task setup to create the ` +
			'database key, administrator and API key this task picks up',
		],
	};
}

/** The modes of `secrets/` and of every file `setup` and `doctor` write in it. */
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o644;

/**
 * The `.env` `setup` writes: the few settings a typical deployment changes, in plain words. Every other value the
 * compose files interpolate keeps its default there and is documented in docs/reference/environment-variables.md.
 */
export const ENV_TEMPLATE =
	`# Multi-MCP settings for Docker Compose. Change a value, save, then run the start script again
# (or \`docker compose up -d\`). Every other setting: docs/reference/environment-variables.md.

# Which network address the web app listens on. 127.0.0.1 = this computer only; 0.0.0.0 = your whole network too.
TTK_BIND=127.0.0.1

# The address you type in the browser. For your network: http://<this computer's address>:8787
TTK_PUBLIC_URL=http://127.0.0.1:8787

# Websites the browser may open, comma-separated (example.com,docs.example.com). Empty = any website.
TTK_ALLOWED_DOMAINS=

# Memory for the web app and every browser it runs (for example 1536m or 4g).
TTK_GATEWAY_MEMORY=1536m
`;

/** Whether `path` exists (a stat needs only the directory's search right, so a file another uid owns still counts). */
async function exists(path: string): Promise<boolean> {
	try {
		await Deno.lstat(path);
		return true;
	} catch (cause) {
		if (cause instanceof Deno.errors.NotFound) return false;
		throw cause;
	}
}

/**
 * Creates `secrets/` if needed and makes it `0700` (see {@linkcode SECRETS_DIR_MODE}); `false` when the mode could not
 * be set (a directory another account owns), which `setup` reports. Windows has no POSIX modes.
 */
async function ensureSecretsDir(dir = SECRETS_DIR): Promise<boolean> {
	await Deno.mkdir(dir, { recursive: true });
	if (Deno.build.os === 'windows') return true;
	try {
		await Deno.chmod(dir, SECRETS_DIR_MODE);
		return true;
	} catch {
		return false;
	}
}

/**
 * Writes a file in `secrets/` with {@linkcode SECRET_FILE_MODE}, never over an existing one unless `force` — the rule
 * for every file `setup` and `doctor` create.
 */
async function writeSecretFile(path: string, text: string, options: { force: boolean }): Promise<'written' | 'exists'> {
	if (await exists(path)) {
		if (!options.force) return 'exists';
		await Deno.remove(path);
	}
	const slash = path.lastIndexOf('/');
	if (slash > 0) await ensureSecretsDir(path.slice(0, slash));
	await Deno.writeTextFile(path, text, { createNew: true, mode: SECRET_FILE_MODE });
	if (Deno.build.os !== 'windows') await Deno.chmod(path, SECRET_FILE_MODE);
	return 'written';
}

/**
 * Gives a kept file in `secrets/` {@linkcode SECRET_FILE_MODE}: one saved private (`0600` — an editor or a copy under a
 * `077` umask — which the containers cannot read) is repaired by running `setup` again.
 */
async function repairSecretMode(path: string): Promise<'repaired' | 'unchanged' | 'foreign'> {
	if (Deno.build.os === 'windows') return 'unchanged';
	const info = await Deno.lstat(path);
	if (!info.isFile || info.mode === null || (info.mode & 0o777) === SECRET_FILE_MODE) return 'unchanged';
	try {
		await Deno.chmod(path, SECRET_FILE_MODE);
		return 'repaired';
	} catch {
		return 'foreign';
	}
}

/** The record list in an API keys file: `[]` when the file is absent, `null` when it holds anything but a list. */
async function readKeyRecords(path: string): Promise<unknown[] | null> {
	let text: string;
	try {
		text = await Deno.readTextFile(path);
	} catch (cause) {
		if (cause instanceof Deno.errors.NotFound) return [];
		throw cause;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** A bearer for a private service: 32 random bytes as 64 hex characters (the services' floor is 32 characters). */
function serviceToken(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The `--only` list, validated; `null` (all units) when absent, `undefined` when it names an unknown one. */
export function setupUnits(only: string | undefined): SetupUnit[] | null | undefined {
	if (only === undefined) return null;
	const named = csv(only);
	if (named.length === 0 || named.some((unit) => !(SETUP_UNITS as readonly string[]).includes(unit))) return undefined;
	return named as SetupUnit[];
}

/**
 * `setup`: creates every file a shipped compose file mounts — the database key, the administrator, the `client` API
 * key, the browser-secrets and git-remotes placeholders, the sandbox token the gateway and the sandbox share — and
 * `.env`, skipping each file that exists.
 */
export async function runSetup(
	args: { force?: boolean; admin?: string; 'key-id'?: string; scopes?: string; only?: string },
	root = '.',
	apparmor?: AppArmorHost,
	show: CredentialStreams = CREDENTIAL_STREAMS,
): Promise<number> {
	const { generateAdminUser, generateApiKey, generateDbKey, SCOPES } = await import('@tykotech/gateway');
	const { STACK_SCOPES } = await import('@tykotech/mcp');
	type Scopes = Parameters<typeof generateApiKey>[1];
	const units = setupUnits(args.only);
	if (units === undefined) {
		console.error(`--only takes a comma-separated list of: ${SETUP_UNITS.join(', ')}`);
		return 1;
	}
	const scopes = args.scopes === undefined ? [...STACK_SCOPES] : csv(args.scopes);
	if (!knownScopes(scopes, SCOPES)) return 1;
	const selected = (unit: SetupUnit): boolean => units === null || units.includes(unit);
	/** For a selected unit: `--force` replaces a generated file, and one you fill in yourself only when `--only` names it. */
	const replace = (yours = false): boolean => args.force === true && (!yours || units !== null);

	/** Where a file of the checkout is when `root` is not the working directory (the unit test's scratch folder). */
	const at = (path: string): string => root === '.' ? path : `${root}/${path}`;
	const report: string[] = [];
	const once: string[] = [];
	const problems: string[] = [];
	const mark = async (path: string, outcome: 'written' | 'exists'): Promise<void> => {
		if (outcome === 'written') {
			report.push(`  created   ${path}`);
			return;
		}
		const mode = path.startsWith(`${SECRETS_DIR}/`) ? await repairSecretMode(at(path)) : 'unchanged';
		report.push(`  ${mode === 'repaired' ? 'repaired' : 'kept    '}  ${path}`);
		if (mode === 'foreign') {
			problems.push(`${path} belongs to another account, so its mode stays; the containers may not read it`);
		}
	};
	/** One file of a unit: written unless it exists and is not being replaced. */
	const file = async (unit: SetupUnit, path: string, make: () => Promise<string> | string, yours = false) => {
		if (!selected(unit)) return;
		const force = replace(yours);
		if (!force && await exists(at(path))) return await mark(path, 'exists');
		await mark(path, await writeSecretFile(at(path), await make(), { force }));
	};

	if (!await ensureSecretsDir(at(SECRETS_DIR))) {
		problems.push(`${SECRETS_DIR}/ is not yours, so it could not be made 0700; its files are readable to others`);
	}

	await file('db-key', DB_KEY_FILE, () => `${generateDbKey()}\n`);
	await file('admin', ADMIN_USER_FILE, async () => {
		const { record, password } = await generateAdminUser(args.admin ?? 'admin', undefined, [...STACK_SCOPES, 'admin']);
		once.push(`  admin user  ${record.username}`, `  password    ${password}`);
		return `${JSON.stringify(record, null, 2)}\n`;
	});
	await file('api-key', API_KEYS_FILE, async () => {
		const id = args['key-id'] ?? 'client';
		const { key, record } = await generateApiKey(id, scopes as Scopes);
		once.push(`  api key     ${key}`, `              id ${id}; ${scopes.join(', ')}`);
		return `${JSON.stringify([record], null, 2)}\n`;
	});
	await file('browser-secrets', BROWSER_SECRETS_FILE, () => '{}\n', true);
	await file('git-remotes', GIT_REMOTES_FILE, () => '[]\n', true);
	// The sandbox's bearer, shared by the gateway and the sandbox: `docker-compose.yml` mounts it read-only into both
	// at the image's default `/run/secrets/ttk_sandbox_token`.
	await file('sandbox-token', SANDBOX_TOKEN_FILE, () => `${serviceToken()}\n`);
	if (selected('env')) {
		if (replace() || !await exists(at(ENV_FILE))) {
			if (await exists(at(ENV_FILE))) await Deno.remove(at(ENV_FILE));
			await Deno.writeTextFile(at(ENV_FILE), ENV_TEMPLATE, { createNew: true });
			await mark(ENV_FILE, 'written');
		} else await mark(ENV_FILE, 'exists');
	}

	console.log('setup:');
	for (const line of report) console.log(line);
	if (once.length > 0) {
		console.log('\nShown once, stored only as hashes — save them now:');
		show.out(`${once.join('\n')}\n`);
	}
	for (const line of problems) console.log(`\nwarning: ${line}`);
	// After the credentials above are on screen: a Ctrl-C at sudo's prompt ends setup, and they are shown only once.
	if (selected('apparmor')) {
		const { ensureSandboxProfile, profileCommands, SANDBOX_PROFILE, shellLine, systemAppArmor } = await import(
			'./apparmor.ts'
		);
		const { resolve } = await import('@std/path');
		const source = resolve(at(SANDBOX_PROFILE.source));
		const outcome = await ensureSandboxProfile(source, apparmor ?? systemAppArmor, {
			force: replace(),
			announce: (line) => console.log(`\napparmor: ${line}`),
		});
		if (outcome.status === 'current') console.log(`\napparmor: ${SANDBOX_PROFILE.target} is current`);
		if (outcome.status === 'installed') console.log(`apparmor: ${SANDBOX_PROFILE.target} is installed and loaded`);
		if (outcome.status === 'failed') {
			const [install, load] = profileCommands(source);
			console.error(
				`\nerror: AppArmor: the coding sandbox's profile could not be installed: ${outcome.reason}.\n` +
					"This host runs AppArmor, and Docker's default AppArmor profile denies the mounts the sandbox's bubblewrap\n" +
					'cages need: until the profile is loaded, Docker refuses the sandbox ("unable to apply apparmor profile")\n' +
					'and the gateway runs without the sandbox tools. Install it by hand, then docker compose up -d --build:\n\n' +
					`  sudo ${shellLine(install)}\n  sudo ${shellLine(load)}\n\n` +
					'Everything else setup does is done; running setup again retries only this step.',
			);
			return 1;
		}
	}
	console.log('\nNext: docker compose up -d --build, then open the TTK_PUBLIC_URL in .env and sign in.');
	console.log('Every file above is described in secrets/README.md.');
	return 0;
}

/**
 * `seed`: copies the providers file (keys sealed) and `TTK_SECRETS(_FILE)` into the database — only into an empty,
 * never-seeded one, unless `--force`. A running server keeps what it loaded until it restarts.
 */
async function runSeed(args: { force?: boolean; only?: string; 'local-defaults'?: boolean }): Promise<number> {
	const { describeSeed, loadConfig, loadModelProviders, openDataStore, resolveSecrets, SEED_TARGETS, secretReader } =
		await import('@tykotech/gateway');
	const only = args.only === undefined ? undefined : csv(args.only);
	const unknown = (only ?? []).filter((target) => !(SEED_TARGETS as readonly string[]).includes(target));
	if (unknown.length > 0) {
		console.error(`unknown seed targets: ${unknown.join(', ')} (valid: ${SEED_TARGETS.join(', ')})`);
		return 1;
	}
	const { env, defaults } = await commandEnv(args, false);
	for (const line of defaults === null ? [] : localDefaultsLines(defaults).info) console.log(line);
	const read = secretReader();
	// A secret manager reference is never seeded (it stays the source), so no provider is contacted for one.
	const config = loadConfig(env, {
		secrets: await resolveSecrets({ env, readFile: read, contactProviders: false }),
		modelProviders: await loadModelProviders(env, { readFile: read }),
	});
	if (config.dataDir === null) {
		console.error('seed needs TTK_DATA_DIR: the database lives there');
		return 1;
	}
	const opened = await openDataStore(config, {
		seed: {
			force: args.force === true,
			...(only === undefined ? {} : { only: only as typeof SEED_TARGETS[number][] }),
		},
	});
	try {
		for (const result of opened.seeded) console.log(describeSeed(result));
	} finally {
		opened.close();
	}
	if (args.force === true) console.log('A running server keeps what it loaded; restart it to use the database now.');
	return 0;
}

/**
 * `doctor --grant <user> --scopes <list>` — the offline remedy for a store in which no enabled account holds `admin`
 * (the startup warning names it), so nobody can reach the Users screen to fix it.
 */
async function runGrant(username: string, args: { scopes?: string; 'data-dir'?: string }): Promise<number> {
	const { grantScopesInFile, processEnv, SCOPES, UserStoreError } = await import('@tykotech/gateway');
	if (args.scopes === undefined) {
		console.error('--grant needs --scopes <list>, for example --scopes mcp:invoke,view:watch,view:control,admin');
		return 1;
	}
	const scopes = csv(args.scopes);
	if (!knownScopes(scopes, SCOPES)) return 1;
	try {
		const dataDir = args['data-dir']?.trim() || processEnv(['TTK_DATA_DIR']).TTK_DATA_DIR?.trim() || '';
		if (dataDir === '') {
			console.error('--grant needs the data directory: set TTK_DATA_DIR or pass --data-dir <path>');
			return 1;
		}
		const { user, migrated, path } = await grantScopesInFile(dataDir, username, scopes);
		console.log(`granted ${user.username}: ${user.scopes.join(', ')} (${path})`);
		if (migrated > 0) console.log(`upgraded ${migrated} other account(s) to explicit scopes`);
		console.log('start the gateway now; a gateway that was running while this ran must be restarted');
		return 0;
	} catch (cause) {
		if (cause instanceof UserStoreError) {
			console.error(`refused: ${cause.message}`);
			return 1;
		}
		console.error(`--grant failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		return 1;
	}
}

if (import.meta.main) Deno.exit(await main(Deno.args));

/** What `doctor` says about the browser. */
async function describeBrowser(configured: string | undefined): Promise<string> {
	const { BrowserNotFoundError, classifyDiscoveryFailure, discoverBrowserExecutable } = await import('@tykotech/cdp');
	if (configured !== undefined) {
		try {
			const info = await Deno.stat(configured);
			return info.isFile ? `${configured} (configured)` : `${configured} (configured, but not a file)`;
		} catch (cause) {
			return cause instanceof Deno.errors.PermissionDenied
				? `${configured} (configured; this check may not read it)`
				: `${configured} (configured, but missing)`;
		}
	}
	try {
		const found = await discoverBrowserExecutable();
		return `${found.path} (discovered via ${found.source})`;
	} catch (cause) {
		if (cause instanceof BrowserNotFoundError) {
			const failure = classifyDiscoveryFailure(cause.probes);
			return failure.kind === 'not-installed'
				? 'not found — install Chromium or set TTK_BROWSER_PATH'
				: 'not found — the search was not permitted to read every candidate; set TTK_BROWSER_PATH';
		}
		return `not resolved (${cause instanceof Error ? cause.message : String(cause)})`;
	}
}
