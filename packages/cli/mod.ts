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
import type { AppArmorHost } from './apparmor.ts';

/** The six `OTEL_*` names the gate reads and every launcher grants (D-137); rule T5's copy is pinned equal to it. */
export { OTEL_GATE_ENV_NAMES } from './otel_gate.ts';

export const VERSION = '0.2.0';

/**
 * The files `setup` manages, by the name `--only` takes, in the order it writes them. `apparmor` is the host's copy of
 * the sandbox's AppArmor profile (`packages/cli/apparmor.ts`), last because it may stop at sudo's password prompt.
 */
export const SETUP_UNITS = [
	'db-key',
	'admin',
	'api-key',
	'peer',
	'browser-secrets',
	'git-remotes',
	'sandbox-token',
	'agent-token',
	'agent-commands',
	'env',
	'apparmor',
] as const;

/** A `setup` unit. */
export type SetupUnit = (typeof SETUP_UNITS)[number];

const SETUP_UNITS_TEXT = SETUP_UNITS.join(', ');

const USAGE = `tykotech-mcp ${VERSION}

USAGE:
  tykotech-mcp <command> [options]

COMMANDS:
  serve            Run the HTTP gateway (MCP over Streamable HTTP + live view)
  stdio            Run MCP over stdio for a local client
  acp              Run Agent Client Protocol over stdio through the configured agent bridge
  setup            Create every missing file in secrets/ the compose files mount, and .env; --force replaces
  seed             Copy the providers file and browser secrets into the database; --force replaces
  doctor           Diagnose the environment; generate an API key
  healthcheck      Probe a running server on loopback; exit 0 when healthy
  version          Print the version

SERVE OPTIONS:
  --host <addr>    Bind address        (default 127.0.0.1, env TTK_HOST)
  --port <n>       Bind port           (default 8787, env TTK_PORT)

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
		boolean: ['help', 'force', 'new-db-key', 'save'],
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
		save?: boolean;
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

/** D-154: where `setup` and `doctor` write the deployment's files, as the compose files mount them. */
const SECRETS_DIR = 'secrets';
const DB_KEY_FILE = `${SECRETS_DIR}/ttk_db_key`;
const ADMIN_USER_FILE = `${SECRETS_DIR}/ttk_admin_user.json`;
const API_KEYS_FILE = `${SECRETS_DIR}/ttk_api_keys.json`;
const PEERS_FILE = `${SECRETS_DIR}/ttk_agent_peers.json`;
const PEER_TOKEN_FILE = `${SECRETS_DIR}/ttk_peer_token`;
const PEER_API_KEYS_FILE = `${SECRETS_DIR}/ttk_peer_api_keys.json`;
const BROWSER_SECRETS_FILE = `${SECRETS_DIR}/ttk_secrets.json`;
const GIT_REMOTES_FILE = `${SECRETS_DIR}/ttk_git_remotes`;
const SANDBOX_TOKEN_FILE = `${SECRETS_DIR}/ttk_sandbox_token`;
const AGENT_TOKEN_FILE = `${SECRETS_DIR}/ttk_agent_bridge_token`;
const AGENT_COMMANDS_FILE = `${SECRETS_DIR}/ttk_agent_commands.json`;
const ENV_FILE = '.env';

/**
 * The modes of `secrets/` and of every file `setup` and `doctor` write in it. A compose file secret is a bind mount
 * that keeps the host's owner and mode — Compose ignores `uid`, `gid` and `mode` for file secrets — and the containers
 * run as uid 1993 (slim: 1000; rootless Docker and Docker Desktop map ids again), so a `0600` file is unreadable in
 * them and the gateway restarts forever. The directory's `0700` is what keeps the files private on the host: no other
 * account can open anything inside it, whatever a file's own mode. Inside a container the mount is the file alone, and
 * `0644` lets the service's uid read it; every process there runs as that uid, which the old `chgrp 1993` + `0440`
 * granted all the same.
 */
const SECRETS_DIR_MODE = 0o700;
const SECRET_FILE_MODE = 0o644;

/** The A2A peer the default stack runs (`a2a-peer` in docker-compose.yml): its URL is its own `TTK_PUBLIC_URL`. */
const BUNDLED_PEER = { id: 'peer', url: 'http://a2a-peer:8787', token_file: '/run/secrets/ttk_peer_token' } as const;

/**
 * The ACP runner's commands file `setup` starts `docker-compose.agents.yml` with: one agent at the path the runner
 * image reserves, offered the gateway's MCP endpoint (the delegated token is matched against `TTK_AGENT_MCP_URL`). The
 * runner refuses to start until that executable exists — install your agent in an image derived from
 * docker/Dockerfile.agent-runner. No credential belongs here: mount those as files and name them in `env` as `*_FILE`.
 */
const AGENT_COMMANDS_TEMPLATE = [{
	id: 'default',
	executable: '/opt/agents/agent',
	args: [],
	cwd: '/agent-workspace',
	env: {},
	mcp_servers: [{ name: 'tykotech', url: 'http://tykotech-mcp:8787/mcp' }],
}];

/**
 * The `.env` `setup` writes: every value the compose files interpolate, at its default. `.env.example` is this text
 * byte for byte (`tests/unit/setup_test.ts` holds the two equal), so there is one template, not two.
 */
export const ENV_TEMPLATE =
	`# Multi-MCP: Docker Compose settings. Compose reads this file for interpolation only; no container sees it.
