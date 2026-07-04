import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import webTools from "../agent/extensions/web-tools.js";
import { buildSystemPrompt } from "../agent/extensions/system-prompt.js";

describe("web-tools extension", () => {
	it("按顺序注册 websearch、webfetch 工具、schema 和简短提示", async () => {
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
			promptSnippet: string;
			promptGuidelines: string[];
		};
		const fetchTool = registered[1] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
			promptSnippet: string;
			promptGuidelines: string[];
		};
		expect(searchTool.name).toBe("websearch");
		expect(fetchTool.name).toBe("webfetch");
		expect(Object.keys(searchTool.parameters.properties)).toEqual(["query", "limit", "recency"]);
		expect(Object.keys(fetchTool.parameters.properties)).toEqual(["url", "mode", "offset", "limit"]);
		expect(searchTool.promptSnippet).toContain("query");
		expect(fetchTool.promptSnippet).toContain("known HTTP(S) URL");
		expect(new Set([...searchTool.promptGuidelines, ...fetchTool.promptGuidelines]).size).toBe(3);

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

	it("system prompt fallback 包含 webfetch", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\repo",
			toolSnippets: {
				ls: "List",
				read: "Read",
				find: "Find",
				grep: "Grep",
				websearch: "Search",
				webfetch: "Fetch",
				bash: "Bash",
				edit: "Edit",
			},
		});
		expect(prompt).toContain("- websearch: Search");
		expect(prompt).toContain("- webfetch: Fetch");
		expect(prompt.indexOf("- websearch: Search")).toBeLessThan(prompt.indexOf("- webfetch: Fetch"));
	});
});
