/**
 * CDP `Runtime` domain — expression evaluation, function calls on remote objects, bindings.
 *
 * Used for the `getEventListeners` census and JS fallback paths in the DOM layer
 * (SPECS/DATA-MODEL.md §6.1), iframe scroll, ARIA/framework dropdown handling
 * (SPECS/ARCHITECTURE.md §6.10), and the `Runtime.evaluate('1+1')` health probe (§6.11).
 */

import type {
	CallArgument,
	EmptyResult,
	ExceptionDetails,
	ExecutionContextId,
	NoParams,
	PropertyDescriptor,
	RemoteObject,
	RemoteObjectId,
} from './common.ts';

/** `Runtime.ExecutionContextDescription`. */
export interface ExecutionContextDescription {
	id: ExecutionContextId;
	origin: string;
	name: string;
	uniqueId: string;
	auxData?: Record<string, unknown>;
}

/** `Runtime.SerializationOptions`. */
export interface SerializationOptions {
	serialization: 'deep' | 'json' | 'idOnly';
	maxDepth?: number;
	additionalParameters?: Record<string, unknown>;
}

export interface RuntimeParams {
	'Runtime.addBinding': { name: string; executionContextId?: ExecutionContextId; executionContextName?: string };
	'Runtime.callFunctionOn': {
		functionDeclaration: string;
		objectId?: RemoteObjectId;
		arguments?: CallArgument[];
		silent?: boolean;
		returnByValue?: boolean;
		userGesture?: boolean;
		awaitPromise?: boolean;
		executionContextId?: ExecutionContextId;
		objectGroup?: string;
		serializationOptions?: SerializationOptions;
	};
	'Runtime.disable': NoParams;
	'Runtime.enable': NoParams;
	'Runtime.evaluate': {
		expression: string;
		objectGroup?: string;
		includeCommandLineAPI?: boolean;
		silent?: boolean;
		contextId?: ExecutionContextId;
		returnByValue?: boolean;
		generatePreview?: boolean;
		userGesture?: boolean;
		awaitPromise?: boolean;
		throwOnSideEffect?: boolean;
		timeout?: number;
		replMode?: boolean;
		uniqueContextId?: string;
		serializationOptions?: SerializationOptions;
	};
	'Runtime.getProperties': {
		objectId: RemoteObjectId;
		ownProperties?: boolean;
		accessorPropertiesOnly?: boolean;
		generatePreview?: boolean;
		nonIndexedPropertiesOnly?: boolean;
	};
	'Runtime.releaseObject': { objectId: RemoteObjectId };
	'Runtime.releaseObjectGroup': { objectGroup: string };
	'Runtime.removeBinding': { name: string };
}

export interface RuntimeResults {
	'Runtime.addBinding': EmptyResult;
	'Runtime.callFunctionOn': { result: RemoteObject; exceptionDetails?: ExceptionDetails };
	'Runtime.disable': EmptyResult;
	'Runtime.enable': EmptyResult;
	'Runtime.evaluate': { result: RemoteObject; exceptionDetails?: ExceptionDetails };
	'Runtime.getProperties': {
		result: PropertyDescriptor[];
		internalProperties?: Record<string, unknown>[];
		privateProperties?: Record<string, unknown>[];
		exceptionDetails?: ExceptionDetails;
	};
	'Runtime.releaseObject': EmptyResult;
	'Runtime.releaseObjectGroup': EmptyResult;
	'Runtime.removeBinding': EmptyResult;
}

export interface RuntimeEvents {
	'Runtime.bindingCalled': { name: string; payload: string; executionContextId: ExecutionContextId };
	'Runtime.consoleAPICalled': {
		type: string;
		args: RemoteObject[];
		executionContextId: ExecutionContextId;
		timestamp: number;
		stackTrace?: Record<string, unknown>;
	};
	'Runtime.exceptionThrown': { timestamp: number; exceptionDetails: ExceptionDetails };
	'Runtime.executionContextCreated': { context: ExecutionContextDescription };
	'Runtime.executionContextDestroyed': { executionContextId?: ExecutionContextId; executionContextUniqueId?: string };
	'Runtime.executionContextsCleared': Record<never, never>;
}

export const RUNTIME_METHODS = [
	'addBinding',
	'callFunctionOn',
	'disable',
	'enable',
	'evaluate',
	'getProperties',
	'releaseObject',
	'releaseObjectGroup',
	'removeBinding',
] as const;
