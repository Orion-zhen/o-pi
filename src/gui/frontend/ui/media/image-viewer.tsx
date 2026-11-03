import { useRef, useState } from "react";
import { Button } from "../button.tsx";
import { ImageTransition } from "./image-transition.tsx";
import { ImageViewport } from "./image-viewport.tsx";

type ImageState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; width: number; height: number };

export function ImageViewer({ url, alt, size, transitionSource, onBackgroundClick }: {
	url: string; alt: string; size?: number; transitionSource?: HTMLImageElement; onBackgroundClick?: () => void;
}) {
	const image = useRef<HTMLImageElement>(null);
	const [state, setState] = useState<ImageState>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	return <ImageViewport dimensions={state.kind === "ready" ? state : undefined} size={size} fadeToolbar={!!transitionSource}
		{...(onBackgroundClick ? { onBackgroundClick } : {})}>
		{(style, ready) => {
			if (state.kind === "error") return <div className="media-hint"><p role="alert">图片无法解码或读取失败。</p>
				<Button variant="outline" size="sm" onClick={() => { setState({ kind: "loading" }); setAttempt(attempt + 1); }}>重试图片</Button></div>;
			const picture = <img key={attempt} ref={image} src={url} alt={alt} decoding="async" draggable={false} className="file-preview-image"
				onLoad={(event) => setState({ kind: "ready", width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
				onError={() => setState({ kind: "error" })} style={style} />;
			return <>
				{state.kind === "loading" && <p className="media-hint" role="status">正在加载图片…</p>}
				{transitionSource ? <ImageTransition source={transitionSource} image={image} ready={ready}>{picture}</ImageTransition> : picture}
			</>;
		}}
	</ImageViewport>;
}
