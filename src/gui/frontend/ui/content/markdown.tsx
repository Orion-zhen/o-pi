import { Children, createContext, isValidElement, lazy, memo, Suspense, useContext, useDeferredValue, type ComponentProps } from "react";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from "react-markdown";
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
import "./math.css";

export function StreamingText({ text, active }: { text: string; active: boolean }) {
	const formatted = useDeferredValue(text);
	return <MarkdownText text={active ? formatted : text} streaming={active} />;
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
const markdownPlugins: ComponentProps<typeof Markdown>["remarkPlugins"] = [
	[remarkGfm, { singleTilde: false }],
	remarkCjkFriendly,
	[remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }],
	remarkMath,
];
const markdownUrl: UrlTransform = (url, key, node) => node.tagName === "a" && key === "href" ? url : defaultUrlTransform(url);
const markdownComponents: Components = {
	span: MarkdownSpan,
	pre: MarkdownCode,
	a: MarkdownLink,
	img: ({ alt }) => <span>[图片链接: {alt}]</span>,
};

function MarkdownCode({ children }: ComponentProps<"pre">) {
	const streaming = useContext(Streaming);
	const child = Children.only(children);
	if (!isValidElement<{ children?: string; className?: string }>(child)) return <pre>{children}</pre>;
	const language = child.props.className?.replace(/^language-/, "") ?? "text";
	if (language.toLowerCase() === "mermaid") return <MermaidBlock text={child.props.children ?? ""} streaming={streaming} />;
	return <CodeBlock text={child.props.children ?? ""} label={language === "text" ? "代码" : language} language={language} highlight={!streaming} />;
}

export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
	return <Streaming value={streaming}>
		<Markdown remarkPlugins={markdownPlugins} components={markdownComponents} urlTransform={markdownUrl}>{clean(text)}</Markdown>
	</Streaming>;
});
