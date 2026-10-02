import type { GuiMessage } from "../../messages.ts";
import { Children, isValidElement, lazy, memo, Suspense, useDeferredValue, type ComponentProps, type ReactNode } from "react";
import { MessageIdentity } from "./message-meta.tsx";
import { CodeBlock } from "./code-block.tsx";
import { motion } from "motion/react";
import { fade } from "../lib/motion";
import { Disclosure } from "../components/disclosure";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMath } from "./remark-math.ts";
import "./math.css";
import { SessionImage } from "../runtime/payload.tsx";
import { SKILL_CONTEXT_MESSAGE } from "../../../harness/skill-context/types.ts";
import { isSkillLoadDetails } from "../../skill-facts.ts";
import { SkillCard } from "./skill-card.tsx";

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

export const MarkdownText = memo(function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm, remarkMath]}
			components={{
				span: MarkdownSpan,
				pre: ({ children }) => {
					const child = Children.only(children);
					if (!isValidElement<{ children?: string; className?: string }>(child)) return <pre>{children}</pre>;
					const language = child.props.className?.replace(/^language-/, "") ?? "text";
					return <CodeBlock text={child.props.children ?? ""} label={language === "text" ? "代码" : language} language={language} highlight={!streaming} />;
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
			<Disclosure className="thinking" summary="思考" lazy>
				<MarkdownText text={value.thinking} />
			</Disclosure>
		);
	if (value.type === "image") {
		if (typeof value.imageId === "string" && typeof value.mimeType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(value.mimeType))
			return <SessionImage id={value.imageId} mime={value.mimeType} />;
		return <span>[无法显示的图片格式]</span>;
	}
	return <pre>{pretty(value)}</pre>;
}

export const Message = memo(function Message({ value, entryId }: { value: GuiMessage; entryId?: string | undefined }) {
	const role = value.role;
	if (value.role === "custom" && !value.display) return null;
	if (value.role === "custom" && value.customType === SKILL_CONTEXT_MESSAGE && isSkillLoadDetails(value.details)) {
		return <motion.article {...fade} className="message skill-message" data-entry-id={entryId}>
			<SkillCard id={`message:${entryId ?? value.timestamp}`} name={value.details.name} loadedBy={value.details.loadedBy}
				state="completed" output={{ kind: "inline", value: { content: value.content, details: value.details } }} />
		</motion.article>;
	}
	return (
		<motion.article {...fade} className={`message ${role}`} data-entry-id={entryId}>
			{role === "user" && typeof value.timestamp === "number" && <MessageIdentity name="You" timestamp={value.timestamp} />}
			{role !== "user" && <header><strong>{value.role === "custom" ? value.customType : role}</strong></header>}
			{value.role === "bashExecution" ? <>
				<CodeBlock label="命令" language="bash" text={value.command} />
				<CodeBlock label="输出" text={clean(value.output)} />
			</> : value.role === "user" ? <div className="user-bubble"><Content value={value.content} /></div>
				: value.role === "compactionSummary" || value.role === "branchSummary" ? <Content value={value.summary} />
				: value.role === "toolResult" ? <Content value={value.output.kind === "inline" ? value.output.value.content : value.output.preview.content} />
				: <Content value={value.content} />}
			{value.role === "assistant" && value.errorMessage && <pre className="error">{value.errorMessage}</pre>}
		</motion.article>
	);
});
