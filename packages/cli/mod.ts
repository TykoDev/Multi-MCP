/**
 * `@tykotech/cli` — the composition root.
 *
 * Subcommands: `serve` (HTTP gateway), `stdio` (MCP over stdio), `acp` (Agent
 * Client Protocol over stdio, through the agent bridge), `setup` (create the
 * deployment's secrets and `.env`), `seed` (copy the providers file and browser
 * secrets into the database, D-154), `doctor` (diagnostics, key and account
 * generation), `healthcheck` (probe a running server on loopback), `version`.
 * `USAGE` below is the full reference.
 *
 * The gateway and MCP layers are imported dynamically so an unused surface
 * stays out of the module graph — `stdio` never loads Hono, and `serve` never
 * loads the stdio transport.
 *
 * D-137 (design §2.3, F5): the only static imports are `@std/cli/parse-args` and the import-free `./otel_gate.ts`,
 * and the OpenTelemetry egress gate runs at module top level, before `main()`, for every subcommand — so nothing that
 * could be exported (a span, a log, a console line) happens before a refusal. `tests/unit/serve_tasks_test.ts` holds
 * the static graph to those two.
 */
import { parseArgs } from '@std/cli/parse-args';
import { checkOtelEgress, enforceOtelEgress, otelDoctorLines, processOtelInputs } from './otel_gate.ts';

/** The six `OTEL_*` names the gate reads and every launcher grants (D-137); rule T5's copy is pinned equal to it. */
export { OTEL_GATE_ENV_NAMES } from './otel_gate.ts';

export const VERSION = '0.2.0';

const USAGE = `tykotech-mcp ${VERSION}

USAGE:
  tykotech-mcp <command> [options]

COMMANDS:
  serve            Run the HTTP gateway (MCP over Streamable HTTP + live view)
  stdio            Run MCP over stdio for a local client
  acp              Run Agent Client Protocol over stdio through the configured agent bridge
  setup            Create missing secrets (API key, admin, database key) and .env; --force replaces them
  seed             Copy the providers file and browser secrets into the database; --force replaces
  doctor           Diagnose the environment; generate an API key
  healthcheck      Probe a running server on loopback; exit 0 when healthy
  version          Print the version

SERVE OPTIONS:
  --host <addr>    Bind address        (default 127.0.0.1, env TTK_HOST)
  --port <n>       Bind port           (default 8787, env TTK_PORT)

SETUP OPTIONS:
  --force, -Force      Replace files that exist (a new database key makes stored secrets unreadable)
  --admin <user>       Administrator username (default admin)
  --key-id <id>        API key id (default client); --scopes as for doctor --new-key

SEED OPTIONS:
  --force, -Force      Replace what the database holds with the sources (default: only an empty, never-seeded one)
  --only <list>        providers, secrets (default both)

DOCTOR OPTIONS:
  --new-key <id>       Print a new API key and its hashed record
  --scopes <list>      Comma-separated scopes for --new-key, --new-admin or --grant
                       (--new-key default: the default grant; --new-admin always adds admin)
  --new-key-set <pfx>  Mint one single-scope key per scope in the vocabulary (ids <pfx>-<scope>)
  --new-admin <user>   Generate a new admin user record with password and save to secrets/ (--force to replace)
  --password <pass>    Optional explicit password for --new-admin
  --new-db-key         Write a new database key to secrets/ttk_db_key (--force to replace: stored secrets are lost)
  --grant <user>       Set an account's scopes to --scopes, offline: in <TTK_DATA_DIR>/users.json, or in the
                       cluster store when TTK_CLUSTER_KV is set (run with --unstable-kv)
  --data-dir <path>    The data directory for --grant (default: TTK_DATA_DIR)

Configuration is read from TTK_* environment variables; see docs/reference/environment-variables.md.
`;

/** The command line, parsed; `-Force` (the PowerShell spelling the owner asked for, D-154) is `--force`. */
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
		boolean: ['help', 'force', 'new-db-key'],
		alias: { h: 'help' },
	});
}

type CliArgs = ReturnType<typeof parseCli>;

