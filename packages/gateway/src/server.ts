/**
 * Process composition and lifecycle.
 *
 * Everything is constructed inside {@linkcode startGateway} and handed back on
 * the returned handle — no module-level state — so a test can run several
 * gateways in one process and tear each down independently.
 */
import { type SecretEntry, SecretStore, SessionRegistry, type SessionRegistryOptions, ToolError } from '@tykotech/mcp';
import { checkBindPolicy, type Config } from './config.ts';
import { VerifierChain } from './auth.ts';
import { ApiKeyFileWatcher } from './keyreload.ts';
import { LoginStore } from './logins.ts';
import { LibraryStore } from '@tykotech/mcp';
import { apiKeyAdminWarning, UserStore } from './users.ts';
import { headRoutingRefusal, privateLiteralEntries, probeEgressGrant } from '@tykotech/mcp';
import { createGatewayApp } from './app.ts';
import { canHostSessions, Cluster } from './cluster.ts';
import { createLogger, type Logger } from './logger.ts';
import { isLoopbackHost } from './config.ts';
import { SandboxClient } from '@tykotech/sandbox';
import { bridgeProbe, ServiceHealth } from './service_health.ts';
import type { Telemetry } from './telemetry.ts';
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
	/** R7 (D-127): the tool-call telemetry; absent, the app probes the runtime. Tests pass a recording one. */
	readonly telemetry?: Telemetry;
	/**
	 * NF-3 (design §2.8), tests only: builds the process's one {@linkcode SecretStore} from
	 * `config.secrets`. Called exactly once per gateway; absent, `new SecretStore(entries)`.
	 */
	readonly secretStore?: (entries: readonly SecretEntry[]) => SecretStore;
}

/** F5 (BACKEND §7): the listener always gets this long to close, however much of the budget earlier stages took. */
const LISTENER_FLOOR_MS = 1_000;

export interface RunningGateway {
	readonly url: string;
	/** This node's cluster identity, when clustering is on. */
	readonly nodeId?: string;
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
	// D-150: a default-on switch this deployment cannot run resolved off in `loadConfig`; each says so once, here.
	for (const note of config.featureNotes) logger.info(note);

	// R10/R12: joining the cluster comes first, because the role decides whether
	// this process launches browsers at all.
	const cluster = config.cluster === null ? undefined : await Cluster.open({
		kvPath: config.cluster.kvPath,
		nodeId: config.cluster.nodeId,
		nodeUrl: config.cluster.nodeUrl,
		role: config.role,
		version,
		logger,
		// R1 (D-121): a task's node record is kept as long as the task can be read.
		...(config.expansion.taskRetentionMs === undefined ? {} : { taskRetentionMs: config.expansion.taskRetentionMs }),
	});

	// D-154: the database under the data directory — opened, its vault unlocked, and what was never seeded copied in
	// from the providers file and `TTK_SECRETS(_FILE)`. A secret with nowhere encrypted to go refuses startup here.
	const data = await openDataStore(config, { logger });

	// NF-3 (design §2.8): one store for the whole mount. The registry's `redact` (request log, console ring) and the
	// tools' `ctx.secrets` (substitution, `browser_fill_secret`, the inspection redactor) read the same instance, so
	// the two can never disagree about what a secret is — two stores built from one list could, the day either is
	// reloaded or narrowed on its own. D-154: the list is the vault's once seeded.
	const secrets = (options.secretStore ?? ((entries) => new SecretStore(entries)))(data.secrets);

	const registry = new SessionRegistry({
		maxSessions: config.limits.maxSessions,
		sessionTtlMs: config.limits.sessionTtlMs,
		browserPath: config.browser.path,
		dataDir: config.dataDir,
		browserArgs: config.browser.args,
		headless: config.browser.headless,
		// D-094: `TTK_CHROMIUM_NO_SANDBOX`; the registry warns at startup when it is off.
		chromiumSandbox: config.browser.chromiumSandbox,
		// The ledger gate reads the same list the tools gate on (owner item 6), and so does the browser (D-095).
		allowedDomains: config.allowedDomains,
		// D-138 (design §2.0 item 7): `TTK_ALLOWED_DOMAINS_SCOPE`; the registry acts on it from WS-B.
		allowedDomainsScope: config.allowedDomainsScope,
		// D-128, D-150: `TTK_SESSION_OWNERSHIP` — `owner` on a single node unless the operator shares sessions.
		ownership: config.sessionOwnership,
		// Review R2-7: the configured secrets are redacted before the request log and the console ring cap their text.
		redact: (text: string) => secrets.redact(text),
		logger,
		...(options.launch === undefined
			? canHostSessions(config.role) ? {} : {
				// An edge node hosts nothing. Refusing at the launcher rather than
				// hoping no request reaches it means the role is enforced by the
				// one function that would otherwise spawn Chromium — and it is why
				// an edge node needs no `--allow-run` and no browser in its image.
				launch: () => {
					throw new ToolError(
						'browser-unavailable',
						'this node runs in edge mode and hosts no browsers; it forwards to a browser node',
					);
				},
			}
			: { launch: options.launch }),
	});

