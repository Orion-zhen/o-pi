import { createContext, isValidElement, lazy, memo, Suspense, useContext, type ComponentProps } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from "react-markdown";
import { Streamdown } from "streamdown";
import { streamingTextReveal } from "../motion/transitions.ts";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import { Hint } from "../tooltip.tsx";
import { CodeBlock } from "./code-block.tsx";
import { MermaidBlock } from "./mermaid-block.tsx";
import { FileLinksContext, fileLinkPath } from "./file-links.ts";
import { remarkMath } from "./remark-math.ts";
import { clean } from "./format.ts";
import { ExternalLink } from "./external-link.tsx";
import "streamdown/styles.css";
import "./math.css";

export function StreamingText({ text, active }: { text: string; active: boolean }) {
	return <Streaming value={active}>
		<Streamdown className="streaming-markdown space-y-0" animated={streamingTextReveal} isAnimating={active}
			remarkPlugins={markdownPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents} urlTransform={markdownUrl}>
			{clean(text)}
		</Streamdown>
	</Streaming>;
}

const MathFormula = lazy(() => import("./math-formula.tsx"));

function MarkdownSpan({ node, children, ...props }: ComponentProps<"span"> & ExtraProps) {
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

const Streaming = createContext(false);
const markdownPlugins: NonNullable<ComponentProps<typeof Streamdown>["remarkPlugins"]> = [
	[remarkGfm, { singleTilde: false }],
	remarkCjkFriendly,
	[remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }],
	remarkMath,
];
// 不启用 HTML 解析，保留现有公式节点与原生 HTML 按文本显示的行为。
const markdownRehypePlugins: NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]> = [];
const markdownUrl: UrlTransform = (url, key, node) => node.tagName === "a" && key === "href" ? url : defaultUrlTransform(url);
const markdownComponents: Components = {
	p: "p", strong: "strong", blockquote: "blockquote",
	h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
	ul: "ul", ol: "ol", li: "li", hr: "hr",
	table: "table", thead: "thead", tbody: "tbody", tr: "tr", th: "th", td: "td",
	section: "section", sub: "sub", sup: "sup", code: "code",
	span: MarkdownSpan,
	pre: MarkdownCode,
	a: MarkdownLink,
	img: ({ alt }) => <span>[图片链接: {alt}]</span>,
};

function MarkdownCode({ children: child }: ComponentProps<"pre">) {
	const streaming = useContext(Streaming);
	if (!isValidElement<{ children?: string; className?: string }>(child)) throw new Error("代码块需要单个 React 元素");
	const language = child.props.className?.replace(/^language-/, "") ?? "text";
	if (language.toLowerCase() === "mermaid") return <MermaidBlock text={child.props.children ?? ""} streaming={streaming} />;
	return <CodeBlock text={child.props.children ?? ""} label={language === "text" ? "代码" : language} language={language} highlight={!streaming} />;
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
	return <Markdown remarkPlugins={markdownPlugins} components={markdownComponents} urlTransform={markdownUrl}>{clean(text)}</Markdown>;
});
