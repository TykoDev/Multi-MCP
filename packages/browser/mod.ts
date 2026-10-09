/**
 * `@tykotech/browser` — the browser control layer.
 *
 * Vendored from the BUA reference implementation (`browser-use-cleanR`,
 * `packages/core`), reduced to the browser subset: session model, DOM/AX
 * extraction pipeline, watchdogs, and URL security. The agent loop, LLM
 * providers, tool registry, filesystem, and sensitive-data pipeline are
 * deliberately not vendored (SPECS/DECISION-REGISTER.md D-005, D-011).
 *
 * The vendored sources keep their original ERRATUM commentary; behavioural
 * edits require an `E-nn` register entry and a comment at the site.
 */

// --- browser session model ------------------------------------------------
export * from './src/browser/session.ts';
export * from './src/browser/session_manager.ts';
export * from './src/browser/navigation.ts';
export * from './src/browser/reconnect.ts';
export * from './src/browser/profile.ts';

// --- watchdogs ------------------------------------------------------------
export * from './src/watchdogs/base.ts';
export * from './src/watchdogs/attach_order.ts';

// --- downloads (E-33) -----------------------------------------------------
// The download ledger and its record type. The MCP layer keeps the *instance*
// `attachWatchdogs` constructed rather than attaching a second one, and reads
// files only through records this watchdog validated.
export {
	DEFAULT_DOWNLOAD_LIMITS,
	DOWNLOAD_TRANSFER_DEADLINE_MS,
	type DownloadLimits,
	type DownloadRecord,
	DownloadsWatchdog,
	isDownloadRetrievable,
	isSafeDownloadGuid,
	MAX_DOWNLOAD_BYTES,
	MAX_SESSION_DOWNLOAD_BYTES,
	MAX_TRACKED_DOWNLOADS,
	// ERRATUM(E-54): the bounded retry a cancelled download's partial removal now makes on Windows.
	PARTIAL_REMOVE_ATTEMPTS,
	PARTIAL_REMOVE_RETRY_MS,
	removeWithRetry,
} from './src/watchdogs/downloads.ts';

// --- JavaScript dialogs (B2.5) --------------------------------------------
// ERRATUM(E-53). `browser_handle_dialog` answers a dialog through the *same*
// watchdog instance `attachWatchdogs` built, for the reason the download ledger
// is kept the same way: the instance that armed `Page.javascriptDialogOpening`
// is the only one holding anything to answer. The barrel had no popups export
// at all, so the type could not be named across the package boundary.
export {
	DIALOG_HANDLE_ATTEMPTS,
	DIALOG_HANDLE_TIMEOUT_MS,
	DIALOG_MANUAL_TIMEOUT_MS,
	type HandledDialog,
	type PendingDialog,
	PopupsWatchdog,
	shouldAcceptDialog,
} from './src/watchdogs/popups.ts';

// --- persistent storage state (R3) ----------------------------------------
// The document algebra and the watchdog's own constants. `browser_storage_state`
// reads a saved document back to report its counts without re-implementing the
// parser the watchdog writes with.
export {
	DEFAULT_STORAGE_STATE_FILENAME,
	describeStorageState,
	emptyStorageState,
	mergeStorageState,
	parseStorageState,
	shouldAttachStorageStateWatchdog,
} from './src/watchdogs/storage_state.ts';

// --- input synthesis ------------------------------------------------------
// The key tables and the session-targeted dispatchers. `TypeTextEvent` requires
// a node, so typing into whatever the page has focused — which the live view
// does on every keystroke, and which `browser_type` offers when no index is
// given — has to reach these directly rather than through an element event.
export { type KeyTarget, pressCombo, pressKey, typeCharacter } from './src/watchdogs/default_action_input.ts';
// ERRATUM(E-42). `MODIFIER_ALIASES` and `ModifierName` were declared beside
// `MODIFIER_BITS` and exported from their own module, but not from this barrel —
// so the gateway, which already imports the rest of this table, could not fold a
// client-supplied modifier *name* into the bitmask without writing a second
// alias map. Two spellings of `'cmd' | 'command' | 'meta' | 'super' | 'win'`
// eventually disagree, which is the same defect class as E-29's second password
// predicate. One line, one owner (B1.11).
export {
	type KeyCombo,
	type KeySpec,
	keySpecForCharacter,
	keySpecForName,
	MODIFIER_ALIASES,
	MODIFIER_BITS,
	type ModifierName,
	NAMED_KEYS,
	parseKeyCombo,
	parseKeys,
	selectAllModifier,
	suppressesText,
} from './src/watchdogs/default_action_keys.ts';

// --- DOM / accessibility pipeline ----------------------------------------
export * from './src/dom/types.ts';
export * from './src/dom/extract.ts';
export * from './src/dom/serialize.ts';
export * from './src/dom/derived.ts';
export * from './src/dom/hashes.ts';

// --- URL security ---------------------------------------------------------
export * from './src/security/url_matcher.ts';
export * from './src/security/containment.ts';

// --- shared events / types / errors ---------------------------------------
export * from './src/events.ts';
export * from './src/types.ts';
export * from './src/errors.ts';

// --- ambiguity resolution (TS2308) ----------------------------------------
// Two names are exported by two sub-modules each. An explicit re-export wins
// over `export *`, so each is pinned to its owning module rather than left to
// import order. Both pins are carried over from the donor package verbatim.

/**
 * Anti-exfiltration predicate: the node-only form is the public one;
 * `serialize_attrs.ts` keeps a `(node, tag)` variant as an internal
 * emission-path helper. Both apply the same rule — see donor ERRATUM(E-29),
 * where they did not.
 */
export { isPasswordField } from './src/dom/derived.ts';

/** URL policy owns the canonical definition. */
export { isNewTabUrl } from './src/security/url_matcher.ts';
