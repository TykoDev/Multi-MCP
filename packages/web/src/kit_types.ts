/**
 * Type-only: every kit element's tag-name typing (`HTMLElementTagNameMap['wa-…']`) for any program that builds kit
 * elements with `el()`, including the unit tests. Erased at runtime.
 */
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaIcon from '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaOption from '@awesome.me/webawesome/dist/components/option/option.js';
import type WaPopover from '@awesome.me/webawesome/dist/components/popover/popover.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaSpinner from '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import type WaTab from '@awesome.me/webawesome/dist/components/tab/tab.js';
import type WaTabGroup from '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import type WaTabPanel from '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';

/** Any element of the component kit. */
export type KitElement =
	| WaDialog
	| WaIcon
	| WaInput
	| WaOption
	| WaPopover
	| WaSelect
	| WaSpinner
	| WaTab
	| WaTabGroup
	| WaTabPanel;
