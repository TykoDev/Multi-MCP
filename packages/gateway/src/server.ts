/** Process composition and lifecycle. */
import { type SecretEntry, SecretStore, SessionRegistry, type SessionRegistryOptions } from '@tykotech/mcp';
import { checkBindPolicy, type Config } from './config.ts';
import { VerifierChain } from './auth.ts';
import { ApiKeyFileWatcher } from './keyreload.ts';
import { LoginStore } from './logins.ts';
import { LibraryStore } from '@tykotech/mcp';
import { apiKeyAdminWarning, UserStore } from './users.ts';
import { headRoutingRefusal, privateLiteralEntries, probeEgressGrant } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { createLogger, type Logger } from './logger.ts';
import { isLoopbackHost } from './config.ts';
import { SandboxClient } from '@tykotech/sandbox';
import { ServiceHealth } from './service_health.ts';
import { loadLinkSigningKey, SecretError } from './secrets.ts';
import { AgentSettingsStore } from './agent_settings.ts';
import { ModelProvidersAdmin } from './model_providers_admin.ts';
import { openDataStore } from './data_store.ts';
import { MemoryStore } from './memory.ts';

/** Total budget for stages 2–5 of shutdown. */
const TEARDOWN_BUDGET_MS = 5_000;

export interface StartGatewayOptions {
	readonly config: Config;
	readonly version: string;
	readonly logger?: Logger;
	/** Overrides the browser launcher; used by tests to avoid Chromium. */
	readonly launch?: SessionRegistryOptions['launch'];
	/**
	 * Tests only: builds the process's one {@linkcode SecretStore} from `config.secrets`. Called exactly once per
	 * gateway; absent, `new SecretStore(entries)`.
	 */
	readonly secretStore?: (entries: readonly SecretEntry[]) => SecretStore;
}

/** The listener always gets this long to close, however much of the budget earlier stages took. */
const LISTENER_FLOOR_MS = 1_000;

export interface RunningGateway {
	readonly url: string;
	readonly port: number;
	readonly registry: SessionRegistry;
	/** Resolves when the listener has fully stopped. */
	readonly finished: Promise<void>;
	shutdown(): Promise<void>;
}

