import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import type { ImageAttachment, TextAttachment } from "@/features/sessions/session-views.ts";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogTrigger } from "@/ui/dialog.tsx";
import { FileIcon } from "@/ui/file-icon.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ImagePreviewButton } from "@/ui/media/image-preview.tsx";
import { fileSize } from "@/ui/media/preview-viewport.ts";
import { ListItem, Reveal } from "@/ui/motion/animated.tsx";
import { fade, settle } from "@/ui/motion/transitions.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { TextAttachmentDialog } from "./text-attachment-dialog.tsx";

const attachmentOrigin = { y: 6, rotate: -2, scale: 0.98 };

export function AttachmentPreviews({ images, files, removeImage, removeFile }: {
	images: readonly ImageAttachment[];
	files: readonly TextAttachment[];
	removeImage: (id: number) => void;
	removeFile: (id: number) => void;
}) {
	const seenImages = useRef(new Set(images.map((image) => image.id)));
	useEffect(() => { for (const image of images) seenImages.current.add(image.id); }, [images]);
	return <AnimatePresence initial={false}>
		{files.length + images.length > 0 && <Reveal key="attachments"><ul className="attachment-previews">
			<AnimatePresence initial={false} propagate>
				{files.map((file) => <ListItem className="attachment-preview text-attachment" key={file.id}>
					<TextAttachmentCard file={file} remove={() => removeFile(file.id)} />
				</ListItem>)}
				{images.map((image, index) => (
					<ListItem className="attachment-preview image-preview" key={image.id} initial={seenImages.current.has(image.id) ? false : fade.initial}>
						<ImagePreviewButton src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`}>
							<motion.img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片"
								initial={seenImages.current.has(image.id) ? false : attachmentOrigin}
								animate={{ y: 0, rotate: 0, scale: 1 }} exit={attachmentOrigin} transition={settle} />
						</ImagePreviewButton>
						<IconButton className="attachment-remove" label={`移除附件 ${index + 1}`} size="icon-xs" onClick={() => removeImage(image.id)}><X /></IconButton>
					</ListItem>
				))}
			</AnimatePresence>
		</ul></Reveal>}
	</AnimatePresence>;
}

function TextAttachmentCard({ file, remove }: { file: TextAttachment; remove: () => void }) {
	const [open, setOpen] = useState(false);
	return <Dialog open={open} onOpenChange={setOpen}>
		<Hint content={file.name}><DialogTrigger asChild><Button variant="ghost" className="text-attachment-preview" aria-label={`预览附件 ${file.name}`}>
			<FileIcon name={file.name} kind="file" />
			<span className="text-attachment-info"><span>{file.name}</span><small>{fileSize(file.size)}</small></span>
		</Button></DialogTrigger></Hint>
		<IconButton className="attachment-remove" label={`移除附件 ${file.name}`} size="icon-xs" onClick={remove}><X /></IconButton>
		<AnimatePresence>
			{open && <TextAttachmentDialog file={file} />}
		</AnimatePresence>
	</Dialog>;
}
