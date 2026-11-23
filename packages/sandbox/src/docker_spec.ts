/**
 * What the Docker backend asks the Engine for and runs inside a workspace container; pure, so tests run anywhere.
 *
 * The Engine socket is root on the host, so no body is ever composed from a request: each is built from fixed values
 * and checked again — key allowlist, forbidden list, every field's fixed value — by `checkCreateBody` /
 * `checkExecBody`, which the Engine client calls before sending (a failure is `invalid_request`, never sent).
 *
 * A container is the bwrap cage made long-lived: its own volume subpaths only (`/workspace`, `/workspace/.git`
 * read-only, `/home/sandbox`, `/run/harbour` read-only), a read-only root with a 256 MiB `/tmp`, `NetworkMode: none`,
 * no capabilities, `no-new-privileges`, uid 1993, resource limits, and `sleep infinity` under Docker's init.
 */
import { BASE_ENV, CAGE_HOME, PROXY_PORT, PROXY_SOCKET, proxyEnv, WORKSPACE } from './cage.ts';
import { LIMITS } from './limits.ts';
import { RESERVED_ENV, RUN_ID } from './request.ts';

/** The uid and gid every workspace process runs as: the cage's `sandbox` user. */
export const WORKSPACE_USER = '1993:1993';
/** Where a workspace container sees its socket-volume subpath; the proxy's socket is PROXY_SOCKET inside it. */
export const HARBOUR_DIR = '/run/harbour';
/** A container is named `ttk-sandbox-<deployment>-<workspace>`, so a restarted service finds it again. */
export const CONTAINER_PREFIX = 'ttk-sandbox-';
export const LABEL_SANDBOX = 'eu.tykotech.sandbox';
export const LABEL_WORKSPACE = 'eu.tykotech.workspace';
export const LABEL_OWNER = 'eu.tykotech.owner';
/** The deployment a container belongs to ({@linkcode deploymentId}); reconciliation touches its own only. */
export const LABEL_DEPLOYMENT = 'eu.tykotech.deployment';
/** The SHA-256 of the canonical create body, so a container whose body differs from today's is replaced. */
export const LABEL_BODY = 'eu.tykotech.body';
export const TMPFS_OPTIONS = 'rw,nosuid,nodev,size=256m';
export const CONTAINER_MEMORY = 1024 * 1024 * 1024;
export const CONTAINER_NANO_CPUS = 1_000_000_000;
/** Where the diff stages its index and objects: on the volume, as bwrap's /tmp is; the container's /tmp is small. */
export const DOCKER_DIFF_SCRATCH = `${CAGE_HOME}/.harbour-diff`;
/** The start-up volume proof's file, in the check container's own home, never a workspace's. */
export const VOLUME_CHECK_FILE = '.harbour-volume-check';
/** The owner label of the start-up check's container: no principal hashes to it, so no owner record ever names it. */
export const CHECK_OWNER = '0'.repeat(64);

/** Fields that must never appear in a create body, at its top or in `HostConfig`. */
export const FORBIDDEN_FIELDS = [
	'Binds',
	'Devices',
	'DeviceRequests',
	'CapAdd',
	'PidMode',
	'IpcMode',
	'UTSMode',
	'UsernsMode',
	'CgroupnsMode',
	'PortBindings',
	'PublishAllPorts',
	'VolumesFrom',
	'Links',
	'ExtraHosts',
	'Sysctls',
	'Runtime',
] as const;

const CREATE_KEYS = ['Image', 'User', 'Cmd', 'Env', 'WorkingDir', 'Labels', 'HostConfig'] as const;
const HOST_KEYS = [
	'Mounts',
	'NetworkMode',
	'ReadonlyRootfs',
	'Tmpfs',
	'CapDrop',
	'SecurityOpt',
	'Privileged',
	'Memory',
	'MemorySwap',
	'NanoCpus',
	'PidsLimit',
	'Init',
] as const;
const EXEC_KEYS = [
	'Cmd',
	'Env',
	'WorkingDir',
	'User',
	'Privileged',
	'Tty',
	'AttachStdin',
	'AttachStdout',
	'AttachStderr',
] as const;

/** The deployment's fixed choices: the image and the two named volumes (TTK_SANDBOX_*; see settings.ts). */
export interface DockerPolicy {
	image: string;
	/** The code volume, mounted at the service's work folder. */
	volume: string;
	/** The socket volume, mounted at the service's socket folder. */
	sockVolume: string;
}

