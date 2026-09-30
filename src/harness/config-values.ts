/** 深度合并 JSON 对象，数组和标量由覆盖值替换。 */
export function mergeConfigValues(base: unknown, overlay: unknown): unknown {
	if (!isRecord(base) || !isRecord(overlay)) return structuredClone(overlay);
	const merged: Record<string, unknown> = structuredClone(base);
	for (const [key, value] of Object.entries(overlay)) {
		merged[key] = key in merged ? mergeConfigValues(merged[key], value) : structuredClone(value);
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
