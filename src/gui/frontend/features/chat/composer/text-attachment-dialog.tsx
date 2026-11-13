import { useState } from "react";
import { X } from "lucide-react";
import { AlignLeft, Check, CircleAlert, Copy, WrapText } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { TextAttachment } from "@/features/sessions/session-views.ts";
import { SourceCode } from "@/ui/content/source-code.tsx";
import { DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog.tsx";
import { FileIcon } from "@/ui/file-icon.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { fileSize } from "@/ui/media/preview-viewport.ts";
import { useClipboard } from "@/ui/use-clipboard.ts";
import "./text-attachment-dialog.css";

export function TextAttachmentDialog({ file }: { file: TextAttachment }) {
	const [wrap, setWrap] = useState(true);
	const { status, copy } = useClipboard();
	const copyLabel = status === "copied" ? "已复制" : status === "error" ? "复制失败" : "复制";
	return <DialogContent className="text-attachment-dialog"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			(event.target as HTMLElement).focus();
		}}>
		<DialogHeader className="text-attachment-heading">
			<div className="text-attachment-identity">
				<FileIcon name={file.name} kind="file" />
				<DialogTitle>{file.name}</DialogTitle>
				<DialogDescription>{fileSize(file.size)}</DialogDescription>
			</div>
			<div className="text-attachment-actions">
				<IconButton label="自动折行" size="icon-sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
					<MorphIcon icon={wrap ? WrapText : AlignLeft} spring="smooth" size="1em" />
				</IconButton>
				<IconButton label="复制附件原文" tooltip={copyLabel} size="icon-sm" onClick={() => void copy(file.text)}>
					<MorphIcon icon={status === "copied" ? Check : status === "error" ? CircleAlert : Copy} spring="smooth" size="1em" />
				</IconButton>
				<DialogClose asChild><IconButton label="关闭面板" size="icon-sm"><X /></IconButton></DialogClose>
			</div>
		</DialogHeader>
		<div className="code-block text-attachment-source" role="region" aria-label="附件原文" tabIndex={0}>
			<SourceCode path={file.name} text={file.text} wrap={wrap} />
		</div>
	</DialogContent>;
}