export interface VolumeMount {
	Type: 'volume';
	Source: string;
	Target: string;
	ReadOnly: boolean;
	VolumeOptions: { NoCopy: true; Subpath: string };
}

export interface CreateBody {
	Image: string;
	User: string;
	Cmd: string[];
	Env: string[];
	WorkingDir: string;
	Labels: Record<string, string>;
	HostConfig: {
		Mounts: VolumeMount[];
		NetworkMode: 'none';
		ReadonlyRootfs: true;
		Tmpfs: Record<string, string>;
		CapDrop: string[];
		SecurityOpt: string[];
		Privileged: false;
		Memory: number;
		MemorySwap: number;
		NanoCpus: number;
		PidsLimit: number;
		Init: true;
	};
}

export interface ExecBody {
	Cmd: string[];
	Env: string[];
	WorkingDir: string;
	User: string;
	Privileged: false;
	Tty: false;
	AttachStdin: boolean;
	AttachStdout: true;
	AttachStderr: true;
}

/** What a body is built for. */
export interface WorkspaceTarget {
	policy: DockerPolicy;
	runId: string;
	/** The workspace owner's hash (SHA-256 of the principal), as the owner record keeps it. */
	owner: string;
	/** Whether the checkout has its `.git` yet: the provisioning container, which runs `git init`, has not. */
	git: boolean;
	/** This deployment's id, {@linkcode deploymentId} of the code volume. */
	deployment: string;
}

/** A target with its body's hash ({@linkcode createFor}), so the check can rebuild every fixed value and compare. */
export interface CreateFor extends WorkspaceTarget {
	/** SHA-256 (hex) of the canonical body without its own hash label. */
	bodyHash: string;
}

/** A body the Engine client will not send; `field` names what was wrong, never a value. */
export class BodyRefused extends Error {
	constructor(readonly field: string, why: string) {
		super(`Docker request refused: ${field} ${why}`);
		this.name = 'BodyRefused';
	}
}

/** A workspace container's name, scoped to its deployment. */
export const containerName = (deployment: string, runId: string): string => `${CONTAINER_PREFIX}${deployment}-${runId}`;

const OWNER = /^[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEPLOYMENT = /^[0-9a-f]{16}$/;

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A deployment's id: 16 hex digits of the SHA-256 of its code volume's name. It scopes container names and
 * reconciliation; two deployments sharing a code volume would share every workspace, so they must not.
 */
export async function deploymentId(volume: string): Promise<string> {
	return (await sha256(volume)).slice(0, 16);
}

/** JSON with every object's keys sorted, so equal bodies hash equally whatever order they were built in. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isRecord(value)) {
		return `{${
			Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')
		}}`;
	}
	return JSON.stringify(value);
}

/** The target with the hash of the body it builds (without the hash's own label). */
export async function createFor(target: WorkspaceTarget): Promise<CreateFor> {
	return { ...target, bodyHash: await sha256(canonicalJson(unlabelledBody(target))) };
}

/** `BASE_ENV` as Docker's `NAME=value` list, in its own order. */
export function envList(env: Readonly<Record<string, string>>): string[] {
	return Object.entries(env).map(([name, value]) => `${name}=${value}`);
}

/**
 * The workspace's mounts: daemon-resolved volume subpaths (no host path), each `NoCopy`. `/workspace/.git` appears
 * once the checkout has one (provisioning's `git init` runs before). `/run/harbour` is read-only: connecting to the
 * socket needs no write, and a writable folder would hold data outside the measured budget.
 */
export function workspaceMounts(policy: DockerPolicy, runId: string, git: boolean): VolumeMount[] {
	const mount = (source: string, target: string, readOnly: boolean, subpath: string): VolumeMount => ({
		Type: 'volume',
		Source: source,
		Target: target,
		ReadOnly: readOnly,
		VolumeOptions: { NoCopy: true, Subpath: subpath },
	});
	return [
		mount(policy.volume, WORKSPACE, false, runId),
		...(git ? [mount(policy.volume, `${WORKSPACE}/.git`, true, `${runId}/.git`)] : []),
		mount(policy.volume, CAGE_HOME, false, `.sandbox/${runId}/home`),
		mount(policy.sockVolume, HARBOUR_DIR, true, runId),
	];
}

/** The folders a workspace container may write: the two the disk budget measures, and nothing else. */
export const WRITABLE_TARGETS: readonly string[] = [WORKSPACE, CAGE_HOME];

/** The create body for one workspace, from fixed values only, without the hash label. */
function unlabelledBody(target: WorkspaceTarget): CreateBody {
	return {
		Image: target.policy.image,
		User: WORKSPACE_USER,
		Cmd: ['sleep', 'infinity'],
		Env: envList(BASE_ENV),
		WorkingDir: WORKSPACE,
		Labels: {
			[LABEL_SANDBOX]: '1',
			[LABEL_WORKSPACE]: target.runId,
			[LABEL_OWNER]: target.owner,
			[LABEL_DEPLOYMENT]: target.deployment,
		},
		HostConfig: {
			Mounts: workspaceMounts(target.policy, target.runId, target.git),
			NetworkMode: 'none',
			ReadonlyRootfs: true,
			Tmpfs: { '/tmp': TMPFS_OPTIONS },
			CapDrop: ['ALL'],
			SecurityOpt: ['no-new-privileges:true'],
			Privileged: false,
			Memory: CONTAINER_MEMORY,
			MemorySwap: CONTAINER_MEMORY,
			NanoCpus: CONTAINER_NANO_CPUS,
			PidsLimit: LIMITS.cageProcesses,
			Init: true,
		},
	};
}

/** The create body for one workspace, from fixed values only, labelled with its own hash. */
export function containerBody(target: CreateFor): CreateBody {
	const body = unlabelledBody(target);
	body.Labels[LABEL_BODY] = target.bodyHash;
	return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON values, key order ignored. */
export function sameJson(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
	}
	if (isRecord(a) || isRecord(b)) {
		if (!isRecord(a) || !isRecord(b)) return false;
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
	}
	return a === b;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new BodyRefused(`${where}${key}`, 'is not a field this backend sends');
	}
}

