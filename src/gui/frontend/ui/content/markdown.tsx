import { createContext, isValidElement, lazy, memo, Suspense, useCallback, useContext, useState, type ComponentProps } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import { useGuiQuery } from "@/connection/query-context.ts";
import { useRemote } from "@/connection/use-remote.ts";
import { ImagePreviewButton } from "../media/image-preview.tsx";
import { Hint } from "../tooltip.tsx";
import { CodeBlock } from "./code-block.tsx";
import { MermaidBlock } from "./mermaid-block.tsx";
import { FileLinksContext, fileLinkPath } from "./file-links.ts";
import { remarkMath } from "./remark-math.ts";
import { clean } from "./format.ts";
import { ExternalLink } from "./external-link.tsx";
import { TextReveal, RevealedText, rehypeTextReveal } from "./text-reveal.tsx";
import "./math.css";

export function StreamingText({ text, active, reveal = false }: { text: string; active: boolean; reveal?: boolean }) {
	// 历史消息不安装动画层，流式结束后保留渲染结构。
	const [revealMounted, setRevealMounted] = useState(reveal && active);
	if (reveal && active && !revealMounted) setRevealMounted(true);
	const content = <MarkdownText text={text} reveal={revealMounted} />;
	return <Streaming value={active}>
		<div className="streaming-markdown">{revealMounted ? <TextReveal text={clean(text)} active={active}>{content}</TextReveal> : content}</div>
	</Streaming>;
}

const MathFormula = lazy(() => import("./math-formula.tsx"));

function MarkdownSpan({ node, children, ...props }: ComponentProps<"span"> & ExtraProps) {
	const start = node?.properties.dataTextStart;
	if (typeof start === "number" && typeof children === "string") return <RevealedText text={children} start={start} />;
	const source = node?.properties.dataMathSource;
	const tex = node?.properties.dataMathTex;
	if (typeof source !== "string" || typeof tex !== "string") return <span {...props}>{children}</span>;
	const display = node?.properties.dataMathDisplay === true;
	return <Suspense fallback={<span className={display ? "math-formula math-display" : "math-formula"}>{source}</span>}>
		<MathFormula tex={tex} source={source} display={display} />
	</Suspense>;
}

function MarkdownLink({ href, children }: ComponentProps<"a">) {
	const files = useContext(FileLinksContext);
	const path = files && href ? fileLinkPath(href, files.cwd) : undefined;
	if (files && path !== undefined) return <Hint content={path}><a href={`./${path.split("/").map(encodeURIComponent).join("/")}`} onClick={(event) => {
		event.preventDefault();
		files.openFile(path);
	}}>{children}</a></Hint>;
	return href ? <ExternalLink href={href}>{children}</ExternalLink> : <span>{children}</span>;
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
	const files = useContext(FileLinksContext);
	const path = files && typeof src === "string" && fileLinkPath(src, files.cwd);
	return path ? <WorkspaceImage cwd={files.cwd} path={path} label={alt || path} hint={src} /> : <span>[图片链接: {alt}]</span>;
}

function WorkspaceImage({ cwd, path, label, hint }: { cwd: string; path: string; label: string; hint: string }) {
	const query = useGuiQuery();
	const load = useCallback(async () => {
		const { content } = await query({ query: "previewFile", cwd, path });
		return content.kind === "image" ? content.url : undefined;
	}, [query, cwd, path]);
	const { result } = useRemote(load);
	if (result.state === "error") return <span role="alert">{result.message}</span>;
	const src = result.state === "ready" ? result.value : undefined;
	return <ImagePreviewButton src={src} alt={label} hint={hint}>
		<img className="attachment" src={src} alt={label} loading="lazy" />
	</ImagePreviewButton>;
}

const Streaming = createContext(false);
const markdownPlugins: NonNullable<ComponentProps<typeof Markdown>["remarkPlugins"]> = [
	[remarkGfm, { singleTilde: false }],
	remarkCjkFriendly,
	[remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }],
	remarkMath,
];
const markdownUrl: UrlTransform = (url, key, node) =>
	(node.tagName === "a" && key === "href") || (node.tagName === "img" && key === "src") ? url : defaultUrlTransform(url);
const markdownComponents: Components = {
	span: MarkdownSpan,
	pre: MarkdownCode,
	a: MarkdownLink,
	img: MarkdownImage,
};

function MarkdownCode({ children: child }: ComponentProps<"pre">) {
	const streaming = useContext(Streaming);
	if (!isValidElement<{ children?: string; className?: string }>(child)) throw new Error("代码块需要单个 React 元素");
	const language = child.props.className?.replace(/^language-/, "") ?? "text";
	if (language.toLowerCase() === "mermaid") return <MermaidBlock text={child.props.children ?? ""} streaming={streaming} />;
	return <CodeBlock text={child.props.children ?? ""} label={language === "text" ? "代码" : language} language={language} highlight={!streaming} />;
}

const revealPlugins = [rehypeTextReveal];
export const MarkdownText = memo(function MarkdownText({ text, reveal = false }: { text: string; reveal?: boolean }) {
	return <Markdown remarkPlugins={markdownPlugins} rehypePlugins={reveal ? revealPlugins : undefined}
		components={markdownComponents} urlTransform={markdownUrl}>{clean(text)}</Markdown>;
});