export async function startGateway(options: StartGatewayOptions): Promise<RunningGateway> {
	const { config, version } = options;
	const logger = options.logger ?? createLogger({ level: config.logLevel, format: config.logFormat });

	checkBindPolicy(config, (message) => logger.warn(message));
	// A default-on switch this deployment cannot run resolved off in `loadConfig`; each says so once, here.
	for (const note of config.featureNotes) logger.info(note);

	// The database under the data directory — opened, its vault unlocked, and what was never seeded copied in from the
	// providers file and `TTK_SECRETS(_FILE)`. A secret with nowhere encrypted to go refuses startup here.
	const data = await openDataStore(config, { logger });

	// One store for the whole mount.
	const secrets = (options.secretStore ?? ((entries) => new SecretStore(entries)))(data.secrets);

	const registry = new SessionRegistry({
		maxSessions: config.limits.maxSessions,
		sessionTtlMs: config.limits.sessionTtlMs,
		browserPath: config.browser.path,
		dataDir: config.dataDir,
		browserArgs: config.browser.args,
		headless: config.browser.headless,
		// `TTK_CHROMIUM_NO_SANDBOX`; the registry warns at startup when it is off.
		chromiumSandbox: config.browser.chromiumSandbox,
		// The ledger gate reads the same list the tools gate on, and so does the browser.
		allowedDomains: config.allowedDomains,
		// `TTK_ALLOWED_DOMAINS_SCOPE`: which of the browser's requests the allowlist governs.
		allowedDomainsScope: config.allowedDomainsScope,
		// `TTK_SESSION_OWNERSHIP` — `owner` unless the operator shares sessions.
		ownership: config.sessionOwnership,
		// The configured secrets are redacted before the request log and the console ring cap their text.
		redact: (text: string) => secrets.redact(text),
		logger,
		...(options.launch === undefined ? {} : { launch: options.launch }),
	});

	// Accounts and sign-ins live in the data directory, so a redeploy keeps both. The admin secret seeds the account
	// store on first start and is not consulted once the store exists.
	const users = new UserStore({ dataDir: config.dataDir, seed: config.adminUser, logger });
	if (users.status === 'seeded') logger.info(`user store created at ${config.dataDir}/users.json from TTK_ADMIN_USER`);
	const logins = new LoginStore({ dataDir: config.dataDir, logger });
	// A store with no enabled administrator is said once, at startup.
	const noAdmin = users.adminWarning();
	if (noAdmin !== null) logger.warn(noAdmin);
	// And when the administrators are API keys instead, said too: a key without `scopes` gets the defaults, which do
	// not include `admin`, and nothing else reports it.
	const noKeyAdmin = apiKeyAdminWarning(config.apiKeys, users.enabledAdminCount());
	if (noKeyAdmin !== null) logger.warn(noKeyAdmin);
	const verifier = new VerifierChain({
		config,
		allowAnonymous: isLoopbackHost(config.host),
		logger,
		users,
		logins,
	});

	// The key file is watched so a revocation takes effect without a restart — which is what makes the 300 s stream
	// re-check able to deny an API-key principal at all.
	const keyWatcher = config.apiKeysFile === null ? null : new ApiKeyFileWatcher({
		path: config.apiKeysFile,
		apply: (records) => verifier.replaceApiKeys(records),
		logger,
	});
	keyWatcher?.start();

	// `browser_head` is offered only where the permissions API proves an outbound grant beyond loopback. Probed once,
	// here, so the per-request server reads a static deployment fact.
	const grantProven = await probeEgressGrant(config.allowedDomains);
	// A deployment that routes the browser through its own proxy flag gets two different network paths from one tool
	// surface, and this server's HEAD follows the process proxy environment rather than Chromium's flag.
	const routingRefusal = headRoutingRefusal(config.browser.args);
	if (grantProven && routingRefusal !== null) logger.warn(routingRefusal);
	const egress = grantProven;
	const privateLiterals = privateLiteralEntries(config.allowedDomains);
	if (egress && routingRefusal === null && privateLiterals.length > 0) {
		logger.warn(
			`browser_head is live and TTK_ALLOWED_DOMAINS names loopback or private literals (${
				privateLiterals.join(', ')
			}): ` +
				'server-side HEAD requests may reach those exact hosts',
		);
	}

	// The private services are configured once and watched for as long as the server runs: a service down at start-up
	// gets its tools when it comes up, and one that goes down loses them until it is back.
	const sandbox = config.expansion.sandbox === null ? undefined : new SandboxClient(config.expansion.sandbox);
	const health = new ServiceHealth({
		...(sandbox === undefined ? {} : { sandbox: () => sandbox.ready() }),
	}, { logger });
	await health.start();
	// The library lives beside the other data-volume state; without a data dir there is none to serve.
	let library: LibraryStore | undefined;
	if (config.dataDir !== null) {
		library = new LibraryStore({ dataDir: config.dataDir });
		await library.initialize();
	}
	// The link-signing key — the operator's file, or one generated on first start and sealed in the database's vault.
	// Read here, once, so a key that cannot be read or created refuses startup rather than a first link.
	let signedLinks = config.signedLinks;
	let signedLinkKey: Uint8Array | undefined;
	if (signedLinks !== null) {
		try {
			signedLinkKey = await loadLinkSigningKey({
				key: signedLinks.key,
				vault: data.store?.vault ?? null,
			});
		} catch (cause) {
			if (!signedLinks.defaulted || !(cause instanceof SecretError)) throw cause;
			// `SecretError` names the variable and the path, never the key's contents.
			logger.warn(`TTK_SIGNED_LINKS is unset and stays off: ${cause.message}`);
			signedLinks = null;
		}
	}
	// The model providers in force — the database's (seeded from the providers file), or the file's as is without a
	// data directory.
	const modelProviderStore = await ModelProvidersAdmin.load({
		operator: config.modelProviders,
		store: data.store,
		logger,
	});
	// The agents' vector memory, in the same database; a provider embedder reads the providers in force.
	const memory = data.store === null
		? undefined
		: new MemoryStore(data.store.db, { providers: () => modelProviderStore.effective()?.providers ?? [] });
	// The agents' settings, in the same database; the defaults without one.
	const agentSettings = new AgentSettingsStore(data.store?.db ?? null, logger);
	const gateway = createGatewayApp({
		config: { ...config, secrets: data.secrets, signedLinks },
		modelProviderStore,
		agentSettings,
		...(memory === undefined ? {} : { memory }),
		// The same store the registry redacts with (`GatewayDeps.secrets`).
		secrets,
		...(signedLinkKey === undefined ? {} : { signedLinkKey }),
		registry,
		...(library === undefined ? {} : { library }),
		verifier,
		logger,
		version,
		egress,
		headRouting: routingRefusal,
		...(sandbox === undefined ? {} : { sandbox }),
		...(health.watching ? { health } : {}),
	});

	let resolveListening: (port: number) => void;
	const listening = new Promise<number>((resolve) => (resolveListening = resolve));

	const server = Deno.serve({
		hostname: config.host,
		port: config.port,
		onListen: ({ port, hostname }) => {
			logger.info(`listening on http://${hostname}:${port}`, { credentialed: verifier.credentialed });
			resolveListening(port);
		},
	}, (request, info) =>
		gateway.app.fetch(request, {
			remoteAddr: info.remoteAddr,
		}));

	const port = await listening;

	let shuttingDown: Promise<void> | null = null;
	const shutdown = (): Promise<void> => {
		// Idempotent: a second signal joins the first teardown rather than starting a competing one.
		shuttingDown ??= (async () => {
			logger.info('shutting down');
			const deadline = Date.now() + TEARDOWN_BUDGET_MS;
			// The timer is always cleared: left running, it would fire after a clean shutdown and log a stage as
			// abandoned that in fact finished.
			const budget = async <T>(label: string, work: Promise<T>): Promise<T | void> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const expiry = new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						logger.warn(`shutdown stage abandoned: ${label}`);
						resolve();
					}, Math.max(label === 'listener' ? LISTENER_FLOOR_MS : 0, deadline - Date.now()));
				});
				try {
					return await Promise.race([work, expiry]);
				} finally {
					clearTimeout(timer);
				}
			};

			// Stage 1: drain — no new session, ticket or live-view socket from here on.
			gateway.drain();
			// The key watch first: it holds a live filesystem resource and a pending reload timer, and neither has
			// anything left to serve once shutdown has begun.
			if (keyWatcher !== null) await budget('api key watch', keyWatcher.close());
			health.stop();
			await budget('mcp handler close', gateway.close());
			await budget('browser sessions', registry.shutdown('server-shutdown'));
			await budget('listener', server.shutdown());
			// Last: every request that could write to it has ended with the listener.
			data.close();
		})();
		return shuttingDown;
	};

	return {
		url: `http://${isLoopbackHost(config.host) ? '127.0.0.1' : config.host}:${port}`,
		port,
		registry,
		finished: server.finished,
		shutdown,
	};
}
