/**
 * Element-classification contract — the predicates every cascade branches on before it touches CDP
 * (ARCHITECTURE.md §6.10 guard rails and "special-input direct value assignment").
 *
 * Pure: no browser, no CDP. Getting `<input type=FILE>` wrong here is what turns a guard rail into an
 * OS file dialog nobody can close.
 */

import { assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '../dom/types.ts';
import {
	attributeOf,
	describeNode,
	DIRECT_VALUE_INPUT_TYPES,
	inputTypeOf,
	isContentEditable,
	isFileInput,
	isNativeSelect,
	isStaleNodeError,
	isTypable,
	needsDirectValueAssignment,
	tagNameOf,
} from './default_action_dom.ts';

function node(nodeName: string, attributes: Record<string, string> = {}): EnhancedDomTreeNode {
	return {
		nodeId: 1,
		backendNodeId: 7,
		nodeType: 1,
		nodeName,
		nodeValue: '',
		attributes,
		isScrollable: null,
		isVisible: true,
		absolutePosition: null,
		targetId: 'T',
		frameId: 'F',
		sessionId: 'S',
		contentDocument: null,
		shadowRootType: null,
		shadowRoots: null,
		parentNode: null,
		childrenNodes: [],
		axNode: null,
		snapshotNode: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'u',
	};
}

Deno.test('dom: tag names are lower-cased and attributes read case-insensitively', () => {
	assertEquals(tagNameOf(node('BUTTON')), 'button');
	assertEquals(attributeOf(node('INPUT', { Type: 'Text' }), 'type'), 'Text');
	assertEquals(attributeOf(node('INPUT', {}), 'type'), null);
});

Deno.test('dom: an input without a type attribute is a text input', () => {
	assertEquals(inputTypeOf(node('INPUT')), 'text');
	assertEquals(inputTypeOf(node('INPUT', { type: 'CHECKBOX' })), 'checkbox');
	assertEquals(inputTypeOf(node('DIV')), null);
});

Deno.test('dom: the two guard-railed element kinds are recognised in every spelling', () => {
	assertEquals(isNativeSelect(node('SELECT')), true);
	assertEquals(isNativeSelect(node('DIV', { role: 'listbox' })), false);
	assertEquals(isFileInput(node('INPUT', { type: 'file' })), true);
	assertEquals(isFileInput(node('INPUT', { TYPE: 'FILE' })), true);
	assertEquals(isFileInput(node('INPUT', { type: 'text' })), false);
});

Deno.test('dom: contenteditable is truthy in its three legal spellings', () => {
	assertEquals(isContentEditable(node('DIV', { contenteditable: '' })), true);
	assertEquals(isContentEditable(node('DIV', { contenteditable: 'true' })), true);
	assertEquals(isContentEditable(node('DIV', { contenteditable: 'plaintext-only' })), true);
	assertEquals(isContentEditable(node('DIV', { contenteditable: 'false' })), false);
	assertEquals(isContentEditable(node('DIV')), false);
});

Deno.test('dom: browser-owned editors take the direct-value path, text fields do not', () => {
	assertEquals(DIRECT_VALUE_INPUT_TYPES.length, 7);
	for (const type of DIRECT_VALUE_INPUT_TYPES) {
		assertEquals(needsDirectValueAssignment(node('INPUT', { type })), true, type);
	}
	assertEquals(needsDirectValueAssignment(node('INPUT', { type: 'text' })), false);
	assertEquals(needsDirectValueAssignment(node('TEXTAREA')), false);
});

Deno.test('dom: typable elements are inputs (not file), textareas and contenteditable hosts', () => {
	assertEquals(isTypable(node('INPUT')), true);
	assertEquals(isTypable(node('TEXTAREA')), true);
	assertEquals(isTypable(node('DIV', { contenteditable: 'true' })), true);
	assertEquals(isTypable(node('INPUT', { type: 'file' })), false);
	assertEquals(isTypable(node('BUTTON')), false);
	assertEquals(isTypable(node('SELECT')), false);
});

Deno.test('dom: node descriptions name the tag, the input type and the id', () => {
	assertEquals(describeNode(node('INPUT', { type: 'email', id: 'login' })), '<input type=email #login> [7]');
	assertEquals(describeNode(node('BUTTON')), '<button> [7]');
});

Deno.test('dom: a stale-id CDP error is recognised so R6.3 can mean "rebuild", not "crash"', () => {
	assertEquals(isStaleNodeError(new Error('No node with given id found')), true);
	assertEquals(isStaleNodeError(new Error('Could not find node with given id')), true);
	assertEquals(isStaleNodeError(new Error('Session closed')), false);
	assertEquals(isStaleNodeError('no node with given id'), true);
});
