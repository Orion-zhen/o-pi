import type { WebFetchResult, WebSearchResult } from "./types.js";
import { escapeXml } from "./url-utils.js";

export function runtimeConfigFailure(tool: "webfetch" | "websearch", error: unknown): WebFetchResult & WebSearchResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: `<error tool="${tool}" code="CONFIG_ERROR">\n${escapeXml(message)}\n</error>`,
		details: { status: "failed", error: { code: "CONFIG_ERROR", message }, duration_ms: 0 },
	};
}
