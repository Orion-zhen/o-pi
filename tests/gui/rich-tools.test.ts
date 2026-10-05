import { createElement } from "react";
import { renderWithMemory } from "./render.ts";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ToolResult } from "../../src/gui/ui/tools/tool-results.tsx";
import type { ToolActivity } from "../../src/gui/ui/transcript/transcript-items.ts";
import { agentDetails, agentRun, fetchDetails, searchDetails } from "./rich-tool-fixtures.ts";

function render(name: string, details: unknown, state: ToolActivity["state"] = "completed") {
	const tool = { id: "rich-tool", name, args: {}, state, output: { content: [], details } };
	return parseHTML(renderWithMemory(createElement(ToolResult, { tool }))).document;
}

describe("文件列表图标", () => {
	it("ls 按文件名显示类型图标，并区分目录和符号链接", () => {
		const names = ["src", "package.json", "index.ts", "current"];
		const doc = render("ls", { path: "/workspace", truncated: false, entries: names.map((name, index) => ({
			name, path: `/workspace/${name}`, type: index === 0 ? "directory" : index === 3 ? "symlink" : "file",
		})) });
		const icons = [...doc.querySelectorAll(".path-list .file-type-icon")];
		expect(icons).toHaveLength(4);
		expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(4);
		expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
		expect(icons[3]?.classList.contains("file-link-icon")).toBe(true);
		expect([...doc.querySelectorAll(".path-list code")].map((code) => code.textContent)).toEqual(names);
	});

	it("find 用路径的文件名选择同款图标", () => {
		const ls = render("ls", { path: "/workspace", truncated: false, entries: [{ name: "package.json", path: "/workspace/package.json", type: "file" }] });
		const find = render("find", {
			status: "success", query: "package", path: "/workspace", paths: ["/workspace"],
			total_candidates: 1, total_matches: 1, returned_matches: 1, matches: [], stats: {}, truncated_by: [],
			displayed_matches: [{ path: "nested/package.json", kind: "file" }],
		});
		expect(find.querySelector(".file-type-icon")?.outerHTML).toBe(ls.querySelector(".file-type-icon")?.outerHTML);
	});
});

describe("外部工具内容", () => {
	it("搜索结果允许网页链接，但标题不能注入 HTML，危险协议不可点击", () => {
		const doc = render("websearch", { ...searchDetails, results: [
			...searchDetails.results,
			{ rank: 3, title: "<script>alert(1)</script>", url: "javascript:alert(1)" },
		] });
		expect(doc.querySelector('a[href="https://react.dev/learn?source=search"]')).not.toBeNull();
		expect(doc.querySelector("script")).toBeNull();
		expect(doc.querySelector('a[href^="javascript:"]')).toBeNull();
	});

	it("网页 Markdown 不自动加载远程图片，源码预览不作为 HTML 执行", () => {
		const markdown = render("webfetch", fetchDetails);
		expect(markdown.querySelector("img, iframe")).toBeNull();
		const source = render("webfetch", { ...fetchDetails, format: "source", preview: "<script>alert(1)</script>" });
		expect(source.querySelector("script")).toBeNull();
		expect(source.querySelector("pre")?.textContent).toContain("<script>alert(1)</script>");
	});
});

describe("子代理结束状态", () => {
	it("折叠的长输出只渲染摘要，不挂载正文和执行记录", () => {
		const doc = render("subagent", { ...agentDetails, results: [
			agentRun(0, { exitCode: 0, outputFile: "/workspace/result.md", output: "进度内容".repeat(20_000), events: [{ type: "text", text: "历史过程" }] }),
		] }, "running");
		expect(doc.querySelector(".subagent-current")?.textContent?.length).toBeLessThanOrEqual(2048);
		expect(doc.querySelector(".subagent-task-body, .subagent-events")).toBeNull();
	});

	it("串行失败保留错误和部分结果，后续任务标为未执行", () => {
		const doc = render("subagent", { ...agentDetails, mode: "chain", results: [
			agentRun(0, { mode: "chain", exitCode: 1, outputFile: "/workspace/error.md", error: "provider unavailable", output: "已生成的部分" }),
		] }, "failed");
		expect([...doc.querySelectorAll(".subagent-task")].map((task) => task.getAttribute("data-state")))
			.toEqual(["failed", "skipped", "skipped"]);
		expect(doc.querySelector(".subagent-error")?.textContent).toBe("provider unavailable");
		expect(doc.querySelector(".subagent-output")?.textContent).toBe("已生成的部分");
	});

	it("取消的任务不显示为成功，保留已完成的同批任务", () => {
		const doc = render("subagent", { ...agentDetails, results: [
			agentRun(0, { exitCode: 0, outputFile: "/workspace/ok.md", output: "布局完成" }),
			agentRun(1, { exitCode: 1, outputFile: "/workspace/abort.md", error: "subagent aborted" }),
		] }, "failed");
		expect([...doc.querySelectorAll(".subagent-task")].map((task) => task.getAttribute("data-state")))
			.toEqual(["completed", "stopped", "skipped"]);
		expect(doc.querySelector(".subagent-current")?.textContent).toBe("布局完成");
		expect(doc.querySelector(".subagent-task-body")).toBeNull();
	});
});