# \`deno task setup\` writes .env from this template (.env.example is the same text) and never replaces it without
# --force. Change a value, then \`docker compose up -d\`.

# Host interface Docker publishes port 8787 on. 0.0.0.0 = every interface (the stack has credentials, so it may).
TTK_BIND=127.0.0.1

# The address clients use; opens the Host and Origin allowlists to it. LAN access: http://<host address>:8787
TTK_PUBLIC_URL=http://127.0.0.1:8787

# Allowlist overrides (comma-separated hostnames). Empty = derived from TTK_PUBLIC_URL. A value REPLACES the derived
# list, so include the public host. Set both or neither.
TTK_ALLOWED_HOSTS=
TTK_ALLOWED_ORIGINS=

# Navigation allowlist of the browsers (gateway and peer), followed by browser_head too. Empty = unrestricted.
# Example: example.com,docs.example.com
TTK_ALLOWED_DOMAINS=

# Memory limit of the gateway container (the server and every browser session it runs), and the server's heap in MiB.
TTK_GATEWAY_MEMORY=1536m
TTK_GATEWAY_HEAP_MB=1024
# The same for the bundled A2A peer.
TTK_PEER_MEMORY=1g
TTK_PEER_HEAP_MB=512

# docker-compose.agents.yml: the runner image holding your ACP agent, and the agent id the gateway uses.
TTK_AGENT_RUNNER_IMAGE=tykotech-agent-runner:0.2.0
TTK_AGENT_DEFAULT=default

# docker-compose.sandbox-docker.yml: the group owning the Docker socket (\`stat -c %g /var/run/docker.sock\`; 0 on
# Docker Desktop), the workspace image, and volume names (two deployments on one daemon need different names).
TTK_SANDBOX_DOCKER_GID=0
TTK_SANDBOX_WORKSPACE_IMAGE=tykotech-sandbox-workspace:0.2.0
TTK_SANDBOX_DOCKER_VOLUME=ttk-code
TTK_SANDBOX_DOCKER_SOCK_VOLUME=ttk-sandbox-sock
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
 * D-154: writes a file in `secrets/` with {@linkcode SECRET_FILE_MODE}, never over an existing one unless `force` —
 * the owner's rule for every seed destination. A forced write removes the old file first, so one left `0400` (or owned
 * by the container's uid) is replaced rather than refused. The mode is set after the write because the one passed to
 * the create is masked by the umask.
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
 * Gives a kept file in `secrets/` {@linkcode SECRET_FILE_MODE}: a checkout set up before this mode (`0600`, which the
 * containers cannot read) is repaired by running `setup` again. `'repaired'` when the mode changed, `'unchanged'` when
 * it was already right, `'foreign'` when this account may not change it (a file handed over with `chown 1993`).
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
	const named = only.split(',').map((unit) => unit.trim()).filter((unit) => unit !== '');
	if (named.length === 0 || named.some((unit) => !(SETUP_UNITS as readonly string[]).includes(unit))) return undefined;
	return named as SetupUnit[];
}

