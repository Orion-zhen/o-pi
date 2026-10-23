export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function pretty(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
export function clean(value: string): string {
	return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
}
export function safeLink(url: string): boolean {
	try {
		return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}
