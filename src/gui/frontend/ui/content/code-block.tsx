import { memo } from "react";
import { CodeToolbar } from "./code-toolbar.tsx";
import { SyntaxHighlighter } from "./code-highlight.ts";

export const CodeBlock = memo(function CodeBlock({ text, label = "代码", language = "text", startLine, diff = false, highlight = true }: {
	text: string;
	label?: string;
	language?: string;
	startLine?: number;
	diff?: boolean;
	highlight?: boolean;
}) {
	return (
		<div className={`code-block${diff ? " diff-block" : ""}`}>
			<CodeToolbar text={text} label={label} />
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
