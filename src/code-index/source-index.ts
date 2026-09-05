import type { AnalysisControl } from "../syntax-tree/types.js";
import type { SourceRange } from "./types.js";

/** 将 Tree-sitter/LSP 的 UTF-16 坐标转换为 UTF-8 范围，ASCII 文档无需偏移表。 */
export class SourceIndex {
	readonly #lineStarts: number[] = [0];
	readonly lineStartChars: number[] = [0];
	readonly #charLength: number;
	readonly #charToByte: Uint32Array | undefined;

	constructor(text: string, control?: AnalysisControl) {
		control?.check();
		this.#charLength = text.length;
		this.#charToByte = /[^\x00-\x7f]/u.test(text) ? new Uint32Array(text.length + 1) : undefined;
		let bytes = 0;
		let offset = 0;
		for (const character of text) {
			if ((offset & 0xfff) === 0) control?.check();
			const code = character.charCodeAt(0);
			bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : character.length === 2 ? 4 : 3;
			for (let index = 0; index < character.length; index += 1) {
				offset += 1;
				if (this.#charToByte !== undefined) this.#charToByte[offset] = bytes;
			}
			if (code === 0x0a) {
				this.#lineStarts.push(bytes);
				this.lineStartChars.push(offset);
			}
		}
	}

	byteForChar(charOffset: number): number {
		const offset = Math.min(this.#charLength, Math.max(0, Math.trunc(charOffset)));
		return this.#charToByte?.[offset] ?? offset;
	}

	#lineForByte(byteOffset: number): number {
		let low = 0;
		let high = this.#lineStarts.length - 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const start = this.#lineStarts[middle] ?? 0;
			if (start <= byteOffset) low = middle + 1;
			else high = middle - 1;
		}
		return Math.max(1, high + 1);
	}

	range(startChar: number, endChar: number): SourceRange {
		const startByte = this.byteForChar(startChar);
		const endByte = this.byteForChar(endChar);
		return {
			startLine: this.#lineForByte(startByte),
			endLine: this.#lineForByte(Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		};
	}
}
