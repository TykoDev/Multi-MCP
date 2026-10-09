/**
 * Container verification.
 *
 * Runs the built image and drives a real task through the published port only.
 * The assertion is a per-run 128-bit nonce that exists nowhere but a fixture
 * page served from the host: seeing it come back through an MCP tool result
 * proves the whole chain ran inside the container — HTTP, auth, the tool
 * layer, a sandboxed Chromium launch under `--allow-run`, CDP, and the DOM
 * pipeline.
 *
 * Run with:
 *   deno run --allow-run=docker --allow-net --allow-read --allow-env \
 *     tests/container/verify_container.ts <image-tag> --shape bundled|slim
 *
 * **The shape is an explicit argument (C2, D-103).** The two shipped images carry different permission matrices
 * (D-053: the slim binary's file and env grants are bare and baked; since D-151 both grant unscoped net), so the
 * verifier must know which one it is looking at. It used to infer that from the tag ending in
 * `:slim`, and CI tagged both shapes `tykotech-mcp:ci` — so the slim leg was judged against the bundled image's
 * expectations and could not pass. `--shape` is now authoritative; the tag suffix (`:slim`, `-slim`) remains only as
 * the fallback for a hand-run without it.
 *
 * **The expected tool list is derived from the code (C3).** Hard-coded counts went stale three times as the catalog,
 * the library tools and the default grant moved. The list is computed below from the same `CATALOG`, library tool
 * definitions, `DEFAULT_SCOPES` and availability predicates the server registers from, and the image must serve
 * exactly that set — checked by name, so a failure says which tool arrived or left.
 *
 * The host port is ephemeral (`127.0.0.1::8787`), so two runs — or another workstream's — never collide, and the
 * owner's live stack on 8787 is never touched.
 */
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseArgs } from '@std/cli/parse-args';
import { decodeBase64 } from '@std/encoding/base64';
import { encodeHex } from '@std/encoding/hex';
import {
	CATALOG,
	CHILD_ENV_BLANKED,
	DEFAULT_SCOPES,
	extensionTools,
	LibraryStore,
	libraryTools,
	type ToolAvailability,
} from '@tykotech/mcp';

const SHAPES = ['bundled', 'slim'] as const;
type Shape = (typeof SHAPES)[number];

const args = parseArgs(Deno.args, { string: ['shape', 'providers-fixture'] });
const tagArg = args._[0] === undefined ? undefined : String(args._[0]);
const SHAPE: Shape = (() => {
	if (args.shape === undefined) return /[:-]slim$/.test(tagArg ?? '') ? 'slim' : 'bundled';
	if ((SHAPES as readonly string[]).includes(args.shape)) return args.shape as Shape;
	console.error(`--shape must be one of ${SHAPES.join(', ')}; got ${JSON.stringify(args.shape)}`);
	Deno.exit(2);
})();
// The tags `deno task build:image` and `build:image:slim` produce, when no tag is given.
const IMAGE = tagArg ?? (SHAPE === 'slim' ? 'tykotech-mcp:slim' : 'tykotech-mcp:0.2.0');
const CONTAINER = `ttk-verify-${crypto.randomUUID().slice(0, 8)}`;
/** W2 / F24: the signed-links leg runs in a container of its own, so the default run's tool set stays the default. */
const LINKS_CONTAINER = `${CONTAINER}-links`;
/**
 * D-143 / D-145 (B4, MB7): the providers leg runs in a container of its own and only when asked —
 * `--providers-fixture` (the checked-in fixture beside this file) or `--providers-fixture=<path>` — because the leg
 * needs the parser (W1) and the grant proof (W3) in the image; the S0 seam ignores the file, which would make the
 * expectation fail for the wrong reason. Pass it on both shapes at integration: since D-151 the two expectations are
 * the same, and each shape must meet it.
 */
const PROVIDERS_CONTAINER = `${CONTAINER}-providers`;
const PROVIDERS_FIXTURE: string | null = args['providers-fixture'] === undefined
	? null
	: args['providers-fixture'] === '' || args['providers-fixture'] === 'true'
	? `${Deno.cwd()}/tests/container/model_providers.fixture.json`
	: args['providers-fixture'];
console.log(`verifying ${IMAGE} as the ${SHAPE} shape${args.shape === undefined ? ' (inferred from the tag)' : ''}`);

/**
 * Chromium flags that weaken or remove its sandbox — the `TTK_BROWSER_ARGS` denylist of the design (§2.1, AC23).
 * Compared as whole argv tokens (the part before any `=`), because Chromium itself passes `--no-zygote-sandbox` to
 * its unsandboxed utility zygote, which a substring match would misread as `--no-zygote`.
 */
const SANDBOX_DENYLIST = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--no-zygote',
	'--single-process',
	'--disable-seccomp-filter-sandbox',
	'--disable-namespace-sandbox',
	'--disable-gpu-sandbox',
] as const;

/** `TTK_CHROMIUM_NO_SANDBOX`'s truthy spellings, as the config parser's `bool` reads them. */
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * AC25 / M4 (W5, D-127): names the gateway is started with that every child must see blank — an exporter setting
 * with a credential-shaped value and two more OTel names (`OTEL_DENO=false`, so the gateway itself does not export
 * into a collector that is not there) — and a proxy setting that must still reach Chromium unchanged. `TTK_API_KEYS`
 * is set below anyway, inline, which is exactly the secret spelling the overrides exist for.
 *
 * D-143 / D-145 (B4, MB8): the three model-key names an operator shell may export. The gateway never reads them (the
 * bundled `CMD` does not even grant them), so they are inert in the gateway and must still arrive blank in every
 * child — the value here is a marker, never a key.
 */
const CHILD_ENV_PROBE = {
	OTEL_DENO: 'false',
	OTEL_SERVICE_NAME: 'ttk-verify',
	OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer w5-verify-collector-token',
	ANTHROPIC_API_KEY: 'b4-verify-marker-not-a-key',
	OPENAI_API_KEY: 'b4-verify-marker-not-a-key',
	TTK_MODEL_API_KEY: 'b4-verify-marker-not-a-key',
} as const;
/** The D-143 names, for the checks that read them apart from the OTel ones. */
const MODEL_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TTK_MODEL_API_KEY'] as const;
/** An unreachable proxy: only `https:` requests would use it, and this run's fixture is plain `http:`. */
const PROXY_PROBE = 'http://127.0.0.1:9';

/**
 * The tools a scope-less key record must see in this shape, from the code rather than from a number.
 *
 * Both images set `TTK_DATA_DIR` and `TTK_FFMPEG`, so persistence and recording are available and the library's
 * tools exist, and since D-150 human handoff and MCP Apps are on by default in both. D-154: the data directory holds the
 * database, so the agents' memory tools exist too (a default key reads them: `files:read`); signed links are on by
 * default only where a generated key can be sealed — `TTK_DB_KEY_FILE`, which a plain `docker run` does not set, so
 * the default run has them off and the links leg below mounts a key. Egress used to be the one input the shapes differed on (D-053); since D-151 the bundled `CMD` grants
 * the unscoped `--allow-net` the slim binary bakes, so it is `true` for both, and the set is one set. Extension tools
 * (sandbox, agents, A2UI) are absent here: none of their services is configured and every one of them needs an
 * explicit scope, which the set check below would catch if it ever stopped being true.
 */
function expectedTools(switches: Partial<ToolAvailability> = {}): string[] {
	const availability: ToolAvailability = {
		persistence: true,
		recording: true,
		egress: true,
		headRouting: null,
		// D-150: both images run single-node with `/data` and the embed documents, so human handoff and MCP Apps
		// (`control`) resolve on by default. D-154: signed links need the vault's key for a generated link key, and a
		// plain `docker run` names none, so they resolve off here; the links leg passes `{ signedLinks: true }`.
		signedLinks: false,
		handoff: true,
		mcpApps: true,
		...switches,
	};
	// D-154: the memory tools are composed wherever the database is (`/data`); their actions are never run here.
	const unused = (): Promise<Record<string, unknown>> => Promise.resolve({});
	const memory = extensionTools({
		memory_save: unused,
		memory_search: unused,
		memory_delete: unused,
		memory_list: unused,
	});
	const composed = [...CATALOG, ...libraryTools(new LibraryStore({ dataDir: '/data' })), ...memory];
	return composed
		.filter((tool) => tool.scope === undefined || DEFAULT_SCOPES.includes(tool.scope))
		.filter((tool) => tool.available?.(availability) ?? true)
		.map((tool) => tool.name)
		.sort();
}

