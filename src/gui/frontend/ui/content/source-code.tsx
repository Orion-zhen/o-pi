import { memo, type CSSProperties } from "react";
import { fileLanguage, SyntaxHighlighter } from "./code-highlight.ts";

export const SourceCode = memo(function SourceCode({ text, path, wrap, label }: {
	text: string; path: string; wrap: boolean; label?: string;
}) {
	const language = fileLanguage(path);
	const style: CSSProperties & { "--line-gutter": string } = {
		"--line-gutter": `${String(text.split("\n").length).length + 2}ch`,
	};
	return <SyntaxHighlighter className="source-code" data-wrap={wrap} aria-label={label}
		language={language} useInlineStyles={false} wrapLines wrapLongLines={wrap} customStyle={style}
		codeTagProps={{ className: `language-${language}` }} lineProps={{ className: "source-line" }}>{text}</SyntaxHighlighter>;
});
