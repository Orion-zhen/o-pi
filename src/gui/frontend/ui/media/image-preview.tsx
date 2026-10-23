import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { IconButton } from "../icon-button.tsx";
import { Dialog, DialogClose, DialogTitle } from "../dialog.tsx";
import { fade } from "../motion/transitions.ts";
import { ImageViewer } from "./image-viewer.tsx";
import "./image-preview.css";

type Preview = { id: string; src: string; alt: string; trigger: HTMLButtonElement; source: HTMLImageElement };
const ImagePreviewContext = createContext<{ open: (image: Preview) => void; activeId: string | undefined } | undefined>(undefined);

export function ImagePreviewProvider({ sessionId, fallbackFocus, children }: {
	sessionId: string | null; fallbackFocus: RefObject<HTMLElement | null>; children: ReactNode;
}) {
	const [image, setImage] = useState<(Preview & { sessionId: string | null })>();
	const [visible, setVisible] = useState(false);
	useEffect(() => setVisible(false), [sessionId]);
	const open = useCallback((image: Preview) => { setImage({ ...image, sessionId }); setVisible(true); }, [sessionId]);
	const preview = useMemo(() => ({ open, activeId: image?.id }), [open, image?.id]);
	return <ImagePreviewContext value={preview}>
		{children}
		<AnimatePresence onExitComplete={() => { if (!visible) setImage(undefined); }}>
			{visible && image && image.sessionId === sessionId && <ImagePreviewDialog key={image.id} image={image} close={() => setVisible(false)}
				restoreFocus={() => (image.trigger.isConnected ? image.trigger : fallbackFocus.current)?.focus({ preventScroll: true })} />}
		</AnimatePresence>
	</ImagePreviewContext>;
}

export function ImagePreviewButton({ src, alt, children }: { src: string | undefined; alt: string; children: ReactNode }) {
	const preview = useContext(ImagePreviewContext);
	const id = useId();
	if (!preview) throw new Error("缺少图片预览上下文。");
	return <button type="button" className="image-preview-trigger" aria-label={`查看大图：${alt}`} aria-haspopup="dialog" disabled={!src}
		data-previewing={preview.activeId === id || undefined}
		onClick={(event) => {
			const source = event.currentTarget.querySelector("img");
			if (src && source) preview.open({ id, src, alt, trigger: event.currentTarget, source });
		}}>
		{children}
	</button>;
}

function ImagePreviewDialog({ image, close, restoreFocus }: { image: Preview; close: () => void; restoreFocus: () => void }) {
	const present = useIsPresent();
	return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
		<DialogPrimitive.Portal forceMount container={document.getElementById("root")}>
			<DialogPrimitive.Overlay asChild>
				<div className="modal-layer image-preview-layer">
					<motion.div {...fade} className="image-preview-backdrop" aria-hidden="true" />
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
						<DialogClose asChild><IconButton asChild className="image-preview-close" label="关闭图片预览"><motion.button {...fade}><X /></motion.button></IconButton></DialogClose>
						<ImageViewer url={image.src} alt={image.alt} transitionSource={image.source} onBackgroundClick={close} />
					</DialogPrimitive.Content>
				</div>
			</DialogPrimitive.Overlay>
		</DialogPrimitive.Portal>
	</Dialog>;
}