function forbidden(value: Record<string, unknown>, where: string): void {
	for (const key of FORBIDDEN_FIELDS) {
		if (Object.hasOwn(value, key)) throw new BodyRefused(`${where}${key}`, 'is forbidden');
	}
}

function fixed(value: unknown, expected: unknown, field: string): void {
	if (!sameJson(value, expected)) throw new BodyRefused(field, 'differs from its fixed value');
}

/**
 * Checks a create body before it is sent: nothing forbidden or outside the allowlist, every field its fixed value.
 * The named invariants are checked on their own too, so a mistake in `containerBody` cannot pass by agreeing.
 */
export function checkCreateBody(body: unknown, target: CreateFor): CreateBody {
	if (!isRecord(body)) throw new BodyRefused('body', 'must be an object');
	if (!RUN_ID.test(target.runId)) throw new BodyRefused('Labels', 'names no workspace');
	if (!OWNER.test(target.owner)) throw new BodyRefused('Labels', 'names no owner');
	if (!DEPLOYMENT.test(target.deployment)) throw new BodyRefused('Labels', 'names no deployment');
	if (!HASH.test(target.bodyHash)) throw new BodyRefused('Labels', 'carries no body hash');
	forbidden(body, '');
	const host = body.HostConfig;
	if (!isRecord(host)) throw new BodyRefused('HostConfig', 'must be an object');
	forbidden(host, 'HostConfig.');
	onlyKeys(body, CREATE_KEYS, '');
	onlyKeys(host, HOST_KEYS, 'HostConfig.');
	// The invariants a reader of the security model looks for, by name.
	if (host.Privileged !== false) throw new BodyRefused('HostConfig.Privileged', 'must be false');
	if (host.NetworkMode !== 'none') throw new BodyRefused('HostConfig.NetworkMode', 'must be none');
	if (host.ReadonlyRootfs !== true) throw new BodyRefused('HostConfig.ReadonlyRootfs', 'must be true');
	if (body.User !== WORKSPACE_USER) throw new BodyRefused('User', `must be ${WORKSPACE_USER}`);
	const options = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [];
	if (options.some((o) => typeof o !== 'string' || /unconfined|label[=:]disable/i.test(o))) {
		throw new BodyRefused('HostConfig.SecurityOpt', 'must not disable a security profile');
	}
	const mounts = Array.isArray(host.Mounts) ? host.Mounts : [];
	for (const mount of mounts) {
		if (!isRecord(mount) || mount.Type !== 'volume') {
			throw new BodyRefused('HostConfig.Mounts', 'may hold named volumes only');
		}
		const subpath = isRecord(mount.VolumeOptions) ? mount.VolumeOptions.Subpath : undefined;
		if (typeof subpath !== 'string' || subpath.startsWith('/') || subpath.split('/').some((s) => s === '..')) {
			throw new BodyRefused('HostConfig.Mounts', 'must mount a subpath inside its volume');
		}
		// Whatever a workspace can write is inside the folders its disk budget measures.
		if (mount.ReadOnly !== true && !WRITABLE_TARGETS.includes(String(mount.Target))) {
			throw new BodyRefused('HostConfig.Mounts', 'may write only the workspace and its home');
		}
	}
	const expected = containerBody(target);
	for (const key of CREATE_KEYS) {
		if (key !== 'HostConfig') fixed(body[key], expected[key], key);
	}
	for (const key of HOST_KEYS) fixed(host[key], expected.HostConfig[key], `HostConfig.${key}`);
	return body as unknown as CreateBody;
}

