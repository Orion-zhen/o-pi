import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import webTools from "../../agent/extensions/web-tools.js";

describe("web-tools extension", () => {
	it("按顺序注册 websearch、webfetch 工具、schema 和错误标记事件", async () => {
		const registered: unknown[] = [];
		const handlers = new Map<string, Function>();
		const pi = {
			registerTool(tool: unknown) {
				registered.push(tool);
			},
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		};
		webTools(pi as unknown as ExtensionAPI);
		const searchTool = registered[0] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
		};
		const fetchTool = registered[1] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
		};
		expect(searchTool.name).toBe("websearch");
		expect(fetchTool.name).toBe("webfetch");
		expect(Object.keys(searchTool.parameters.properties)).toEqual(["query", "limit", "recency"]);
		expect(Object.keys(fetchTool.parameters.properties)).toEqual(["url", "mode", "offset", "limit"]);

		const eventResult = handlers.get("tool_result")?.({
			toolName: "webfetch",
			details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
		});
		expect(eventResult).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({
			toolName: "websearch",
			details: { status: "failed", provider: "duckduckgo_html", error: { code: "PROVIDER_BLOCKED", message: "blocked" } },
		})).toEqual({ isError: true });
		await handlers.get("session_shutdown")?.({});
	});
});
