import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { Dialog, DialogClose, DialogTitle } from "../components/ui/dialog";
import { fade } from "../lib/motion";
import { ImageViewer } from "./image-viewer.tsx";
import "./image-preview.css";

type Preview = { src: string; alt: string; trigger: HTMLButtonElement };
const OpenImagePreview = createContext<((image: Preview) => void) | undefined>(undefined);

export function ImagePreviewProvider({ sessionId, fallbackFocus, children }: {
	sessionId: string | null; fallbackFocus: RefObject<HTMLElement | null>; children: ReactNode;
}) {
	const [image, setImage] = useState<(Preview & { sessionId: string | null })>();
	useEffect(() => setImage(undefined), [sessionId]);
	const open = useCallback((image: Preview) => setImage({ ...image, sessionId }), [sessionId]);
	return <OpenImagePreview value={open}>
		{children}
		<AnimatePresence>
			{image && image.sessionId === sessionId && <ImagePreviewDialog image={image} close={() => setImage(undefined)}
				restoreFocus={() => (image.trigger.isConnected ? image.trigger : fallbackFocus.current)?.focus({ preventScroll: true })} />}
		</AnimatePresence>
	</OpenImagePreview>;
}

export function ImagePreviewButton({ src, alt, children }: { src: string | undefined; alt: string; children: ReactNode }) {
	const open = useContext(OpenImagePreview);
	if (!open) throw new Error("缺少图片预览上下文。");
	return <button type="button" className="image-preview-trigger" aria-label={`查看大图：${alt}`} aria-haspopup="dialog" disabled={!src}
		onClick={(event) => { if (src) open({ src, alt, trigger: event.currentTarget }); }}>
		{children}
	</button>;
}

function ImagePreviewDialog({ image, close, restoreFocus }: { image: Preview; close: () => void; restoreFocus: () => void }) {
	const present = useIsPresent();
	return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
		<DialogPrimitive.Portal forceMount container={document.getElementById("root")}>
			<DialogPrimitive.Overlay asChild>
				<motion.div {...fade} className="modal-layer image-preview-layer">
					<DialogPrimitive.Content className="image-preview-dialog" aria-describedby={undefined} inert={!present} aria-hidden={!present}
						onClick={(event) => { if (event.target === event.currentTarget) close(); }}
						onOpenAutoFocus={(event) => { event.preventDefault(); if (event.target instanceof HTMLElement) event.target.focus(); }}
						onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
						onEscapeKeyDown={(event) => {
							if (event.target instanceof HTMLInputElement) event.preventDefault();
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") { event.stopPropagation(); close(); }
						}}>
						<DialogTitle className="sr-only">图片预览</DialogTitle>
						<DialogClose asChild><IconButton className="image-preview-close" label="关闭图片预览"><X /></IconButton></DialogClose>
						<ImageViewer url={image.src} alt={image.alt} onBackgroundClick={close} />
					</DialogPrimitive.Content>
				</motion.div>
			</DialogPrimitive.Overlay>
		</DialogPrimitive.Portal>
	</Dialog>;
}
