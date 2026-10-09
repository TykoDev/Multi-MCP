/**
 * Type-only: brings every kit element's tag-name typing (`HTMLElementTagNameMap['wa-…']`) into any program
 * that builds kit elements with `el()`, including one type-checked without `kit*.ts` (the unit tests).
 * Re-exported from `dom.ts`; erased at runtime, so it adds nothing to any bundle.
 */
import type WaAvatar from '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import type WaBadge from '@awesome.me/webawesome/dist/components/badge/badge.js';
import type WaCallout from '@awesome.me/webawesome/dist/components/callout/callout.js';
import type WaCard from '@awesome.me/webawesome/dist/components/card/card.js';
import type WaDetails from '@awesome.me/webawesome/dist/components/details/details.js';
import type WaDialog from '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import type WaIcon from '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaOption from '@awesome.me/webawesome/dist/components/option/option.js';
import type WaPopover from '@awesome.me/webawesome/dist/components/popover/popover.js';
import type WaRelativeTime from '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaSkeleton from '@awesome.me/webawesome/dist/components/skeleton/skeleton.js';
import type WaSpinner from '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import type WaSplitPanel from '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import type WaTab from '@awesome.me/webawesome/dist/components/tab/tab.js';
import type WaTabGroup from '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import type WaTabPanel from '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import type WaTag from '@awesome.me/webawesome/dist/components/tag/tag.js';
import type WaTextarea from '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import type WaTooltip from '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import type WaTree from '@awesome.me/webawesome/dist/components/tree/tree.js';
import type WaTreeItem from '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';

/** Any element of the component kit. */
export type KitElement =
	| WaAvatar
	| WaBadge
	| WaCallout
	| WaCard
	| WaDetails
	| WaDialog
	| WaDrawer
	| WaIcon
	| WaInput
	| WaOption
	| WaPopover
	| WaRelativeTime
	| WaSelect
	| WaSkeleton
	| WaSpinner
	| WaSplitPanel
	| WaSwitch
	| WaTab
	| WaTabGroup
	| WaTabPanel
	| WaTag
	| WaTextarea
	| WaTooltip
	| WaTree
	| WaTreeItem;
