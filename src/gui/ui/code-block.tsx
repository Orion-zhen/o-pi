import { memo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SyntaxHighlighter } from "./code-highlight.ts";

export const CodeBlock = memo(function CodeBlock({ text, label = "代码", language = "text", startLine, diff = false }: {
	text: string;
	label?: string;
	language?: string;
	startLine?: number;
	diff?: boolean;
}) {
	const [copied, setCopied] = useState<string | null>(null);
	const [error, setError] = useState(false);
	return (
		<div className={`code-block${diff ? " diff-block" : ""}`}>
			<div className="code-toolbar">
				<span title={label}>{label}</span>
				<button type="button" aria-label={`复制${label}`} onClick={async () => {
					try {
						await navigator.clipboard.writeText(text);
						setCopied(text);
						setError(false);
					} catch {
						setError(true);
					}
				}}>
					{copied === text ? <Check /> : <Copy />}
					{error ? "复制失败" : copied === text ? "已复制" : "复制"}
				</button>
			</div>
			<SyntaxHighlighter language={diff ? "diff" : language} useInlineStyles={false}
				showLineNumbers={startLine !== undefined} startingLineNumber={startLine ?? 1}
				wrapLines={diff} lineProps={{ className: "diff-line" }}
				lineNumberStyle={{ color: "var(--muted-foreground)", opacity: 0.6, userSelect: "none" }}
				tabIndex={0} aria-label={label}>
				{text.replace(/\n$/, "")}
			</SyntaxHighlighter>
		</div>
	);
});
