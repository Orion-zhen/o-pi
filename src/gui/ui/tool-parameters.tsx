import { CodeBlock } from "./code-block.tsx";
import { record } from "./content.tsx";

const labels: Record<string, string> = {
	path: "路径", paths: "路径", query: "查询", glob: "文件筛选", mode: "模式", lines: "行号", pages: "页码",
	command: "命令", timeout: "超时（秒）", content: "内容", edits: "替换", old: "原内容", new: "新内容",
	replace_all: "替换全部", url: "网址", find: "查找", offset: "起点", limit: "上限", name: "名称",
	tasks: "任务", agent: "代理", task: "任务说明", cwd: "工作目录",
};

export function ParameterValue({ value }: { value: unknown }) {
	if (value === null || value === undefined) return <span className="parameter-empty">未指定</span>;
	if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
	if (Array.isArray(value)) return value.length ? <ul className="parameter-list">{value.map((entry, index) => (
		<li key={index}><ParameterValue value={entry} /></li>
	))}</ul> : <span className="parameter-empty">空列表</span>;
	if (record(value)) return <dl className="parameter-fields">{Object.entries(value).map(([key, entry]) => (
		<div key={key}><dt title={key}>{Object.hasOwn(labels, key) ? labels[key] : key}</dt><dd><ParameterValue value={entry} /></dd></div>
	))}</dl>;
	const text = String(value);
	return text.includes("\n") ? <CodeBlock text={text} label="内容" /> : <span className="parameter-value">{text}</span>;
}
