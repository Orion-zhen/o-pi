import { useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import { useVirtualizer } from "@tanstack/react-virtual";
import pLimit from "p-limit";
import { ChevronLeft, ChevronRight, Minus, Plus, Scan, ScanLine } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { fileSize, usePreviewViewport } from "./preview-viewport.ts";
import { PdfPage } from "./pdf-page.tsx";
import { stepZoom, ZoomInput } from "./zoom-input.tsx";
import "./pdf-preview.css";

const assets = new URL("pdf/", document.baseURI).href;
GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.mjs`;

type DocumentState = { kind: "loading" } | { kind: "error"; message: string }
	| { kind: "ready"; document: PDFDocumentProxy; width: number; height: number };

interface PdfPosition { page: number; zoom: number | "width" | "page" }

export default function PdfPreview({ url, size }: { url: string; size: number }) {
	const position = useRef<PdfPosition>({ page: 1, zoom: "width" });
	return <PdfDocument key={url} url={url} size={size} position={position.current} />;
}

function PdfDocument({ url, size, position }: { url: string; size: number; position: PdfPosition }) {
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<DocumentState>({ kind: "loading" });
	const [loaded, setLoaded] = useState(0);
	useEffect(() => {
		setState({ kind: "loading" }); setLoaded(0);
		let active = true;
		const task = getDocument({
			url, cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`,
			disableAutoFetch: true, disableStream: true, canvasMaxAreaInBytes: 32 * 1024 * 1024,
		});
		task.onProgress = ({ loaded }: { loaded: number }) => { if (active) setLoaded(loaded); };
		task.onPassword = () => {
			if (active) setState({ kind: "error", message: "此 PDF 需要密码，请先解密后预览。" });
			active = false;
			void task.destroy();
		};
		void task.promise.then(async (document) => {
			const page = await document.getPage(1);
			const viewport = page.getViewport({ scale: 1 });
			page.cleanup();
			if (active) setState({ kind: "ready", document, width: viewport.width, height: viewport.height });
		}).catch((error: unknown) => {
			if (active) {
				setState({ kind: "error", message: `PDF 读取失败：${error instanceof Error ? error.message : String(error)}` });
				void task.destroy();
			}
		});
		return () => { active = false; void task.destroy(); };
	}, [url, attempt]);
	if (state.kind === "error") return <div className="file-hint"><p role="alert">{state.message}</p>
		<Button variant="outline" size="sm" onClick={() => setAttempt(attempt + 1)}>重试 PDF</Button></div>;
	if (state.kind === "loading") return <p className="file-hint" role="status">正在加载 PDF… {fileSize(loaded)} / {fileSize(size)}</p>;
	return <PdfReader document={state.document} baseWidth={state.width} baseHeight={state.height} size={size} position={position} />;
}

function PdfReader({ document, baseWidth, baseHeight, size, position }: { document: PDFDocumentProxy; baseWidth: number; baseHeight: number; size: number; position: PdfPosition }) {
	const viewport = usePreviewViewport();
	const [zoom, setZoom] = useState(position.zoom);
	const queue = useMemo(() => pLimit(2), []);
	const [current, setCurrent] = useState(Math.min(position.page, document.numPages));
	useEffect(() => { position.page = current; position.zoom = zoom; }, [current, zoom, position]);
	const pageNumber = useRef(current);
	pageNumber.current = current;
	const fitWidth = Math.max(1, viewport.width - 32) / baseWidth;
	const scale = zoom === "width" ? fitWidth : zoom === "page" ? Math.min(fitWidth, Math.max(1, viewport.height - 32) / baseHeight) : zoom;
	useEffect(() => {
		const element = viewport.ref.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
			event.preventDefault();
			setZoom((value) => Math.max(0.1, Math.min(8, stepZoom(typeof value === "number" ? value : scale, event.deltaY < 0 ? 1 : -1))));
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [scale, viewport.ref]);
	const virtualizer = useVirtualizer({
		count: document.numPages, getScrollElement: () => viewport.ref.current, enabled: viewport.width > 0,
		estimateSize: () => baseHeight * scale + 16, overscan: 1,
		onChange(instance, scrolling) {
			if (!scrolling) return;
			const center = (instance.scrollOffset ?? 0) + (instance.scrollRect?.height ?? 0) / 2;
			const visible = instance.getVirtualItems();
			const closest = visible.reduce<(typeof visible)[number] | undefined>((best, item) => !best || Math.abs((item.start + item.end) / 2 - center) < Math.abs((best.start + best.end) / 2 - center) ? item : best, undefined);
			if (closest) setCurrent(closest.index + 1);
		},
	});
	const items = virtualizer.getVirtualItems();
	const go = (page: number) => {
		if (!Number.isFinite(page)) return;
		const target = Math.max(1, Math.min(document.numPages, Math.floor(page)));
		setCurrent(target);
		virtualizer.scrollToIndex(target - 1, { align: "center" });
	};
	useEffect(() => {
		if (!viewport.width) return;
		virtualizer.measure();
		virtualizer.scrollToIndex(pageNumber.current - 1, { align: "center" });
	}, [scale, virtualizer, viewport.width]);
	return <div className="pdf-reader media-reader">
		<div className="media-toolbar" aria-label="PDF 工具栏">
			<IconButton label="上一页" size="icon-sm" disabled={current === 1} onClick={() => go(current - 1)}><ChevronLeft /></IconButton>
			<form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); go(Number(data.get("page"))); }}>
				<input key={current} name="page" aria-label="PDF 页码" type="number" min={1} max={document.numPages} defaultValue={current} />
				<span aria-label="PDF 总页数"> / {document.numPages}</span>
			</form>
			<IconButton label="下一页" size="icon-sm" disabled={current === document.numPages} onClick={() => go(current + 1)}><ChevronRight /></IconButton>
			<IconButton label="缩小 PDF" size="icon-sm" disabled={scale <= 0.1} onClick={() => setZoom(Math.max(0.1, stepZoom(scale, -1)))}><Minus /></IconButton>
			<ZoomInput label="PDF 缩放比例" scale={scale} min={0.1} max={8} onChange={setZoom} />
			<IconButton label="放大 PDF" size="icon-sm" disabled={scale >= 8} onClick={() => setZoom(Math.min(8, stepZoom(scale, 1)))}><Plus /></IconButton>
			<IconButton label="适应宽度" size="icon-sm" aria-pressed={zoom === "width"} onClick={() => setZoom("width")}><ScanLine /></IconButton>
			<IconButton label="适应整页" size="icon-sm" aria-pressed={zoom === "page"} onClick={() => setZoom("page")}><Scan /></IconButton>
			<span className="media-details">{fileSize(size)}</span>
		</div>
		<div ref={viewport.ref} className="pdf-viewport" tabIndex={0} aria-label="PDF 正文" onKeyDown={(event) => {
			if (event.target !== event.currentTarget) return;
			if (event.key === "PageDown") go(current + 1);
			else if (event.key === "PageUp") go(current - 1);
			else return;
			event.preventDefault();
		}}>
			<div className="pdf-pages" style={{ height: virtualizer.getTotalSize(), minWidth: baseWidth * scale + 32 }}>
				{viewport.width > 0 && items.map((item) => <div key={`${item.index}-${scale}`} data-index={item.index} ref={virtualizer.measureElement}
					className="pdf-page-slot" data-current={item.index + 1 === current} style={{ transform: `translateY(${item.start}px)` }}>
					<PdfPage document={document} number={item.index + 1} scale={scale} queue={queue} placeholder={{ width: baseWidth * scale, height: baseHeight * scale }} />
				</div>)}
			</div>
		</div>
	</div>;
}
