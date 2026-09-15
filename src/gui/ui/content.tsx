import { Children, isValidElement, memo, type ReactNode } from "react";
import { CodeBlock } from "./code-block.tsx";
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

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
	if (!safeLink(href)) return <span className={className}>{children}</span>;
	return <a href={href} className={className} target="_blank" rel="noreferrer" onClick={(event) => {
		if (window.opi) {
			event.preventDefault();
			void window.opi.openExternal(href);
		}
	}}>{children}</a>;
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				pre: ({ children }) => {
					const child = Children.only(children);
					if (!isValidElement<{ children?: string; className?: string }>(child)) return <pre>{children}</pre>;
					const language = child.props.className?.replace(/^language-/, "") ?? "text";
					return <CodeBlock text={child.props.children ?? ""} label={language === "text" ? "代码" : language} language={language} />;
				},
				a: ({ href, children }) => href ? <ExternalLink href={href}>{children}</ExternalLink> : <span>{children}</span>,
				img: ({ alt }) => <span>[图片链接: {alt}]</span>,
			}}
		>
			{clean(text)}
		</Markdown>
	);
});

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

export function Message({ value }: { value: unknown }) {
	if (!record(value)) return <pre>{pretty(value)}</pre>;
	const role = String(value.role ?? "message");
	if (role === "custom" && value.display === false) return null;
	return (
		<article className={`message ${role}`}>
			{role !== "user" && <header><strong>{String(value.customType ?? role)}</strong></header>}
			{role === "bashExecution" ? <>
				{typeof value.command === "string" && <CodeBlock label="命令" language="bash" text={value.command} />}
				{typeof value.output === "string" && <CodeBlock label="输出" text={clean(value.output)} />}
			</> : <Content value={value.content ?? value.output ?? value} />}
			{typeof value.errorMessage === "string" && <pre className="error">{value.errorMessage}</pre>}
		</article>
	);
}
