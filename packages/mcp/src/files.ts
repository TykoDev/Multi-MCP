/**
 * Session files: the read side of the download pipeline (E-33; MCP-FILE-TOOL-PLAN.md).
 *
 * `DownloadsWatchdog` is the authoritative transfer ledger — it saw every
 * `downloadWillBegin`, validated every completed file, and owns the limits. This
 * module adds only what retrieval needs on top of it: a wire-safe view of a
 * record, a bounded read for inline delivery, a leased stream for HTTP delivery,
 * and the lifetime of the session's download directory. It never scans the
 * directory, never trusts a caller-supplied id as a path, and re-validates the
 * file at read time because "was a regular file inside the directory when it
 * completed" is not the same claim as "is one now".
 */
import { extname, join } from '@std/path';
import { crypto } from '@std/crypto';
import { encodeHex } from '@std/encoding/hex';
import {
	DOWNLOAD_TRANSFER_DEADLINE_MS,
	type DownloadRecord,
	isDownloadRetrievable,
	isSafeDownloadGuid,
	MAX_DOWNLOAD_BYTES,
	MAX_SESSION_DOWNLOAD_BYTES,
	MAX_TRACKED_DOWNLOADS,
} from '@tykotech/browser';
import { isContainedIn } from '@tykotech/browser';
import { ToolError } from './errors.ts';

/**
 * Largest file returned inline as an embedded resource, in raw bytes.
 *
 * A product default, not a protocol limit: base64 adds a third, the JSON
 * envelope adds more, and a tool result is something the model reads. Anything
 * larger is fetched over HTTP, which streams.
 */
export const INLINE_FILE_LIMIT_BYTES = 1024 * 1024;

/** How long a closed session waits for open readers before it closes them and removes its files. */
export const FILE_LEASE_GRACE_MS = 30_000;

/**
 * Subdirectory of the session's download directory holding upload-staging copies (B2.5).
 *
 * Inside the session's own directory on purpose: it inherits the lifetime, the sweep and the
 * containment rule that directory already has, rather than inventing a second temporary location
 * with a second set of rules. Never listed — `browser_list_files` reads the ledger, not the disk.
 */
export const UPLOAD_STAGE_DIR = '.upload';

/** Read chunk for the HTTP stream: bounded memory whatever the file length. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Server-made files one session may hold beside its downloads (R10, D-119): a `browser_pdf {delivery: 'file'}`
 * result is one. The vendored ledger cannot see these, so they carry caps of their own.
 */
export const MAX_SESSION_ARTIFACTS = 32;

/** Bytes one session's artifacts may hold together (R10, D-119). */
export const MAX_SESSION_ARTIFACT_BYTES = 128 * 1024 * 1024;

/** Every artifact id starts with this, which no Chromium download guid (a UUID) can (D-119). */
export const ARTIFACT_ID_PREFIX = 'art-';

