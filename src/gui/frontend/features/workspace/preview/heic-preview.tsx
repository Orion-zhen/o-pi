import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ImageViewport } from "@/ui/media/image-viewport.tsx";
import type { HeicPixels, HeicPixelsResult } from "../../../../../harness/media/heic.ts";
import type { HeicPreviewRequest } from "./heic-preview-worker.ts";

type Frame = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; pixels: HeicPixels };
interface OpenImage {
	worker: Worker;
	imageCount: number;
	primaryIndex: number;
	index: number;
	frame: Frame;
}
type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "open"; image: OpenImage };

export default function HeicPreview({ url, size, alt }: { url: string; size: number; alt: string }) {
	const [state, setState] = useState<State>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const receive = useEffectEvent((worker: Worker, result: HeicPixelsResult) => {
		const frame: Frame = "error" in result ? { kind: "error", message: result.error } : { kind: "ready", pixels: result };
		if (state.kind === "open") {
			setState({ kind: "open", image: { ...state.image, frame } });
		} else if ("error" in result) {
			setState({ kind: "error", message: result.error });
			worker.terminate();
		} else {
			setState({ kind: "open", image: {
				worker, imageCount: result.imageCount, primaryIndex: result.primaryIndex,
				index: result.primaryIndex, frame,
			} });
		}
	});
	useEffect(() => {
		setState({ kind: "loading" });
		const worker = new Worker(new URL("./heic-preview-worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (event: MessageEvent<HeicPixelsResult>) => receive(worker, event.data);
		worker.onerror = (event) => {
			event.preventDefault();
			setState({ kind: "error", message: event.message });
			worker.terminate();
		};
		worker.postMessage({ kind: "open", url: new URL(url, document.baseURI).href } satisfies HeicPreviewRequest);
		return () => { worker.onmessage = null; worker.onerror = null; worker.terminate(); };
	}, [url, attempt]);
	if (state.kind === "loading") return <p className="file-hint" role="status">正在加载 HEIC 图片…</p>;
	if (state.kind === "error") return <div className="file-hint"><p role="alert">HEIC 读取失败：{state.message}</p>
		<Button variant="outline" size="sm" onClick={() => setAttempt(attempt + 1)}>重试 HEIC</Button></div>;

	const image = state.image;
	const busy = image.frame.kind === "loading";
	const show = (index: number) => {
		// 加载期间禁用切图，一次只等待一个结果，不保留上一张的像素缓冲。
		setState({ kind: "open", image: { ...image, index, frame: { kind: "loading" } } });
		image.worker.postMessage({ kind: "select", index } satisfies HeicPreviewRequest);
	};
	const navigation = image.imageCount > 1 && <>
		<IconButton label="上一张图片" size="icon-sm" disabled={busy || image.index === 0} onClick={() => show(image.index - 1)}><ChevronLeft /></IconButton>
		<form onSubmit={(event) => {
			event.preventDefault();
			show(Number(new FormData(event.currentTarget).get("image")) - 1);
		}}>
			<input key={image.index} name="image" aria-label="图片序号" type="number" min={1} max={image.imageCount} required
				defaultValue={image.index + 1} disabled={busy} />
			<span aria-label="图片总数"> / {image.imageCount}</span>
		</form>
		<IconButton label="下一张图片" size="icon-sm" disabled={busy || image.index + 1 === image.imageCount} onClick={() => show(image.index + 1)}><ChevronRight /></IconButton>
		{image.index === image.primaryIndex && <span className="text-muted-foreground">主图</span>}
	</>;
	return <ImageViewport dimensions={image.frame.kind === "ready" ? image.frame.pixels : undefined} size={size} toolbar={navigation}>
		{(style) => image.frame.kind === "ready" ? <HeicCanvas pixels={image.frame.pixels} style={style} alt={`${alt}，第 ${image.index + 1} 张`} />
			: image.frame.kind === "loading" ? <p className="media-hint" role="status">正在解码图片…</p>
			: <p className="media-hint" role="alert">图片解码失败：{image.frame.message}</p>}
	</ImageViewport>;
}

function HeicCanvas({ pixels, style, alt }: { pixels: HeicPixels; style: CSSProperties; alt: string }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useLayoutEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("无法创建 HEIC 显示画布。");
		context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
		return () => { canvas.width = 0; canvas.height = 0; };
	}, [pixels]);
	return <canvas ref={ref} width={pixels.width} height={pixels.height} className="file-preview-image" style={style} role="img" aria-label={alt} />;
}
