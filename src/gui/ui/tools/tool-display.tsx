import { Bot, Check, CircleDashed, CircleStop, CodeXml, FilePenLine, FileSearch, FolderSearch, Globe, LoaderCircle, Search, Terminal, Wrench, X } from "lucide-react";
import type { ToolActivity, ToolState } from "../transcript/transcript-items.ts";
import { outputPreview } from "../../messages.ts";
import { clean, record } from "../content/content.tsx";

export const toolStates: Record<ToolState, string> = {
	preparing: "生成参数", pending: "等待执行", running: "执行中", completed: "完成", failed: "执行失败", stopped: "已停止", unavailable: "无执行结果",
};
const tools = {
	read: { label: "读取", icon: FileSearch }, grep: { label: "搜索", icon: Search }, find: { label: "查找", icon: FolderSearch },
	ls: { label: "列出", icon: FolderSearch }, edit: { label: "修改", icon: FilePenLine }, write: { label: "写入", icon: FilePenLine },
	subagent: { label: "子代理", icon: Bot }, codemode: { label: "codemode", icon: CodeXml },
	bash: { label: "运行", icon: Terminal }, websearch: { label: "搜索网页", icon: Globe }, webfetch: { label: "读取网页", icon: Globe },
};
export function errorSummary(tool: Pick<ToolActivity, "output">): string {
	const output = outputPreview(tool.output);
	const details = output?.details;
	if (record(details) && record(details.error) && typeof details.error.message === "string") return clean(details.error.message);
	const content = output?.content;
	if (Array.isArray(content)) {
		const first = content.find((block: unknown) => record(block) && block.type === "text");
		if (record(first) && typeof first.text === "string") return clean(first.text).split("\n").find((line) => line.trim()) ?? "";
	}
	return "";
}

export function toolDisplay(name: string) {
	return Object.hasOwn(tools, name) ? tools[name as keyof typeof tools] : { label: name || "工具调用", icon: Wrench };
}

export function ActivityState({ state, label = toolStates[state] }: { state: ToolState; label?: string | undefined }) {
	const active = state === "running" || state === "preparing";
	const Icon = active ? LoaderCircle : state === "completed" ? Check : state === "failed" ? X
		: state === "stopped" ? CircleStop : CircleDashed;
	return <span className="activity-state" data-state={state} title={label}>
		<Icon className={active ? "animate-spin" : ""} aria-hidden="true" /><span>{label}</span>
	</span>;
}
