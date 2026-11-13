import { File } from "lucide-react";
import { FileIcon } from "@/ui/file-icon.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { fileLanguage } from "@/ui/content/code-highlight.ts";
import { Content } from "../messages/content.tsx";
import { clean, record } from "@/ui/content/format.ts";
import type { ToolActivity } from "./activity.ts";
import type { GuiToolResult } from "../../../../shared/messages/types.ts";
import { WebFetchResult, WebSearchResult } from "./web-results.tsx";
import { SubagentProgress } from "./subagent-progress.tsx";

const text = (value: unknown) => typeof value === "string" ? value : "";

export function RawToolContent({ value }: { value: unknown }) {
	if (Array.isArray(value)) return <>{value.map((block, index) => <RawToolContent key={index} value={block} />)}</>;
	if (typeof value === "string") return <CodeBlock label="输出" text={clean(value)} />;
	if (record(value) && value.type === "text") return <CodeBlock label="输出" text={clean(text(value.text))} />;
	return <Content value={value} />;
}

export function ToolResult({ tool }: { tool: Omit<ToolActivity, "output"> & { output: GuiToolResult | undefined } }) {
	const { output, state } = tool;
	const args = record(tool.args) ? tool.args : {};
	if (tool.name === "bash") return <>
		{typeof args.command === "string" && <CodeBlock label="命令" language="bash" text={args.command} />}
		{output && <RawToolContent value={output.content} />}
	</>;
	if (!output) {
		if (tool.name === "write" && typeof args.content === "string") return <CodeBlock label="待写入内容" language={fileLanguage(text(args.path))} text={args.content} />;
		if (tool.name === "edit" && Array.isArray(args.edits)) return <>{args.edits.filter(record).map((edit, index) => (
			<CodeBlock key={index} label="拟修改" diff text={[
				...text(edit.old).split("\n").map((line) => `-${line}`),
				...text(edit.new).split("\n").map((line) => `+${line}`),
			].join("\n")} />
		))}</>;
		return null;
	}
	// 子代理和网页结果也展示失败或中止前已取得的部分结果。
	switch (output.view) {
		case "subagent": return <SubagentProgress details={output.details} state={state} />;
		case "websearch": return <WebSearchResult details={output.details} />;
		case "webfetch": return <WebFetchResult details={output.details} content={output.content} />;
		case "progress": return <p className="tool-note" role="status">{output.facts}</p>;
	}
	if (state === "failed" || state === "stopped") return <RawToolContent value={output.content} />;
	switch (output.view) {
		case "read": return <>
			{output.details.segments.map((segment, index) => <CodeBlock key={index} label={`${output.details.path}:${segment.start_line}–${segment.end_line}`}
				text={segment.content} language={fileLanguage(output.details.path)} startLine={segment.start_line} />)}
			{output.details.truncated && <p className="tool-note">内容已截断{output.details.continuation ? `，后续行号：${output.details.continuation.lines}` : ""}</p>}
		</>;
		case "diff": return <>
			{output.details.diff ? <CodeBlock label="变更" text={output.details.diff} diff /> : <p className="tool-note">文件内容没有变化</p>}
			{output.details.lsp?.diagnostics && <p className="tool-note">代码检查：{output.details.lsp.diagnostics.file_errors} 个错误，{output.details.lsp.diagnostics.file_warnings} 个警告</p>}
		</>;
		case "grep": return <>
			<div className="search-results">{output.details.regions.map((region, index) => <div className="search-result" key={index}>
				<div className="result-path"><File aria-hidden="true" /><code>{region.path}</code></div>
				{region.declaration && <div className="search-declaration">{region.declaration}</div>}
				{region.display_lines && <pre className="search-lines">{region.display_lines.map((line, lineIndex) => <span className={line.type === "match" ? "search-match" : ""} key={lineIndex}>
					<span className="line-number" aria-hidden="true">{line.line}</span>{line.text}{"\n"}
				</span>)}</pre>}
			</div>)}</div>
			{!output.details.regions.length && <p className="tool-note">没有匹配结果</p>}
			<SearchNotes details={output.details} />
		</>;
		case "find": return <><PathList entries={output.details.matches} /><SearchNotes details={output.details} /></>;
		case "ls": return <>
			<PathList entries={output.details.entries.map((entry) => ({ path: entry.name, kind: entry.type }))} />
			{output.details.truncated && <p className="tool-note">{output.details.continuation_hint}</p>}
		</>;
		case "raw": return <RawToolContent value={output.content} />;
	}
	output satisfies never;
}

function PathList({ entries }: { entries: { path: string; kind: "directory" | "file" | "symlink" | "other" }[] }) {
	return entries.length ? <ul className="path-list">{entries.map((entry, index) => <li key={index}>
		<FileIcon name={entry.path} kind={entry.kind} /><code>{entry.path}</code>
	</li>)}</ul> : <p className="tool-note">没有条目</p>;
}

function SearchNotes({ details }: { details: { truncated_by?: unknown[]; scope_errors?: { path: string; error?: { message: string } }[] } }) {
	return <>
		{Boolean(details.truncated_by?.length) && <p className="tool-note">仅展示部分结果</p>}
		{details.scope_errors?.map((error, index) => <p className="tool-note error" key={index}>{error.path}：{error.error?.message ?? "搜索失败"}</p>)}
	</>;
}
