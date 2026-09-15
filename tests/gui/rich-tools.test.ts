import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolResult } from "../../src/gui/ui/tool-results.tsx";
import { ToolActivity } from "../../src/gui/ui/tool-activity.tsx";
import type { ToolActivity as Activity } from "../../src/gui/ui/transcript-items.ts";
import { agentDetails, agentRun, fetchDetails, searchDetails } from "./rich-tool-fixtures.ts";

function activity(name: string, details: unknown, state: Activity["state"] = "completed"): Activity {
	return { id: "rich-tool", name, args: {}, state, output: { content: [{ type: "text", text: "模型包装文本" }], details } };
}
const render = (tool: Activity) => renderToStaticMarkup(createElement(ToolResult, { tool }));

describe("网页卡片", () => {
	it("搜索结果展示标题、域名、摘要和安全链接，不展示包装文本", () => {
		const html = render(activity("websearch", searchDetails));
		expect(html).toContain('class="web-card"');
		expect(html).toContain("React 文档");
		expect(html).toContain("react.dev");
		expect(html).toContain("了解组件与流式交互。");
		expect(html).toContain('href="https://react.dev/learn?source=search"');
		expect(html).toContain('target="_blank"');
		expect(html).not.toContain("模型包装文本");
	});
	it("空搜索有明确提示，网页标题不解释为 HTML，危险协议不可点击", () => {
		expect(render(activity("websearch", { ...searchDetails, results: [] }))).toContain("没有搜索结果");
		const html = render(activity("websearch", { ...searchDetails, results: [{ rank: 1, title: "<script>alert(1)</script>", url: "javascript:alert(1)" }] }));
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
	});
	it("读取网页展示 Markdown 预览、静态内容限制和续读位置，不自动请求远程图片", () => {
		const html = render(activity("webfetch", fetchDetails));
		expect(html).toContain("<strong>组件</strong>");
		expect(html).toContain("仅取得部分静态内容");
		expect(html).toContain("2000");
		expect(html).toContain("下一偏移");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("模型包装文本");
	});
	it("源码预览按代码显示，查找显示离散片段数量", () => {
		const html = render(activity("webfetch", { ...fetchDetails, format: "source", preview: "<main>raw</main>", range: { kind: "find", start: 100, total: 6000, has_more: false, matches: 2, passages: [{ start: 110, end: 150 }] } }));
		expect(html).toContain("复制网页预览");
		expect(html).not.toContain("<main>raw</main>");
		expect(html).toContain("2 处匹配");
		expect(html).toContain("1 个片段");
	});
	it("折叠操作行也显示真实下载阶段与搜索结果数量", () => {
		const view = (tool: Activity) => renderToStaticMarkup(createElement(ToolActivity, { tool }));
		expect(view(activity("webfetch", { status: "progress", phase: "downloading", received_bytes: 2048 }, "running"))).toContain("下载中");
		expect(view(activity("websearch", searchDetails))).toContain("2 个结果");
	});
});

describe("子代理进度", () => {
	it("执行中默认展开，展示同名代理的不同任务、实时工具和排队任务", () => {
		const tool = activity("subagent", { ...agentDetails, results: [agentRun(0), agentRun(1)] }, "running");
		const html = renderToStaticMarkup(createElement(ToolActivity, { tool }));
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("检查聊天布局");
		expect(html).toContain("检查流式状态");
		expect(html).toContain("检查回归测试");
		expect(html).toContain("src/gui/ui/main.tsx");
		expect(html).toContain("等待执行");
		expect(html).toContain('max="3"');
		expect(render(tool)).not.toContain("模型包装文本");
	});
	it("后启动的任务先完成时，进度按完成数计算而非数组长度", () => {
		const html = render(activity("subagent", { ...agentDetails, results: [agentRun(0), agentRun(1, { status: "completed", exitCode: 0, outputFile: "/workspace/result.md", output: "**状态检查通过**" })] }, "running"));
		expect(html).toContain('value="1"');
		expect(html).toContain("1/3 已结束");
		expect(html).toContain("<strong>状态检查通过</strong>");
	});
	it.each(["failed", "unavailable"] as const)("串行失败保留错误并将后续任务标为未执行：%s", (state) => {
		const html = render(activity("subagent", { ...agentDetails, mode: "chain", results: [agentRun(0, { status: "completed", exitCode: 1, outputFile: "/workspace/error.md", error: "provider unavailable", output: "已生成的部分" })] }, state));
		expect(html).toContain("串行");
		expect(html).toContain("provider unavailable");
		expect(html).toContain("未执行");
		expect(html).toContain("1 失败");
		expect(html).toContain("已生成的部分");
	});
	it("取消的任务不显示为成功，保留已完成的同批任务", () => {
		const html = render(activity("subagent", { ...agentDetails, results: [
			agentRun(0, { status: "completed", exitCode: 0, outputFile: "/workspace/ok.md", output: "布局完成" }),
			agentRun(1, { status: "completed", exitCode: 1, outputFile: "/workspace/abort.md", error: "subagent aborted" }),
		] }, "failed"));
		expect(html).toContain('data-state="stopped"');
		expect(html).toContain("已停止");
		expect(html).toContain("布局完成");
	});
});
