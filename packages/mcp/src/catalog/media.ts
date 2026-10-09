/**
 * Browser-output tools (R10, R11; design §2.3, §2.7–§2.8; D-118–D-120): a printed PDF, a signed link to a session
 * file, the accessibility tree and the page's performance numbers.
 *
 * The output schemas live here beside their definitions rather than in `schemas.ts` (design §2.3): each part owns
 * its shapes. The file listing entry is borrowed from `OUTPUT.browser_get_file`, so an artifact and a download can
 * never be described two ways.
 */
import * as z from 'zod';
import * as handlers from '../tools.ts';
import { AX_MAX_NODES_DEFAULT, AX_MAX_NODES_MAX, type AxOut } from '../ax_tree.ts';
import { OUTPUT } from '../schemas.ts';
import { def, frameIdArg, sessionId, stateTokenArg, type ToolDefinition } from './shared.ts';

/** One tracked file, exactly as `fileInfoOf` builds it — the schema `browser_get_file` already declares. */
const FileInfo = OUTPUT.browser_get_file.shape.file;

/** One node of the accessibility tree (`AxOut`); recursive, so the JSON Schema carries one `$defs` entry. */
const AxNodeSchema: z.ZodType<AxOut> = z.object({
	role: z.string(),
	name: z.string(),
	description: z.string().optional(),
	properties: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
	index: z.number().int().optional(),
	get children(): z.ZodArray<z.ZodType<AxOut>> {
		return z.array(AxNodeSchema);
	},
});

const nullableNumber = z.number().nullable();

/** The result shapes of this part's tools, by name. Exported so the tests read the same table. */
export const MEDIA_OUTPUT = {
	browser_pdf: z.object({
		session_id: z.string(),
		delivery: z.enum(['inline', 'file']),
		/** The PDF's size in bytes; the bytes themselves ride the `application/pdf` block or the artifact. */
		bytes: z.number().int(),
		/** The artifact, for `delivery: 'file'` (D-119). */
		file: FileInfo.optional(),
	}),
	browser_file_link: z.object({
		session_id: z.string(),
		file_id: z.string(),
		/** Downloads the file with no credential until `expires_at`; a bearer-equivalent for that long. */
		url: z.string(),
		expires_at: z.string(),
		ttl_seconds: z.number().int(),
	}),
	browser_accessibility_snapshot: z.object({
		session_id: z.string(),
		frame_id: z.string(),
		/** Nodes in the whole (filtered) tree; `tree` holds at most `max_nodes` of them. */
		nodes_total: z.number().int(),
		truncated: z.boolean(),
		tree: AxNodeSchema,
		outline: z.string(),
		state_token: z.string().nullable(),
	}),
	browser_performance: z.object({
		session_id: z.string(),
		/** The focused tab's origin; `''` for a document with none (`about:blank`). */
		origin: z.string(),
		vitals: z.object({
			ttfb_ms: nullableNumber,
			dcl_ms: nullableNumber,
			load_ms: nullableNumber,
			fcp_ms: nullableNumber,
			lcp_ms: nullableNumber,
			cls: nullableNumber,
			inp_ms: nullableNumber,
		}).nullable(),
		/** `isolated` when page script could not have answered for the vitals; `null` when none were asked for. */
		vitals_world: z.enum(['isolated', 'main']).nullable(),
		runtime: z.object({
			js_heap_used_bytes: nullableNumber,
			nodes: nullableNumber,
			layout_count: nullableNumber,
			recalc_style_count: nullableNumber,
			script_duration_s: nullableNumber,
			task_duration_s: nullableNumber,
		}).nullable(),
	}),
} as const;

