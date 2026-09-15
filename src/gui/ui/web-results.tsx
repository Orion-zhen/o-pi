import { ExternalLink as LinkIcon, Globe } from "lucide-react";
import type { WebFetchSuccessDetails, WebSearchSuccessDetails } from "../../harness/web-tools/core/types.ts";
import { CodeBlock } from "./code-block.tsx";
import { Content, ExternalLink, MarkdownText, clean, record } from "./content.tsx";

export function isWebSearchSuccess(value: unknown): value is WebSearchSuccessDetails {
	return record(value) && value.status === "success" && typeof value.query === "string" && Array.isArray(value.results);
}
export function isWebFetchSuccess(value: unknown): value is WebFetchSuccessDetails {
	return record(value) && value.status === "success" && value.scope === "static_response"
		&& typeof value.final_url === "string" && typeof value.preview === "string" && record(value.range);
}

function WebCard({ url, title, snippet, rank }: { url: string; title?: string; snippet?: string; rank?: number }) {
	const domain = URL.canParse(url) ? new URL(url).hostname : "";
	return <article className="web-card">
		<ExternalLink href={url} className="web-card-link">
			<span className="web-card-source"><Globe aria-hidden="true" />{domain || clean(url)}
				{rank !== undefined && <span className="web-card-rank">{rank}</span>}<LinkIcon aria-hidden="true" />
			</span>
			<span className="web-card-title">{clean(title || url)}</span>
		</ExternalLink>
		{snippet && <p className="web-card-snippet">{clean(snippet)}</p>}
	</article>;
}

export function WebSearchResult({ details }: { details: WebSearchSuccessDetails }) {
	return details.results.length > 0
		? <div className="web-results">{details.results.map((item) => <WebCard key={item.rank} {...item} />)}</div>
		: <p className="tool-note">没有搜索结果</p>;
}

export function WebFetchResult({ details, content }: { details: WebFetchSuccessDetails; content: unknown }) {
	const range = details.range;
	const images = Array.isArray(content) ? content.filter((block: unknown) => record(block) && block.type === "image") : [];
	return <div className="web-fetch-result">
		<WebCard url={details.final_url} {...(details.title ? { title: details.title } : {})} />
		<p className="tool-note">{range.kind === "find" ? `${range.matches} 处匹配 · ${range.passages.length} 个片段`
			: `本次返回 ${range.start}–${range.end} / ${range.total} 字符`}
			{range.next_offset !== undefined && ` · 下一偏移 ${range.next_offset}`}
		</p>
		{details.completeness === "partial" && <p className="web-partial">仅取得部分静态内容，动态或嵌入内容可能未包含。</p>}
		{details.preview && <details className="web-preview">
			<summary>{range.kind === "find" ? "匹配片段预览" : "页面预览"}</summary>
			{details.format === "markdown" ? <div className="message web-preview-content"><MarkdownText text={details.preview} /></div>
				: <CodeBlock label="网页预览" text={clean(details.preview)} language={details.format === "source" || details.format === "xml" ? "markup" : details.format} />}
			<p className="tool-note">短预览，完整返回内容见原始数据。</p>
		</details>}
		{images.length > 0 && <Content value={images} />}
	</div>;
}

export function webToolFacts(details: unknown): string {
	if (isWebSearchSuccess(details)) return `${details.results.length} 个结果`;
	if (isWebFetchSuccess(details)) return [details.http_status, details.format, details.completeness === "partial" ? "部分内容" : ""].filter(Boolean).join(" · ");
	if (!record(details) || details.status !== "progress") return "";
	const phases: Record<string, string> = { waiting: "等待搜索", requesting: "请求中", redirecting: "重定向中", downloading: "下载中", converting: "提取正文", parsing: "整理结果" };
	if (typeof details.phase !== "string") return "";
	return [phases[details.phase], typeof details.received_bytes === "number" ? `${(details.received_bytes / 1024).toFixed(1)} KB` : ""].filter(Boolean).join(" · ");
}
