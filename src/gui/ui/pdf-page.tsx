import { useEffect, useRef, useState } from "react";
import { AnnotationMode, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import type { LimitFunction } from "p-limit";

const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_EDGE = 8192;

type PageState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export function PdfPage({ document, number, scale, queue, placeholder }: { document: PDFDocumentProxy; number: number; scale: number; queue: LimitFunction; placeholder: { width: number; height: number } }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const text = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ width: number; height: number }>();
	const [state, setState] = useState<PageState>({ kind: "loading" });
	useEffect(() => {
		const target = canvas.current;
		const container = text.current;
		if (!target || !container) return;
		const controller = new AbortController();
		let render: RenderTask | undefined;
		let layer: TextLayer | undefined;
		void queue(async () => {
			let page: PDFPageProxy | undefined;
			try {
				controller.signal.throwIfAborted();
				page = await document.getPage(number);
				controller.signal.throwIfAborted();
				const viewport = page.getViewport({ scale });
				setSize({ width: viewport.width, height: viewport.height });
				const outputScale = Math.min(devicePixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)), MAX_CANVAS_EDGE / viewport.width, MAX_CANVAS_EDGE / viewport.height);
				target.width = Math.max(1, Math.floor(viewport.width * outputScale));
				target.height = Math.max(1, Math.floor(viewport.height * outputScale));
				render = page.render({ canvas: target, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0], annotationMode: AnnotationMode.DISABLE });
				await render.promise;
				controller.signal.throwIfAborted();
				container.style.setProperty("--total-scale-factor", String(scale * viewport.userUnit));
				layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
				await layer.render();
				controller.signal.throwIfAborted();
				setState({ kind: "ready" });
			} catch (error) {
				if (!controller.signal.aborted) setState({ kind: "error", message: `页面读取失败：${error instanceof Error ? error.message : String(error)}` });
			} finally { page?.cleanup(); }
		});
		return () => {
			controller.abort(); render?.cancel(); layer?.cancel();
			container.replaceChildren(); target.width = 0; target.height = 0;
		};
	}, [document, number, scale, queue]);
	return <div className="pdf-page" aria-label={`第 ${number} 页`} style={size ?? placeholder}>
		<canvas ref={canvas} aria-hidden="true" />
		<div className="pdf-text-layer" ref={text} />
		{state.kind !== "ready" && <p className="pdf-page-status" role={state.kind === "error" ? "alert" : "status"}>
			{state.kind === "loading" ? "正在渲染…" : state.message}
		</p>}
	</div>;
}