// --- execs ---------------------------------------------------------------------------------------------------

/**
 * Every exec starts through this wrapper: it runs the work in a session of its own (`setsid`), reports its pid and
 * the work's session on stderr, and waits, so the exit status is the work's. The session is what the kill targets
 * and what a cleanup spares.
 */
export const WRAPPER = [
	'exec 3<&0',
	's=$1',
	'shift',
	'setsid /bin/sh -c "$s" harbour-sandbox "$@" <&3 3<&- &',
	'echo "harbour-cage-ready $$ $!" >&2',
	'exec 3<&-',
	'wait "$!"',
].join('\n');

/** What the wrapper says on stderr once the work is started: its own pid, and the work's session id. */
export const READY_LINE = /^harbour-cage-ready (\d+) (\d+)$/m;

/** Kills a process group at once; no `--`, which dash's builtin `kill` reads as a pid. */
export const KILL_SCRIPT = 'kill -KILL "-$1" 2>/dev/null\nexit 0';

/**
 * Kills every process in the container except PID 1's session, the wrapper pids in `$1` and the sessions in `$2`
 * (execs still running), as a cage's pid namespace would; builtins only, the count to stdout. It ends only after two
 * passes in a row find no candidate — a process that forks and exits between scan and kill would fool "a pass that
 * killed nothing" — counting unreadable stats and zombies whose parent is not spared. Fifty passes without that
 * proof exit 3 and PID 1's stat unreadable exits 2; either way the service stops the container.
 */
export const CLEANUP_SCRIPT = [
	'kp=" $1 $$ "',
	'ks=" $2 "',
	'read -r s 2>/dev/null </proc/1/stat || exit 2',
	's=${s##*) }',
	's=${s#* }',
	's=${s#* }',
	's=${s#* }',
	'ks="$ks${s%% *} "',
	'n=0',
	'quiet=0',
	'pass=0',
	'while [ "$pass" -lt 50 ]; do',
	'  pass=$((pass + 1))',
	'  c=0',
	'  for d in /proc/[0-9]*; do',
	'    p=${d#/proc/}',
	'    [ "$p" = 1 ] && continue',
	'    case $kp in *" $p "*) continue ;; esac',
	'    if ! read -r s 2>/dev/null <"$d/stat"; then',
	'      c=$((c + 1))',
	'      continue',
	'    fi',
	'    s=${s##*) }',
	'    st=${s%% *}',
	'    s=${s#* }',
	'    pp=${s%% *}',
	'    s=${s#* }',
	'    s=${s#* }',
	'    case $ks in *" ${s%% *} "*) continue ;; esac',
	'    case $st in Z*)',
	'      if read -r q 2>/dev/null <"/proc/$pp/stat"; then',
	'        q=${q##*) }',
	'        q=${q#* }',
	'        q=${q#* }',
	'        q=${q#* }',
	'        case $ks in *" ${q%% *} "*) continue ;; esac',
	'      fi',
	'      c=$((c + 1))',
	'      continue',
	'      ;;',
	'    esac',
	'    c=$((c + 1))',
	'    kill -KILL "$p" 2>/dev/null && n=$((n + 1))',
	'  done',
	'  if [ "$c" -eq 0 ]; then',
	'    quiet=$((quiet + 1))',
	'    if [ "$quiet" -ge 2 ]; then',
	'      echo "$n"',
	'      exit 0',
	'    fi',
	'  else',
	'    quiet=0',
	'  fi',
	'done',
	'echo "$n"',
	'exit 3',
].join('\n');

