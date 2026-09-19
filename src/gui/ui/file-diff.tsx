import { Fragment, memo, useMemo } from "react";
import { Decoration, Diff, Hunk, parseDiff, tokenize, type FileData } from "react-diff-view";
import { refractor } from "refractor/core";
import { fileLanguage } from "./code-highlight.ts";
import "react-diff-view/style/index.css";
import "./file-diff.css";

function FileChanges({ file, language }: { file: FileData; language: string }) {
	const tokens = useMemo(() => tokenize(file.hunks, refractor.registered(language) ? {
		highlight: true, language, refractor: { highlight: (text: string) => refractor.highlight(text, language).children },
	} : {}), [file, language]);
	if (file.isBinary) return <p className="file-hint">二进制文件已变更，无法展示文本差异。</p>;
	if (!file.hunks.length) return <p className="file-hint">
		{file.type === "rename" ? `${file.oldPath} → ${file.newPath}` : "无文本行变更"}
		{file.oldMode !== file.newMode && ` · 文件模式 ${file.oldMode} → ${file.newMode}`}
	</p>;
	return <Diff viewType="unified" diffType={file.type} hunks={file.hunks} tokens={tokens}>
		{(hunks) => hunks.map((hunk) => <Fragment key={`${hunk.oldStart}-${hunk.newStart}`}>
			<Decoration><span className="file-diff-location">原行 {hunk.oldStart} · 新行 {hunk.newStart}</span></Decoration>
			<Hunk hunk={hunk} />
		</Fragment>)}
	</Diff>;
}

export const FileDiff = memo(function FileDiff({ text, path, title }: { text: string; path: string; title: string }) {
	const files = useMemo(() => parseDiff(text), [text]);
	const changes = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.changes));
	const added = changes.filter((change) => change.type === "insert").length;
	const deleted = changes.filter((change) => change.type === "delete").length;
	return <section className="file-diff" aria-label={`${title}差异`}>
		<h3><span>{title}</span><span className="file-diff-added">+{added}</span><span className="file-diff-deleted">-{deleted}</span></h3>
		{files.map((file, index) => <FileChanges key={index} file={file} language={fileLanguage(path)} />)}
	</section>;
});
