import mermaid, { type MermaidConfig } from "mermaid";
import type { MermaidAppearance } from "./mermaid-appearance.ts";
import { MAX_MERMAID_SOURCE_LENGTH, validateMermaidSource } from "./mermaid-source.ts";

let queue = Promise.resolve();
let sequence = 0;

async function render(source: string, appearance: MermaidAppearance, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	validateMermaidSource(source);
	const config: MermaidConfig = {
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		theme: appearance.theme,
		fontFamily: appearance.fontFamily,
		fontSize: appearance.fontSize,
		themeVariables: { fontFamily: appearance.fontFamily, fontSize: `${appearance.fontSize}px` },
		htmlLabels: false,
		maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
		maxEdges: 200,
		flowchart: { useMaxWidth: false },
		dompurifyConfig: {
			FORBID_TAGS: ["style", "img", "image", "video", "audio", "iframe", "object", "embed", "link"],
			FORBID_ATTR: ["style", "src", "srcset"],
		},
		secure: ["securityLevel", "startOnLoad", "suppressErrorRendering", "maxTextSize", "maxEdges", "htmlLabels", "dompurifyConfig", "themeCSS", "fontFamily", "fontSize"],
	};
	mermaid.initialize(config);
	const host = document.createElement("div");
	host.className = "mermaid-measure";
	host.inert = true;
	host.setAttribute("aria-hidden", "true");
	document.body.append(host);
	try {
		const rendering = mermaid.render(`opi-mermaid-${++sequence}`, source, host);
		// 渲染完成后引擎会清除图表级主题作用域，启动后保留实际使用的主题。
		const variables: unknown = mermaid.mermaidAPI.getConfig().themeVariables;
		const { svg } = await rendering;
		signal.throwIfAborted();
		const document = new DOMParser().parseFromString(svg, "image/svg+xml");
		const root = document.documentElement;
		if (!(root instanceof SVGSVGElement)) throw new Error("图表未生成有效的 SVG。");
		const { width, height } = root.viewBox.baseVal;
		if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error("图表没有有效的尺寸。");
		// 固有尺寸来自 Mermaid，不绑定聊天容器宽度。CSS 负责等比例缩略展示。
		root.setAttribute("width", String(width));
		root.setAttribute("height", String(height));
		root.style.removeProperty("max-width");
		// 使用引擎合并源码主题后的画布颜色，避免透明图片在预览遮罩上失去对比度。
		if (typeof variables !== "object" || variables === null || !("background" in variables) || typeof variables.background !== "string")
			throw new Error("图表主题缺少画布颜色。");
		root.style.backgroundColor = variables.background;
		const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
		const image = new Image();
		image.src = url;
		await image.decode();
		signal.throwIfAborted();
		return url;
	} finally {
		host.remove();
	}
}

/** Mermaid 配置是全局状态，初始化与渲染必须一起串行执行。 */
export function renderMermaid(source: string, appearance: MermaidAppearance, signal: AbortSignal): Promise<string> {
	const result = queue.then(() => render(source, appearance, signal));
	// 单张图失败不阻塞后续图表，错误仍由当前调用方展示。
	queue = result.then(() => {}, () => {});
	return result;
}
