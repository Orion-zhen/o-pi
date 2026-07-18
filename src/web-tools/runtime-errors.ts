import type { WebFetchResult, WebSearchResult } from "./types.js";
import { escapeXml } from "./url-utils.js";

export function runtimeConfigFailure(tool: "webfetch" | "websearch", error: unknown): WebFetchResult & WebSearchResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: `<error tool="${tool}" code="CONFIG_ERROR">\n${escapeXml(message)}\n</error>`,
		details: { status: "failed", error: { code: "CONFIG_ERROR", message }, duration_ms: 0 },
	};
}

/** 从 capability 图内并行启动配置模块；只启动一次，失败后允许重试。 */
export function createConfigModulePreloader(): () => void {
	let pending: Promise<typeof import("./config.js")> | undefined;
	return () => {
		if (pending !== undefined) return;
		const created = import("./config.js");
		pending = created;
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
	};
}
