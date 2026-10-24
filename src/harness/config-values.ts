/** 深度合并 JSON 对象，数组和标量由覆盖值替换。 */
export function mergeConfigValues(base: unknown, overlay: unknown): unknown {
	if (!isRecord(base) || !isRecord(overlay)) return structuredClone(overlay);
	const merged: Record<string, unknown> = structuredClone(base);
	for (const [key, value] of Object.entries(overlay)) {
		merged[key] = key in merged ? mergeConfigValues(merged[key], value) : structuredClone(value);
	}
	return merged;
}

/** 比较配置值，忽略对象键顺序，保留数组顺序。 */
export function equalConfigValues(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => equalConfigValues(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length
		&& keys.every((key) => Object.hasOwn(right, key) && equalConfigValues(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
