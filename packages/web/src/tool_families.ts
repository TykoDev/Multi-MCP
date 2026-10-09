/**
 * The families the Tools console lists tools under — pure, so `screens_test.ts` asserts them against the catalog
 * without loading the Tools screen and its kit.
 *
 * Browser tools are grouped by what each is for; extension tools by their name prefix. A browser tool missing here
 * falls under "Other" with a generic glyph, which is how the run's new tools first landed (RV-5): the test reads every
 * `browser_*` name the MCP layer declares and allows none of them under "Other".
 */
import type { IconName } from './icon_names.ts';

/** Browser tool families: a heading, its glyph, and the tools under it (names without `browser_`). */
const FAMILIES: ReadonlyArray<readonly [string, IconName, string]> = [
	['Navigation', 'nav', 'navigate go_back wait_for'],
	[
		'Interaction',
		'control',
		'click double_click right_click hover type press_key fill scroll_to scroll_into_view select_option ' +
		'upload_file handle_dialog drag scroll fill_secret evaluate run_task',
	],
	[
		// RV-5: what the page sent, logged and exposes to assistive technology, and how fast it was, is perception too.
		'Perception',
		'eye',
		'get_state find element_at get_frames locator_candidates verify_locator get_html screenshot extract_content ' +
		'network_log console_log har_export accessibility_snapshot performance',
	],
	[
		// RV-5: handing the session to a person is a session matter, like showing it live.
		'Session',
		'sessions',
		'get_session set_viewport set_session_options list_tabs switch_tab close_tab storage_state record ' +
		'list_sessions close_session close_all health audit live_view request_human',
	],
	// RV-5: a printed page, a signed link to a session file and a copy into the share are files of the session.
	['Files', 'file', 'list_files get_file download head file_policy pdf file_link save_to_share'],
];

/**
 * Extension tools, by name prefix — the families composed beside the browser catalog. The library's three
 * (`file_`, `skill_`, `prompt_`) get a heading of their own instead of falling under "Other".
 */
const PREFIXED: ReadonlyArray<readonly [string, string, IconName]> = [
	['file_', 'File share', 'folder'],
	['skill_', 'Skills', 'skills'],
	['prompt_', 'Prompts', 'prompt'],
	['sandbox_', 'Sandbox', 'terminal'],
	['agent_', 'Agents', 'agents'],
	['a2ui_', 'Surfaces', 'surface'],
	// D-154: the agents' vector memory.
	['memory_', 'Memory', 'brain'],
];

/** The order families are listed in: the browser workflow first, then the extensions. */
export const FAMILY_ORDER: readonly string[] = [
	...FAMILIES.map(([name]) => name),
	...PREFIXED.map(([, name]) => name),
	'Other',
];

/** A tool's family heading and glyph. */
export function familyOf(name: string): readonly [string, IconName] {
	const prefixed = PREFIXED.find(([prefix]) => name.startsWith(prefix));
	if (prefixed !== undefined) return [prefixed[1], prefixed[2]];
	const short = name.replace(/^browser_/, '');
	const family = FAMILIES.find(([, , names]) => names.split(' ').includes(short));
	return family === undefined ? ['Other', 'box'] : [family[0], family[1]];
}