export async function main(argv: string[]): Promise<number> {
	const args = parseCli(argv);
	const command = String(args._[0] ?? '');

	if (args.help || command === '' || command === 'help') {
		console.log(USAGE);
		return command === '' && !args.help ? 1 : 0;
	}

	try {
		return await dispatch(command, args);
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

/** Errors whose message is written for the operator (D-154 adds the database, vault and seed refusals). */
const OPERATOR_ERRORS = new Set(['ConfigError', 'SecretError', 'SeedError', 'VaultError', 'DatabaseError']);

async function dispatch(command: string, args: CliArgs): Promise<number> {
	switch (command) {
		case 'version':
			console.log(VERSION);
			return 0;
		case 'serve':
			return await runServe(args);
		case 'stdio':
			return await runStdio();
		case 'acp':
			return await runAcp();
		case 'setup':
			return await runSetup(args);
		case 'seed':
			return await runSeed(args);
		case 'doctor':
			return await runDoctor(args);
		case 'healthcheck':
			return await runHealthcheck();
		default:
			console.error(`unknown command: ${command}\n`);
			console.log(USAGE);
			return 1;
	}
}

async function runServe(args: { host?: string; port?: string }): Promise<number> {
	const { ENV_NAMES, createLogger, loadConfig, processEnv, startGateway } = await import('@tykotech/gateway');
	const { loadModelProviders, resolveSecrets, secretReader } = await import('@tykotech/gateway');

	const env: Record<string, string | undefined> = { ...processEnv(ENV_NAMES) };
	// Flags outrank the environment.
	if (args.host !== undefined) env.TTK_HOST = args.host;
	if (args.port !== undefined) env.TTK_PORT = args.port;

	// Secrets are resolved first and threaded by argument; they are never
	// written back into the environment Chromium will inherit. The providers
	// file (D-143) goes through the same reader and the same argument path; a
	// refused file throws here, before anything listens, naming the field.
	const read = secretReader();
	const secrets = await resolveSecrets({ env, readFile: read });
	const providerWarnings: string[] = [];
	const modelProviders = await loadModelProviders(env, { readFile: read, warn: (line) => providerWarnings.push(line) });
	const config = loadConfig(env, { secrets, modelProviders });
	const logger = createLogger({ level: config.logLevel, format: config.logFormat });
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

async function runStdio(): Promise<number> {
	const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
	const {
		createBuildServer,
		LibraryStore,
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
		createTelemetry,
		ENV_NAMES,
		loadConfig,
		loadModelProviders,
		MemoryStore,
		ModelProvidersAdmin,
		openDataStore,
		processEnv,
		resolveSecrets,
		secretReader,
	} = await import('@tykotech/gateway');
	const { SandboxClient } = await import('@tykotech/sandbox');

	const env = processEnv(ENV_NAMES);
	const read = secretReader();
	const providerWarnings: string[] = [];
	const config = loadConfig(env, {
		secrets: await resolveSecrets({ env, readFile: read }),
		modelProviders: await loadModelProviders(env, { readFile: read, warn: (line) => providerWarnings.push(line) }),
	});
	// On stdio the protocol owns stdout, so every log line goes to stderr.
	const logger = createLogger({ level: config.logLevel, format: 'json', sink: 'stderr' });
	for (const line of providerWarnings) logger.warn(line);

	// D-154: a local agent on stdio reads the same database `serve` writes — providers added in the web app, keys and
	// browser secrets opened from the vault — so it needs the same TTK_DATA_DIR and TTK_DB_KEY_FILE. SQLite's WAL lets
	// both processes hold it at once. Without a data directory the files are used as they are.
	const data = await openDataStore(config, { logger });
	const providers = await ModelProvidersAdmin.load({ operator: config.modelProviders, store: data.store, logger });

	// NF-3 (design §2.8, F16, AC26): one `SecretStore` for the registry's redaction and the tools' `secrets`.
	const stdioSecrets = oneSecretStore(() => new SecretStore(data.secrets));
	const registry = new SessionRegistry({
		maxSessions: config.limits.maxSessions,
		sessionTtlMs: config.limits.sessionTtlMs,
		browserPath: config.browser.path,
		dataDir: config.dataDir,
		browserArgs: config.browser.args,
		headless: config.browser.headless,
		// D-094: `TTK_CHROMIUM_NO_SANDBOX`, as on the HTTP mount.
		chromiumSandbox: config.browser.chromiumSandbox,
		// The ledger gate reads the same list the tools gate on (owner item 6), and so does the browser (D-095).
		allowedDomains: config.allowedDomains,
		// D-138 (design §2.0 item 7): `TTK_ALLOWED_DOMAINS_SCOPE`; the registry acts on it from WS-B.
		allowedDomainsScope: config.allowedDomainsScope,
		// D-128: `TTK_SESSION_OWNERSHIP`. On stdio every call is the one anonymous-loopback owner, so `owner` changes
		// only the `default` session's id.
		ownership: config.sessionOwnership,
		// Review R2-7: the configured secrets are redacted before the request log and the console ring cap their text —
		// NF-3: by the very store the tools read (`core.secrets` below), built once.
		redact: stdioSecrets.redact,
		logger,
	});
	// D-127: tool-call spans on stdio too, while the runtime exports; the warning goes to stderr like every line.
	const telemetry = createTelemetry(logger);

	// D-075: the library is served on stdio too, on the same data directory and the same scopes.
	const library = config.dataDir === null ? undefined : new LibraryStore({ dataDir: config.dataDir });
	await library?.initialize();
	const core = {
		registry,
		version: VERSION,
		...(library === undefined ? {} : { library }),
		allowedDomains: config.allowedDomains,
		// SEC-01: stdio has no credential to carry a grant either.
		anonScopes: config.anonScopes,
		secrets: stdioSecrets.secrets,
		persistence: config.dataDir !== null,
		// SR-HEAD-REDIRECT: proven through the permissions API, never declared.
		egress: await probeEgressGrant(config.allowedDomains),
		logger,
		// R5 (D-125): `TTK_CONFIRM_DESTRUCTIVE`, as on HTTP. No `viewUrl`: stdio has no public URL, so
		// `TTK_HUMAN_HANDOFF` is ignored here and `browser_request_human` is never offered (R2, D-124).
		confirmations: config.confirmDestructive,
		...(telemetry.active ? { traceTool: telemetry.traceTool } : {}),
	};
	const sandbox = config.expansion.sandbox === null ? undefined : new SandboxClient(config.expansion.sandbox);
	// D-082: watched for the connection's life, as on HTTP; the pinned instance re-reads its tools on each change.
	const { bridgeProbe, ServiceHealth } = await import('@tykotech/gateway');
	const bridge = config.expansion.bridge;
	const health = new ServiceHealth({
		...(sandbox === undefined ? {} : { sandbox: () => sandbox.ready() }),
		...(bridge === null ? {} : { agents: bridgeProbe(bridge.url) }),
	}, { logger });
	await health.start();
	const services = health.watching ? { services: () => health.states() } : {};
	// R12 (design §2.19): `sandbox_clone` only while the sandbox's `/healthz` says it clones, as on HTTP.
	const clone = sandbox === undefined ? {} : { sandboxClone: () => sandbox.clone === true };
	// D-143: stdio composes the built-in model agent exactly as serve does (backend design §1 "Flow"); the providers in
	// force (D-154: the database's) reach the runtime by argument, and the anonymous principal needs `model:invoke` in
	// TTK_ANON_SCOPES. Read once: a provider changed in the web app reaches stdio at its next start.
	const expansion = createExpansionServices(
		config.expansion,
		{ ...core, ...services, ...clone },
		sandbox,
		undefined,
		undefined,
		{
			modelProviders: providers.effective(),
			logger,
			// D-154: a local agent's memory is the same store `serve` uses (same owner on the credential-less mounts).
			...(data.store === null ? {} : {
				memory: new MemoryStore(data.store.db, { providers: () => providers.effective()?.providers ?? [] }),
			}),
		},
	);
	// D-080: the one instance pinned to this connection pushes the registry's changes, per the era it serves.
	const build = createBuildServer({
		...core,
		...services,
		extraTools: expansion.tools,
		// D-108: `capabilities.tykotech.sandbox` on stdio too.
		...(sandbox === undefined ? {} : { sandboxBackend: () => sandbox.backend }),
		...clone,
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

	// Block forever. `serveStdio` owns the transport, and its pending stdin read
	// is what holds the runtime open; when the client closes stdin that op
	// completes, the event loop drains and the process exits on its own. This
	// promise registers no op of its own — it exists only to stop `main` from
	// returning, which would exit the process before the first message was read.
	await new Promise<never>(() => {});
	return 0;
}

async function runAcp(): Promise<number> {
	const { ENV_NAMES, loadConfig, loadModelProviders, processEnv, resolveSecrets, secretReader } = await import(
		'@tykotech/gateway'
	);
	const { runAcpProxy } = await import('@tykotech/agents');
	const env = processEnv(ENV_NAMES);
	// The proxy never dials a provider, but it parses the same configuration the server would, so a refused file is
	// refused here too rather than on the next `serve`.
	const read = secretReader();
	const config = loadConfig(env, {
		secrets: await resolveSecrets({ env, readFile: read }),
		modelProviders: await loadModelProviders(env, { readFile: read }),
	});
	if (config.expansion.bridge === null) {
		console.error('acp requires TTK_AGENT_BRIDGE_URL and TTK_AGENT_BRIDGE_TOKEN_FILE');
		return 1;
	}
	try {
		await runAcpProxy(config.expansion.bridge);
		return 0;
	} catch {
		console.error('ACP bridge failed; check the configured runner and agent');
		return 1;
	}
}

/**
 * Liveness probe, as a subcommand.
 *
 * The same check `scripts/healthcheck.ts` performs, reachable from the
 * compiled binary (R15) — the slim image (R11) has no Deno runtime to run a
 * script with, and a container without a health check is a container whose
 * restarts nobody notices.
 *
 * Always dials `127.0.0.1`, never `TTK_HOST`: a server bound to `0.0.0.0` is
 * reachable on loopback, but a probe that *connects* to `0.0.0.0` fails — the
 * classic bind-versus-connect mistake that presents as a restart loop.
 */
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
	},
): Promise<number> {
	const { DEFAULT_SCOPES, ENV_NAMES, generateAdminUser, generateApiKey, loadConfig, processEnv, SCOPES } = await import(
		'@tykotech/gateway'
	);
	const { ADMIN_SCOPES } = await import('@tykotech/mcp');

	/**
	 * The scopes a minted credential carries: DEFAULT_SCOPES unless `--scopes` names others, each checked against
	 * the vocabulary. Shared by `--new-key` (SEC-01, fourth grant site) and `--new-admin` (GW-2, sixth): both
	 * materialise the array into the record they print, so neither reaches a verifier fallback, and neither may
	 * hand out an EXPLICIT_SCOPES member nobody named (D-065). `null` means an unknown name was reported.
	 */
	const requestedScopes = (): typeof DEFAULT_SCOPES | null => {
		const requested = args.scopes === undefined
			? DEFAULT_SCOPES
			: args.scopes.split(',').map((s) => s.trim()).filter((s) => s !== '');
		const invalid = requested.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
		if (invalid.length > 0) {
			console.error(`unknown scopes: ${invalid.join(', ')}`);
			console.error(`valid scopes: ${SCOPES.join(', ')}`);
			return null;
		}
		return requested as typeof DEFAULT_SCOPES;
	};

	const grantUser = args.grant;
	if (grantUser !== undefined && grantUser !== '') return await runGrant(grantUser, args);

	if (args['new-db-key'] === true) {
		const written = await writeSecretFile(DB_KEY_FILE, `${(await import('@tykotech/gateway')).generateDbKey()}\n`, {
			force: args.force === true,
		});
		if (written === 'exists') {
			console.error(`${DB_KEY_FILE} exists; --force replaces it, and every secret sealed with it becomes unreadable`);
			return 1;
		}
		console.log(`Wrote ${DB_KEY_FILE} (0600). Set TTK_DB_KEY_FILE to it; keep it off the data volume and backed up.`);
		return 0;
	}

	const adminUsername = args['new-admin'];
	if (adminUsername !== undefined && adminUsername !== '') {
		// Validated before anything is generated or written: a typo must never replace a working admin record.
		const named = args.scopes === undefined ? null : requestedScopes();
		if (args.scopes !== undefined && named === null) return 1;
		// D-154: an existing record is never replaced without --force.
		if (args.force !== true && await exists(ADMIN_USER_FILE)) {
			console.error(`${ADMIN_USER_FILE} exists; pass --force to replace it`);
			return 1;
		}
		// C7 / D-098: `admin` is no longer part of the default grant, so an administrator record names it — the
		// default grant plus `admin` without --scopes, and `admin` added to whatever --scopes names.
		const adminScopes = named === null ? [...ADMIN_SCOPES] : [...new Set([...named, 'admin' as const])];
		const { record, password } = await generateAdminUser(adminUsername, args.password, adminScopes);
		console.log('====================================================');
		console.log('Admin User Generated Successfully');
		console.log('====================================================');
		console.log(`Username: ${record.username}`);
		console.log(`Password: ${password}`);
		console.log('====================================================\n');

		const secretFile = ADMIN_USER_FILE;
		let wrote = false;
		try {
			await writeSecretFile(secretFile, JSON.stringify(record, null, 2) + '\n', { force: true });
			wrote = true;
			console.log(`Saved admin user record to ${secretFile}`);
		} catch (cause) {
			console.log(`Could not write to ${secretFile}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		if (!wrote) {
			console.log('Add this record to secrets/ttk_admin_user.json:\n');
			console.log(JSON.stringify(record, null, 2));
		}
		return 0;
	}

	const keySetPrefix = args['new-key-set'];
	if (keySetPrefix !== undefined && keySetPrefix !== '') {
		// One key per scope, each holding exactly that one scope. A role that
		// should be able to invoke tools and nothing else gets the `mcp:invoke`
		// key and never the `admin` one; the operator composes a deployment from
		// the subset it wants rather than editing a scope array by hand. Every
		// scope in the vocabulary is minted, `evaluate` included when it is
		// declared there (EXPLICIT_SCOPES lives in SCOPES), because withholding
		// it here would hide the one key an operator must deliberately choose to
		// hand out. `generateApiKey` is used as-is: this adds no fifth default
		// grant site (BF-2) — it never consults DEFAULT_SCOPES, it names one
		// scope explicitly per key.
		const records: unknown[] = [];
		console.error('New API keys (each shown once — store them now):\n');
		for (const scope of SCOPES) {
			const id = `${keySetPrefix}-${scope.replace(/:/g, '-')}`;
			const { key, record } = await generateApiKey(id, [scope]);
			console.error(`  ${id}\n    ${key}\n`);
			records.push(record);
		}
		// The raw keys go to stderr, the hashed records to stdout as one array,
		// so `doctor --new-key-set web > keys.json` yields a file ready for
		// TTK_API_KEYS_FILE without the secrets leaking into it.
		console.log(JSON.stringify(records, null, 2));
		return 0;
	}

	const keyId = args['new-key'];
	if (keyId !== undefined && keyId !== '') {
		// SEC-01, fourth grant site. This one *materialises* the array into the
		// printed record, so it sails past the `matched.scopes ?? DEFAULT_SCOPES`
		// fallback in the verifier: a key minted here with no --scopes would hold
		// whatever it was given, forever. It is given the defaults.
		const requested = requestedScopes();
		if (requested === null) return 1;
		const { key, record } = await generateApiKey(keyId, requested);
		console.log('New API key (shown once — store it now):\n');
		console.log(`  ${key}\n`);
		console.log('Add this record to TTK_API_KEYS (or the file TTK_API_KEYS_FILE points at):\n');
		console.log(JSON.stringify([record], null, 2));
		return 0;
	}

	console.log(`tykotech-mcp ${VERSION}`);
	console.log(`deno            ${Deno.version.deno}`);
	console.log(`platform        ${Deno.build.os}/${Deno.build.arch}`);

	let ok = true;
	// D-137 (N5): the same pure decision the edge made, re-run for its signal map — `otel off`, or where each signal
	// goes. Run from `main()` without the edge (a unit test), a refusal is reported here and fails the doctor.
	const otel = checkOtelEgress(processOtelInputs([]));
	for (const line of otelDoctorLines(otel)) console.log(line);
	if (!otel.ok) ok = false;
	try {
		const {
			configuredSecretRefs,
			describeSecretRefs,
			databaseDoctorLine,
			loadModelProviders,
			providerNetHost,
			resolveSecrets,
			secretReader,
		} = await import('@tykotech/gateway');
		const env = processEnv(ENV_NAMES);
		// R15 (D-123): every `*_REF` and provider setting is checked, but no provider is contacted and no token read —
		// this task holds no net grant, and a diagnostic must not be the thing that pulls a secret.
		const read = secretReader();
		// D-143: the providers file is parsed exactly as `serve` parses it (a key file is read, never printed), so a
		// refused entry is reported here with its field rather than by a failed start.
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
		console.log(`public url      ${config.publicUrl.href}`);
		console.log(
			`api keys        ${keysRef === undefined ? config.apiKeys.length : `from ${keysRef.provider} (not contacted)`}`,
		);
		console.log(`oauth           ${config.oauth === null ? 'disabled' : config.oauth.issuer.href}`);
		console.log(
			`allowed domains ${config.allowedDomains.length === 0 ? '(unrestricted)' : config.allowedDomains.join(', ')}`,
		);
		for (const line of doctorScopeLines(config.allowedDomainsScope, config.browser.args)) console.log(line);
		// B1.10: an entry that carries a scheme or a port matches nothing, and
		// `loadConfig` now refuses one — so an operator finds it here, before a
		// restart finds it one 403 at a time. Printing the accepted list is what
		// makes the valid case checkable too.
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
		console.log(`role            ${config.role}${config.cluster === null ? ' (single node)' : ''}`);
		if (config.cluster !== null) {
			console.log(`cluster kv      ${config.cluster.kvPath}`);
			console.log(`node            ${config.cluster.nodeId} at ${config.cluster.nodeUrl || '(no url)'}`);
		}
		console.log(`data dir        ${config.dataDir ?? '(ephemeral sessions)'}`);
		console.log(`ffmpeg          ${config.ffmpeg ?? '(recording disabled)'}`);
		console.log(`coding sandbox  ${config.expansion.sandbox?.url ?? 'disabled'}`);
		console.log(`ACP agent       ${config.expansion.bridge?.agent ?? 'disabled'}`);
		console.log(`A2A peers       ${config.expansion.peers.map((peer) => peer.id).join(', ') || 'none'}`);
		for (const line of modelProvidersDoctorLines(config.modelProviders, providerWarnings, providerNetHost)) {
			console.log(line);
		}
		// D-154: the providers in force live in the database (the file above is its seed); counts only, no key opened.
		const storeLine = databaseDoctorLine(config.dataDir, config.dbKey !== null);
		if (storeLine !== null) console.log(storeLine);
		console.log(`headless        ${config.browser.headless}`);
		// F6 (IMPLEMENTATION-PLAN M3.4): the browser is resolved here the way the server will resolve it at launch,
		// so a missing or unreadable Chromium is found by `doctor` rather than by the first tool call.
		console.log(`browser         ${await describeBrowser(config.browser.path ?? undefined)}`);
		// C9: the same count the bind policy makes — an account (the seed, or a readable users.json) is a credential.
		const { configuredAccounts } = await import('@tykotech/gateway');
		const accounts = configuredAccounts(config.dataDir, config.adminUser);
		console.log(`accounts        ${accounts}`);
		if (config.apiKeys.length === 0 && keysRef === undefined && config.oauth === null && accounts === 0) {
			console.log('\nwarning: no credentials configured — only loopback development mode will start.');
		}
	} catch (cause) {
		ok = false;
		console.error(`\nconfiguration error: ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	return ok ? 0 : 1;
}

/** D-154: where `setup` and `doctor` write the deployment's secrets, as `docker-compose.yml` mounts them. */
const SECRETS_DIR = 'secrets';
const DB_KEY_FILE = `${SECRETS_DIR}/ttk_db_key`;
const ADMIN_USER_FILE = `${SECRETS_DIR}/ttk_admin_user.json`;
const API_KEYS_FILE = `${SECRETS_DIR}/ttk_api_keys.json`;
const ENV_FILE = '.env';

/** The `.env` `setup` writes: the two Compose settings an operator changes first, at their loopback defaults. */
const ENV_TEMPLATE = `# TykoTech-MCP: docker compose settings. Created by \`setup\`; never replaced without --force.
# Publish beyond this machine: TTK_BIND=0.0.0.0 and TTK_PUBLIC_URL=http://<this host's address>:8787
TTK_BIND=127.0.0.1
TTK_PUBLIC_URL=http://127.0.0.1:8787
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
 * D-154: writes a secret file `0600`, never over an existing one unless `force` — the owner's rule for every seed
 * destination. A forced write removes the old file first, so one left `0400` (or owned by the container's uid) is
 * replaced rather than refused.
 */
async function writeSecretFile(path: string, text: string, options: { force: boolean }): Promise<'written' | 'exists'> {
	if (await exists(path)) {
		if (!options.force) return 'exists';
		await Deno.remove(path);
	}
	const slash = path.lastIndexOf('/');
	if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
	await Deno.writeTextFile(path, text, { createNew: true, mode: 0o600 });
	return 'written';
}

/**
 * `setup` (D-154): creates what a first `docker compose up` needs — the database key, an administrator account, an
 * API key and `.env` — skipping each file that exists unless `--force`. The generated password and API key are
 * printed once and stored only as hashes.
 */
async function runSetup(
	args: { force?: boolean; admin?: string; 'key-id'?: string; scopes?: string },
): Promise<number> {
	const { DEFAULT_SCOPES, generateAdminUser, generateApiKey, generateDbKey, SCOPES } = await import(
		'@tykotech/gateway'
	);
	const { ADMIN_SCOPES } = await import('@tykotech/mcp');
	const force = args.force === true;
	const scopes = args.scopes === undefined
		? [...DEFAULT_SCOPES]
		: args.scopes.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '');
	const unknown = scopes.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
	if (unknown.length > 0) {
		console.error(`unknown scopes: ${unknown.join(', ')}\nvalid scopes: ${SCOPES.join(', ')}`);
		return 1;
	}
	const report: string[] = [];
	const once: string[] = [];
	const mark = (path: string, outcome: 'written' | 'exists'): void => {
		report.push(`  ${outcome === 'written' ? 'created' : 'kept   '}  ${path}`);
	};

	mark(DB_KEY_FILE, await writeSecretFile(DB_KEY_FILE, `${generateDbKey()}\n`, { force }));

	if (force || !await exists(ADMIN_USER_FILE)) {
		const { record, password } = await generateAdminUser(args.admin ?? 'admin', undefined, [...ADMIN_SCOPES]);
		mark(ADMIN_USER_FILE, await writeSecretFile(ADMIN_USER_FILE, `${JSON.stringify(record, null, 2)}\n`, { force }));
		once.push(`  admin user  ${record.username}`, `  password    ${password}`);
	} else mark(ADMIN_USER_FILE, 'exists');

	if (force || !await exists(API_KEYS_FILE)) {
		const id = args['key-id'] ?? 'client';
		const { key, record } = await generateApiKey(id, scopes as typeof DEFAULT_SCOPES);
		mark(API_KEYS_FILE, await writeSecretFile(API_KEYS_FILE, `${JSON.stringify([record], null, 2)}\n`, { force }));
		once.push(`  api key     ${key}  (id ${id}; ${scopes.join(', ')})`);
	} else mark(API_KEYS_FILE, 'exists');

	if (force || !await exists(ENV_FILE)) {
		if (force && await exists(ENV_FILE)) await Deno.remove(ENV_FILE);
		await Deno.writeTextFile(ENV_FILE, ENV_TEMPLATE, { createNew: true });
		mark(ENV_FILE, 'written');
	} else mark(ENV_FILE, 'exists');

	console.log('setup:');
	for (const line of report) console.log(line);
	if (once.length > 0) {
		console.log('\nShown once, stored only as hashes — save them now:');
		for (const line of once) console.log(line);
	}
	// The containers run as 1993:1993, and a bind-mounted secret keeps its owner, group and mode. Group 1993 with 0440
	// lets them read a file the operator still owns, so `dev`, `stdio` and `doctor` keep reading it too. `Deno.uid`
	// needs a sys grant the task does not hold; unknown, the hint is printed.
	let uid: number | null = null;
	try {
		uid = Deno.uid();
	} catch {
		uid = null;
	}
	if (Deno.build.os === 'linux' && uid !== 1993) {
		console.log(
			`\nFor docker compose: sudo chgrp 1993 ${SECRETS_DIR}/ttk_* && chmod 0440 ${SECRETS_DIR}/ttk_*`,
		);
	}
	return 0;
}

/**
 * `seed` (D-154): copies the providers file (keys sealed) and `TTK_SECRETS(_FILE)` into the database — only into an
 * empty, never-seeded one, unless `--force`. A running server keeps what it loaded until it restarts.
 */
async function runSeed(args: { force?: boolean; only?: string }): Promise<number> {
	const {
		describeSeed,
		ENV_NAMES,
		loadConfig,
		loadModelProviders,
		openDataStore,
		processEnv,
		resolveSecrets,
		SEED_TARGETS,
		secretReader,
	} = await import('@tykotech/gateway');
	const only = args.only === undefined
		? undefined
		: args.only.split(',').map((target) => target.trim()).filter((target) => target !== '');
	const unknown = (only ?? []).filter((target) => !(SEED_TARGETS as readonly string[]).includes(target));
	if (unknown.length > 0) {
		console.error(`unknown seed targets: ${unknown.join(', ')} (valid: ${SEED_TARGETS.join(', ')})`);
		return 1;
	}
	const env = processEnv(ENV_NAMES);
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
 * G15 / D-098: `doctor --grant <user> --scopes <list>` — the offline remedy for a store in which no enabled account
 * holds `admin` (the startup warning names it), so nobody can reach the Users screen to fix it.
 *
 * Without a cluster it rewrites `<TTK_DATA_DIR>/users.json` (or `--data-dir`), and must run with the gateway
 * stopped: a running gateway does not re-read the file, and its next account change would write its own copy over
 * this one. With `TTK_CLUSTER_KV` set the accounts live in the shared KV (N2), so the grant is written there through
 * the same optimistic commit the gateway uses and running nodes pick it up within one poll — which needs a runtime
 * with KV enabled; without it the command refuses and prints the exact flag to add rather than editing a file no
 * node reads.
 *
 * ERRATUM(E-80): design §2.2 had `--grant` refuse outright whenever the cluster KV is configured and print its path.
 * A refusal alone leaves a cluster with no enabled administrator no offline remedy at all — the KV is the authority
 * and every node adopts it — so the grant is written to the KV when the runtime can open it, and the refusal (with
 * the KV path and the command that can) stands only where it cannot.
 */
async function runGrant(username: string, args: { scopes?: string; 'data-dir'?: string }): Promise<number> {
	const { grantScopesInCluster, grantScopesInFile, processEnv, SCOPES, UserStoreError } = await import(
		'@tykotech/gateway'
	);
	if (args.scopes === undefined) {
		console.error('--grant needs --scopes <list>, for example --scopes mcp:invoke,view:watch,view:control,admin');
		return 1;
	}
	const scopes = args.scopes.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '');
	const invalid = scopes.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
	if (invalid.length > 0) {
		console.error(`unknown scopes: ${invalid.join(', ')}`);
		console.error(`valid scopes: ${SCOPES.join(', ')}`);
		return 1;
	}
	const env = processEnv(['TTK_DATA_DIR', 'TTK_CLUSTER_KV']);
	const kvPath = env.TTK_CLUSTER_KV?.trim() ?? '';
	try {
		if (kvPath !== '') {
			if (typeof Deno.openKv !== 'function') {
				console.error(`TTK_CLUSTER_KV is set: the accounts live in the cluster store at ${kvPath}, not in users.json.`);
				console.error('Run this command with KV enabled, for example:');
				console.error(
					`  deno run --unstable-kv --allow-read --allow-write --allow-env=TTK_* packages/cli/mod.ts doctor --grant ${username} --scopes ${
						scopes.join(',')
					}`,
				);
				return 1;
			}
			const kv = await Deno.openKv(kvPath);
			try {
				const { user, migrated } = await grantScopesInCluster(kv, username, scopes);
				console.log(`granted ${user.username}: ${user.scopes.join(', ')} (cluster store ${kvPath})`);
				if (migrated > 0) console.log(`upgraded ${migrated} other account(s) to explicit scopes`);
			} finally {
				kv.close();
			}
			return 0;
		}
		const dataDir = args['data-dir']?.trim() || env.TTK_DATA_DIR?.trim() || '';
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

/**
 * NF-3 (design §2.8, AC26): the stdio composition's secret wiring — the store is built by `make` exactly once, and
 * `redact` delegates to that same instance, so the registry's log redaction and the tools' `secrets` can never diverge.
 */
export function oneSecretStore<S extends { redact(text: string): string }>(
	make: () => S,
): { readonly secrets: S; readonly redact: (text: string) => string } {
	const secrets = make();
	return { secrets, redact: (text: string) => secrets.redact(text) };
}

/**
 * The doctor's `scope` line (D-138, design §2.3/§2.5), and the WebSocket caveat when `all` runs under a proxy: with
 * `--proxy-server`, `--proxy-pac-url` or `--proxy-auto-detect` in `TTK_BROWSER_ARGS` the browser bypasses the resolver
 * layer, and no CDP control pauses a WebSocket handshake (measured, C3/C9).
 */
export function doctorScopeLines(scope: 'documents' | 'all', browserArgs: readonly string[]): string[] {
	const proxied = browserArgs.some((arg) => /^--proxy-(?:server|pac-url|auto-detect)(?:=|$)/.test(arg));
	return [
		`scope           ${scope}`,
		...(scope === 'all' && proxied
			? [
				'warning: under a proxy, WebSockets to off-list hosts are not refused (no CDP control); HTTP requests ' +
				'still are',
			]
			: []),
	];
}

/**
 * The doctor's `model providers` line (D-143, backend §2.5): each provider as `id (kind, host:port, N models, key:
 * file|inline|none)`, the default, and one `warning:` line per parser warning (an `allow_http` provider, a short key).
 * Never the key and never the URL path — the host is `netHost(p)`, the gateway's `providerNetHost`: the `host:port`
 * spelling the grant proof queries and the one to copy into `--allow-net` (DX-1 / CR2-11 / BUG-12), with the default
 * port the URL parser dropped put back. Passed in because this module imports the gateway dynamically (D-137 F5).
 */
export function modelProvidersDoctorLines(
	config: { readonly default: string | null; readonly providers: readonly ModelProviderDoctorRow[] } | null,
	warnings: readonly string[],
	netHost: (provider: ModelProviderDoctorRow) => string,
): string[] {
	if (config === null || config.providers.length === 0) return ['model providers none'];
	const listed = config.providers
		.map((p) => `${p.id} (${p.kind}, ${netHost(p)}, ${p.models.length} models, key: ${p.keySource})`)
		.join(', ');
	return [
		`model providers ${listed}; default: ${config.default ?? 'none'}`,
		...warnings.map((line) => `warning: ${line}`),
	];
}

/** What the doctor line reads from a provider — a structural subset of the gateway's `ModelProviderSettings`. */
interface ModelProviderDoctorRow {
	readonly id: string;
	readonly kind: string;
	readonly host: string;
	readonly baseUrl: string;
	readonly models: readonly string[];
	readonly keySource: 'file' | 'inline' | 'stored' | 'none';
}

// D-137 (design §2.3, F4): the gate runs before `main()` for every subcommand — `version`, `help` and an unknown command
// included. A refused process has written one stderr line and set `Deno.exitCode = 1`; with nothing pending it ends
// naturally, which exported nothing even past a missed metric tick, where `Deno.exit` hung (O26/O27). MB8: a tick that
// falls while the runtime is still loading this graph — before any line here runs — is exported by the runtime itself
// (resource attributes and `v8js.gc.*` only); that window is D-137's residual. `main()` itself stays ungated for its
// unit tests, which run with OpenTelemetry off. N6: `Deno.exit(await main())` below, and the
// existing exits inside `main` (a second interrupt, the stdio shutdown), can hang until the export timeout when a
// metric tick was missed while exporting — recorded in D-137 as a shutdown residual.
if (import.meta.main && enforceOtelEgress(Deno.args)) Deno.exit(await main(Deno.args));

/**
 * F6: what `doctor` says about the browser. A configured path is checked for existence; otherwise the same
 * discovery the launcher uses runs, and a failure says whether nothing is installed or the search was not
 * permitted (E-24), so the fix is obvious.
 */
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