	// D-074 / D-073: accounts and sign-ins live in the data directory, so a redeploy keeps both. The admin
	// secret seeds the account store on first start and is not consulted once the store exists.
	const users = new UserStore({ dataDir: config.dataDir, seed: config.adminUser, logger });
	if (users.status === 'seeded') logger.info(`user store created at ${config.dataDir}/users.json from TTK_ADMIN_USER`);
	const logins = new LoginStore({ dataDir: config.dataDir, logger });
	// D-084: in a cluster the accounts and sign-ins live in the shared KV, so a sign-in made on one node holds on
	// every node and an account change reaches all of them at once.
	if (cluster !== undefined) {
		await users.attachCluster(cluster.kv);
		await logins.attachCluster(cluster.kv);
		logger.info('accounts and sign-ins are shared through the cluster store');
	}
	// G15: said once, after the accounts are where they will be served from.
	const noAdmin = users.adminWarning();
	if (noAdmin !== null) logger.warn(noAdmin);
	// R1-10: and when the keys are where the administrators were, said too — a key without `scopes` lost `admin` with
	// C7, and nothing else reports it.
	const noKeyAdmin = apiKeyAdminWarning(config.apiKeys, users.enabledAdminCount());
	if (noKeyAdmin !== null) logger.warn(noKeyAdmin);
	const verifier = new VerifierChain({
		config,
		allowAnonymous: isLoopbackHost(config.host),
		logger,
		users,
		logins,
	});

	// SR2-M3: the key file is watched so a revocation takes effect without a
	// restart — which is what makes the 300 s stream re-check able to deny an
	// API-key principal at all. Only when `TTK_API_KEYS_FILE` is the source in
	// force: an inline `TTK_API_KEYS` has no file to watch, and a watch on a file
	// whose records something else overrode would report changes that change
	// nothing. The watch needs no permission beyond the read grant the
	// configuration already used (measured — see keyreload.ts).
	const keyWatcher = config.apiKeysFile === null ? null : new ApiKeyFileWatcher({
		path: config.apiKeysFile,
		apply: (records) => verifier.replaceApiKeys(records),
		logger,
	});
	keyWatcher?.start();

	// SR-HEAD-REDIRECT: `browser_head` is offered only where the permissions
	// API proves an outbound grant beyond loopback. Probed once, here, so the
	// per-request server reads a static deployment fact (R5). A private or
	// loopback literal on the allowlist lifts the address deny for that exact
	// host, which is worth one line at startup when the tool is live.
	const grantProven = await probeEgressGrant(config.allowedDomains);
	// SR3-M2 / D-049: a deployment that routes the browser through its own proxy
	// flag gets two different network paths from one tool surface, and this
	// server's HEAD follows the process proxy environment rather than Chromium's
	// flag. The tool is withheld rather than allowed to answer about the wrong
	// path; the handler refuses the same case, so an out-of-band call cannot walk
	// past a control that lives only in `tools/list`.
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

