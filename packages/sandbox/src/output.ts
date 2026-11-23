/**
 * A command's output within a fixed size: the first and last half of the limit with a line counting the cut; the
 * middle is dropped as it arrives. UTF-8, never split mid-character; invalid bytes and NUL become U+FFFD, and
 * terminal control codes are removed.
 */
import { LIMITS } from './limits.ts';

export interface Output {
	output: string;
	truncated: boolean;
	/** Bytes left out of `output`, counted before decoding. */
	omittedBytes: number;
	/** Bytes the command printed in all. */
	outputBytes: number;
}

export class OutputCapture {
	readonly #half: number;
	readonly #head: Uint8Array;
	#headLength = 0;
	readonly #tail: Uint8Array;
	/** Where the next byte of the tail ring goes, and how many bytes it holds. */
	#tailNext = 0;
	#tailLength = 0;
	#total = 0;

	constructor(limit: number = LIMITS.outputBytes) {
		this.#half = Math.floor(limit / 2);
		this.#head = new Uint8Array(this.#half);
		this.#tail = new Uint8Array(limit - this.#half);
	}

	get total(): number {
		return this.#total;
	}

	push(chunk: Uint8Array): void {
		this.#total += chunk.length;
		let rest = chunk;
		if (this.#headLength < this.#half) {
			const take = Math.min(this.#half - this.#headLength, rest.length);
			this.#head.set(rest.subarray(0, take), this.#headLength);
			this.#headLength += take;
			rest = rest.subarray(take);
		}
		const size = this.#tail.length;
		if (rest.length >= size) {
			this.#tail.set(rest.subarray(rest.length - size));
			this.#tailNext = 0;
			this.#tailLength = size;
			return;
		}
		const first = Math.min(size - this.#tailNext, rest.length);
		this.#tail.set(rest.subarray(0, first), this.#tailNext);
		this.#tail.set(rest.subarray(first), 0);
		this.#tailNext = (this.#tailNext + rest.length) % size;
		this.#tailLength = Math.min(size, this.#tailLength + rest.length);
	}

	result(): Output {
		const head = this.#head.subarray(0, this.#headLength);
		const tail = this.#tailBytes();
		const dropped = this.#total - head.length - tail.length;
		if (dropped === 0) {
			return {
				output: clean(decode(concat([head, tail]))),
				truncated: false,
				omittedBytes: 0,
				outputBytes: this.#total,
			};
		}
		// Both cuts land between characters: the head loses a character it has only part of, the
		// tail the continuation bytes of one that began in the part left out.
		const kept = head.subarray(0, completeLength(head));
		let start = 0;
		while (start < tail.length && start < 3 && (tail[start]! & 0xc0) === 0x80) start++;
		const end = tail.subarray(start);
		const omitted = this.#total - kept.length - end.length;
		return {
			output: `${clean(decode(kept))}\n[... ${omitted} bytes of output left out ...]\n${clean(decode(end))}`,
			truncated: true,
			omittedBytes: omitted,
			outputBytes: this.#total,
		};
	}

	#tailBytes(): Uint8Array {
		if (this.#tailLength < this.#tail.length) return this.#tail.slice(0, this.#tailLength);
		return concat([this.#tail.subarray(this.#tailNext), this.#tail.subarray(0, this.#tailNext)]);
	}
}

/** How much of `bytes` ends on a character boundary: an unfinished last character is left out. */
export function completeLength(bytes: Uint8Array): number {
	let i = bytes.length - 1;
	// Walk back over at most three continuation bytes to the start of the last character.
	while (i >= 0 && bytes.length - i <= 4 && (bytes[i]! & 0xc0) === 0x80) i--;
	if (i < 0) return bytes.length;
	const lead = bytes[i]!;
	const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return bytes.length - i >= needed ? bytes.length : i;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Output kept whole up to `limit` bytes; `push` answers false from there on, which stops the work. */
export function collect(limit: number): { push(chunk: Uint8Array): boolean; bytes(): Uint8Array } {
	const chunks: Uint8Array[] = [];
	let size = 0;
	return {
		push: (chunk) => {
			if (size >= limit) return false;
			chunks.push(chunk);
			size += chunk.length;
			return size < limit;
		},
		bytes: () => concat(chunks),
	};
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Terminal control sequences: CSI, OSC (ended by BEL or ESC \) and two-byte escapes. */
const CONTROL = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
	'g',
);
const NUL = new RegExp(String.fromCharCode(0), 'g');
const REPLACEMENT = String.fromCharCode(0xfffd);

export function clean(text: string): string {
	return text.replace(CONTROL, '').replace(NUL, REPLACEMENT);
}
