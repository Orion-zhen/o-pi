import { lazy, Suspense, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Fade } from "@/ui/motion/animated.tsx";
import { WrapText, X } from "lucide-react";
import { nativeFileEvents } from "../native-file.ts";
import { ReferenceFileButton } from "../reference-file-button.tsx";
import type { FilePreview as Preview } from "../../../../shared/workspace.ts";
import type { Remote } from "../use-workbench.ts";
import { fileLanguage, SyntaxHighlighter } from "@/ui/content/code-highlight.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { ImageViewer } from "@/ui/media/image-viewer.tsx";
import "./file-preview.css";

const PdfPreview = lazy(() => import("./pdf-preview.tsx"));
const FileDiff = lazy(() => import("./file-diff.tsx").then((module) => ({ default: module.FileDiff })));

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
	if (diff) return <Suspense fallback={<p className="file-hint" role="status">正在加载差异查看器…</p>}>
		{preview.diffs.map((part) => <FileDiff key={part.title} path={preview.path} text={part.text} title={part.title} />)}
	</Suspense>;
	const content = preview.content;
	if (content.kind === "deleted") return <p className="file-hint">文件已删除，可查看差异。</p>;
	if (content.kind === "unavailable") return <p className="file-hint">{content.reason}</p>;
	if (content.kind === "image") return <ImageViewer key={content.url} url={content.url} alt={preview.path} size={content.size} />;
	if (content.kind === "pdf") return <Suspense fallback={<p className="file-hint" role="status">正在加载 PDF 阅读器…</p>}>
		<PdfPreview url={content.url} size={content.size} />
	</Suspense>;
	return <FileCode path={preview.path} text={content.text} wrap={wrap} />;
}

export function FilePreviewPanel({ cwd, setError, preview: selection, referenceFile, close }: {
	cwd: string; setError: (message: string) => void;
	preview: { path: string; result: Remote<Preview> }; referenceFile: (path: string) => boolean; close: () => void;
}) {
	const [mode, setMode] = useState<"content" | "diff" | null>(null);
	const [wrap, setWrap] = useState(true);
	const result = selection.result;
	const preview = result.state === "ready" ? result.value : undefined;
	const media = preview?.content.kind === "image" || preview?.content.kind === "pdf";
	const diff = mode !== "content" && Boolean(preview?.diffs.length);
	const name = selection.path.split("/").at(-1);
	return <div className="file-preview" data-wrap={wrap} data-media={media}>
		<div className="file-preview-heading">
			<Hint content={selection.path}><strong className="file-preview-path" {...(preview && preview.content.kind !== "deleted" ? nativeFileEvents(cwd, selection.path, true, setError) : {})}>{name}</strong></Hint>
			{preview && preview.diffs.length > 0 && <div className="file-preview-modes" aria-label="文件视图">
				<Button variant="ghost" size="sm" aria-pressed={!diff} onClick={() => setMode("content")}>内容</Button>
				<Button variant="ghost" size="sm" aria-pressed={diff} onClick={() => setMode("diff")}>差异</Button>
			</div>}
			{!media && <IconButton label="自动折行" size="icon-sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText /></IconButton>}
			<ReferenceFileButton path={selection.path} referenceFile={referenceFile} direction={-1} disabled={!preview || preview.content.kind === "deleted"} />
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
