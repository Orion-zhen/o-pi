import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ToolResult } from "../../src/gui/ui/tool-results.tsx";
import type { ToolActivity } from "../../src/gui/ui/transcript-items.ts";
import { agentDetails, agentRun, fetchDetails, searchDetails } from "./rich-tool-fixtures.ts";

function render(name: string, details: unknown, state: ToolActivity["state"] = "completed") {
	const tool: ToolActivity = { id: "rich-tool", name, args: {}, state, output: { content: [], details } };
	return parseHTML(renderToStaticMarkup(createElement(ToolResult, { tool }))).document;
}

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
		expect(doc.querySelector(".subagent-output")?.textContent).toBe("布局完成");
	});
});
