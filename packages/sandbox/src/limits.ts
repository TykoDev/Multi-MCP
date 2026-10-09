/**
 * The sandbox's limits, in one place. They are constants rather than settings: the compose file
 * gives the container 1 GB of memory, two CPUs and 512 processes, and these are sized to fit in it.
 */
export const LIMITS = {
	/** A command's time limit when the caller names none, and the range it may ask for. */
	defaultTimeoutMs: 5 * 60_000,
	minTimeoutMs: 1_000,
	maxTimeoutMs: 15 * 60_000,
	/** Output kept per command: the first half and the last half of this many bytes. */
	outputBytes: 1024 * 1024,
	/**
	 * Everything one run may keep on the work volume: its checkout, home and /tmp.
	 * Docker volumes have no quotas, so this is measured before and after each command, and watched
	 * while it runs (SB-1, disk.ts).
	 */
	diskBudgetBytes: 1536 * 1024 * 1024,
	/**
	 * SB-1: everything one owner's workspaces may keep together. Without it the per-run budget only
	 * slows a principal down: 128 workspaces at 1.5 GiB each would still fill most disks.
	 */
	ownerDiskBytes: 4 * 1536 * 1024 * 1024,
	/**
	 * A command is stopped when the volume's free space falls below this, whoever is filling it:
	 * the database shares the disk, and a full disk stops everything, not just the sandbox.
	 */
	minFreeBytes: 1024 * 1024 * 1024,
	/**
	 * How often a running cage's free space is checked (SB-1): what a command can write between two
	 * checks is what it can overshoot its budget by, so this is short; a check is one statfs.
	 */
	diskPollMs: 250,
	/**
	 * SB-1: how far past its allowance the volume may fall before the run's files are measured again;
	 * keeps a busy disk from turning every check into a du.
	 */
	diskTriggerBytes: 8 * 1024 * 1024,
	/**
	 * SB-1: what other writers on the volume (the gateway's database, logs) may account for while a
	 * cage runs alone. Beyond this, loss the cage's files do not explain is charged to the cage.
	 */
	diskNoiseBytes: 256 * 1024 * 1024,
	/** Commands (and diffs) running at once; more wait their turn, up to a point. */
	running: 2,
	waiting: 8,
	maxWaitMs: 120_000,
	/**
	 * Live shell sessions (D-076): long-lived cages beside the command cages, counted apart from them so an
	 * open terminal never takes a command slot. Idle and lifetime bounds end a forgotten one; the output ring
	 * holds what a reader has not collected yet; one session per workspace.
	 */
	sessionsRunning: 4,
	sessionIdleMs: 30 * 60_000,
	sessionLifetimeMs: 4 * 60 * 60_000,
	sessionOutputBytes: 256 * 1024,
	sessionReadWaitMs: 10_000,
	sessionInputBytes: 16 * 1024,
	/**
	 * Processes and threads one cage may have, live sessions included. The container has 512 for everything: two
	 * cages at this limit still leave room for the service itself. The Docker backend (D-108) applies it as the
	 * workspace container's `PidsLimit` instead.
	 */
	cageProcesses: 200,
	/** Request sizes. */
	bodyBytes: 512 * 1024,
	commandBytes: 16 * 1024,
	stdinBytes: 256 * 1024,
	cwdChars: 400,
	envEntries: 32,
	envValueBytes: 4096,
	/** A diff's patch text; past this, whole files are left out and the reply says so. */
	patchBytes: 8 * 1024 * 1024,
	/**
	 * SB-6: the most one reply may take as JSON. Escaping can make text six times longer (a control
	 * byte becomes \u0001), so a diff is cut to fit this rather than to patchBytes alone; the client
	 * accepts a little more than this.
	 */
	responseBytes: 9 * 1024 * 1024,
	/** Files a diff lists. */
	diffFiles: 5000,
	diffTimeoutMs: 2 * 60_000,
	/** The housekeeping cages: measuring disk use, restoring permissions, the start-up check. */
	choreTimeoutMs: 60_000,
	/**
	 * SB-3: housekeeping cages started for requests that hold no command slot (file writes, removal,
	 * the sweep) run this many at once, with this many waiting; a command's own housekeeping runs
	 * under its slot.
	 */
	choreRunning: 4,
	choreWaiting: 32,
	/**
	 * SB-4: a checkout or run state with no owner record (a crash during creation or removal) is
	 * removed once nothing has touched it for this long, by a sweep this often.
	 */
	orphanAgeMs: 3_600_000,
	sweepEveryMs: 3_600_000,
	/**
	 * D-108: the Docker backend stops a workspace's container after this long with nothing running in it; the next
	 * operation starts it again. Removing the workspace removes it.
	 */
	containerIdleMs: 10 * 60_000,
	/** Tunnels one command may hold open through the registry proxy at once. */
	proxyTunnels: 64,
	/** Hosts the proxy refused, as listed back in one reply. */
	refusedHostsListed: 20,
	/** SB-9: refusals one command's proxy logs one by one; past this, a running total once a minute. */
	refusalsLogged: 20,
} as const;
