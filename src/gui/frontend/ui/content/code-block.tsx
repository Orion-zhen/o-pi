import { memo, useState } from "react";
import { Check, Copy } from "lucide";
import { MorphIcon } from "morphicons/react";
import { TextMorph } from "../motion/text-morph.tsx";
import { Hint } from "../tooltip.tsx";
import { SyntaxHighlighter } from "./code-highlight.ts";

export const CodeBlock = memo(function CodeBlock({ text, label = "代码", language = "text", startLine, diff = false, highlight = true }: {
	text: string;
	label?: string;
	language?: string;
	startLine?: number;
	diff?: boolean;
	highlight?: boolean;
}) {
	const [copied, setCopied] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const complete = copied === text && !error;
	return (
		<div className={`code-block${diff ? " diff-block" : ""}`}>
			<div className="code-toolbar">
				<Hint content={label}><span>{label}</span></Hint>
				<button type="button" aria-label={`复制${label}`} onClick={async () => {
					try {
						await navigator.clipboard.writeText(text);
						setCopied(text);
						setError(false);
					} catch {
						setError(true);
					}
				}}>
					<MorphIcon icon={complete ? Check : Copy} spring="smooth" size="1em" />
					<TextMorph>{error ? "复制失败" : complete ? "已复制" : "复制"}</TextMorph>
				</button>
			</div>
			{!highlight ? <pre tabIndex={0} aria-label={label}><code>{text.replace(/\n$/, "")}</code></pre> : <SyntaxHighlighter language={diff ? "diff" : language} useInlineStyles={false}
				showLineNumbers={startLine !== undefined} startingLineNumber={startLine ?? 1}
				wrapLines={diff} lineProps={{ className: "diff-line" }}
				lineNumberStyle={{ color: "var(--muted-foreground)", opacity: 0.6, userSelect: "none" }}
				tabIndex={0} aria-label={label}>
				{text.replace(/\n$/, "")}
			</SyntaxHighlighter>}
		</div>
	);
});