export const MEDIA_TOOLS: readonly ToolDefinition<z.ZodType>[] = [
	def({
		name: 'browser_pdf',
		title: 'Print the page to PDF',
		description: 'Print the focused tab to a PDF, as the browser’s print-to-PDF would, without a header or ' +
			'footer. delivery "inline" (the default) returns the PDF as an embedded application/pdf resource for files ' +
			'up to 1 MiB; a larger one is refused with a pointer to delivery "file", which keeps the PDF as a session ' +
			'file (an art- file_id in browser_list_files) to read with browser_get_file or link with ' +
			'browser_file_link. page_ranges takes the print dialog’s syntax, e.g. "1-3, 5".',
		inputSchema: z.object({
			session_id: sessionId,
			landscape: z.boolean().optional().describe('Landscape orientation. Default false.'),
			print_background: z.boolean().optional().describe('Print background colours and images. Default true.'),
			scale: z.number().min(0.1).max(2).optional().describe('Rendering scale, 0.1 to 2. Default 1.'),
			page_ranges: z.string().regex(/^[0-9, -]{0,64}$/).optional().describe(
				'Pages to print, e.g. "1-3, 5". Default all.',
			),
			paper: z.enum(['A4', 'Letter']).optional().describe('Paper size. Default A4.'),
			delivery: z.enum(['inline', 'file']).optional().describe(
				'inline (default, ≤ 1 MiB) or file (kept as a session file, up to 64 MiB).',
			),
		}),
		mutates: false,
		outputSchema: MEDIA_OUTPUT.browser_pdf,
		handler: handlers.browserPdf,
	}),
	def({
		name: 'browser_file_link',
		title: 'Link to a session file',
		// D-140 (G5): the life widened from 300 s to an hour, a wire widening offset by revocation — the link dies with
		// the session (incarnation), with a rotated key or changed password (credential epoch), and with the OAuth
		// access token it was minted under (F1).
		description: 'Mint a URL that downloads one file listed by browser_list_files with no ' +
			'credential — for handing a file to a person or a program that holds none. The link is bound to the file, ' +
			'the session and the credential that minted it, works for ttl_seconds (default 3600, at most 3600), and ' +
			'stops working early if the session closes or that credential is revoked, rotated or expires. Anyone ' +
			'holding the URL can download the file until then, so share it only with its intended reader. Offered only ' +
			'where the operator has enabled signed links.',
		inputSchema: z.object({
			file_id: z.string().min(1).max(128).describe('The file_id from browser_list_files.'),
			session_id: sessionId,
			ttl_seconds: z.number().int().min(10).max(3600).optional().describe(
				'10 to 3600 seconds. Default: the deployment’s, 3600 unless the operator changed it. A link never ' +
					'outlives the OAuth access token it was minted under.',
			),
		}),
		mutates: false,
		// A deployment switch, not a missing capability: the refusal names it (design §2.4). D-150: on by default
		// wherever a signing key can be had, so a refusal means the operator turned it off or gave it no key.
		available: (state) => state.signedLinks === true,
		unavailableDetail: () =>
			'browser_file_link needs signed links, which this deployment has not enabled; the operator sets ' +
			'TTK_SIGNED_LINKS=true',
		outputSchema: MEDIA_OUTPUT.browser_file_link,
		handler: handlers.browserFileLink,
	}),
	def({
		name: 'browser_accessibility_snapshot',
		title: 'Read the accessibility tree',
		description: 'Read the page’s accessibility tree — the roles, names and states a screen reader is given — ' +
			'as a nested tree in structuredContent and an indented outline in the text. index (from browser_get_state) ' +
			'reads one element instead of the document; frame_id reads one frame. interesting_only (default true) ' +
			'drops ignored nodes, unnamed containers and text runs that repeat their parent. max_nodes (default ' +
			`${AX_MAX_NODES_DEFAULT}, at most ${AX_MAX_NODES_MAX}) bounds the tree; nodes_total and truncated report ` +
			'what was left out. Field values never appear: a value is not returned for any node, a form control’s name ' +
			'is blanked when it repeats what was typed, and a text field’s typed text is not part of the tree.',
		inputSchema: z.object({
			session_id: sessionId,
			frame_id: frameIdArg,
			index: z.number().int().min(0).optional().describe(
				'An element index from browser_get_state: read that element’s node instead of the whole document.',
			),
			interesting_only: z.boolean().optional().describe(
				'Drop uninteresting nodes, keeping their children. Default true.',
			),
			max_nodes: z.number().int().min(1).max(AX_MAX_NODES_MAX).optional().describe(
				`Most nodes returned, in document order. Default ${AX_MAX_NODES_DEFAULT}.`,
			),
			state_token: stateTokenArg,
		}),
		mutates: false,
		outputSchema: MEDIA_OUTPUT.browser_accessibility_snapshot,
		handler: handlers.browserAccessibilitySnapshot,
	}),
	def({
		name: 'browser_performance',
		title: 'Measure page performance',
		description: 'Report the focused tab’s Core Web Vitals and runtime counters. vitals: time to first byte, ' +
			'DOMContentLoaded, load, first and largest contentful paint, cumulative layout shift and interaction to ' +
			'next paint, read once from the browser’s buffered performance entries — so CLS and INP count only what ' +
			'the browser kept, and under-report against a measurement taken from page load. runtime: JS heap in use, ' +
			'DOM node count, layout and style recalculation counts, script and task time. The browser counts layouts, ' +
			'style recalculations, script and task time only once asked to, so those four count from the first ' +
			'browser_performance call on the tab: call it once before the interaction you want to measure. Any value the ' +
			'page has not produced is null.',
		inputSchema: z.object({
			session_id: sessionId,
			metrics: z.array(z.enum(['vitals', 'runtime'])).min(1).max(2).optional().describe(
				'Which groups to read. Default both.',
			),
		}),
		mutates: false,
		outputSchema: MEDIA_OUTPUT.browser_performance,
		handler: handlers.browserPerformance,
	}),
];
