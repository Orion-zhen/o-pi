import { createHash } from "node:crypto";

/** 对安全上下文使用稳定 JSON，确保 ticket 与 grant 不受对象 key 顺序影响。 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function digestBytes(bytes: Buffer | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function cloneJson<T>(value: T): T {
	return structuredClone(value);
}

export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	Object.freeze(value);
	for (const entry of Object.values(value)) deepFreeze(entry);
	return value;
}
