import type { ReactNode } from "react";
import { LoaderCircle, Terminal, UserRound, Wrench } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function pretty(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
export function clean(value: string): string {
	return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}
export function safeLink(url: string): boolean {
	try {
		return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}

export function MarkdownText({ text }: { text: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ href, children }) =>
					href && safeLink(href) ? (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							onClick={(event) => {
								if (window.opi) {
									event.preventDefault();
									void window.opi.openExternal(href);
								}
							}}
						>
							{children}
						</a>
					) : (
						<span>{children}</span>
					),
				img: ({ alt }) => <span>[图片链接: {alt}]</span>,
			}}
		>
			{clean(text)}
		</Markdown>
	);
}

export function Content({ value }: { value: unknown }): ReactNode {
	if (typeof value === "string") return <MarkdownText text={value} />;
	if (Array.isArray(value)) return value.map((block, index) => <Content key={index} value={block} />);
	if (!record(value)) return <pre>{pretty(value)}</pre>;
	if (value.type === "text" && typeof value.text === "string") return <MarkdownText text={value.text} />;
	if (value.type === "thinking" && typeof value.thinking === "string")
		return (
			<details className="thinking">
				<summary>思考</summary>
				<MarkdownText text={value.thinking} />
			</details>
		);
	if (value.type === "toolCall")
		return (
			<details className="tool" open>
				<summary>调用 {String(value.name)}</summary>
				<pre>{pretty(value.arguments)}</pre>
			</details>
		);
	if (value.type === "image") {
		const source = record(value.source) ? value.source : value;
		const data = source.data;
		const mime = source.mediaType ?? source.mimeType;
		if (typeof data === "string" && typeof mime === "string" && /^image\/(png|jpeg|gif|webp)$/.test(mime))
			return <img className="attachment" src={`data:${mime};base64,${data}`} alt="会话图片" loading="lazy" />;
		return <span>[无法显示的图片格式]</span>;
	}
	return <pre>{pretty(value)}</pre>;
}

export function Message({ value, streaming = false }: { value: unknown; streaming?: boolean }) {
	if (!record(value)) return <pre>{pretty(value)}</pre>;
	const role = String(value.role ?? "message");
	const tool = role === "toolResult" || role === "tool";
	if (role === "custom" && value.display === false) return null;
	return (
		<article className={`message ${role}`}>
			<header>
				<span className="message-avatar" aria-hidden="true">
					{role === "user" ? <UserRound /> : tool ? <Wrench /> : <Terminal />}
				</span>
				<strong>
					{role === "user"
						? "你"
						: role === "assistant"
							? "o-pi"
							: tool
								? `工具结果 ${String(value.toolName ?? "")}`
								: String(value.customType ?? role)}
				</strong>
				{streaming && (
					<span className="streaming-label">
						<LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
						生成中
					</span>
				)}
				{typeof value.timestamp === "number" && <time>{new Date(value.timestamp).toLocaleTimeString()}</time>}
			</header>
			{tool ? (
				<details open={value.isError === true}>
					<summary>{value.isError ? "执行失败" : "查看结果"}</summary>
					<Content value={value.content} />
					{value.details !== undefined && (
						<details>
							<summary>结构化详情</summary>
							<pre>{pretty(value.details)}</pre>
						</details>
					)}
				</details>
			) : (
				<Content value={value.content ?? value.output ?? value} />
			)}
			{typeof value.errorMessage === "string" && <pre className="error">{value.errorMessage}</pre>}
		</article>
	);
}