const checks: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ''): void {
	checks.push([name, ok, detail]);
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function sha256Hex(value: string): Promise<string> {
	return encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

/**
 * The environment of every process in `container` whose command line matches `pattern`, read from
 * `/proc/<pid>/environ` as the container's own user (D-127). A process that user may not read — a sandboxed renderer
 * is not dumpable — is simply absent. Values stay inside this verifier: only names and booleans are printed.
 */
async function procEnvirons(
	container: string,
	pattern: RegExp,
): Promise<Array<{ pid: string; argv: string[]; env: Map<string, string> }>> {
	// One record per process: pid, TAB, cmdline, TAB, environ — NULs as \x01 so a record is one line.
	const script = 'for d in /proc/[0-9]*; do e=$(tr "\\000" "\\001" < "$d/environ" 2>/dev/null) || continue; ' +
		'c=$(tr "\\000" "\\001" < "$d/cmdline" 2>/dev/null); printf "%s\\t%s\\t%s\\n" "${d#/proc/}" "$c" "$e"; done';
	const listed = await run(['exec', container, 'sh', '-c', script]);
	const out: Array<{ pid: string; argv: string[]; env: Map<string, string> }> = [];
	for (const line of listed.stdout.split('\n')) {
		const [pid, cmdline, environ] = line.split('\t');
		if (pid === undefined || cmdline === undefined || environ === undefined) continue;
		const argv = cmdline.split('\x01').flatMap((arg) => arg.split(/\s+/)).filter((arg) => arg !== '');
		if (!pattern.test(argv[0] ?? '')) continue;
		const env = new Map<string, string>();
		for (const pair of environ.split('\x01')) {
			const at = pair.indexOf('=');
			if (at > 0) env.set(pair.slice(0, at), pair.slice(at + 1));
		}
		out.push({ pid, argv, env });
	}
	return out;
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const command = new Deno.Command('docker', { args, stdout: 'piped', stderr: 'piped' });
	const { code, stdout, stderr } = await command.output();
	return { code, stdout: new TextDecoder().decode(stdout), stderr: new TextDecoder().decode(stderr) };
}

// --- fixture page, served from the host -------------------------------------
const nonce = encodeHex(crypto.getRandomValues(new Uint8Array(16)));
// A second marker, served only as an attachment: Chromium has to download it
// into the container's own /data volume for it to come back (R16, E-33).
const fileNonce = encodeHex(crypto.getRandomValues(new Uint8Array(16)));
// R3 (W1, AC2): the name the containment probe's page tries to leave for. It resolves, inside the probe container
// only, to this same fixture (`--add-host`), so a request that escaped the veto would be counted here.
const OFF_LIST_HOST = 'ttk-off-list.test';
const offListHits: string[] = [];
/**
 * V1 / AC17 (D-138): the host gateway's IP literal as the probe containers see it (`host.docker.internal`'s address),
 * read from the first probe container. It is off every allowlist, so a request to it counts as an off-list hit.
 */
let offListIp: string | null = null;
const fixture = Deno.serve(
	{ hostname: '0.0.0.0', port: 0, onListen: () => {} },
	(request) => {
		const url = new URL(request.url);
		if (url.hostname === OFF_LIST_HOST) offListHits.push(url.pathname);
		else if (offListIp !== null && url.hostname === offListIp) offListHits.push(`ip:${url.pathname}`);
		// V1 / AC17 (D-138, D-139): the request-scope probe pages, aimed at the off-list name and the IP literal.
		const scopePage = requestScopePage(url);
		if (scopePage !== null) return scopePage;
		if (url.pathname === '/contain-popup') {
			const away = `http://${OFF_LIST_HOST}:${url.port}/off-list-popup?probe=1`;
			return new Response(
				`<!doctype html><title>popup probe</title>` +
					`<button id="open" type="button" onclick='window.open(${
						JSON.stringify(away)
					},"_blank","noopener")'>open</button>`,
				{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
			);
		}
		if (url.pathname === '/contain') {
			const away = `http://${OFF_LIST_HOST}:${url.port}/off-list-probe?probe=1`;
			return new Response(
				`<!doctype html><title>containment probe</title><h1>on-list</h1>` +
					`<script>setTimeout(()=>{location.href=${JSON.stringify(away)};},300);</script>`,
				{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
			);
		}
		return url.pathname === '/attachment'
			? new Response(fileNonce, {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'content-disposition': 'attachment; filename="container-report.txt"',
				},
			})
			: new Response(
				`<!doctype html><title>container fixture</title><h1>marker ${nonce}</h1>` +
					'<p><a href="/attachment">export</a></p>',
				{ headers: { 'content-type': 'text/html; charset=utf-8' } },
			);
	},
);
const fixturePort = (fixture.addr as Deno.NetAddr).port;

// --- credential --------------------------------------------------------------
const mintKey = (): string =>
	`ttk_${
		btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	}`;
const rawKey = mintKey();
// D-143 (B4): three more records, each holding exactly the scope one REST check needs. The default record stays
// scope-less (SEC-01b), so every tool-set check above and below still reads the default grant.
const agentKey = mintKey();
const modelKey = mintKey();
const adminKey = mintKey();
const keyRecords = JSON.stringify([
	{ id: 'verify', sha256: await sha256Hex(rawKey) },
	{ id: 'verify-agent', sha256: await sha256Hex(agentKey), scopes: ['agent:invoke'] },
	{ id: 'verify-model', sha256: await sha256Hex(modelKey), scopes: ['agent:invoke', 'model:invoke'] },
	{ id: 'verify-admin', sha256: await sha256Hex(adminKey), scopes: ['admin'] },
]);

let started = false;
// R3 (W1, AC2): the second, allowlisted container the containment probe runs in, removed in `finally`.
const PROBE_CONTAINER = `${CONTAINER}-e0`;
let probeStarted = false;
// D-143 (B4): the providers-fixture container, created only with `--providers-fixture`, removed in `finally`.
let providersCreated = false;

/**
 * R3 / AC2 (W1, F24): in this image's own Chromium, a page script's `location =` to a host off
 * `TTK_ALLOWED_DOMAINS` is refused before its request is sent (E0). Read back through `browser_network_log`: the
 * document request ends in M12's `net::ERR_ABORTED`, the off-list name — mapped to this fixture inside the probe
 * container only — receives nothing, and the tab stays on the allowlisted page. A second container because the
 * allowlist is deployment configuration; the main run above stays unrestricted, as the shipped images are.
 */
async function containmentProbe(): Promise<void> {
	const launched = await run([
		'run',
		'-d',
		'--name',
		PROBE_CONTAINER,
		'--shm-size=1g',
		`--security-opt=seccomp=${Deno.cwd()}/docker/seccomp-chromium.json`,
		'-p',
		'127.0.0.1::8787',
		'-e',
		`TTK_API_KEYS=${keyRecords}`,
		'-e',
		'TTK_HOST=0.0.0.0',
		'-e',
		'TTK_ALLOWED_DOMAINS=host.docker.internal',
		'--add-host=host.docker.internal:host-gateway',
		`--add-host=${OFF_LIST_HOST}:host-gateway`,
		IMAGE,
	]);
	probeStarted = launched.code === 0;
	if (!probeStarted) {
		check('R3/AC2: the allowlisted probe container starts', false, launched.stderr.slice(0, 200));
		return;
	}
	const mapped = await run(['port', PROBE_CONTAINER, '8787/tcp']);
	const port = Number(/:(\d+)\s*$/m.exec(mapped.stdout)?.[1] ?? NaN);
	let healthy = false;
	for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
			healthy = response.ok && (await response.json()).status === 'ok';
		} catch {
			// Not up yet.
		}
		if (!healthy) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	if (!healthy) {
		check('R3/AC2: the allowlisted probe container becomes healthy', false, '');
		return;
	}
	const probe = new Client({ name: 'verify-e0', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await probe.connect(
		new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${rawKey}`);
				return fetch(input, { ...init, headers });
			},
		}),
	);
	try {
		const page = `http://host.docker.internal:${fixturePort}/contain`;
		await probe.callTool({ name: 'browser_navigate', arguments: { url: page } });
		type Entry = { origin: string; resource_type: string; error_text: string | null };
		let refused: Entry | undefined;
		for (let attempt = 0; attempt < 40 && refused === undefined; attempt++) {
			const log = await probe.callTool({ name: 'browser_network_log', arguments: { failed_only: true } });
			refused = ((log.structuredContent as { entries?: Entry[] } | undefined)?.entries ?? [])
				.find((entry) => entry.origin === `http://${OFF_LIST_HOST}:${fixturePort}`);
			if (refused === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		check(
			'R3/AC2: a location= off the allowlist ends in net::ERR_ABORTED in browser_network_log (M12)',
			refused?.error_text === 'net::ERR_ABORTED' && refused.resource_type === 'Document',
			JSON.stringify(refused ?? null),
		);
		check(
			'R3/AC2: the off-list host received no request (E0 refused it before it was sent)',
			offListHits.length === 0,
			JSON.stringify(offListHits),
		);
		const state = await probe.callTool({ name: 'browser_get_state', arguments: {} });
		const url = (state.structuredContent as { url?: string } | undefined)?.url ?? '';
		check('R3/AC2: the tab is still on the allowlisted page', url === page, url);

		// M5 on this image's Chromium: a pop-up's first document is held for its session's veto.
		await probe.callTool({
			name: 'browser_navigate',
			arguments: { url: `http://host.docker.internal:${fixturePort}/contain-popup` },
		});
		const popupState = await probe.callTool({ name: 'browser_get_state', arguments: { fields: ['core', 'attrs'] } });
		const button = ((popupState.structuredContent as {
			interactive_elements?: Array<{ index: number; attrs?: Record<string, string> }>;
		} | undefined)?.interactive_elements ?? []).find((element) => element.attrs?.id === 'open');
		if (button !== undefined) await probe.callTool({ name: 'browser_click', arguments: { index: button.index } });
		let popupRefused: Entry | undefined;
		for (let attempt = 0; attempt < 40 && popupRefused === undefined; attempt++) {
			const log = await probe.callTool({ name: 'browser_network_log', arguments: { failed_only: true } });
			popupRefused = ((log.structuredContent as { entries?: Array<Entry & { path: string }> } | undefined)?.entries ??
				[]).find((entry) => entry.path === '/off-list-popup');
			if (popupRefused === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		let tabs = -1;
		for (let attempt = 0; attempt < 40 && tabs !== 1; attempt++) {
			const listed = await probe.callTool({ name: 'browser_list_tabs', arguments: {} });
			tabs = ((listed.structuredContent as { tabs?: unknown[] } | undefined)?.tabs ?? []).length;
			if (tabs !== 1) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		check(
			'R3/M5: a pop-up’s first document off the allowlist is refused before it is sent, and the pop-up is closed',
			button !== undefined && popupRefused?.error_text === 'net::ERR_ABORTED' && tabs === 1 &&
				!offListHits.includes('/off-list-popup'),
			`${JSON.stringify(popupRefused ?? null)}; tabs=${tabs}; off-list saw ${JSON.stringify(offListHits)}`,
		);

		// Review R2-1, ERRATUM(E-110): under an allowlist this image's launcher started the profile with preloading off —
		// the control that stops speculation-rules prefetch/prerender, which no `Fetch` pattern can pause. Read from the
		// probe container's own temp profile (this verifier's container, never a deployed one).
		const prefs = await run([
			'exec',
			PROBE_CONTAINER,
			'sh',
			'-c',
			'cat "${TMPDIR:-/tmp}"/bua-tmp-*/Default/Preferences',
		]);
		const preloadingOff = /"network_prediction_options":\s*2\b/.test(prefs.stdout);
		check(
			'R2-1/E-110: the allowlisted profile launched with preloading off (net.network_prediction_options = 2)',
			preloadingOff,
			prefs.code !== 0
				? prefs.stderr.slice(0, 200)
				: `Preferences (${prefs.stdout.length} bytes) ${preloadingOff ? 'carries' : 'lacks'} the key`,
		);

		// V1 / AC17, MB2 (D-139, ERRATUM(E-115)): in this image's Chromium, the default `documents` scope refuses
		// `<link rel=prefetch|prerender>` to the off-list name and to an IP literal before they are sent, while the same
		// page's off-list images still arrive — which is also the proof that both are reachable from this container.
		// IPv4: Docker Desktop also maps the name to an IPv6 address, which `getent hosts` lists first.
		const gateway = await run(['exec', PROBE_CONTAINER, 'getent', 'ahostsv4', 'host.docker.internal']);
		offListIp = /^(\S+)/.exec(gateway.stdout.trim())?.[1] ?? null;
		if (offListIp === null) {
			check('V1/AC17: the probe container resolves host.docker.internal', false, gateway.stderr.slice(0, 200));
			return;
		}
		const hintsFrom = offListHits.length;
		const hintsPage = `http://host.docker.internal:${fixturePort}/scope-hints?ip=${encodeURIComponent(offListIp)}`;
		await probe.callTool({ name: 'browser_navigate', arguments: { url: hintsPage } });
		const controls = ['/scope-doc-img.png', 'ip:/scope-doc-ip.png'];
		for (let attempt = 0; attempt < 40; attempt++) {
			if (controls.every((path) => offListHits.slice(hintsFrom).includes(path))) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		// Long enough for a hint to be fetched (measured: well under a second when it is).
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		const hintHits = offListHits.slice(hintsFrom);
		// MB2 C4: the browser did attempt the prefetches — they are in the request log, refused by the answerer — so the
		// zero above is this image's Chromium sending `Sec-Purpose: prefetch` and E-115 judging it, not a hint never made.
		const hintLog = await probe.callTool({ name: 'browser_network_log', arguments: { failed_only: true } });
		const refusedHints = ((hintLog.structuredContent as { entries?: Array<Entry & { path: string }> } | undefined)
			?.entries ?? []).filter((entry) => entry.path.startsWith('/scope-hint-'));
		console.log(
			`[MB2 ${SHAPE}] refused hints in the request log: ${
				JSON.stringify(refusedHints.map((entry) => [entry.origin, entry.path, entry.error_text]))
			}`,
		);
		check(
			'V1/AC17 (MB2 C4): documents — <link rel=prefetch|prerender> to an off-list name and IP literal are not sent',
			controls.every((path) => hintHits.includes(path)) && !hintHits.some((path) => path.includes('/scope-hint-')) &&
				refusedHints.some((entry) => (entry.error_text ?? '').startsWith('net::ERR_BLOCKED_BY_CLIENT')),
			`off-list saw ${JSON.stringify(hintHits)} (the two images are the reachability control); ` +
				`${refusedHints.length} hint(s) refused in the request log`,
		);
	} finally {
		await probe.close();
	}
	// V1 / AC17 (D-138): the `all` scope, in a container of its own.
	if (offListIp !== null) await requestScopeProbe(offListIp);
}

/**
 * V1 / AC17 (D-138, D-139): the request-scope probe pages, served from the host fixture. `/scope-hints` is the
 * `documents` leg's (hints, plus two images as the reachability control); `/scope-all` the `all` leg's — an image, a
 * script, a fetch, a WebSocket and a dedicated worker's fetch to the off-list name and to the IP literal, an on-list
 * image as the positive control, and a fetch to `[::1]:8790` (a listener the probe starts inside its container, MB6).
 */
function requestScopePage(url: URL): Response | null {
	const ip = url.searchParams.get('ip') ?? '';
	const name = `http://${OFF_LIST_HOST}:${url.port}`;
	const literal = `http://${ip}:${url.port}`;
	const page = (body: string): Response =>
		new Response(`<!doctype html><title>scope probe</title><h1 id="scope">scope</h1>${body}`, {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		});
	switch (url.pathname) {
		case '/scope-hints':
			return page(
				`<link rel="prefetch" href="${name}/scope-hint-prefetch?probe=1">` +
					`<link rel="prerender" href="${name}/scope-hint-prerender?probe=1">` +
					`<link rel="prefetch" href="${literal}/scope-hint-ip-prefetch?probe=1">` +
					`<img src="${name}/scope-doc-img.png"><img src="${literal}/scope-doc-ip.png">`,
			);
		case '/scope-all': {
			const aims = [name, literal];
			return page(
				aims.map((origin) => `<img src="${origin}/scope-all-img.png"><script src="${origin}/scope-all.js"></script>`)
					.join('') +
					`<img id="onlist" src="/scope-onlist.png">` +
					'<script>' +
					aims.map((origin) =>
						`fetch('${origin}/scope-all-fetch').catch(()=>{});` +
						`try{new WebSocket('${origin.replace('http:', 'ws:')}/scope-all-ws')}catch(e){}`
					).join('') +
					`new Worker('/scope-worker.js?ip=${encodeURIComponent(ip)}');` +
					`fetch('http://[::1]:${V6_PORT}/healthz',{mode:'no-cors'}).catch(()=>{});` +
					'</script>',
			);
		}
		case '/scope-worker.js':
			return new Response(
				`fetch('${name}/scope-all-worker-fetch').catch(()=>{});fetch('${literal}/scope-all-worker-fetch').catch(()=>{});`,
				{ headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } },
			);
		case '/scope-onlist.png':
			scopeOnList.push(url.pathname);
			return new Response('on', { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
		default:
			return null;
	}
}

/** V1 / AC17: on-list requests the `all` probe page made (the positive control). */
const scopeOnList: string[] = [];

/** V1 / AC17: the `all`-scope probe container, removed by its own probe. */
const SCOPE_CONTAINER = `${CONTAINER}-all`;

/** MB6: the port of the IPv6-loopback listener started inside {@linkcode SCOPE_CONTAINER}. */
const V6_PORT = 8790;

/**
 * V1 / AC17, MB2, MB6 (D-138): in this image's own Chromium, under `TTK_ALLOWED_DOMAINS_SCOPE=all`, a page's image,
 * script, fetch, WebSocket and dedicated-worker fetch aimed at an off-list name and at an IP literal reach the host
 * **0 times**, while an on-list image loads. The allowlist carries `[::1]` too, so the resolver layer is proven still in
 * force with an IPv6 entry (`EXCLUDE ::1`, MB6) — the WebSocket refusals are the layer's alone — and, where the
 * container has an IPv6 loopback, the page's fetch to a listener on `[::1]:8790` inside the container gets an answer.
 *
 * The listener is a second process in this verifier's own probe container: on bundled a bare `deno eval` server (the
 * smallest listener the image can run without restating the gateway's argv), on slim a second `tykotech-mcp serve` on
 * `::1` with its own data dir.
 * The gateway itself cannot bind `::` today (`TTK_HOST=::` fails at the public-URL parse — a residual, not this run's).
 */
async function requestScopeProbe(ip: string): Promise<void> {
	const launched = await run([
		'run',
		'-d',
		'--name',
		SCOPE_CONTAINER,
		'--shm-size=1g',
		`--security-opt=seccomp=${Deno.cwd()}/docker/seccomp-chromium.json`,
		'-p',
		'127.0.0.1::8787',
		'-e',
		`TTK_API_KEYS=${keyRecords}`,
		'-e',
		'TTK_HOST=0.0.0.0',
		'-e',
		'TTK_ALLOWED_DOMAINS=host.docker.internal,[::1]',
		'-e',
		'TTK_ALLOWED_DOMAINS_SCOPE=all',
		'--add-host=host.docker.internal:host-gateway',
		`--add-host=${OFF_LIST_HOST}:host-gateway`,
		IMAGE,
	]);
	if (launched.code !== 0) {
		check('V1/AC17: the all-scope probe container starts', false, launched.stderr.slice(0, 200));
		return;
	}
	try {
		const mapped = await run(['port', SCOPE_CONTAINER, '8787/tcp']);
		const port = Number(/:(\d+)\s*$/m.exec(mapped.stdout)?.[1] ?? NaN);
		if (!(await waitHealthy(port))) {
			const logs = await run(['logs', '--tail', '20', SCOPE_CONTAINER]);
			check('V1/AC17: the all-scope probe container becomes healthy', false, (logs.stdout + logs.stderr).slice(-400));
			return;
		}
		const client = new Client({ name: 'verify-scope', version: '0' }, { versionNegotiation: { mode: 'auto' } });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
				fetch: (input, init) => {
					const headers = new Headers(init?.headers);
					headers.set('Authorization', `Bearer ${rawKey}`);
					return fetch(input, { ...init, headers });
				},
			}),
		);
		try {
			// MB6: an IPv6-loopback listener inside this probe container, so `[::1]` can answer the page.
			await run([
				'exec',
				'-d',
				...(SHAPE === 'slim'
					? ['-e', 'TTK_HOST=::1', '-e', `TTK_PORT=${V6_PORT}`, '-e', 'TTK_DATA_DIR=/tmp/ttk-v6', SCOPE_CONTAINER]
					: [SCOPE_CONTAINER]),
				...(SHAPE === 'slim' ? ['/usr/local/bin/tykotech-mcp', 'serve'] : [
					'deno',
					'eval',
					`Deno.serve({hostname:'::1',port:${V6_PORT},onListen(){}},()=>new Response('v6'))`,
				]),
			]);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			const from = offListHits.length;
			const page = `http://host.docker.internal:${fixturePort}/scope-all?ip=${encodeURIComponent(ip)}`;
			await client.callTool({ name: 'browser_navigate', arguments: { url: page } });
			for (let attempt = 0; attempt < 40 && !scopeOnList.includes('/scope-onlist.png'); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			const hits = offListHits.slice(from);
			type Entry = {
				origin: string;
				status: number | null;
				failed: boolean;
				error_text: string | null;
				resource_type: string;
			};
			const log = await client.callTool({ name: 'browser_network_log', arguments: { limit: 500 } });
			const entries = (log.structuredContent as { entries?: Entry[] } | undefined)?.entries ?? [];
			const blockedByClient = entries.filter((entry) =>
				(entry.error_text ?? '').startsWith('net::ERR_BLOCKED_BY_CLIENT')
			);
			console.log(
				`[V1/AC17 ${SHAPE}] all: off-list saw ${JSON.stringify(hits)}; on-list ${JSON.stringify(scopeOnList)}; ` +
					`${blockedByClient.length} requests failed ${
						JSON.stringify([...new Set(blockedByClient.map((e) => e.error_text))])
					}`,
			);
			check(
				'V1/AC17 (MB2 C1-C3, C7, C8): all — img, script, fetch, WebSocket and worker fetch to an off-list name and an ' +
					'IP literal reach the host 0 times; the on-list image loads',
				hits.length === 0 && scopeOnList.includes('/scope-onlist.png') && blockedByClient.length > 0,
				`off-list saw ${JSON.stringify(hits)}; on-list ${
					JSON.stringify(scopeOnList)
				}; refusals ${blockedByClient.length}`,
			);
			// MB6: is there an IPv6 loopback in this container at all? Only then can `[::1]` answer.
			const inet6 = await run(['exec', SCOPE_CONTAINER, 'cat', '/proc/net/if_inet6']);
			const hasV6Loopback = /^0{31}1\s/m.test(inet6.stdout);
			const v6 = entries.find((entry) => entry.origin === `http://[::1]:${V6_PORT}`);
			console.log(
				`[MB6 ${SHAPE}] IPv6 loopback in the container: ${hasV6Loopback}; [::1]:${V6_PORT} entry ${
					JSON.stringify(v6 ?? null)
				}`,
			);
			check(
				'MB6: with an IPv6 allowlist entry the layer is in force (above), and [::1] answers where the container has it',
				// A status is the answer: the connection to `::1` was made. (A no-cors JSON body may then be withheld from the
				// page by the browser's opaque-response blocking — `net::ERR_ABORTED` after a 200 on slim's JSON `/healthz`.)
				!hasV6Loopback || (v6 !== undefined && v6.status !== null),
				`ipv6 loopback ${hasV6Loopback}; ${JSON.stringify(v6 ?? null)}`,
			);
		} finally {
			await client.close();
		}
	} finally {
		await run(['rm', '-f', SCOPE_CONTAINER]);
	}
}

/**
 * D-137 (AC7, MB4, MB7, N8): the OpenTelemetry egress gate in this image, against two collector stubs on this host
 * (reached from the container as `host.docker.internal`; nothing leaves the machine). Every container it starts is its
 * own and is removed before it returns. The default metric interval (60 s) is kept, so "0 requests" is exact: the
 * pre-gate load window MB8 measured at a 100 ms interval cannot hold a tick.
 *
 * - **Bundled, off-list:** `OTEL_DENO=true` with the endpoint off `TTK_OTEL_ENDPOINTS` → the container exits non-zero,
 *   its log carries the one refusal line, and neither stub receives anything.
 * - **Bundled, listed:** the container becomes healthy, the listed stub receives OTLP, the off-list one nothing. **No
 *   healthcheck-originated export (N8):** the OTLP trace bodies are decoded and every span on `/healthz` is classified
 *   by kind — the gateway's SERVER spans for Docker's probes must be there (the probes ran and were exported), and no
 *   CLIENT span (the probe's own `fetch`) may be. The detector is proven live by running the *old* probe form in the
 *   container (OTEL_DENO inherited): its CLIENT span arrives. Then the shipped form, `/usr/bin/env -u OTEL_DENO …`,
 *   exits 0 (MB7) and adds none.
 * - **Slim:** the compiled binary never exports, so `OTEL_DENO=true` is refused as "not exporting" (MB4) and nothing is
 *   sent.
 */
async function otelProbe(): Promise<void> {
	type Received = { path: string; body: Uint8Array };
	const stub = () => {
		const received: Received[] = [];
		const server = Deno.serve({ hostname: '0.0.0.0', port: 0, onListen: () => {} }, async (request) => {
			received.push({ path: new URL(request.url).pathname, body: new Uint8Array(await request.arrayBuffer()) });
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		});
		return { received, server, origin: `http://host.docker.internal:${(server.addr as Deno.NetAddr).port}` };
	};
	const listed = stub();
	const offList = stub();
	const names: string[] = [];
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const start = async (suffix: string, env: Record<string, string>): Promise<string | null> => {
		const name = `${CONTAINER}-otel-${suffix}`;
		const launched = await run([
			'run',
			'-d',
			'--name',
			name,
			'-e',
			`TTK_API_KEYS=${keyRecords}`,
			'-e',
			'TTK_HOST=0.0.0.0',
			...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
			'--add-host=host.docker.internal:host-gateway',
			IMAGE,
		]);
		if (launched.code !== 0) {
			check(`D-137: the ${suffix} probe container starts`, false, launched.stderr.slice(0, 200));
			return null;
		}
		names.push(name);
		return name;
	};
	/** Waits up to 30 s for a container to stop; its exit code, or null while it still runs. */
	const exited = async (name: string): Promise<number | null> => {
		for (let attempt = 0; attempt < 60; attempt++) {
			const state = await run(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', name]);
			const [status, code] = state.stdout.trim().split(' ');
			if (status === 'exited' || status === 'dead') return Number(code);
			await sleep(500);
		}
		return null;
	};
	const logsOf = async (name: string) => {
		const logs = await run(['logs', name]);
		return `${logs.stdout}${logs.stderr}`;
	};

	// --- a minimal OTLP/protobuf reader: ExportTraceServiceRequest → spans (name 5, kind 6, attributes 9) ---------
	const fieldsOf = (bytes: Uint8Array): Array<{ field: number; value: Uint8Array | number }> => {
		const out: Array<{ field: number; value: Uint8Array | number }> = [];
		let at = 0;
		const varint = (): number => {
			let result = 0;
			let shift = 0;
			while (at < bytes.length) {
				const byte = bytes[at++]!;
				result += (byte & 0x7f) * 2 ** shift;
				if ((byte & 0x80) === 0) break;
				shift += 7;
			}
			return result;
		};
		while (at < bytes.length) {
			const tag = varint();
			const field = Math.floor(tag / 8);
			const wire = tag % 8;
			if (wire === 0) out.push({ field, value: varint() });
			else if (wire === 2) {
				const length = varint();
				out.push({ field, value: bytes.subarray(at, at + length) });
				at += length;
			} else if (wire === 1) at += 8;
			else if (wire === 5) at += 4;
			else break;
		}
		return out;
	};
	const sub = (bytes: Uint8Array, field: number) =>
		fieldsOf(bytes).filter((entry) => entry.field === field && entry.value instanceof Uint8Array)
			.map((entry) => entry.value as Uint8Array);
	const text = (bytes: Uint8Array | undefined) => bytes === undefined ? '' : new TextDecoder().decode(bytes);
	/** Every exported span: its kind (2 SERVER, 3 CLIENT) and its `url.full`. */
	const spans = (received: Received[]) =>
		received.filter((entry) => entry.path === '/v1/traces').flatMap((entry) =>
			sub(entry.body, 1).flatMap((resource) => sub(resource, 2)).flatMap((scope) => sub(scope, 2)).map((span) => {
				const kind = fieldsOf(span).find((entry) => entry.field === 6)?.value;
				const url = sub(span, 9).map((pair) => ({ key: text(sub(pair, 1)[0]), value: sub(pair, 2)[0] }))
					.find((pair) => pair.key === 'url.full');
				return { kind: typeof kind === 'number' ? kind : 0, url: text(url?.value ? sub(url.value, 1)[0] : undefined) };
			})
		);
	const probes = (received: Received[], kind: number) =>
		spans(received).filter((span) => span.kind === kind && span.url === 'http://127.0.0.1:8787/healthz').length;

	try {
		if (SHAPE === 'slim') {
			// MB4: the compiled binary is inactive under OTEL_DENO=true, and the gate says so instead of starting.
			const name = await start('slim', {
				OTEL_DENO: 'true',
				TTK_OTEL_ENDPOINTS: listed.origin,
				OTEL_EXPORTER_OTLP_ENDPOINT: offList.origin,
			});
			if (name === null) return;
			const code = await exited(name);
			const log = await logsOf(name);
			await sleep(3_000);
			check(
				'D-137/MB4: slim refuses OTEL_DENO=true as "not exporting" and exits non-zero',
				code !== null && code !== 0 &&
					log.includes('refusing to start: OTEL_DENO=true but this build is not exporting'),
				`exit ${code}; ${log.trim().slice(0, 160)}`,
			);
			check(
				'D-137: no collector received anything from the refused slim container',
				listed.received.length === 0 && offList.received.length === 0,
				`listed ${listed.received.length}, off-list ${offList.received.length}`,
			);
			return;
		}

		// Bundled, off-list: refused before anything runs.
		const refused = await start('off', {
			OTEL_DENO: 'true',
			TTK_OTEL_ENDPOINTS: listed.origin,
			OTEL_EXPORTER_OTLP_ENDPOINT: offList.origin,
		});
		if (refused !== null) {
			const code = await exited(refused);
			const log = await logsOf(refused);
			await sleep(3_000);
			check(
				'D-137/AC7: an off-list endpoint stops the bundled container with the refusal in its log',
				code !== null && code !== 0 && log.includes('tykotech-mcp: refusing to start: OTEL_EXPORTER_OTLP_ENDPOINT') &&
					log.includes('is not an allowlisted collector'),
				`exit ${code}; ${log.trim().slice(0, 200)}`,
			);
			check(
				'D-137/AC7: neither collector received a request from the refused container',
				listed.received.length === 0 && offList.received.length === 0,
				`listed ${listed.received.map((entry) => entry.path)}, off-list ${offList.received.map((entry) => entry.path)}`,
			);
		}

		// Bundled, listed: healthy, exporting to the listed collector only, and never from its healthcheck.
		const exporting = await start('on', {
			OTEL_DENO: 'true',
			TTK_OTEL_ENDPOINTS: listed.origin,
			OTEL_EXPORTER_OTLP_ENDPOINT: listed.origin,
		});
		if (exporting === null) return;
		let health = '';
		for (let attempt = 0; attempt < 120 && health !== 'healthy' && health !== 'unhealthy'; attempt++) {
			health = (await run(['inspect', '--format', '{{.State.Health.Status}}', exporting])).stdout.trim();
			if (health !== 'healthy') await sleep(1_000);
		}
		check('D-137/AC7: with a listed collector the bundled container becomes healthy', health === 'healthy', health);
		// The batch span processor flushes on a schedule; give the probe's spans (if any) and the server's time to land.
		await sleep(8_000);
		const serverProbes = probes(listed.received, 2);
		const clientProbes = probes(listed.received, 3);
		check(
			'D-137/AC7: the listed collector receives OTLP, the off-list one nothing',
			listed.received.some((entry) => entry.path.startsWith('/v1/')) && offList.received.length === 0,
			`listed ${
				[...new Set(listed.received.map((entry) => entry.path))].join(',')
			}; off-list ${offList.received.length}`,
		);
		check(
			'D-137/AC7/N8: Docker’s health probes were exported as gateway SERVER spans, and none as a probe CLIENT span',
			serverProbes > 0 && clientProbes === 0,
			`/healthz spans: ${serverProbes} server, ${clientProbes} client`,
		);
		// The detector is live: the pre-D-137 probe form, which inherits OTEL_DENO, exports its fetch as a CLIENT span.
		const before = probes(listed.received, 3);
		const oldForm = await run([
			'exec',
			exporting,
			'deno',
			'run',
			'--cached-only',
			'--allow-net=127.0.0.1',
			'--allow-env=TTK_PORT',
			'scripts/healthcheck.ts',
		]);
		await sleep(3_000);
		const afterOld = probes(listed.received, 3);
		check(
			'D-137/N8: control — the old probe form (OTEL_DENO inherited) is seen exporting its CLIENT span',
			oldForm.code === 0 && afterOld > before,
			`exit ${oldForm.code}; client spans ${before} -> ${afterOld}`,
		);
		// MB7 and the shipped form: `/usr/bin/env -u OTEL_DENO` exists in this base, the probe passes, and exports none.
		const shipped = await run([
			'exec',
			exporting,
			'/usr/bin/env',
			'-u',
			'OTEL_DENO',
			'deno',
			'run',
			'--cached-only',
			'--allow-net=127.0.0.1',
			'--allow-env=TTK_PORT',
			'scripts/healthcheck.ts',
		]);
		await sleep(3_000);
		const afterShipped = probes(listed.received, 3);
		check(
			'D-137/MB7: the shipped probe form runs (/usr/bin/env -u in this base), exits 0 and exports no CLIENT span',
			shipped.code === 0 && afterShipped === afterOld,
			`exit ${shipped.code}; client spans ${afterOld} -> ${afterShipped}; ${shipped.stderr.slice(0, 120)}`,
		);
	} finally {
		for (const name of names) await run(['rm', '-f', name]);
		await listed.server.shutdown();
		await offList.server.shutdown();
	}
}

let linksStarted = false;

/** Polls `/healthz` on a published port until it answers ok, for up to a minute. */
async function waitHealthy(port: number): Promise<boolean> {
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
			if (response.ok && (await response.json()).status === 'ok') return true;
			await response.body?.cancel();
		} catch {
			// Not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
}

/** One authenticated REST read on a published port: the status, the raw text and the parsed JSON (or `{}`). */
async function rest(
	port: number,
	path: string,
	key: string,
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${key}` } });
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// Not JSON: the checks below then fail on the fields, naming the text.
	}
	return { status: response.status, text, body };
}

/** The shape `GET /api/v1/agent/providers` answers (design §3.3); `host` and `reason` only for a `model:invoke` holder. */
interface ProvidersBody {
	invocable?: unknown;
	acp?: unknown;
	default?: unknown;
	providers?: Array<Record<string, unknown>>;
}

/**
 * D-143 / D-145 / D-151 (B4, MB7, gate condition 3): the built-in model agent's grant proof, in a container of its own.
 * The fixture names one `openai` provider at `https://api.openai.com/v1` with no key (the parser admits a keyless
 * `openai` provider for local servers, so no secret is needed), so the only question is the grant. Until D-151 the
 * bundled `CMD` granted no provider host and the answer diverged by shape (`reachable: false`, `reason:
 * 'no-net-grant'`, `builtinAgent: false` on bundled); both shapes now grant unscoped net, which proves any host, so
 * both answer `reachable: true` and `builtinAgent: true`. Nothing is dialled either way — reachability is a
 * `Deno.permissions.querySync` at startup, never a request — and this host has no route to the provider that matters
 * here.
 *
 * The file enters the container by `docker create` + `docker cp` + `docker start`: the docker CLI reads the host
 * file itself (no bind mount, no host-path sharing, no write grant for this verifier), and the gateway reads it at
 * `/tmp` under its own `--allow-read=/tmp` (bundled) or bare read grant (slim). The copy is root-owned 0644, which
 * is readable by either image's user; compose mounts secrets 0444, so a parser could never demand 0600 here without
 * breaking that path too.
 */
async function providersProbe(): Promise<void> {
	if (PROVIDERS_FIXTURE === null) {
		console.log('SKIP  D-143: no --providers-fixture given; the builtinAgent leg did not run');
		return;
	}
	const inContainer = '/tmp/ttk_model_providers.json';
	const created = await run([
		'create',
		'--name',
		PROVIDERS_CONTAINER,
		'--shm-size=1g',
		`--security-opt=seccomp=${Deno.cwd()}/docker/seccomp-chromium.json`,
		'-p',
		'127.0.0.1::8787',
		'-e',
		`TTK_API_KEYS=${keyRecords}`,
		'-e',
		'TTK_HOST=0.0.0.0',
		'-e',
		`TTK_MODEL_PROVIDERS_FILE=${inContainer}`,
		IMAGE,
	]);
	providersCreated = created.code === 0;
	if (!providersCreated) {
		check('D-143: the providers container is created', false, created.stderr.slice(0, 200));
		return;
	}
	const copied = await run(['cp', PROVIDERS_FIXTURE, `${PROVIDERS_CONTAINER}:${inContainer}`]);
	check(
		'D-143: the providers fixture is copied into the container before it starts',
		copied.code === 0,
		copied.code === 0 ? PROVIDERS_FIXTURE : copied.stderr.slice(0, 200),
	);
	if (copied.code !== 0) return;
	const launched = await run(['start', PROVIDERS_CONTAINER]);
	if (launched.code !== 0) {
		check('D-143: the providers container starts', false, launched.stderr.slice(0, 200));
		return;
	}
	const mapped = await run(['port', PROVIDERS_CONTAINER, '8787/tcp']);
	const port = Number(/:(\d+)\s*$/m.exec(mapped.stdout)?.[1] ?? NaN);
	const healthy = Number.isInteger(port) && await waitHealthy(port);
	if (!healthy) {
		const logs = await run(['logs', '--tail', '20', PROVIDERS_CONTAINER]);
		check(
			'D-143: the container becomes healthy with the providers file (the parser accepted the fixture)',
			false,
			(logs.stdout + logs.stderr).slice(-400),
		);
		return;
	}
	check('D-143: the container becomes healthy with the providers file (the parser accepted the fixture)', true, '');

	// MB7 / §3.7: the diagnostics fact — the same in both shapes since D-151, asserted for each.
	const diagnostics = await rest(port, '/api/v1/system/diagnostics', adminKey);
	const config = (diagnostics.body as { config?: { modelProviders?: unknown; builtinAgent?: unknown } }).config;
	check(
		`D-151: the ${SHAPE} image reports builtinAgent: true — its unscoped --allow-net proves the provider host`,
		diagnostics.status === 200 && config?.builtinAgent === true,
		`status=${diagnostics.status} builtinAgent=${JSON.stringify(config?.builtinAgent ?? null)}`,
	);
	check(
		'D-143 §3.7: diagnostics list the provider as id, kind, model count and reachability — nothing else',
		JSON.stringify(config?.modelProviders) ===
			JSON.stringify([{ id: 'openai-main', kind: 'openai', models: 1, reachable: true }]),
		JSON.stringify(config?.modelProviders ?? null).slice(0, 200),
	);

	// §3.3: a `model:invoke` holder sees the map of its world — the host, and no reason, since nothing is withheld.
	const held = await rest(port, '/api/v1/agent/providers', modelKey);
	const heldBody = held.body as ProvidersBody;
	const provider = heldBody.providers?.[0];
	check(
		`D-143 §3.3 / D-151: on ${SHAPE} the provider is reachable and carries no reason`,
		held.status === 200 && heldBody.invocable === true && heldBody.default === 'openai-main' &&
			heldBody.providers?.length === 1 && provider?.id === 'openai-main' && provider.kind === 'openai' &&
			provider.host === 'api.openai.com:443' && JSON.stringify(provider.models) === '["gpt-4.1"]' &&
			provider.default_model === 'gpt-4.1' && provider.reachable === true && !('reason' in provider),
		held.text.slice(0, 240),
	);
	check(
		'D-143 §3.3: the providers route never shows the base URL path or scheme',
		held.status === 200 && !held.text.includes('/v1') && !held.text.includes('https://'),
		'',
	);
	// Gate F9: without the scope, the list — and no host, no reason.
	const plain = await rest(port, '/api/v1/agent/providers', agentKey);
	const plainBody = plain.body as ProvidersBody;
	const listed = plainBody.providers?.[0];
	check(
		'D-143 gate F9: a caller without model:invoke sees the provider listed, with no host and no reason',
		plain.status === 200 && plainBody.invocable === false && listed?.id === 'openai-main' &&
			listed.reachable === true && !('host' in listed) && !('reason' in listed),
		plain.text.slice(0, 240),
	);
}

try {
	// --- start the container -------------------------------------------------
	const seccompPath = `${Deno.cwd()}/docker/seccomp-chromium.json`;
	const started_ = await run([
		'run',
		'-d',
		'--name',
		CONTAINER,
		'--shm-size=1g',
		`--security-opt=seccomp=${seccompPath}`,
		'-p',
		// An ephemeral host port, read back below: never 8787, never a fixed number another run could hold.
		'127.0.0.1::8787',
		'-e',
		`TTK_API_KEYS=${keyRecords}`,
		'-e',
		'TTK_HOST=0.0.0.0',
		'-e',
		'TTK_LOG_LEVEL=info',
		...Object.entries(CHILD_ENV_PROBE).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
		'-e',
		`HTTPS_PROXY=${PROXY_PROBE}`,
		// `docs.example` too, so the `browser_head` probe below still fails at DNS — not at this proxy (D-053, D-151).
		'-e',
		'NO_PROXY=host.docker.internal,localhost,127.0.0.1,docs.example',
		// The fixture lives on the host; from inside the container that is the
		// gateway address Docker Desktop provides.
		'--add-host=host.docker.internal:host-gateway',
		IMAGE,
	]);
	if (started_.code !== 0) {
		console.error(`docker run failed: ${started_.stderr}`);
		Deno.exit(1);
	}
	started = true;
	const mapped = await run(['port', CONTAINER, '8787/tcp']);
	const HOST_PORT = Number(/:(\d+)\s*$/m.exec(mapped.stdout)?.[1] ?? NaN);
	if (!Number.isInteger(HOST_PORT)) throw new Error(`no host port mapped for 8787: ${mapped.stdout}${mapped.stderr}`);

	// --- AC23 / M10: nothing in the image or the container turns the Chromium sandbox off -----------------
	// The only switch is `TTK_CHROMIUM_NO_SANDBOX` (§2.1), and a shipped image must never carry it set.
	const envOf = async (kind: 'image' | 'container', ref: string): Promise<string[]> => {
		const inspected = await run([kind, 'inspect', '--format', '{{json .Config.Env}}', ref]);
		return inspected.code === 0 ? JSON.parse(inspected.stdout) as string[] : [`<inspect failed: ${inspected.stderr}>`];
	};
	for (const [kind, ref] of [['image', IMAGE], ['container', CONTAINER]] as const) {
		const env = await envOf(kind, ref);
		const unsandboxed = env.filter((entry) => {
			const [name, ...value] = entry.split('=');
			return name === 'TTK_CHROMIUM_NO_SANDBOX' && TRUTHY.test(value.join('=').trim());
		});
		check(
			`AC23: the ${kind} environment does not set TTK_CHROMIUM_NO_SANDBOX`,
			unsandboxed.length === 0 && !env.some((entry) => entry.startsWith('<inspect failed')),
			unsandboxed.join(' ') || `${env.length} variables`,
		);
	}

	// --- wait for health -----------------------------------------------------
	let healthy = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${HOST_PORT}/healthz`, {
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) {
				const body = await response.json();
				healthy = body.status === 'ok';
				if (healthy) break;
			} else {
				await response.body?.cancel();
			}
		} catch {
			// Not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	check('container becomes healthy', healthy);
	if (!healthy) {
		const logs = await run(['logs', CONTAINER]);
		console.error(logs.stdout.slice(-3000));
		console.error(logs.stderr.slice(-3000));
		throw new Error('container never became healthy');
	}

	// --- the SPA is served ---------------------------------------------------
	const spa = await fetch(`http://127.0.0.1:${HOST_PORT}/`);
	const spaBody = await spa.text();
	check('live-view SPA is served', spa.ok && spaBody.includes('TykoTech-MCP'), `${spa.status}`);

	// --- unauthenticated access is refused ------------------------------------
	const anon = await fetch(`http://127.0.0.1:${HOST_PORT}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
	});
	await anon.body?.cancel();
	check('MCP refuses an unauthenticated call', anon.status === 401, `status=${anon.status}`);

	// --- drive a real browser -------------------------------------------------
	const client = new Client({ name: 'verify', version: '0' }, { versionNegotiation: { mode: 'auto' } });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HOST_PORT}/mcp`), {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${rawKey}`);
				return fetch(input, { ...init, headers });
			},
		}),
	);

	// --- R14 (D-122, AC17): registry-ready identity -------------------------------------------------------------
	// The OCI ownership label the MCP Registry reads, on the image itself, naming server.json's `name`.
	const registryName = (JSON.parse(await Deno.readTextFile('server.json')) as { name: string }).name;
	const labels = await run(['image', 'inspect', '--format', '{{json .Config.Labels}}', IMAGE]);
	const label = labels.code === 0
		? (JSON.parse(labels.stdout) as Record<string, string> | null)?.['io.modelcontextprotocol.server.name']
		: undefined;
	check(
		'AC17: the image carries the io.modelcontextprotocol.server.name label from server.json',
		label === registryName,
		`label=${String(label)} expected=${registryName}`,
	);
	// The identity the server reports, and the icon it names served without a credential.
	const info = client.getServerVersion();
	const iconSrc = info?.icons?.[0]?.src ?? '';
	// D-122 as amended by review B3: this container binds 0.0.0.0 with no TTK_PUBLIC_URL, so the public URL's host is a
	// wildcard address no client can reach — the server then names no website and no icon (stdio's shape), while the
	// favicon itself is still served publicly (checked below on its fixed path).
	check(
		'AC16 / B3: serverInfo carries the title and the description, and no website or icon on a wildcard bind',
		info?.title === 'Multi-MCP' && typeof info.description === 'string' && info.websiteUrl === undefined &&
			info.icons === undefined,
		JSON.stringify(info),
	);
	const icon = await fetch(
		`http://127.0.0.1:${HOST_PORT}${new URL(iconSrc || 'http://x/assets/brand/icon-192.png').pathname}`,
	);
	const iconBody = new Uint8Array(await icon.arrayBuffer());
	check(
		'AC16: the icon is served publicly as PNG',
		icon.ok && iconBody[1] === 0x50 && iconBody[2] === 0x4e && iconBody[3] === 0x47,
		`${icon.status}`,
	);
	const instructions = client.getInstructions() ?? '';
	check(
		'AC16: the instructions are present and at most 2 KiB',
		instructions !== '' && new TextEncoder().encode(instructions).byteLength <= 2048,
		`${instructions.length} chars`,
	);

	const tools = await client.listTools();
	const names = tools.tools.map((tool) => tool.name);
	// **The egress-dependent tools are the same in both shapes since D-151.**
	//
	// D-053 found the two images serving different catalogs: the slim binary
	// bakes a bare `--allow-net` (`scripts/compile.ts`; a compiled binary cannot
	// be re-flagged at launch), the bundled `CMD` granted only the bind and
	// loopback, and `browser_head`'s availability predicate — a
	// `Deno.permissions.query` on a public host — answered differently. D-151
	// (owner-approved) gave the bundled `CMD` the same unscoped grant, so both
	// shapes now offer `browser_head`, and the checks below assert that for each:
	// either image drifting back to a scoped grant fails this tier.
	// The image serves exactly what the code says a scope-less key record holds in this shape (C3): the catalog
	// and the library's tools, filtered by `DEFAULT_SCOPES` and by the availability this shape's matrix proves. The
	// key record above omits `scopes` entirely — the credential shape SEC-01b changed — so `browser_evaluate` and
	// `browser_run_task` (explicit scopes) are absent, and so is every tool behind a scope the default grant lacks.
	// Compared as a set, by name: this tier was silently red for two revisions on a bare count, because a count
	// cannot say which tool arrived or left. The count is printed for the record.
	const expected = expectedTools();
	const missing = expected.filter((name) => !names.includes(name));
	const unexpected = names.filter((name) => !expected.includes(name));
	check(
		`the default key sees exactly the ${expected.length} tools the code derives for the ${SHAPE} shape`,
		missing.length === 0 && unexpected.length === 0,
		`served ${names.length}; missing [${missing.join(',')}]; unexpected [${unexpected.join(',')}]`,
	);
	check(
		'browser_close_all follows the default grant: offered only while DEFAULT_SCOPES holds admin',
		names.includes('browser_close_all') === DEFAULT_SCOPES.includes('admin'),
		`DEFAULT_SCOPES=${DEFAULT_SCOPES.join(',')}`,
	);
	check(
		'SEC-01b: a key record naming no scopes does not hold the autonomous loop',
		!names.includes('browser_run_task'),
		names.join(','),
	);
	check(
		'browser_health is served by the shipped image (B3.2)',
		names.includes('browser_health'),
		names.join(','),
	);
	check(
		'browser_evaluate is not offered without an explicit grant, in the real image (B2.7)',
		!names.includes('browser_evaluate'),
		names.join(','),
	);
	// Asserted per shape, so neither image can drift into a narrower grant unnoticed.
	check(
		`D-053 / D-151: browser_head IS offered by the ${SHAPE} image — its net grant is unscoped`,
		names.includes('browser_head'),
		'',
	);
	const headRefused = await client.callTool({ name: 'browser_head', arguments: { url: 'https://docs.example/x' } });
	const headError = (headRefused.structuredContent as { error?: { code?: string; feature?: string } } | undefined)
		?.error;
	const headText = JSON.stringify(headRefused.content);
	check(
		// The host does not resolve, so the dial fails at DNS. That it reached DNS at
		// all is the point: the permission gate let it through, in both shapes now.
		`D-053 / D-151: a browser_head call in the ${SHAPE} image reaches the network and fails at DNS, not at the gate`,
		headRefused.isError === true && headError?.code !== 'feature-unavailable',
		headText.slice(0, 160),
	);
	// B1.7's event-ring tool, which needs no HTTP transport of its own.
	check('the event-ring tool is offered in the image', names.includes('browser_wait_for'), '');
	check('the B1.12 download tool is offered in the image', names.includes('browser_download'), '');
	check('recording is offered in the image', names.includes('browser_record'), '');
	check('persistence is offered in the image', names.includes('browser_storage_state'), '');
	check(
		'file retrieval is offered in the image',
		names.includes('browser_list_files') && names.includes('browser_get_file'),
		'',
	);

	// --- D-143 (B4): the providers route and the diagnostics facts with no providers file, in both shapes -------
	// Neither image ships a providers file, so both report nothing configured and no built-in agent; the route sits
	// behind `agent:invoke`, which the default grant lacks, so the scope-less key is refused before any list.
	const providersRefused = await rest(HOST_PORT, '/api/v1/agent/providers', rawKey);
	check(
		'D-143 §3.3: GET /api/v1/agent/providers is 403 forbidden-scope for a key without agent:invoke',
		providersRefused.status === 403 && providersRefused.text.includes('forbidden-scope'),
		`status=${providersRefused.status}`,
	);
	const providersListed = await rest(HOST_PORT, '/api/v1/agent/providers', agentKey);
	check(
		'D-143 §3.3: with agent:invoke the route answers the empty list, invocable: false, acp: false, default: null',
		providersListed.status === 200 &&
			JSON.stringify(providersListed.body) === '{"invocable":false,"acp":false,"default":null,"providers":[]}',
		providersListed.text.slice(0, 160),
	);
	const providersHeld = await rest(HOST_PORT, '/api/v1/agent/providers', modelKey);
	check(
		'D-143 §3.3: with model:invoke too the route answers invocable: true and the same empty list',
		providersHeld.status === 200 &&
			JSON.stringify(providersHeld.body) === '{"invocable":true,"acp":false,"default":null,"providers":[]}',
		providersHeld.text.slice(0, 160),
	);
	const diagnosticsNoFile = await rest(HOST_PORT, '/api/v1/system/diagnostics', adminKey);
	const configNoFile = (diagnosticsNoFile.body as { config?: { modelProviders?: unknown; builtinAgent?: unknown } })
		.config;
	check(
		`D-143 §3.7: with no providers file the ${SHAPE} image reports builtinAgent: false and modelProviders: []`,
		diagnosticsNoFile.status === 200 && configNoFile?.builtinAgent === false &&
			JSON.stringify(configNoFile?.modelProviders) === '[]',
		`status=${diagnosticsNoFile.status} builtinAgent=${JSON.stringify(configNoFile?.builtinAgent ?? null)} ` +
			`modelProviders=${JSON.stringify(configNoFile?.modelProviders ?? null)}`,
	);

	const target = `http://host.docker.internal:${fixturePort}/`;
	const navigated = await client.callTool({ name: 'browser_navigate', arguments: { url: target } });
	const navText = JSON.stringify(navigated.content);
	check('sandboxed Chromium navigates', navigated.isError !== true, navText.slice(0, 160));

	// --- AC23 / M10: the running Chromium carries no sandbox-weakening flag -----------------------------
	// Read from the container's own /proc while the browser is up, as NUL-separated argv, one process per line.
	const procs = await run([
		'exec',
		CONTAINER,
		'sh',
		'-c',
		'for f in /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; printf "\\n"; done',
	]);
	// Chromium rewrites its children's process titles, which collapses their argv into one space-separated string,
	// so each command line is tokenized on NUL *and* whitespace; a flag is always a token of its own either way.
	const chromium = procs.stdout.split('\n')
		.map((line) => line.split('\0').flatMap((arg) => arg.split(/\s+/)).filter((token) => token !== ''))
		.filter((argv) => {
			const name = argv[0]?.split('/').pop() ?? '';
			return /chrom/i.test(name) && !/crashpad/i.test(name);
		});
	const browserProcesses = chromium.filter((argv) => !argv.some((arg) => arg.startsWith('--type=')));
	const offending = chromium.flatMap((argv) =>
		argv.filter((arg) => (SANDBOX_DENYLIST as readonly string[]).includes(arg.split('=')[0]!.toLowerCase()))
	);
	check(
		'AC23: a Chromium browser process is running, so the flag check below is not vacuous',
		procs.code === 0 && browserProcesses.length > 0,
		`${chromium.length} chromium processes, ${browserProcesses.length} browser; ${procs.stderr.slice(0, 120)}`,
	);
	check(
		'AC23: no running Chromium process carries a sandbox-weakening flag',
		offending.length === 0,
		offending.join(' ') || `checked ${chromium.length} processes against ${SANDBOX_DENYLIST.length} flags`,
	);
	// --- AC25 / M4 (D-127): Chromium's environment blanks the exporter and secret names, and keeps the proxy -------
	// Read from `/proc/<pid>/environ` of every Chromium process the container's user may read, beside the gateway's own
	// so the check proves the names were set where the overrides had something to override.
	const environs = await procEnvirons(CONTAINER, /chrom/i);
	const browserEnv = environs.find((entry) => !entry.argv.some((arg) => arg.startsWith('--type=')));
	const gatewayEnv = (await procEnvirons(CONTAINER, /deno|tykotech-mcp/)).find((entry) =>
		entry.env.has('TTK_API_KEYS')
	);
	check(
		'AC25: the gateway itself holds the inline secret and exporter names the overrides target',
		gatewayEnv !== undefined && (gatewayEnv.env.get('TTK_API_KEYS') ?? '') !== '' &&
			gatewayEnv.env.get('OTEL_EXPORTER_OTLP_HEADERS') === CHILD_ENV_PROBE.OTEL_EXPORTER_OTLP_HEADERS,
		gatewayEnv === undefined ? 'no gateway process environment was readable' : `pid ${gatewayEnv.pid}`,
	);
	// D-143 / D-145 (B4, MB8): the three model-key names were set on the gateway (so the blanks below are not vacuous)
	// and are blank — absent or empty, as the leak check below reads it — in every Chromium process the container's
	// user can read. The launch overrides drop the names rather than passing them empty.
	check(
		'AC25 / MB8 (D-143): the gateway holds the three model-key marker values the overrides target',
		gatewayEnv !== undefined && MODEL_KEY_NAMES.every((name) => gatewayEnv.env.get(name) === CHILD_ENV_PROBE[name]),
		gatewayEnv === undefined ? '' : MODEL_KEY_NAMES.map((name) => `${name}=${gatewayEnv.env.has(name)}`).join(' '),
	);
	check(
		'AC25 / MB8 (D-143): ANTHROPIC_API_KEY, OPENAI_API_KEY and TTK_MODEL_API_KEY are blank in every Chromium environ',
		environs.length > 0 &&
			environs.every((entry) => MODEL_KEY_NAMES.every((name) => (entry.env.get(name) ?? '') === '')),
		environs.flatMap((entry) =>
			MODEL_KEY_NAMES.filter((name) => entry.env.get(name) !== '').map((name) =>
				`${entry.pid}:${name}=${JSON.stringify(entry.env.get(name) ?? null)}`
			)
		).join(' ') || `${environs.length} chromium environs, ${MODEL_KEY_NAMES.length} names each`,
	);
	const leaks = environs.flatMap((entry) =>
		CHILD_ENV_BLANKED.filter((name) => (entry.env.get(name) ?? '') !== '').map((name) => `${entry.pid}:${name}`)
	);
	check(
		'AC25 / M4: no Chromium process holds a value for an OTel or inline-secret name',
		browserEnv !== undefined && leaks.length === 0,
		browserEnv === undefined
			? `no browser process environment was readable (${environs.length} chromium environs)`
			: leaks.join(' ') || `${environs.length} chromium environs, ${CHILD_ENV_BLANKED.length} names each`,
	);
	const overridden = [...Object.keys(CHILD_ENV_PROBE), 'TTK_API_KEYS'];
	check(
		'AC25 / M4: the overridden names are present and empty in the browser process (overridden, not cleared)',
		browserEnv !== undefined && overridden.every((name) => browserEnv.env.get(name) === ''),
		browserEnv === undefined
			? ''
			: overridden.map((name) => `${name}=${JSON.stringify(browserEnv.env.get(name) ?? null)}`).join(' '),
	);
	check(
		'AC25 / M4: HTTPS_PROXY on the gateway reaches Chromium unchanged (no clearEnv)',
		browserEnv?.env.get('HTTPS_PROXY') === PROXY_PROBE && browserEnv?.env.get('NO_PROXY') !== undefined,
		`HTTPS_PROXY=${JSON.stringify(browserEnv?.env.get('HTTPS_PROXY') ?? null)}`,
	);

	// The server's own account of its Chromium posture (`capabilities.tykotech.browser.sandboxed`, D-094) must say
	// sandboxed in a shipped image. Read from `ttk://capabilities`: the SDK client strips the vendor key from the
	// `initialize` capabilities, so reading it there would always see `undefined` and pass vacuously.
	const capabilityResource = await client.readResource({ uri: 'ttk://capabilities' });
	const capabilityText = capabilityResource.contents[0] !== undefined && 'text' in capabilityResource.contents[0]
		? String(capabilityResource.contents[0].text)
		: '{}';
	const sandboxed = (JSON.parse(capabilityText) as { browser?: { sandboxed?: unknown } }).browser?.sandboxed;
	check(
		'AC23: the server reports a sandboxed browser',
		sandboxed === true,
		`ttk://capabilities browser.sandboxed=${String(sandboxed)}`,
	);

	const state = await client.callTool({ name: 'browser_get_state', arguments: {} });
	const stateText = JSON.stringify(state.content);
	// The nonce exists only on the host fixture page for this run.
	check('the page nonce round-trips through the container', stateText.includes(nonce), `nonce=${nonce}`);

	const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
	const hasImage = (shot.content as Array<{ type: string }>).some((block) => block.type === 'image');
	check('a screenshot is captured inside the container', shot.isError !== true && hasImage);

	// --- R16: a real download lands in the container's own /data volume -------
	// The image grants --allow-write=/data,/tmp,/home/deno, so this also proves
	// the session's download directory is allocated somewhere the server may write.
	const textOf = (result: { content: unknown }): string =>
		(result.content as Array<{ type: string; text?: string }>).find((block) => block.type === 'text')?.text ?? '';
	const elements = (JSON.parse(textOf(state)) as {
		interactive_elements: Array<{ index: number; tag: string; href?: string }>;
	}).interactive_elements;
	const exportLink = elements.find((element) => element.tag === 'a' && (element.href ?? '').includes('/attachment'));
	check(
		'the export link is offered by the page state',
		exportLink !== undefined,
		JSON.stringify(elements).slice(0, 120),
	);

	type ContainerFile = { file_id: string; name: string; size: number; status: string; available: boolean };
	let file: ContainerFile | undefined;
	if (exportLink !== undefined) {
		await client.callTool({ name: 'browser_click', arguments: { index: exportLink.index } });
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const listing = JSON.parse(
				textOf(await client.callTool({ name: 'browser_list_files', arguments: {} })),
			) as { files: ContainerFile[] };
			file = listing.files.find((entry) => entry.status === 'completed');
			if (file !== undefined || listing.files.some((entry) => entry.status === 'failed')) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	check(
		'a clicked attachment is captured inside the container',
		file?.available === true && file?.name === 'container-report.txt',
		JSON.stringify(file ?? null),
	);

	if (file !== undefined) {
		const inline = await client.callTool({ name: 'browser_get_file', arguments: { file_id: file.file_id } });
		const resource = (inline.content as Array<{ type: string; resource?: { blob?: string } }>)
			.find((block) => block.type === 'resource')?.resource;
		const inlineBytes = new TextDecoder().decode(decodeBase64(resource?.blob ?? ''));
		check('the download round-trips inline through MCP', inlineBytes === fileNonce, `${inlineBytes.slice(0, 12)}...`);

		const fileUrl = `http://127.0.0.1:${HOST_PORT}/api/v1/sessions/default/files/${file.file_id}`;
		const overHttp = await fetch(fileUrl, { headers: { authorization: `Bearer ${rawKey}` } });
		const disposition = overHttp.headers.get('content-disposition') ?? '';
		const httpBytes = await overHttp.text();
		check(
			'the same bytes stream over the authenticated file route',
			overHttp.ok && httpBytes === fileNonce && disposition.startsWith('attachment'),
			`${overHttp.status}, ${disposition}`,
		);

		const anonymous = await fetch(fileUrl);
		await anonymous.body?.cancel();
		check('the file route refuses an unauthenticated read', anonymous.status === 401, `status=${anonymous.status}`);
	}

	// --- R7: record a real video inside the container -------------------------
	const recStart = await client.callTool({
		name: 'browser_record',
		arguments: { action: 'start', name: 'verify' },
	});
	check('recording starts', recStart.isError !== true, JSON.stringify(recStart.content).slice(0, 160));
	// AC25 (D-127): the encoder is a child too, and gets the same blank overrides while it runs.
	const ffmpegEnv = (await procEnvirons(CONTAINER, /ffmpeg/)).find((entry) => entry.argv.includes('libvpx-vp9'));
	const ffmpegLeaks = ffmpegEnv === undefined
		? []
		: CHILD_ENV_BLANKED.filter((name) => (ffmpegEnv.env.get(name) ?? '') !== '');
	check(
		'AC25: the running ffmpeg holds no value for an OTel, inline-secret or model-key name, and keeps the proxy',
		ffmpegEnv !== undefined && ffmpegLeaks.length === 0 && ffmpegEnv.env.get('TTK_API_KEYS') === '' &&
			MODEL_KEY_NAMES.every((name) => ffmpegEnv.env.get(name) === '') &&
			ffmpegEnv.env.get('HTTPS_PROXY') === PROXY_PROBE,
		ffmpegEnv === undefined ? 'no ffmpeg process environment was readable' : ffmpegLeaks.join(' ') || 'blank',
	);

	// Make the page paint, so the encoder has something other than one frame.
	for (let i = 0; i < 4; i++) {
		await client.callTool({ name: 'browser_scroll', arguments: { direction: 'down', pages: 0.2 } });
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	const recStop = await client.callTool({ name: 'browser_record', arguments: { action: 'stop' } });
	const stopped = JSON.parse(
		(recStop.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '{}',
	) as { frames?: number; bytes?: number; url?: string };
	check(
		'ffmpeg encodes a non-empty video',
		recStop.isError !== true && (stopped.bytes ?? 0) > 0 && (stopped.frames ?? 0) > 0,
		`${stopped.frames ?? 0} frames, ${stopped.bytes ?? 0} bytes`,
	);

	const video = await fetch(`http://127.0.0.1:${HOST_PORT}${stopped.url ?? '/api/v1/recordings/verify'}`, {
		headers: { authorization: `Bearer ${rawKey}` },
	});
	const videoBytes = new Uint8Array(await video.arrayBuffer());
	// EBML magic: the file is a real Matroska/WebM container, not a stub.
	check(
		'the recording downloads as a real WebM',
		video.ok && videoBytes[0] === 0x1a && videoBytes[1] === 0x45 && videoBytes[2] === 0xdf && videoBytes[3] === 0xa3,
		`${video.status}, ${videoBytes.length} bytes`,
	);

	await client.close();

	// --- the CDP port is not published -----------------------------------------
	// Asked of the container's own port map rather than by probing the host:
	// anything else on the machine could be listening on 9222 and turn this
	// into a false alarm.
	const ports = await run(['port', CONTAINER]);
	const published = ports.stdout.split('\n').filter((line) => line.trim() !== '');
	check(
		'only 8787 is published',
		published.every((line) => line.startsWith('8787/')),
		published.join(' ') || '(none)',
	);

	// --- no secret material in the image ---------------------------------------
	const history = await run(['history', '--no-trunc', IMAGE]);
	check('no credential material in image layers', !history.stdout.includes('ttk_'), '');

	// --- R3 (W1): pre-request containment in this image's own Chromium ------------
	await containmentProbe();
	await otelProbe();
	// --- D-143 / D-145 (B4): the providers file in this shape, when a fixture is given ------------
	await providersProbe();

	// --- W2 (R10/R11; AC10, F24): signed links, PDF and performance in a container of their own -------------
	// A separate start with `TTK_SIGNED_LINKS=true` and no link-key file, so the key is generated at startup. D-154:
	// it is sealed in `/data/ttk.db` with the vault key `tests/container/db-key.fixture` (a test-only key, copied in
	// before the start as the providers fixture is), never written as a plaintext file; the database's mode is POSIX,
	// which is why AC10 is proven here and not on the Windows unit tier.
	const linksStart = await run([
		'create',
		'--name',
		LINKS_CONTAINER,
		'--shm-size=1g',
		`--security-opt=seccomp=${seccompPath}`,
		'-p',
		'127.0.0.1::8787',
		'-e',
		`TTK_API_KEYS=${keyRecords}`,
		'-e',
		'TTK_HOST=0.0.0.0',
		'-e',
		'TTK_SIGNED_LINKS=true',
		'-e',
		'TTK_DB_KEY_FILE=/tmp/ttk_db_key',
		'--add-host=host.docker.internal:host-gateway',
		IMAGE,
	]);
	if (linksStart.code === 0) {
		const keyCopied = await run(['cp', 'tests/container/db-key.fixture', `${LINKS_CONTAINER}:/tmp/ttk_db_key`]);
		const started = keyCopied.code === 0 ? await run(['start', LINKS_CONTAINER]) : keyCopied;
		linksStart.code = started.code;
		linksStart.stderr = started.stderr;
	}
	linksStarted = linksStart.code === 0;
	check('W2: a container with TTK_SIGNED_LINKS=true starts', linksStarted, linksStart.stderr.slice(0, 160));
	if (linksStarted) {
		const linksMapped = await run(['port', LINKS_CONTAINER, '8787/tcp']);
		const LINKS_PORT = Number(/:(\d+)\s*$/m.exec(linksMapped.stdout)?.[1] ?? NaN);
		const linksHealthy = Number.isInteger(LINKS_PORT) && await waitHealthy(LINKS_PORT);
		check('W2: it becomes healthy with a generated link-signing key', linksHealthy, `port ${LINKS_PORT}`);
		if (!linksHealthy) {
			const logs = await run(['logs', LINKS_CONTAINER]);
			console.error(logs.stdout.slice(-2000));
			console.error(logs.stderr.slice(-2000));
		} else {
			const stat = await run(['exec', LINKS_CONTAINER, 'stat', '-c', '%a', '/data/ttk.db']);
			const plain = await run(['exec', LINKS_CONTAINER, 'ls', '/data']);
			check(
				'AC10/D-154: the generated link key is sealed in a 0600 database, never a plaintext file',
				stat.code === 0 && stat.stdout.trim() === '600' && !plain.stdout.includes('link-signing.key'),
				`stat -c %a /data/ttk.db -> ${stat.stdout.trim() || stat.stderr.trim()}; /data: ${
					plain.stdout.trim().split(/\s+/).join(' ')
				}`,
			);
			const linksClient = new Client({ name: 'verify-links', version: '0' }, { versionNegotiation: { mode: 'auto' } });
			await linksClient.connect(
				new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${LINKS_PORT}/mcp`), {
					fetch: (input, init) => {
						const headers = new Headers(init?.headers);
						headers.set('Authorization', `Bearer ${rawKey}`);
						return fetch(input, { ...init, headers });
					},
				}),
			);
			try {
				const linkNames = (await linksClient.listTools()).tools.map((tool) => tool.name);
				const linkExpected = expectedTools({ signedLinks: true });
				const linkMissing = linkExpected.filter((name) => !linkNames.includes(name));
				const linkUnexpected = linkNames.filter((name) => !linkExpected.includes(name));
				check(
					`W2/F24: with signed links on, the default key sees exactly the ${linkExpected.length} tools the code derives`,
					linkMissing.length === 0 && linkUnexpected.length === 0 && linkNames.includes('browser_file_link'),
					`served ${linkNames.length}; missing [${linkMissing.join(',')}]; unexpected [${linkUnexpected.join(',')}]`,
				);
				const opened = await linksClient.callTool({
					name: 'browser_navigate',
					arguments: { url: `http://host.docker.internal:${fixturePort}/` },
				});
				check(
					'W2: the links container navigates',
					opened.isError !== true,
					JSON.stringify(opened.content).slice(0, 120),
				);
				const textOfResult = (result: { content: unknown }): string =>
					(result.content as Array<{ type: string; text?: string }>).find((block) => block.type === 'text')?.text ??
						'';
				const printed = await linksClient.callTool({ name: 'browser_pdf', arguments: { delivery: 'file' } });
				const pdfFile = (printed.structuredContent as { file?: { file_id?: string; size?: number } } | undefined)
					?.file;
				check(
					'W2/AC7: the image’s Chromium prints the page to a PDF kept as an art- file',
					printed.isError !== true && (pdfFile?.file_id ?? '').startsWith('art-') && (pdfFile?.size ?? 0) > 0,
					textOfResult(printed).slice(0, 160),
				);
				if (pdfFile?.file_id !== undefined) {
					const minted = await linksClient.callTool({
						name: 'browser_file_link',
						arguments: { file_id: pdfFile.file_id },
					});
					const linkUrl = (minted.structuredContent as { url?: string } | undefined)?.url ?? '';
					const parsed = URL.parse(linkUrl);
					// The link is built from the configured public URL; the verifier reaches it on the published port.
					const local = parsed === null ? '' : `http://127.0.0.1:${LINKS_PORT}${parsed.pathname}${parsed.search}`;
					const downloaded = local === '' ? null : await fetch(local);
					const head = downloaded === null ? '' : new TextDecoder().decode(
						new Uint8Array(await downloaded.arrayBuffer()).slice(0, 5),
					);
					check(
						'W2/AC9: the signed link downloads the PDF with no bearer',
						downloaded?.status === 200 && head === '%PDF-' &&
							downloaded.headers.get('referrer-policy') === 'no-referrer',
						`${downloaded?.status ?? 'no link'} ${JSON.stringify(head)}`,
					);
				}
				const perf = await linksClient.callTool({ name: 'browser_performance', arguments: {} });
				const perfOut = perf.structuredContent as {
					vitals_world?: string | null;
					vitals?: { fcp_ms?: number | null };
					runtime?: { nodes?: number | null };
				} | undefined;
				check(
					'W2/M7: in the image’s Chromium the vitals resolve in an isolated world, with runtime metrics',
					perf.isError !== true && perfOut?.vitals_world === 'isolated' && typeof perfOut.vitals?.fcp_ms === 'number' &&
						(perfOut.runtime?.nodes ?? 0) > 0,
					textOfResult(perf).slice(0, 200),
				);
			} finally {
				await linksClient.close();
			}
		}
	}
} finally {
	await fixture.shutdown();
	if (started) {
		await run(['rm', '-f', CONTAINER]);
	}
	if (probeStarted) await run(['rm', '-f', PROBE_CONTAINER]);
	if (providersCreated) await run(['rm', '-f', PROVIDERS_CONTAINER]);
	if (linksStarted) {
		await run(['rm', '-f', LINKS_CONTAINER]);
	}
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} container checks passed`);
Deno.exit(failed.length === 0 ? 0 : 1);
