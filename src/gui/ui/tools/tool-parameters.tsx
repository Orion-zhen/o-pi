import { CodeBlock } from "../content/code-block.tsx";
import { record } from "../content/content.tsx";

export function ParameterValue({ value }: { value: unknown }) {
	if (value === null || value === undefined) return <span className="parameter-empty">未指定</span>;
	if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
	if (Array.isArray(value)) return value.length ? <ul className="parameter-list">{value.map((entry, index) => (
		<li key={index}><ParameterValue value={entry} /></li>
	))}</ul> : <span className="parameter-empty">空列表</span>;
	if (record(value)) return <dl className="parameter-fields">{Object.entries(value).map(([key, entry]) => (
		<div key={key}><dt>{key}</dt><dd><ParameterValue value={entry} /></dd></div>
	))}</dl>;
	const text = String(value);
	return text.includes("\n") ? <CodeBlock text={text} label="内容" /> : <span className="parameter-value">{text}</span>;
}