/** The work must lead its own session or the kill and cleanup could not tell it apart; stderr joins stdout. */
const SESSION_CHECK = [
	'read -r s </proc/$$/stat || exit 125',
	's=${s##*) }',
	's=${s#* }',
	's=${s#* }',
	'case $s in "$$ $$ "*) ;; *) echo "harbour-sandbox: no session of its own" >&2; exit 125 ;; esac',
	'exec 2>&1',
].join('\n');

export interface InnerOptions {
	/** The registry proxy's forwarder: socat from 127.0.0.1:3128 to the proxy socket, as in a cage. */
	proxy?: boolean;
	/** The work reads the exec's standard input; otherwise it reads /dev/null. */
	stdin?: boolean;
	/** The run is over its budget, so nothing it starts may write file data. */
	noGrowth?: boolean;
}

/**
 * The work's script: the session check, the cage's prelude lines, then `body`. No `ulimit -p`: without a user
 * namespace it would count every uid-1993 process on the host; `PidsLimit` bounds the container instead.
 */
export function innerScript(body: string, options: InnerOptions = {}): string {
	const lines = [SESSION_CHECK];
	if (!options.stdin) lines.push('exec </dev/null');
	lines.push('echo 1000 >/proc/self/oom_score_adj');
	if (options.proxy) {
		const port = PROXY_PORT.toString(16).toUpperCase().padStart(4, '0');
		lines.push(
			`socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${PROXY_SOCKET} </dev/null >/dev/null 2>&1 &`,
			'n=0',
			`until grep -q '0100007F:${port} 00000000:0000 0A' /proc/net/tcp; do`,
			`  n=$((n + 1)); if [ "$n" -gt 500 ]; then echo 'harbour-sandbox: the registry proxy did not start'; exit 125; fi`,
			'  sleep 0.01',
			'done',
		);
	}
	if (options.noGrowth) lines.push(`trap '' XFSZ`, 'ulimit -c 0', 'ulimit -f 0');
	lines.push(body);
	return lines.join('\n');
}

/** A request's command line: the caller's text arrives as `$1`, never inside the script. */
export const COMMAND_BODY = 'exec /bin/sh -c "$1"';
/** A live session's shell: it reads what the service writes to the exec's standard input. */
export const SESSION_BODY = 'exec /bin/sh -s';

/** Gives the owner read, write and search back throughout the checkout, so git can stage what a command locked. */
export const REPAIR_BODY = `chmod -R u+rwX ${WORKSPACE} 2>/dev/null\nexit 0`;

/** Reads the volume check file the service wrote into its check container's home (never a workspace's). */
export const VOLUME_CHECK_BODY = `cat ${CAGE_HOME}/${VOLUME_CHECK_FILE} 2>/dev/null`;

/** The fixed outer scripts an exec may start, and nothing else. */
const OUTER_SCRIPTS: readonly string[] = [WRAPPER, KILL_SCRIPT, CLEANUP_SCRIPT];
const PID = /^[1-9][0-9]{0,9}$/;
const PID_LIST = /^(?:[1-9][0-9]{0,9}(?: [1-9][0-9]{0,9})*)?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXEC_ARG_BYTES = 64 * 1024;

/** An exec body from its parts; `cmd` follows `/bin/sh -c`. */
export function execBody(
	parts: { cmd: string[]; env: Record<string, string>; workdir: string; stdin: boolean },
): ExecBody {
	return {
		Cmd: ['/bin/sh', '-c', ...parts.cmd],
		Env: envList(parts.env),
		WorkingDir: parts.workdir,
		User: WORKSPACE_USER,
		Privileged: false,
		Tty: false,
		AttachStdin: parts.stdin,
		AttachStdout: true,
		AttachStderr: true,
	};
}

function checkWorkdir(value: unknown): void {
	if (value === '/' || value === WORKSPACE) return;
	if (typeof value !== 'string' || !value.startsWith(`${WORKSPACE}/`)) {
		throw new BodyRefused('WorkingDir', 'must be the workspace or a folder in it');
	}
	for (const segment of value.slice(WORKSPACE.length + 1).split('/')) {
		if (
			segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' ||
			/[\0\\]/.test(segment)
		) throw new BodyRefused('WorkingDir', 'must be a plain folder in the workspace');
	}
}

