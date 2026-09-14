/** 仅返回顶层属性中已收到结束引号的完整 JSON 字符串值。 */
export function completedTopLevelStringProperty(source: string, property: string): string | undefined {
	let depth = 0;
	for (let cursor = 0; cursor < source.length;) {
		const character = source[cursor] ?? "";
		if (character === "{" || character === "[") {
			depth += 1;
			cursor += 1;
			continue;
		}
		if (character === "}" || character === "]") {
			depth -= 1;
			cursor += 1;
			continue;
		}
		if (character !== "\"") {
			cursor += 1;
			continue;
		}
		const keyEnd = jsonStringEnd(source, cursor);
		if (keyEnd === undefined) return undefined;
		const key = decodeJsonString(source.slice(cursor, keyEnd));
		if (depth === 1 && key === property) {
			let valueStart = skipWhitespace(source, keyEnd);
			if (source[valueStart] === ":") valueStart = skipWhitespace(source, valueStart + 1);
			else {
				cursor = keyEnd;
				continue;
			}
			if (source[valueStart] !== "\"") return undefined;
			const valueEnd = jsonStringEnd(source, valueStart);
			if (valueEnd === undefined) return undefined;
			return decodeJsonString(source.slice(valueStart, valueEnd));
		}
		cursor = keyEnd;
	}
	return undefined;
}

function jsonStringEnd(source: string, start: number): number | undefined {
	let escaped = false;
	for (let cursor = start + 1; cursor < source.length; cursor += 1) {
		const character = source[cursor];
		if (escaped) escaped = false;
		else if (character === "\\") escaped = true;
		else if (character === "\"") return cursor + 1;
	}
	return undefined;
}

function decodeJsonString(source: string): string | undefined {
	try {
		const value: unknown = JSON.parse(source);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function skipWhitespace(source: string, start: number): number {
	let cursor = start;
	while (cursor < source.length && /\s/u.test(source[cursor] ?? "")) cursor += 1;
	return cursor;
}

export function stringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
