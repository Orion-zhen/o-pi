import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";

interface ThemeStub {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
}

const theme: ThemeStub = {
	fg(_name: string, text: string) {
		return text;
	},
	bg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return text;
	},
};

interface Renderable {
	render(width: number): string[];
}

type ToolResultHandler = (event: { toolName: string; details: unknown }) => unknown;
type RenderResult = (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeStub, context: unknown) => Renderable;
type RenderCall = (args: unknown, theme: ThemeStub, context: unknown) => Renderable;

describe("file-tools extension", () => {
	beforeAll(() => {
		initTheme();
	});

	it("文件工具失败结果标记为错误，并按失败分支渲染", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, ToolResultHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: ToolResultHandler) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);

		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "C:/Users/orion/.pi" },
		};
		expect(handlers.get("tool_result")?.({ toolName: "find", details: failure })).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({ toolName: "find", details: { total: 0 } })).toBeUndefined();

		for (const toolName of ["ls", "find", "grep", "read"]) {
			const output = renderToolResult(registered, toolName, failure);
			expect(output).toContain("INVALID_PATH: path must be workspace-relative.");
			expect(output).not.toContain('"status": "failed"');
		}
	});

	it("find 使用自定义调用和结果 renderer 展示 strategy、类型、折叠组和扫描统计", () => {
		const registered: Array<{ name: string; renderCall?: RenderCall; renderResult?: RenderResult }> = [];
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);
		const find = registered.find((tool) => tool.name === "find");
		const call = find?.renderCall?.({ query: "auth service", path: "." }, theme, {
			cwd: "/repo",
			lastComponent: undefined,
		});
		const callOutput = call?.render(120).join("\n") ?? "";
		expect(callOutput.split("\n")).toHaveLength(2);
		expect(callOutput).toContain('find      "auth service" in .');

		const details = {
			query: "auth service",
			path: ".",
			strategy: "fuzzy",
			totalMatches: 5,
			returnedMatches: 3,
			scannedEntries: 42,
			matches: [
				{ path: "src/auth", kind: "directory" },
				{ path: "src/auth/service.ts", kind: "file" },
			],
			collapsedGroups: [{ path: "tests/auth", files: 2, directories: 0 }],
			ignoredCount: 1,
			skippedCount: 0,
			truncated: true,
		};
		const collapsed = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const collapsedOutput = collapsed?.render(120).join("\n") ?? "";
		expect(collapsedOutput.split("\n")).toHaveLength(2);
		expect(collapsedOutput).toContain("5 matches · 1 file · 1 directory · fuzzy · truncated");

		const expanded = find?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined },
		);
		const output = expanded?.render(120).join("\n") ?? "";
		expect(output).toContain("src/auth/ (directory)");
		expect(output).toContain("src/auth/service.ts (file)");
		expect(output).toContain("tests/auth/** (2 files)");
		expect(output).toContain("Scanned 42 entries; skipped 0; ignored 1.");
		expect(output).toContain("Truncated.");
	});

	it("edit 完成后成功和失败结果都保留 tool card 背景，折叠态成功结果展示 diff", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const success = renderEditResult(registered, {
			status: "applied",
			path: "src/app.ts",
			replacements: 1,
			old_version: "old",
			new_version: "new",
			diff: "-old\n+new",
		});
		expect(success).toContain("toolSuccessBg");
		expect(success).toContain("edit      src/app.ts");
		expect(success).toContain("+1 -1");
		expect(success).toContain("-old");
		expect(success).toContain("+new");

		const failure = renderEditResult(registered, {
			status: "failed",
			error: { code: "OLD_TEXT_NOT_FOUND", message: "edits[0].old was not found in the original file." },
		});
		expect(failure).toContain("toolErrorBg");
		expect(failure).toContain("OLD_TEXT_NOT_FOUND: edits[0].old was not found in the original file.");
	});

	it("edit 参数完整后的折叠调用预览展示 diff", async () => {
		const registered: Array<{ name: string; renderCall?: RenderCall }> = [];
		fileTools({
			registerTool(tool: { name: string; renderCall?: RenderCall }) {
				registered.push(tool);
			},
			on() {},
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-edit-card-"));
		await writeFile(join(cwd, "app.ts"), "old\n", "utf8");
		const edit = registered.find((tool) => tool.name === "edit");
		const args = { path: "app.ts", edits: [{ old: "old", new: "new" }] };
		const context = {
			args,
			argsComplete: true,
			cwd,
			expanded: false,
			invalidate() {},
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};

		const first = edit?.renderCall?.(args, theme, context);
		const output = await renderEditCallAfterPreview(edit, args, context, first);
		expect(output).toContain("edit      app.ts");
		expect(output).toContain("-1 old");
		expect(output).toContain("+1 new");
	});
});

function renderToolResult(registered: Array<{ name: string; renderResult?: RenderResult }>, toolName: string, details: unknown): string {
	const tool = registered.find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(120).join("\n") ?? "";
}

function renderEditResult(registered: Array<{ name: string; renderResult?: RenderResult }>, details: unknown): string {
	const tool = registered.find((item) => item.name === "edit");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", edits: [{ old: "old", new: "new" }] },
			cwd: "/repo",
			expanded: false,
			lastComponent: undefined,
			state: {},
		},
	);
	return component?.render(120).join("\n") ?? "";
}

async function renderEditCallAfterPreview(
	edit: { renderCall?: RenderCall } | undefined,
	args: unknown,
	context: Record<string, unknown>,
	first: Renderable | undefined,
): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		const component = edit?.renderCall?.(args, theme, { ...context, lastComponent: first });
		const output = component?.render(120).join("\n") ?? "";
		if (output.includes("old") && output.includes("new")) return output;
	}
	return edit?.renderCall?.(args, theme, { ...context, lastComponent: first })?.render(120).join("\n") ?? "";
}