function checkEnv(value: unknown): void {
	if (!Array.isArray(value)) throw new BodyRefused('Env', 'must be a list');
	const seen = new Set<string>();
	const proxy = proxyEnv();
	let extra = 0;
	for (const entry of value) {
		const at = typeof entry === 'string' ? entry.indexOf('=') : -1;
		if (at <= 0) throw new BodyRefused('Env', 'must hold NAME=value entries');
		const name = (entry as string).slice(0, at);
		const content = (entry as string).slice(at + 1);
		if (!ENV_NAME.test(name) || seen.has(name)) throw new BodyRefused('Env', 'holds a bad or repeated name');
		seen.add(name);
		if (content.includes('\0') || new TextEncoder().encode(content).length > LIMITS.envValueBytes) {
			throw new BodyRefused('Env', 'holds a value that is too long or has NUL');
		}
		if (Object.hasOwn(proxy, name)) {
			if (content !== proxy[name]) throw new BodyRefused('Env', `${name} differs from its fixed value`);
			continue;
		}
		if (Object.hasOwn(BASE_ENV, name)) {
			// The cage's identity is fixed; its other defaults (CI, LANG, NO_COLOR...) a request may change, as in bwrap.
			if (RESERVED_ENV.has(name.toUpperCase()) && content !== BASE_ENV[name]) {
				throw new BodyRefused('Env', `${name} differs from its fixed value`);
			}
			continue;
		}
		if (RESERVED_ENV.has(name.toUpperCase())) throw new BodyRefused('Env', `${name} is set by the sandbox itself`);
		extra++;
	}
	for (const name of Object.keys(BASE_ENV)) {
		if (!seen.has(name)) throw new BodyRefused('Env', `lacks ${name}`);
	}
	// A request's own variables, plus TTK_PATH for a file operation.
	if (extra > LIMITS.envEntries + 1) throw new BodyRefused('Env', 'holds too many variables');
}

/**
 * Checks an exec body before it is sent: allowlisted keys, the fixed user, never privileged or a TTY, a fixed outer
 * script with arguments of its shape, the cage's environment, a working folder in the workspace.
 */
export function checkExecBody(body: unknown): ExecBody {
	if (!isRecord(body)) throw new BodyRefused('body', 'must be an object');
	onlyKeys(body, EXEC_KEYS, '');
	if (body.User !== WORKSPACE_USER) throw new BodyRefused('User', `must be ${WORKSPACE_USER}`);
	if (body.Privileged !== false) throw new BodyRefused('Privileged', 'must be false');
	if (body.Tty !== false) throw new BodyRefused('Tty', 'must be false');
	if (body.AttachStdout !== true || body.AttachStderr !== true) {
		throw new BodyRefused('AttachStdout', 'output must be attached');
	}
	if (typeof body.AttachStdin !== 'boolean') throw new BodyRefused('AttachStdin', 'must be true or false');
	const cmd = body.Cmd;
	if (
		!Array.isArray(cmd) || cmd.length < 4 || cmd.some((part) => typeof part !== 'string' || part.includes('\0'))
	) throw new BodyRefused('Cmd', 'must be a shell and its arguments');
	if (cmd[0] !== '/bin/sh' || cmd[1] !== '-c') throw new BodyRefused('Cmd', 'must start /bin/sh -c');
	if (!OUTER_SCRIPTS.includes(cmd[2] as string)) throw new BodyRefused('Cmd', 'must run one of the fixed scripts');
	if (cmd[3] !== 'harbour-sandbox') throw new BodyRefused('Cmd', 'must name the sandbox as $0');
	const args = cmd.slice(4) as string[];
	if (args.reduce((sum, arg) => sum + arg.length, 0) > EXEC_ARG_BYTES + LIMITS.commandBytes) {
		throw new BodyRefused('Cmd', 'is too long');
	}
	if (cmd[2] === KILL_SCRIPT && (args.length !== 1 || !PID.test(args[0]!) || args[0] === '1')) {
		throw new BodyRefused('Cmd', 'must kill one process group');
	}
	if (cmd[2] === CLEANUP_SCRIPT && (args.length !== 2 || !args.every((a) => PID_LIST.test(a)))) {
		throw new BodyRefused('Cmd', 'must name the pids and sessions to keep');
	}
	if (cmd[2] === WRAPPER && (args.length < 1 || !args[0]!.startsWith(SESSION_CHECK))) {
		throw new BodyRefused('Cmd', 'must start its work in a session of its own');
	}
	checkEnv(body.Env);
	checkWorkdir(body.WorkingDir);
	return body as unknown as ExecBody;
}

/** The exec start body: attached, never a TTY. Fixed; the Engine client sends nothing else. */
export const EXEC_START = { Detach: false, Tty: false } as const;
