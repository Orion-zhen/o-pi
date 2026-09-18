import { File, Folder } from "lucide-react";
import { isReadSuccess } from "../../harness/file-tools/read/guards.ts";
import { isFindDetails } from "../../harness/file-tools/find/guards.ts";
import { isLsSuccess } from "../../harness/file-tools/ls/guards.ts";
import { CodeBlock } from "./code-block.tsx";
import { fileLanguage } from "./code-highlight.ts";
import { Content, clean, record } from "./content.tsx";
import type { ToolActivity } from "./transcript-items.ts";
import { WebFetchResult, WebSearchResult } from "./web-results.tsx";
import { SubagentProgress } from "./subagent-progress.tsx";
import { isWebFetchSuccess, isWebSearchSuccess, webToolFacts, isSubagentDetails } from "../tool-facts.ts";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function RawToolContent({ value }: { value: unknown }) {
	if (Array.isArray(value)) return <>{value.map((block, index) => <RawToolContent key={index} value={block} />)}</>;
	if (typeof value === "string") return <CodeBlock label="输出" text={clean(value)} />;
	if (record(value) && value.type === "text") return <CodeBlock label="输出" text={clean(text(value.text))} />;
	return <Content value={value} />;
}

export function ToolResult({ tool }: { tool: ToolActivity }) {
	const args = record(tool.args) ? tool.args : {};
	const details = tool.output?.details;
	if (tool.name === "subagent" && isSubagentDetails(details)) return <SubagentProgress details={details} state={tool.state} />;
	if (tool.name === "websearch" || tool.name === "webfetch") {
		if (tool.name === "websearch" && isWebSearchSuccess(details)) return <WebSearchResult details={details} />;
		if (tool.name === "webfetch" && isWebFetchSuccess(details)) return <WebFetchResult details={details} content={tool.output?.content} />;
		if (record(details) && details.status === "progress") return <p className="tool-note" role="status">{webToolFacts(details)}</p>;
	}
	if (tool.name === "bash") return <>
		{typeof args.command === "string" && <CodeBlock label="命令" language="bash" text={args.command} />}
		{tool.output && <RawToolContent value={tool.output.content} />}
	</>;
	if (tool.state !== "failed" && tool.state !== "stopped") {
		if (tool.name === "read" && isReadSuccess(details)) return <>
			{details.segments.map((segment, index) => <CodeBlock key={index} label={`${details.path}:${segment.start_line}–${segment.end_line}`}
				text={segment.content} language={fileLanguage(details.path)} startLine={segment.start_line} />)}
			{details.truncated && <p className="tool-note">内容已截断{details.continuation ? `，后续行号：${details.continuation.lines}` : ""}</p>}
		</>;
		if ((tool.name === "edit" || tool.name === "write") && record(details) && typeof details.diff === "string") return <>
			{details.diff ? <CodeBlock label="变更" text={details.diff} diff /> : <p className="tool-note">文件内容没有变化</p>}
			{record(details.lsp) && record(details.lsp.diagnostics) && <p className="tool-note">
				代码检查：{String(details.lsp.diagnostics.file_errors)} 个错误，{String(details.lsp.diagnostics.file_warnings)} 个警告
			</p>}
		</>;
		if (tool.name === "grep" && record(details) && Array.isArray(details.regions)) return <>
			<div className="search-results">{details.regions.filter(record).map((region, index) => (
				<div className="search-result" key={index}>
					<div className="result-path"><File aria-hidden="true" /><code>{text(region.path)}</code></div>
					{typeof region.declaration === "string" && <div className="search-declaration">{region.declaration}</div>}
					{Array.isArray(region.display_lines) && <pre className="search-lines">{region.display_lines.filter(record).map((line, lineIndex) => (
						<span className={line.type === "match" ? "search-match" : ""} key={lineIndex}>
							<span className="line-number" aria-hidden="true">{typeof line.line === "number" ? line.line : ""}</span>
							{text(line.text)}{"\n"}
						</span>
					))}</pre>}
				</div>
			))}</div>
			{details.regions.length === 0 && <p className="tool-note">没有匹配结果</p>}
			<SearchNotes details={details} />
		</>;
		if (tool.name === "find" && isFindDetails(details)) return <>
			<PathList entries={details.displayed_matches.map((entry) => ({ path: entry.path, directory: entry.kind === "directory" }))} />
			<SearchNotes details={details} />
		</>;
		if (tool.name === "ls" && isLsSuccess(details)) return <>
			<PathList entries={details.entries.map((entry) => ({ path: entry.name, directory: entry.type === "directory" }))} />
			{details.truncated && <p className="tool-note">{details.continuation_hint}</p>}
		</>;
	}
	if (tool.output) return <RawToolContent value={tool.output.content} />;
	if (tool.name === "write" && typeof args.content === "string") return <CodeBlock label="待写入内容" language={fileLanguage(text(args.path))} text={args.content} />;
	if (tool.name === "edit" && Array.isArray(args.edits)) return <>{args.edits.filter(record).map((edit, index) => (
		<CodeBlock key={index} label="拟修改" diff text={[
			...text(edit.old).split("\n").map((line) => `-${line}`),
			...text(edit.new).split("\n").map((line) => `+${line}`),
		].join("\n")} />
	))}</>;
	return null;
}

function PathList({ entries }: { entries: { path: string; directory: boolean }[] }) {
	return entries.length ? <ul className="path-list">{entries.map((entry, index) => <li key={index}>
		{entry.directory ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}<code>{entry.path}</code>
	</li>)}</ul> : <p className="tool-note">没有条目</p>;
}

function SearchNotes({ details }: { details: { truncated_by?: unknown; scope_errors?: unknown } }) {
	return <>
		{Array.isArray(details.truncated_by) && details.truncated_by.length > 0 && <p className="tool-note">仅展示部分结果</p>}
		{Array.isArray(details.scope_errors) && details.scope_errors.filter(record).map((error, index) => (
			<p className="tool-note error" key={index}>{text(error.path)}：{record(error.error) ? text(error.error.message) : "搜索失败"}</p>
		))}
	</>;
}
