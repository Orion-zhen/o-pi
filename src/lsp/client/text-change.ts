import type { Position, TextDocumentContentChangeEvent } from "vscode-languageserver-protocol";

/** 生成一个基于旧文本 UTF-16 code unit 的最小 replacement change。 */
export function incrementalContentChange(previous: string, next: string): TextDocumentContentChangeEvent {
	let prefix = 0;
	const sharedLength = Math.min(previous.length, next.length);
	while (prefix < sharedLength && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
	if (splitsCrLf(previous, prefix) || splitsCrLf(next, prefix)) prefix -= 1;

	let suffix = 0;
	while (
		suffix < previous.length - prefix
		&& suffix < next.length - prefix
		&& previous.charCodeAt(previous.length - suffix - 1) === next.charCodeAt(next.length - suffix - 1)
	) {
		suffix += 1;
	}
	while (suffix > 0 && (splitsCrLf(previous, previous.length - suffix) || splitsCrLf(next, next.length - suffix))) {
		suffix -= 1;
	}

	const previousEnd = previous.length - suffix;
	const nextEnd = next.length - suffix;
	return {
		range: { start: positionAt(previous, prefix), end: positionAt(previous, previousEnd) },
		text: next.slice(prefix, nextEnd),
	};
}

function positionAt(text: string, offset: number): Position {
	let line = 0;
	let lineStart = 0;
	let index = 0;
	while (index < offset) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			index += text.charCodeAt(index + 1) === 10 ? 2 : 1;
			line += 1;
			lineStart = index;
			continue;
		}
		if (code === 10) {
			index += 1;
			line += 1;
			lineStart = index;
			continue;
		}
		index += 1;
	}
	return { line, character: offset - lineStart };
}

function splitsCrLf(text: string, offset: number): boolean {
	return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10;
}