/**
 * `setup` (D-154): creates every file a shipped compose file mounts — the database key, the administrator, the
 * `client` API key, the A2A peer's token pair and list, the browser-secrets and git-remotes placeholders, the overlay
 * tokens and the ACP commands template — and `.env`, skipping each file that exists. `--force` replaces the generated
 * ones; files you fill in yourself (browser secrets, git remotes, agent commands) are replaced only when `--only`
 * names them. Generated passwords and keys are printed once and stored only as hashes; the service tokens are stored
 * as they are (each side must present one), in `secrets/` like every other file. Kept files get their modes repaired.
 * On an AppArmor host it then installs the sandbox's profile through sudo (`apparmor`), and when that fails it exits 1
 * with the commands that do it by hand. `apparmor` stands in for the host in the unit tests.
 */
export async function runSetup(
	args: { force?: boolean; admin?: string; 'key-id'?: string; scopes?: string; only?: string },
	root = '.',
	apparmor?: AppArmorHost,
): Promise<number> {
	const { generateAdminUser, generateApiKey, generateDbKey, SCOPES } = await import('@tykotech/gateway');
	const { A2A_PEER_SCOPES, STACK_SCOPES } = await import('@tykotech/mcp');
	type Scopes = Parameters<typeof generateApiKey>[1];
	const units = setupUnits(args.only);
	if (units === undefined) {
		console.error(`--only takes a comma-separated list of: ${SETUP_UNITS.join(', ')}`);
		return 1;
	}
	const scopes = args.scopes === undefined
		? [...STACK_SCOPES]
		: args.scopes.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '');
	const unknown = scopes.filter((scope) => !(SCOPES as readonly string[]).includes(scope));
	if (unknown.length > 0) {
		console.error(`unknown scopes: ${unknown.join(', ')}\nvalid scopes: ${SCOPES.join(', ')}`);
		return 1;
	}
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
	if (selected('peer')) {
		// The token and its hash are one unit: a half that is missing or replaced makes the other useless, so both are
		// written together. The list names the token by its path in the gateway container.
		const force = replace();
		if (force || !await exists(at(PEER_TOKEN_FILE)) || !await exists(at(PEER_API_KEYS_FILE))) {
			const { key, record } = await generateApiKey('gateway', A2A_PEER_SCOPES);
			await mark(PEER_TOKEN_FILE, await writeSecretFile(at(PEER_TOKEN_FILE), `${key}\n`, { force: true }));
			await mark(
				PEER_API_KEYS_FILE,
				await writeSecretFile(at(PEER_API_KEYS_FILE), `${JSON.stringify([record], null, 2)}\n`, { force: true }),
			);
		} else {
			await mark(PEER_TOKEN_FILE, 'exists');
			await mark(PEER_API_KEYS_FILE, 'exists');
		}
		await file('peer', PEERS_FILE, () => `${JSON.stringify([BUNDLED_PEER], null, 2)}\n`);
	}
	await file('browser-secrets', BROWSER_SECRETS_FILE, () => '{}\n', true);
	await file('git-remotes', GIT_REMOTES_FILE, () => '[]\n', true);
	await file('sandbox-token', SANDBOX_TOKEN_FILE, () => `${serviceToken()}\n`);
	await file('agent-token', AGENT_TOKEN_FILE, () => `${serviceToken()}\n`);
	await file(
		'agent-commands',
		AGENT_COMMANDS_FILE,
		() => `${JSON.stringify(AGENT_COMMANDS_TEMPLATE, null, 2)}\n`,
		true,
	);
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
		for (const line of once) console.log(line);
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
					'and the gateway, which waits for it, never starts. Install it by hand, then docker compose up -d --build:\n\n' +
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