	// D-082: the private services are configured once and watched for as long as the server runs: a service down at
	// start-up gets its tools when it comes up, and one that goes down loses them until it is back.
	const sandbox = config.expansion.sandbox === null ? undefined : new SandboxClient(config.expansion.sandbox);
	const bridge = config.expansion.bridge;
	const health = new ServiceHealth({
		...(sandbox === undefined ? {} : { sandbox: () => sandbox.ready() }),
		...(bridge === null ? {} : { agents: bridgeProbe(bridge.url) }),
	}, { logger });
	await health.start();
	const expansion = config.expansion;
	// D-075: the library lives beside the other data-volume state; without a data dir there is none to serve.
	let library: LibraryStore | undefined;
	if (config.dataDir !== null) {
		library = new LibraryStore({ dataDir: config.dataDir });
		await library.initialize();
	}
	// R10 (D-119): the link-signing key — the operator's file, or (D-154) one generated on first start and sealed in the
	// database's vault. Read here, once, so a key that cannot be read or created refuses startup rather than a first link.
	// D-150: that refusal is for an operator who set `TTK_SIGNED_LINKS`; the default turns links off with a warning
	// (an unwritable data directory, a short or unreadable generated key) and starts.
	let signedLinks = config.signedLinks;
	let signedLinkKey: Uint8Array | undefined;
	if (signedLinks !== null) {
		try {
			signedLinkKey = await loadLinkSigningKey({
				key: signedLinks.key,
				dataDir: config.dataDir,
				vault: data.store?.vault ?? null,
			});
		} catch (cause) {
			if (!signedLinks.defaulted || !(cause instanceof SecretError)) throw cause;
			// `SecretError` names the variable and the path, never the key's contents.
			logger.warn(`TTK_SIGNED_LINKS is unset and stays off: ${cause.message}`);
			signedLinks = null;
		}
	}
	// D-154: the model providers in force — the database's (seeded from the providers file), or the file's as is
	// without a data directory. Read here, once, before the runtime is composed; rows the parser refuses are logged and
	// offer nothing, never fatal.
	const modelProviderStore = await ModelProvidersAdmin.load({
		operator: config.modelProviders,
		store: data.store,
		logger,
	});
	// D-154: the agents' vector memory, in the same database; a provider embedder reads the providers in force.
	const memory = data.store === null
		? undefined
		: new MemoryStore(data.store.db, { providers: () => modelProviderStore.effective()?.providers ?? [] });
	// D-158: the agents' settings, in the same database; the defaults without one.
	const agentSettings = new AgentSettingsStore(data.store?.db ?? null, logger);
	const gateway = createGatewayApp({
		config: { ...config, secrets: data.secrets, expansion, signedLinks },
		modelProviderStore,
		agentSettings,
		...(memory === undefined ? {} : { memory }),
		// NF-3: the same store the registry redacts with (`GatewayDeps.secrets`, design §2.0 item 6).
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
		...(cluster === undefined ? {} : { cluster }),
		...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
	});

	let resolveListening: (port: number) => void;
	const listening = new Promise<number>((resolve) => (resolveListening = resolve));

	const server = Deno.serve({
		hostname: config.host,
		port: config.port,
		onListen: ({ port, hostname }) => {
			logger.info(`listening on http://${hostname}:${port}`, {
				credentialed: verifier.credentialed,
				oauth: config.oauth !== null,
			});
			resolveListening(port);
		},
	}, (request, info) =>
		gateway.app.fetch(request, {
			remoteAddr: info.remoteAddr,
		}));

	const port = await listening;

	let shuttingDown: Promise<void> | null = null;
	const shutdown = (): Promise<void> => {
		// Idempotent: a second signal joins the first teardown rather than
		// starting a competing one.
		shuttingDown ??= (async () => {
			logger.info('shutting down');
			const deadline = Date.now() + TEARDOWN_BUDGET_MS;
			// The timer is always cleared: left running, it would fire after a
			// clean shutdown and log a stage as abandoned that in fact finished.
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

			// F5, stage 1: drain — no new session, ticket or live-view socket from here on.
			gateway.drain();
			// The key watch first: it holds a live filesystem resource and a pending
			// reload timer, and neither has anything left to serve once shutdown has
			// begun.
			if (keyWatcher !== null) await budget('api key watch', keyWatcher.close());
			health.stop();
			await budget('mcp handler close', gateway.close());
			await budget('browser sessions', registry.shutdown('server-shutdown'));
			// Deregistering last: while the listener is still up this node can
			// still serve, and a peer routing to it is not yet wrong.
			users.detachCluster();
			logins.detachCluster();
			if (cluster !== undefined) await budget('cluster deregister', cluster.close());
			await budget('listener', server.shutdown());
			// Last: every request that could write to it has ended with the listener.
			data.close();
		})();
		return shuttingDown;
	};

	return {
		url: `http://${isLoopbackHost(config.host) ? '127.0.0.1' : config.host}:${port}`,
		...(cluster === undefined ? {} : { nodeId: cluster.self.id }),
		port,
		registry,
		finished: server.finished,
		shutdown,
	};
}
