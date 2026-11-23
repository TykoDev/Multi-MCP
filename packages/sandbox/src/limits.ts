/**
 * The sandbox's limits, in one place. Constants rather than settings: the compose file gives the container 1 GB of
 * memory, two CPUs and 512 processes, and these are sized to fit in it.
 */
export const LIMITS = {
	/** A command's time limit by default, and the range it may ask for. */
	defaultTimeoutMs: 5 * 60_000,
	minTimeoutMs: 1_000,
	maxTimeoutMs: 15 * 60_000,
	/** Output kept per command: the first and last half of this many bytes. */
	outputBytes: 1024 * 1024,
	/** One run's checkout, home and /tmp. Volumes have no quotas, so this is measured and watched (disk.ts). */
	diskBudgetBytes: 1536 * 1024 * 1024,
	/** One owner's workspaces together; without it 128 workspaces would still fill most disks. */
	ownerDiskBytes: 4 * 1536 * 1024 * 1024,
	/** Any command stops when free space falls below this: the database shares the disk. */
	minFreeBytes: 1024 * 1024 * 1024,
	/** Free-space poll while a cage runs; what a command writes between polls is its possible overshoot. */
	diskPollMs: 250,
	/** How far past its allowance the volume may fall before the run is measured again (keeps du rare). */
	diskTriggerBytes: 8 * 1024 * 1024,
	/** What other writers may account for while a cage runs alone; loss beyond it is charged to the cage. */
	diskNoiseBytes: 256 * 1024 * 1024,
	/** Commands (and diffs) running at once, waiting, and for how long. */
	running: 2,
	waiting: 8,
	maxWaitMs: 120_000,
	/** Live shell sessions, counted apart from commands so a terminal never takes a command slot. */
	sessionsRunning: 4,
	/** Sessions one owner may hold, so one `sandbox:execute` holder cannot take every slot. */
	ownerSessions: 2,
	/** Commands one owner may have running or queued for a slot, and how many more may wait behind them. */
	ownerRunning: 1,
	ownerWaiting: 4,
	sessionIdleMs: 30 * 60_000,
	sessionLifetimeMs: 4 * 60 * 60_000,
	sessionOutputBytes: 256 * 1024,
	sessionReadWaitMs: 10_000,
	sessionInputBytes: 16 * 1024,
	/** Processes per cage (sessions included), or the container's `PidsLimit` under Docker. */
	cageProcesses: 200,
	bodyBytes: 512 * 1024,
	commandBytes: 16 * 1024,
	stdinBytes: 256 * 1024,
	cwdChars: 400,
	envEntries: 32,
	envValueBytes: 4096,
	/** A diff's patch text; past this, whole files are left out and the reply says so. */
	patchBytes: 8 * 1024 * 1024,
	/** One reply as JSON: escaping can grow text sixfold, so a diff is cut to fit this; the client allows a little more. */
	responseBytes: 9 * 1024 * 1024,
	diffFiles: 5000,
	diffTimeoutMs: 2 * 60_000,
	/** Housekeeping cages (measuring, repairs, the start-up check). */
	choreTimeoutMs: 60_000,
	/** Housekeeping for requests without a command slot (writes, removal, the sweep). */
	choreRunning: 4,
	choreWaiting: 32,
	/** Leftovers of a crash (no owner record) untouched this long are removed by a sweep this often. */
	orphanAgeMs: 3_600_000,
	sweepEveryMs: 3_600_000,
	/** The Docker backend stops an idle workspace container after this long. */
	containerIdleMs: 10 * 60_000,
	/** Tunnels one command may hold open through the registry proxy. */
	proxyTunnels: 64,
	/** Refused hosts listed back in one reply. */
	refusedHostsListed: 20,
	/** Refusals logged one by one per command; past this, a running total once a minute. */
	refusalsLogged: 20,
} as const;
