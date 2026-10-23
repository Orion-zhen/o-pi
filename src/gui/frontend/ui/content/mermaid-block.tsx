import { CodeXml, GraphStar } from "lucide-react";
import { resize } from "motion";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { memo, useEffect, useId, useRef, useState } from "react";
import { ImagePreviewButton } from "../media/image-preview.tsx";
import { AnimatedBackground } from "../motion/animated-background.tsx";
import { fade, settle } from "../motion/transitions.ts";
import { ToggleGroup, ToggleGroupItem } from "../toggle-group.tsx";
import { CodeToolbar } from "./code-toolbar.tsx";
import { useMermaidAppearance, type MermaidAppearance } from "./mermaid-appearance.ts";
import "./mermaid.css";

type Rendered = { text: string; appearance: MermaidAppearance } & ({ url: string; error?: never } | { error: string; url?: never });

export const MermaidBlock = memo(function MermaidBlock({ text, streaming }: { text: string; streaming: boolean }) {
	const container = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const highlightId = useId();
	const reducedMotion = useReducedMotion();
	const [height, setHeight] = useState<number | "auto">("auto");
	useEffect(() => {
		if (content.current) return resize(content.current, (_, { height }) => setHeight(height));
	}, []);
	const appearance = useMermaidAppearance(container);
	const [rendered, setRendered] = useState<Rendered>();
	const [source, setSource] = useState(false);
	useEffect(() => {
		if (streaming || !appearance) return;
		const controller = new AbortController();
		void import("./mermaid-renderer.ts").then(({ renderMermaid }) => renderMermaid(text, appearance, controller.signal)).then(
			(url) => { if (!controller.signal.aborted) setRendered({ text, appearance, url }); },
			(error: unknown) => {
				if (!controller.signal.aborted) setRendered({ text, appearance, error: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => controller.abort();
	}, [text, streaming, appearance]);
	const current = rendered?.text === text ? rendered : undefined;
	const url = current?.url;
	const error = current?.appearance === appearance ? current?.error : undefined;
	const pending = !streaming && (!current || current.appearance !== appearance);
	const showSource = source || streaming || !url;
	const contentTransition = reducedMotion ? { duration: 0 } : fade.transition;
	return <MotionConfig reducedMotion="user"><div ref={container} className="code-block mermaid-block" aria-busy={pending}>
		<CodeToolbar text={text} label="Mermaid">
			<ToggleGroup type="single" className="mermaid-view-toggle" aria-label="Mermaid 视图" value={showSource ? "source" : "graph"}
				onValueChange={(value) => { if (value) setSource(value === "source"); }}>
				<ToggleGroupItem value="graph" className="animated-background-target" aria-label="查看 Mermaid 图表" disabled={!url || streaming}>
					<AnimatedBackground active={!showSource} layoutId={highlightId} />
					<GraphStar aria-hidden="true" />图表
				</ToggleGroupItem>
				<ToggleGroupItem value="source" className="animated-background-target" aria-label="查看 Mermaid 源码">
					<AnimatedBackground active={showSource} layoutId={highlightId} />
					<CodeXml aria-hidden="true" />源码
				</ToggleGroupItem>
			</ToggleGroup>
		</CodeToolbar>
		<motion.div className="mermaid-viewport" initial={false} animate={{ height: streaming || reducedMotion ? "auto" : height }}
			transition={streaming || reducedMotion ? { duration: 0 } : settle}>
			<div ref={content}>
				{!streaming && (pending ? <p className="mermaid-status" role="status">正在渲染图表…</p>
					: error && <p className="mermaid-status mermaid-error" role="alert">图表渲染失败：{error.slice(0, 400)}</p>)}
				<div className="mermaid-views">
					{url && <motion.div className="mermaid-view mermaid-picture" initial={{ opacity: 0 }} animate={{ opacity: showSource ? 0 : 1 }}
						transition={contentTransition} inert={showSource} aria-hidden={showSource}>
						<ImagePreviewButton src={url} alt="Mermaid 图表"><img src={url} alt="Mermaid 图表" draggable={false} /></ImagePreviewButton>
					</motion.div>}
					<motion.div className="mermaid-view" initial={false} animate={{ opacity: showSource ? 1 : 0 }}
						transition={contentTransition} inert={!showSource} aria-hidden={!showSource}>
						<pre tabIndex={0} aria-label="Mermaid 源码"><code>{text.replace(/\n$/, "")}</code></pre>
					</motion.div>
				</div>
			</div>
		</motion.div>
	</div></MotionConfig>;
});
