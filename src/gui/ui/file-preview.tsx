import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Fade } from "./components/animated";
import { AtSign, WrapText, X } from "lucide-react";
import type { FilePreview as Preview } from "../workbench.ts";
import type { Remote } from "./use-workbench.ts";
import { fileLanguage, SyntaxHighlighter } from "./code-highlight.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { FileDiff } from "./file-diff.tsx";
import "./file-preview.css";

function FileCode({ text, path, wrap }: { text: string; path: string; wrap: boolean }) {
	const gutter = `${String(text.split("\n").length).length + 1}ch`;
	return <div className="code-block file-code">
		<SyntaxHighlighter language={fileLanguage(path)} useInlineStyles={false} showLineNumbers
			wrapLines wrapLongLines={wrap} lineProps={{
				className: "file-source-line",
				style: { display: "block", paddingInlineStart: gutter, textIndent: `-${gutter}` },
			}} aria-label="文件内容"
			lineNumberStyle={{ minWidth: gutter, paddingRight: "1ch", textIndent: 0, color: "var(--muted-foreground)", userSelect: "none" }}>{text}</SyntaxHighlighter>
	</div>;
}
function FileDocument({ preview, diff, wrap }: { preview: Preview; diff: boolean; wrap: boolean }) {
	if (diff) return preview.diffs.map((part) => <FileDiff key={part.title} path={preview.path} text={part.text} title={part.title} />);
	const content = preview.content;
	if (content.kind === "deleted") return <p className="file-hint">文件已删除，可查看差异。</p>;
	if (content.kind === "unavailable") return <p className="file-hint">{content.reason}</p>;
	if (content.kind === "image") return <img className="file-preview-image" src={`data:${content.mime};base64,${content.data}`} alt={preview.path} />;
	return <FileCode path={preview.path} text={content.text} wrap={wrap} />;
}

export function FilePreviewPanel({ preview: selection, referenceFile, close }: {
	preview: { path: string; result: Remote<Preview> }; referenceFile: (path: string) => void; close: () => void;
}) {
	const [mode, setMode] = useState<"content" | "diff" | null>(null);
	const [wrap, setWrap] = useState(true);
	const result = selection.result;
	const preview = result.state === "ready" ? result.value : undefined;
	const diff = mode !== "content" && Boolean(preview?.diffs.length);
	const name = selection.path.split("/").at(-1);
	return <div className="file-preview" data-wrap={wrap}>
		<div className="file-preview-heading">
			<strong className="file-preview-path" title={selection.path}>{name}</strong>
			{preview && preview.diffs.length > 0 && <div className="file-preview-modes" aria-label="文件视图">
				<Button variant="ghost" size="sm" aria-pressed={!diff} onClick={() => setMode("content")}>内容</Button>
				<Button variant="ghost" size="sm" aria-pressed={diff} onClick={() => setMode("diff")}>差异</Button>
			</div>}
			<IconButton label="自动折行" size="icon-sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText /></IconButton>
			<IconButton label="引用文件" size="icon-sm" disabled={!preview || preview.content.kind === "deleted"}
				onClick={() => referenceFile(selection.path)}><AtSign /></IconButton>
			<IconButton label="关闭文件预览" size="icon-sm" onClick={close}><X /></IconButton>
		</div>
		<div className="file-preview-body" tabIndex={0} aria-label="文件正文">
			<AnimatePresence initial={false} mode="wait"><Fade key={`${result.state}-${diff}`}>
			{result.state === "loading" ? <p className="file-hint" role="status">正在读取文件…</p>
				: result.state === "error" ? <p className="file-hint" role="alert">{result.message}</p>
				: <FileDocument preview={result.value} diff={diff} wrap={wrap} />}
			</Fade></AnimatePresence>
		</div>
	</div>;
}