/** What a caller hands {@linkcode SessionFiles.addArtifact}. */
export interface ArtifactInput {
	/** The display name; one path segment is never built from it (the file on disk is named by its id). */
	readonly name: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

/** One server-made file: a ledger-shaped record, so every read path treats it as a completed download. */
interface ArtifactRecord {
	readonly record: DownloadRecord;
	readonly mimeType: string;
}

/**
 * The lifecycle a client sees. `completed` implies `available` only when
 * validation passed.
 *
 * An array rather than a bare union so the output schema can be derived from it
 * (`packages/mcp/src/schemas.ts`) instead of restating it. A hand-copied enum in
 * the schema is a second declaration of the same contract, free to drift — and
 * it did, until the gateway's own file test caught it.
 */
export const FILE_STATUSES = ['pending', 'completed', 'failed', 'canceled'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** Wire shape of one tracked download. No absolute paths, no source URL. */
export interface FileInfo {
	file_id: string;
	/** Sanitized, disambiguated display name. Never used as a path. */
	name: string;
	status: FileStatus;
	/** True only for a completed, validated, locally readable regular file. */
	available: boolean;
	bytes_received: number;
	bytes_total: number;
	/** Validated size on disk once available; 0 otherwise. */
	size: number;
	mime_type: string;
	auto_download: boolean;
	started_at: string;
	completed_at: string | null;
	error?: string;
	/**
	 * SHA-256 of the file's bytes, lower-case hex, or `null` (B2.9).
	 *
	 * `null` means "not computed", never "empty file" — an empty file has a perfectly good digest and
	 * gets it. The digest is started when the download completes and cached for the file's lifetime,
	 * because a completed download's bytes do not change; `browser_list_files` awaits any that are
	 * still in flight, so a caller that reads the listing gets a digest rather than a race.
	 *
	 * There is deliberately no second `bytes` field beside `size`: the validated size on disk is
	 * already on the wire under that name, and a second spelling of one fact is how the two drift.
	 */
	sha256: string | null;
}

/** The slice of `DownloadsWatchdog` this module reads. The watchdog satisfies it structurally. */
export interface DownloadLedger {
	readonly downloads: readonly DownloadRecord[];
	readonly isRemoteBrowser: boolean;
	lookup(guid: string): DownloadRecord | undefined;
}

export interface SessionFilesOptions {
	/** The session's owned download directory; `null` when nothing was configured. */
	readonly dir: string | null;
	/** The ledger, or `null` for a session with no download watchdog (tests, remote attach). */
	readonly ledger: DownloadLedger | null;
	readonly logger?: { warn(msg: string): void; info(msg: string): void };
	/** Removes the whole directory. Injected so the lifecycle is testable without a browser. */
	readonly removeDir?: (dir: string) => Promise<void>;
	/** Deferred-cleanup cap; tests shorten it. */
	readonly leaseGraceMs?: number;
	/**
	 * The artifact caps (D-119); tests shrink them so a cap is reachable without writing 128 MiB. Absent members are
	 * {@linkcode MAX_SESSION_ARTIFACTS}, {@linkcode MAX_SESSION_ARTIFACT_BYTES} and `MAX_SESSION_DOWNLOAD_BYTES`.
	 */
	readonly artifactLimits?: { readonly count?: number; readonly bytes?: number; readonly sessionBytes?: number };
	/**
	 * K-3: called once a server-made file has been added, so the owner can announce that the file list changed — what
	 * a finished download already does through the registry's `files-changed` (E-33). Never throws into the caller.
	 */
	readonly onChange?: () => void;
}

/** A leased, streaming read of one file. Release happens on close, cancel or error. */
export interface OpenedFile {
	readonly info: FileInfo;
	/** The file's full size on disk, whatever slice of it the stream carries. */
	readonly size: number;
	readonly stream: ReadableStream<Uint8Array>;
	/**
	 * The slice actually served, when the caller asked for one (B2.9).
	 *
	 * Present only for a ranged read, so a route cannot emit `Content-Range` for a whole-file
	 * response by forgetting to check — the shape says which kind of answer this is.
	 */
	readonly range?: { readonly start: number; readonly end: number; readonly total: number };
}

/** Everything a validated retrieval knows before bytes move. */
export interface ResolvedFile {
	readonly record: DownloadRecord;
	readonly info: FileInfo;
	/** Realpath'ed, contained, regular file. */
	readonly path: string;
	readonly size: number;
}

/**
 * Conservative MIME lookup for the display name's extension.
 *
 * Deliberately never `text/html` or `image/svg+xml`: a downloaded document is
 * served as an attachment, and a type a browser would render inline is a type
 * an attacker's export could abuse. Unknown means `application/octet-stream`.
 */
export function mimeTypeFor(name: string): string {
	const extension = extname(name).replace(/^\./, '').toLowerCase();
	return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

const MIME_BY_EXTENSION: Record<string, string> = {
	pdf: 'application/pdf',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	xml: 'application/xml',
	zip: 'application/zip',
	gz: 'application/gzip',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The client-facing status of a ledger record. */
export function fileStatusOf(record: DownloadRecord): FileStatus {
	if (record.completedAt === null) return 'pending';
	if (isDownloadRetrievable(record)) return 'completed';
	if (record.state === 'canceled') return 'canceled';
	return 'failed';
}

/** The wire view of a record. `available` is false for a remote browser: the bytes are not here. */
export function fileInfoOf(record: DownloadRecord, remote = false, sha256: string | null = null): FileInfo {
	const status = fileStatusOf(record);
	const info: FileInfo = {
		sha256,
		file_id: record.guid,
		name: record.fileName,
		status,
		available: status === 'completed' && !remote,
		bytes_received: record.receivedBytes,
		bytes_total: record.totalBytes,
		size: status === 'completed' ? record.fileSize : 0,
		mime_type: mimeTypeFor(record.fileName),
		auto_download: record.autoDownload,
		started_at: new Date(record.startedAt).toISOString(),
		completed_at: record.completedAt === null ? null : new Date(record.completedAt).toISOString(),
	};
	if (record.error !== null) info.error = record.error;
	return info;
}

/**
 * The files of one session: listing, validated lookup, bounded reads, leased
 * streams, and the directory's lifetime.
 */
export class SessionFiles {
	readonly #dir: string | null;
	readonly #ledger: DownloadLedger | null;
	readonly #logger: SessionFilesOptions['logger'];
	readonly #removeDir: (dir: string) => Promise<void>;
	readonly #leaseGraceMs: number;
	readonly #artifactLimits: { readonly count: number; readonly bytes: number; readonly sessionBytes: number };
	readonly #leases = new Set<Deno.FsFile>();
	/** guid -> SHA-256 hex, computed once per file (B2.9). Dies with the session, like the files. */
	readonly #digests = new Map<string, string>();
	/** guid -> the in-flight hash, so two concurrent listings pay for one. */
	readonly #digesting = new Map<string, Promise<string | null>>();
	/**
	 * R10 / D-119: server-made files, by id, in insertion order. Consulted before the ledger by every read path, and
	 * never written by the vendored watchdog — which is why the accounting below exists at all (F12).
	 */
	readonly #artifacts = new Map<string, ArtifactRecord>();
	/** Bytes of artifacts on disk plus those reserved by an `addArtifact` still writing. */
	#artifactBytes = 0;
	/** Artifacts admitted, written or still being written; the count cap is checked against this. */
	#artifactSlots = 0;
	#closed = false;
	#removed = false;
	#graceTimer: ReturnType<typeof setTimeout> | null = null;
	/** K-3: the owner's "the file list changed" announcement. */
	readonly #onChange: () => void;

	constructor(options: SessionFilesOptions) {
		this.#onChange = options.onChange ?? (() => {});
		this.#dir = options.dir;
		this.#ledger = options.ledger;
		this.#logger = options.logger;
		this.#removeDir = options.removeDir ?? ((dir) => Deno.remove(dir, { recursive: true }));
		this.#leaseGraceMs = options.leaseGraceMs ?? FILE_LEASE_GRACE_MS;
		this.#artifactLimits = {
			count: options.artifactLimits?.count ?? MAX_SESSION_ARTIFACTS,
			bytes: options.artifactLimits?.bytes ?? MAX_SESSION_ARTIFACT_BYTES,
			sessionBytes: options.artifactLimits?.sessionBytes ?? MAX_SESSION_DOWNLOAD_BYTES,
		};
	}

	/** The owned directory, or `null`. Exposed for lifecycle tests; never for path building by callers. */
	get dir(): string | null {
		return this.#dir;
	}

	/** Open leased reads right now. */
	get openReads(): number {
		return this.#leases.size;
	}

	/**
	 * Every tracked file of the session: the downloads, oldest first, pending and failed included, then the
	 * server-made artifacts (R10, D-119) in the order they were made.
	 */
	list(): FileInfo[] {
		const artifacts = [...this.#artifacts.values()].map((artifact) => this.#artifactInfo(artifact));
		if (this.#ledger === null) return artifacts;
		const remote = this.#ledger.isRemoteBrowser;
		return [
			...this.#ledger.downloads.map((record) => fileInfoOf(record, remote, this.#digests.get(record.guid) ?? null)),
			...artifacts,
		];
	}

	/** An artifact's wire view: always local, completed and available, under the type it was made with. */
	#artifactInfo(artifact: ArtifactRecord): FileInfo {
		return {
			...fileInfoOf(artifact.record, false, this.#digests.get(artifact.record.guid) ?? null),
			mime_type: artifact.mimeType,
		};
	}

	/**
	 * Stores a server-made file (a printed PDF) beside the session's downloads and returns its listing entry
	 * (R10, design §2.7, D-119).
	 *
	 * **No vendored edit (F12).** The bytes are written under the session's own download directory as
	 * `art-<uuid>` — temp file first, then a rename, so a reader never sees half a file — and recorded here, not in
	 * `DownloadsWatchdog`. Every read path (`lookup`, `list`, `resolve`, `open`, `digest`, `readInline`) consults
	 * this map before the ledger, so `browser_get_file`, the file route, the resource template and a signed link
	 * serve an artifact exactly as they serve a download. The id cannot collide with a download: Chromium names
	 * those by UUID and none starts with `art-`, which still passes `isSafeDownloadGuid`.
	 *
	 * **The accounting is the part the ledger cannot do.** At most {@linkcode MAX_SESSION_ARTIFACTS} artifacts and
	 * {@linkcode MAX_SESSION_ARTIFACT_BYTES} of them, and one is admitted only while the artifacts plus the ledger's
	 * own completed and received bytes stay within `MAX_SESSION_DOWNLOAD_BYTES` — the session cap the ledger
	 * enforces on downloads. The ledger cannot see artifacts in turn, so a session's worst case is the download cap
	 * plus the artifact cap, which is the stated residual. The reservation is taken synchronously, before the first
	 * await, so two concurrent calls cannot both squeeze under one cap.
	 */
	async addArtifact(input: ArtifactInput): Promise<FileInfo> {
		if (this.#closed) throw new ToolError('unknown-file', 'the session is closed and its files were removed');
		const dir = this.#dir;
		if (dir === null) {
			throw new ToolError('file-unavailable', 'this session has no download directory to keep a file in');
		}
		const size = input.bytes.byteLength;
		const limits = this.#artifactLimits;
		if (this.#artifactSlots >= limits.count) {
			throw new ToolError(
				'file-unavailable',
				`this session already holds ${limits.count} server-made files; close the session to free them`,
			);
		}
		if (this.#artifactBytes + size > limits.bytes) {
			throw new ToolError(
				'file-unavailable',
				`a ${size}-byte file would take this session's server-made files past ${limits.bytes} bytes`,
			);
		}
		if (this.#ledgerBytes() + this.#artifactBytes + size > limits.sessionBytes) {
			throw new ToolError(
				'file-unavailable',
				`a ${size}-byte file would take this session's files past ${limits.sessionBytes} bytes`,
			);
		}
		this.#artifactSlots += 1;
		this.#artifactBytes += size;
		const id = `${ARTIFACT_ID_PREFIX}${crypto.randomUUID()}`;
		const path = join(dir, id);
		const temporary = join(dir, `.${id}.tmp`);
		try {
			await Deno.writeFile(temporary, input.bytes, { createNew: true });
			await Deno.rename(temporary, path);
		} catch (cause) {
			this.#artifactSlots -= 1;
			this.#artifactBytes -= size;
			await Deno.remove(temporary).catch(() => {});
			throw new ToolError(
				'file-unavailable',
				`the file could not be stored: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
		if (this.#closed) {
			// Closed while writing: the directory is going, and this file goes with it.
			await Deno.remove(path).catch(() => {});
			throw new ToolError('unknown-file', 'the session is closed and its files were removed');
		}
		const now = Date.now();
		const name = this.#uniqueName(input.name);
		const extension = extname(name).replace(/^\./, '').toLowerCase();
		const record: DownloadRecord = {
			guid: id,
			url: '',
			suggestedFilename: name,
			fileName: name,
			path,
			fileSize: size,
			receivedBytes: size,
			totalBytes: size,
			fileType: extension === '' ? null : extension,
			mimeType: input.mimeType,
			autoDownload: false,
			state: 'completed',
			startedAt: now,
			completedAt: now,
			error: null,
		};
		// The bytes are in hand, so the digest costs one pass over memory now rather than a read back later.
		const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(input.bytes));
		this.#digests.set(id, encodeHex(new Uint8Array(hash)));
		const artifact: ArtifactRecord = { record, mimeType: input.mimeType };
		this.#artifacts.set(id, artifact);
		// K-3: a new readable file is a resource-list change, exactly as a finished download is (E-33).
		try {
			this.#onChange();
		} catch {
			// The announcement is the owner's; a failing listener must not fail a file that is already stored.
		}
		return this.#artifactInfo(artifact);
	}

	/** The bytes the ledger counts against its session cap: a completed file's size, a transfer's bytes so far. */
	#ledgerBytes(): number {
		if (this.#ledger === null) return 0;
		let total = 0;
		for (const record of this.#ledger.downloads) {
			total += record.state === 'completed' ? record.fileSize : record.receivedBytes;
		}
		return total;
	}

	/** `name`, or `name (n).ext`, so two listing entries never share a display name. */
	#uniqueName(name: string): string {
		const taken = new Set(this.list().map((file) => file.name));
		if (!taken.has(name)) return name;
		const extension = extname(name);
		const stem = extension === '' ? name : name.slice(0, -extension.length);
		for (let n = 1;; n += 1) {
			const candidate = `${stem} (${n})${extension}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	/**
	 * The listing with every available file's digest resolved (B2.9).
	 *
	 * `list()` stays synchronous and answers with whatever digests are already cached, because it is
	 * on the click path (`browser_click` reports a download it started) and must not wait. This is the
	 * form `browser_list_files` uses: a caller reading the listing gets a digest rather than a race
	 * with the hash the completion hook started.
	 */
	async listDigested(): Promise<FileInfo[]> {
		const files = this.list();
		await Promise.all(files.filter((file) => file.available).map((file) => this.digest(file.file_id)));
		return this.list();
	}

	/**
	 * SHA-256 of one available file, computed at most once per file and cached.
	 *
	 * Streamed through the hasher in {@linkcode STREAM_CHUNK_BYTES} chunks, so memory is bounded
	 * whatever the file's length — a 100 MiB download is at the per-file limit and must not become a
	 * 100 MiB allocation. Cached for the file's lifetime because a *completed* download's bytes do not
	 * change; the cache is keyed on the guid and dies with the session, like everything else here.
	 *
	 * Returns `null` rather than throwing when the file cannot be read: a digest is a convenience on a
	 * listing, and failing the whole listing because one file vanished would be the wrong trade. The
	 * in-flight promise is cached too, so two concurrent listings hash once.
	 */
	async digest(fileId: string): Promise<string | null> {
		const cached = this.#digests.get(fileId);
		if (cached !== undefined) return cached;
		const pending = this.#digesting.get(fileId);
		if (pending !== undefined) return await pending;
		const work = this.#computeDigest(fileId).finally(() => this.#digesting.delete(fileId));
		this.#digesting.set(fileId, work);
		return await work;
	}

	/**
	 * Starts a file's digest without waiting for it.
	 *
	 * Called when a download completes, which is the moment the bytes stop changing and the cheapest
	 * point to pay for the hash — by the time a caller lists the session's files it is usually already
	 * there. Failures are swallowed on purpose: a digest that could not be computed is `null` on the
	 * listing, never a broken completion.
	 */
	startDigest(fileId: string): void {
		void this.digest(fileId).catch(() => null);
	}

	async #computeDigest(fileId: string): Promise<string | null> {
		let opened: OpenedFile;
		try {
			opened = await this.open(fileId);
		} catch {
			return null;
		}
		try {
			// Fed as an async iterable rather than a buffer: the std digest hashes chunk by chunk, so
			// the peak allocation is one read chunk and not the file. Each chunk is re-wrapped because
			// the stream's element type is backed by `ArrayBufferLike` and the digest wants a plain
			// `ArrayBuffer`; the copy is one chunk long.
			const chunks = async function* (): AsyncGenerator<Uint8Array<ArrayBuffer>> {
				for await (const chunk of opened.stream) yield new Uint8Array(chunk);
			};
			const hash = await crypto.subtle.digest('SHA-256', chunks());
			const hex = encodeHex(new Uint8Array(hash));
			this.#digests.set(fileId, hex);
			return hex;
		} catch {
			// The stream releases its own lease on error; nothing is cached, so a later call retries.
			return null;
		}
	}

	/** A tracked record by id — an artifact first (D-119), then the ledger — or `undefined`. Refuses non-guid ids. */
	lookup(fileId: string): DownloadRecord | undefined {
		if (!isSafeDownloadGuid(fileId)) return undefined;
		const artifact = this.#artifacts.get(fileId);
		if (artifact !== undefined) return artifact.record;
		if (this.#ledger === null) return undefined;
		return this.#ledger.lookup(fileId);
	}

	/**
	 * Resolves a file id to a validated, readable local file or throws the tool error a caller can
	 * act on: `unknown-file` for an id this session never tracked, `file-unavailable` for anything
	 * tracked that cannot be handed out right now (pending, failed, canceled, remote, gone).
	 */
	async resolve(fileId: string): Promise<ResolvedFile> {
		if (this.#closed) throw new ToolError('unknown-file', 'the session is closed and its files were removed');
		const record = this.lookup(fileId);
		if (record === undefined) {
			throw new ToolError('unknown-file', `no file with id ${fileId} in this session; call browser_list_files`);
		}
		// An artifact (D-119) was written by this server, so its bytes are here whatever kind of browser made it.
		const artifact = this.#artifacts.get(fileId);
		const remote = artifact === undefined && (this.#ledger?.isRemoteBrowser ?? false);
		const info = artifact === undefined
			? fileInfoOf(record, remote)
			: { ...this.#artifactInfo(artifact), sha256: null };
		if (remote) {
			throw new ToolError(
				'file-unavailable',
				`${info.name} was downloaded by a remote browser; its bytes are not on this server`,
			);
		}
		if (info.status === 'pending') {
			throw new ToolError(
				'file-unavailable',
				`${info.name} is still downloading (${info.bytes_received}/${info.bytes_total} bytes); poll browser_list_files`,
			);
		}
		if (info.status !== 'completed') {
			throw new ToolError('file-unavailable', `${info.name} ${info.status}: ${record.error ?? 'no file was produced'}`);
		}
		const dir = this.#dir;
		if (dir === null) throw new ToolError('file-unavailable', 'this session has no download directory');

		// Re-validated at read time: the completion check was a moment in the past.
		let realDir: string;
		let realFile: string;
		let stat: Deno.FileInfo;
		try {
			realDir = await Deno.realPath(dir);
			realFile = await Deno.realPath(record.path);
			stat = await Deno.stat(realFile);
		} catch {
			throw new ToolError('file-unavailable', `${info.name} is no longer on disk`);
		}
		if (!isContainedIn(realDir, realFile)) {
			throw new ToolError('file-unavailable', `${info.name} resolves outside the session's download directory`);
		}
		if (!stat.isFile) throw new ToolError('file-unavailable', `${info.name} is not a regular file`);
		return { record, info: { ...info, size: stat.size }, path: realFile, size: stat.size };
	}

	/**
	 * Stages one tracked file under its **display name**, for `browser_upload_file` (B2.5).
	 *
	 * `DOM.setFileInputFiles` takes a path, and the page reads the *basename* of that path as
	 * `File.name`. Chromium writes every download to disk under its guid, so uploading
	 * `resolved.path` directly hands the form a filename like `7f74c050-4f19-…` — measured on the
	 * browser tier, where the fixture's own change handler reported exactly that. A server that
	 * validates an extension rejects it, and a replay that uploaded `report.txt` no longer does.
	 *
	 * So the bytes are copied once to `<downloads>/.upload/<file_id>/<display name>` and that path is
	 * uploaded. Three properties keep it inside the existing contract rather than adding to it:
	 *
	 * - the display name is already **one sanitised path segment** — the downloads watchdog produced
	 *   it with `sanitizeFilename` before the ledger ever saw it, so nothing page-authored is
	 *   concatenated into a path here;
	 * - the staged copy lives **inside the session's own download directory**, so it is covered by the
	 *   directory lifetime that already exists and is removed by the same sweep on close or reap;
	 * - containment is re-checked on the **realpath of the staged file**, after the copy, so the
	 *   staging step is held to the same rule `resolve` holds the source to.
	 *
	 * Copied rather than hard-linked: a link would share an inode with the file the caller can still
	 * read through `browser_get_file`, and a page that could persuade the browser to write through the
	 * upload would then be writing into the session's own ledger.
	 */
	async stageForUpload(fileId: string): Promise<{ path: string; info: FileInfo; size: number }> {
		const resolved = await this.resolve(fileId);
		const dir = this.#dir;
		if (dir === null) throw new ToolError('file-unavailable', 'this session has no download directory');
		const stageDir = join(dir, UPLOAD_STAGE_DIR, resolved.record.guid);
		const path = join(stageDir, resolved.info.name);
		try {
			await Deno.mkdir(stageDir, { recursive: true });
			await Deno.copyFile(resolved.path, path);
		} catch (cause) {
			throw new ToolError(
				'file-unavailable',
				`${resolved.info.name} could not be prepared for upload: ${cause instanceof Error ? cause.message : cause}`,
			);
		}
		let realDir: string;
		let realStaged: string;
		try {
			realDir = await Deno.realPath(dir);
			realStaged = await Deno.realPath(path);
		} catch {
			throw new ToolError('file-unavailable', `${resolved.info.name} could not be prepared for upload`);
		}
		if (!isContainedIn(realDir, realStaged)) {
			throw new ToolError('file-unavailable', `${resolved.info.name} staged outside the session's directory`);
		}
		return { path: realStaged, info: resolved.info, size: resolved.size };
	}

	/**
	 * Reads a file for inline delivery, refusing anything over `limit` bytes.
	 *
	 * Bounded by *reading*, not by trusting a size: the loop stops at `limit + 1` bytes and reports
	 * the overflow, so a file that grew between stat and read cannot be swallowed whole.
	 */
	async readInline(fileId: string, limit = INLINE_FILE_LIMIT_BYTES): Promise<{ info: FileInfo; bytes: Uint8Array }> {
		const resolved = await this.resolve(fileId);
		if (resolved.size > limit) throw tooLarge(resolved.info, resolved.size, limit);
		const file = await Deno.open(resolved.path, { read: true });
		try {
			const buffer = new Uint8Array(limit + 1);
			let filled = 0;
			while (filled < buffer.length) {
				const read = await file.read(buffer.subarray(filled));
				if (read === null) break;
				filled += read;
			}
			if (filled > limit) throw tooLarge(resolved.info, filled, limit);
			return { info: resolved.info, bytes: buffer.subarray(0, filled) };
		} finally {
			file.close();
		}
	}

	/**
	 * Opens a file for streaming delivery under a lease, optionally over a byte range (B2.9).
	 *
	 * The lease keeps the session's directory alive until the stream closes, is cancelled or errors,
	 * so a Windows deletion cannot fail on an open handle and leak the directory. A session closed
	 * while reads are open waits {@linkcode FILE_LEASE_GRACE_MS}, then closes them.
	 *
	 * With a `range`, the handle is **seeked** and the read is bounded by a remaining counter, so
	 * memory stays one {@linkcode STREAM_CHUNK_BYTES} chunk whatever the file's length and whatever
	 * the range's — the same property the whole-file path already had, and the reason `Range` is
	 * served from here rather than by slicing a buffer at the route. The range is validated against
	 * the size the resolve step just re-`stat`ed, not against the ledger's remembered size.
	 */
	async open(fileId: string, range?: ByteRange): Promise<OpenedFile> {
		const resolved = await this.resolve(fileId);
		if (range !== undefined && (range.start < 0 || range.start > range.end || range.end >= resolved.size)) {
			// Refused, never silently clamped: a caller that asked for bytes past the end has a wrong
			// idea of the file, and answering with fewer bytes than it asked for lets it keep it.
			throw new ToolError(
				'invalid-arguments',
				`bytes ${range.start}-${range.end} are outside ${resolved.info.name}, which is ${resolved.size} bytes`,
			);
		}
		const file = await Deno.open(resolved.path, { read: true });
		this.#leases.add(file);
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.#leases.delete(file);
			try {
				file.close();
			} catch { /* already closed by the grace timer */ }
			if (this.#closed && this.#leases.size === 0) void this.#removeNow();
		};
		if (range !== undefined && range.start > 0) {
			try {
				await file.seek(range.start, Deno.SeekMode.Start);
			} catch (cause) {
				release();
				throw new ToolError(
					'file-unavailable',
					`${resolved.info.name} could not be read from byte ${range.start}: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				);
			}
		}
		let remaining = range === undefined ? Number.POSITIVE_INFINITY : range.end - range.start + 1;
		const stream = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				if (remaining <= 0) {
					release();
					controller.close();
					return;
				}
				const want = Math.min(STREAM_CHUNK_BYTES, remaining);
				const chunk = new Uint8Array(want);
				let read: number | null;
				try {
					read = await file.read(chunk);
				} catch (error) {
					release();
					controller.error(error);
					return;
				}
				if (read === null) {
					release();
					controller.close();
					return;
				}
				remaining -= read;
				controller.enqueue(chunk.subarray(0, read));
			},
			cancel: () => {
				release();
			},
		});
		return {
			info: resolved.info,
			size: resolved.size,
			stream,
			...(range === undefined ? {} : { range: { ...range, total: resolved.size } }),
		};
	}

	/**
	 * Ends the session's file lifetime: no further resolves succeed, and the directory is removed
	 * once no read is open — immediately when none is, otherwise after the last release or the grace
	 * cap, whichever comes first. Never blocks session teardown on a slow reader.
	 */
	async dispose(): Promise<void> {
		this.#closed = true;
		if (this.#leases.size === 0) {
			await this.#removeNow();
			return;
		}
		if (this.#graceTimer !== null) return;
		this.#graceTimer = setTimeout(() => {
			this.#graceTimer = null;
			for (const file of [...this.#leases]) {
				this.#leases.delete(file);
				try {
					file.close();
				} catch { /* the reader already went away */ }
			}
			void this.#removeNow();
		}, this.#leaseGraceMs);
		Deno.unrefTimer(this.#graceTimer);
	}

	async #removeNow(): Promise<void> {
		if (this.#removed) return;
		this.#removed = true;
		if (this.#graceTimer !== null) {
			clearTimeout(this.#graceTimer);
			this.#graceTimer = null;
		}
		if (this.#dir === null) return;
		try {
			await this.#removeDir(this.#dir);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			this.#logger?.warn(`download directory ${this.#dir} could not be removed: ${String(error)}`);
		}
	}
}

function tooLarge(info: FileInfo, size: number, limit: number): ToolError {
	return new ToolError(
		'file-unavailable',
		`${info.name} is ${size} bytes, over the ${limit}-byte inline limit; call browser_get_file with delivery: "link" ` +
			'and fetch the http_url, or read it in chunks from the client that can',
	);
}

/** `Content-Disposition: attachment` with a safe ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachmentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_').replaceAll('\\', '_');
	// A fallback made only of substitutes says nothing; `download` at least says what it is.
	const fallback = /[A-Za-z0-9]/.test(ascii) ? ascii : 'download';
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The absolute path a session's download directory takes under a data root. */
export function downloadsRootOf(dataDir: string): string {
	return join(dataDir, 'downloads');
}

// --- B2.9: byte ranges, digests, and the policy a client can read -------------

/** An inclusive byte range, as `Range: bytes=start-end` names one. */
export interface ByteRange {
	readonly start: number;
	readonly end: number;
}

/** What a `Range` header turned out to be. */
export type ParsedRange =
	/** No `Range` header, or one this server does not implement (a multi-range set). Serve the whole file. */
	| { readonly kind: 'none' }
	| { readonly kind: 'range'; readonly range: ByteRange }
	/** Syntactically a range and outside the file: RFC 9110 says 416, not a clamp. */
	| { readonly kind: 'unsatisfiable' };

/**
 * Parses one `Range` header against a known size.
 *
 * Deliberately narrow: `bytes=` with **one** range, in the three spellings RFC 9110 defines —
 * `start-end`, `start-` (to the end) and `-suffix` (the last N bytes). A multi-range request is
 * answered with the whole file, which is what the specification permits a server to do and is far
 * better than emitting a `multipart/byteranges` body nobody in this product would read.
 *
 * A range outside the file is `unsatisfiable` rather than clamped. Clamping hands a caller fewer
 * bytes than it asked for while telling it the request succeeded, which is how a resumed download
 * silently produces a truncated file.
 */
export function parseByteRange(header: string | null | undefined, size: number): ParsedRange {
	if (header === null || header === undefined) return { kind: 'none' };
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return { kind: 'none' };
	const [, rawStart = '', rawEnd = ''] = match;
	if (rawStart === '' && rawEnd === '') return { kind: 'none' };
	if (size === 0) return { kind: 'unsatisfiable' };

	if (rawStart === '') {
		// `-suffix`: the last N bytes. A suffix longer than the file is the whole file, which is what
		// RFC 9110 says — this is the one case where a bound is applied rather than refused.
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
		return { kind: 'range', range: { start: Math.max(0, size - suffix), end: size - 1 } };
	}
	const start = Number(rawStart);
	if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: 'unsatisfiable' };
	const end = rawEnd === '' ? size - 1 : Number(rawEnd);
	if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
	return { kind: 'range', range: { start, end: Math.min(end, size - 1) } };
}

/**
 * The retention and transfer policy a client can read instead of infer (B2.9, AC-P1-25).
 *
 * Every number here is **read from the constant the enforcement path uses**, never restated: the
 * three limits and the deadline come from `@tykotech/browser`'s download watchdog, the inline limit
 * and the lease grace from this module. ADM's stated need was to stop guessing, and a policy tool
 * whose numbers were typed out again would be a second guess with a nicer interface.
 *
 * `retention.mode` rather than the `retention_hours` the requirement asked for: the real policy is
 * the session's lifetime — the directory goes when the session closes or is reaped, with a deferral
 * for open reads — and returning a number of hours no code reads would be an invented constant.
 * Recorded as a deliberate deviation.
 */
export interface FilePolicy {
	readonly retention: {
		readonly mode: 'session-lifetime';
		readonly session_idle_ttl_s: number;
		readonly open_read_grace_ms: number;
	};
	readonly max_files_per_session: number;
	readonly max_file_bytes: number;
	readonly max_session_bytes: number;
	readonly inline_limit_bytes: number;
	readonly transfer_deadline_ms: number;
	readonly range_supported: boolean;
}

/** Builds the policy from the constants in force, given the registry's own idle TTL. */
export function filePolicyOf(sessionIdleTtlMs: number): FilePolicy {
	return {
		retention: {
			mode: 'session-lifetime',
			session_idle_ttl_s: Math.round(sessionIdleTtlMs / 1000),
			open_read_grace_ms: FILE_LEASE_GRACE_MS,
		},
		max_files_per_session: MAX_TRACKED_DOWNLOADS,
		max_file_bytes: MAX_DOWNLOAD_BYTES,
		max_session_bytes: MAX_SESSION_DOWNLOAD_BYTES,
		inline_limit_bytes: INLINE_FILE_LIMIT_BYTES,
		transfer_deadline_ms: DOWNLOAD_TRANSFER_DEADLINE_MS,
		range_supported: true,
	};
}
