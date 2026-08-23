import "@mathjax/src/js/util/asyncLoad/esm.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js";
import "@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/noerrors/NoErrorsConfiguration.js";
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js";
import "@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { Resvg } from "@resvg/resvg-js";
import type { TuiMathConfig } from "./types.js";

const SVG_VIEWBOX_PATTERN = /viewBox="([^"]+)"/;
const SVG_WIDTH_EX_PATTERN = /width="([0-9.]+)ex"/;
const SVG_HEIGHT_EX_PATTERN = /height="([0-9.]+)ex"/;
const LATEX_LABEL_PATTERN = /\\label\s*\{[^{}]*\}/g;
const MATHJAX_ERROR_PATTERN = /\sdata-mjx-error="/;
const MATHJAX_DATA_ATTRIBUTE_PATTERN = /\sdata-[\w-]+="[^"]*"/g;
const SVG_PADDING_EX = 0.8;
const RENDER_CACHE_LIMIT = 64;
const TEX_PACKAGES = [
	"base",
	"ams",
	"boldsymbol",
	"braket",
	"cancel",
	"centernot",
	"gensymb",
	"mathtools",
	"newcommand",
	"noerrors",
	"noundefined",
	"physics",
	"upgreek",
] as const;

interface RenderedMathImage {
	base64: string;
	widthPx: number;
	heightPx: number;
}

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: [...TEX_PACKAGES] });
const svgOutput = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: texInput, OutputJax: svgOutput });
const cache = new Map<string, RenderedMathImage>();
let fontWarmup: Promise<void> | undefined;
let fontsReady = false;

export function warmMathRenderer(): Promise<void> {
	if (fontWarmup !== undefined) return fontWarmup;
	fontWarmup = svgOutput.font
		.loadDynamicFiles()
		.then(() => {
			fontsReady = true;
		});
	return fontWarmup;
}

export function renderDisplayMathImage(tex: string, config: TuiMathConfig): RenderedMathImage | undefined {
	if (!fontsReady) return undefined;
	const renderTex = stripUnsupportedCommands(tex);
	const key = `${config.svg_scale}\0${config.foreground}\0${renderTex}`;
	const cached = cache.get(key);
	if (cached !== undefined) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	try {
		const node = mathDocument.convert(renderTex, { display: true });
		const outer = adaptor.outerHTML(node);
		if (MATHJAX_ERROR_PATTERN.test(outer)) return undefined;
		const svg = extractSvg(outer);
		if (svg === undefined) return undefined;
		const coloredSvg = sanitizeSvg(addSvgPadding(svg)).replace("<svg ", `<svg color="${config.foreground}" `);
		const rendered = new Resvg(coloredSvg, { fitTo: { mode: "zoom", value: config.svg_scale } }).render();
		const image = {
			base64: Buffer.from(rendered.asPng()).toString("base64"),
			widthPx: rendered.width,
			heightPx: rendered.height,
		};
		setCachedImage(key, image);
		return image;
	} catch (error) {
		silenceMathJaxRetry(error);
		return undefined;
	}
}

function setCachedImage(key: string, image: RenderedMathImage): void {
	if (cache.size >= RENDER_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, image);
}

function stripUnsupportedCommands(tex: string): string {
	if (!tex.includes("\\label")) return tex;
	return tex.replace(LATEX_LABEL_PATTERN, "");
}

function sanitizeSvg(svg: string): string {
	if (!svg.includes(" data-")) return svg;
	return svg.replace(MATHJAX_DATA_ATTRIBUTE_PATTERN, "");
}

function extractSvg(value: string): string | undefined {
	const start = value.indexOf("<svg");
	if (start === -1) return undefined;
	const closeStart = value.lastIndexOf("</svg>");
	if (closeStart < start) return undefined;
	return value.slice(start, closeStart + "</svg>".length);
}

export function clearMathRenderCache(): void {
	cache.clear();
}

function silenceMathJaxRetry(error: unknown): void {
	const retry = (error as { retry?: unknown }).retry;
	if (retry instanceof Promise) void retry.catch(() => {});
}

function addSvgPadding(svg: string): string {
	const viewBoxText = svg.match(SVG_VIEWBOX_PATTERN)?.[1];
	const widthText = svg.match(SVG_WIDTH_EX_PATTERN)?.[1];
	const heightText = svg.match(SVG_HEIGHT_EX_PATTERN)?.[1];
	if (viewBoxText === undefined || widthText === undefined || heightText === undefined) return svg;

	const viewBox = viewBoxText.split(/\s+/).map(Number);
	const widthEx = Number(widthText);
	const heightEx = Number(heightText);
	if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || !Number.isFinite(widthEx) || !Number.isFinite(heightEx) || widthEx <= 0 || heightEx <= 0) {
		return svg;
	}

	const [x = 0, y = 0, width = 0, height = 0] = viewBox;
	if (width <= 0 || height <= 0) return svg;

	const padX = (width / widthEx) * SVG_PADDING_EX;
	const padY = (height / heightEx) * SVG_PADDING_EX;
	const nextViewBox = [x - padX, y - padY, width + padX * 2, height + padY * 2].map((value) => Number(value.toFixed(3))).join(" ");
	const nextWidth = `${Number((widthEx + SVG_PADDING_EX * 2).toFixed(3))}ex`;
	const nextHeight = `${Number((heightEx + SVG_PADDING_EX * 2).toFixed(3))}ex`;

	return svg
		.replace(SVG_VIEWBOX_PATTERN, `viewBox="${nextViewBox}"`)
		.replace(SVG_WIDTH_EX_PATTERN, `width="${nextWidth}"`)
		.replace(SVG_HEIGHT_EX_PATTERN, `height="${nextHeight}"`);
}
