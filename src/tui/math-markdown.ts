import { Markdown, allocateImageId, encodeITerm2, getCapabilities, getCellDimensions, renderImage } from "@earendil-works/pi-tui";
import type { TuiMathConfig } from "./types.js";

type MarkdownRender = (this: Markdown, width: number) => string[];
type MathRendererModule = typeof import("./math-renderer.js");
type SupportedImageProtocol = "kitty" | "iterm2";

interface MarkdownInternals {
	text: string;
	paddingX: number;
	paddingY: number;
	defaultTextStyle?: ConstructorParameters<typeof Markdown>[4];
	theme: ConstructorParameters<typeof Markdown>[3];
	options?: ConstructorParameters<typeof Markdown>[5];
}

interface DisplayMathBlock {
	start: number;
	end: number;
	tex: string;
}

interface SourceLine {
	start: number;
	text: string;
}

const DISPLAY_OPEN_PATTERN = /^ {0,3}(\$\$|\\\[|\\begin\{(align\*?|aligned|alignedat|alignat\*?|equation\*?|gather\*?|multline\*?|split)\})/;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

let installed = false;
let activeConfig: TuiMathConfig;
let mathRendererModule: MathRendererModule | undefined;
let mathRendererImport: Promise<MathRendererModule> | undefined;

/** Pi 原生负责公式解析和文本回退，这里只增强顶层独立块级公式的图片显示。 */
export function installMathMarkdownRenderer(config: TuiMathConfig): void {
	activeConfig = config;
	if (installed) return;
	installed = true;
	const originalRender = Markdown.prototype.render;
	Markdown.prototype.render = function patchedMarkdownRender(width: number): string[] {
		return activeConfig.enabled ? renderDisplayMathImages(this, width, activeConfig, originalRender) : originalRender.call(this, width);
	};
}

export async function warmDisplayMathRenderer(): Promise<void> {
	if (!supportsDisplayMathImages()) return;
	mathRendererImport ??= import("./math-renderer.js").then((module) => {
		mathRendererModule = module;
		return module;
	}).catch((error: unknown) => {
		mathRendererImport = undefined;
		throw error;
	});
	const module = await mathRendererImport;
	await module.warmMathRenderer();
}

export function supportsDisplayMathImages(): boolean {
	return getSupportedImageProtocol() !== undefined;
}

function renderDisplayMathImages(markdown: Markdown, width: number, config: TuiMathConfig, render: MarkdownRender): string[] {
	const imageProtocol = getSupportedImageProtocol();
	const renderer = mathRendererModule;
	if (imageProtocol === undefined || renderer === undefined) return render.call(markdown, width);

	const internals = readMarkdownInternals(markdown);
	const source = internals.text;
	const blocks = parseDisplayMathBlocks(source);
	if (blocks.length === 0) return render.call(markdown, width);
	const lines: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) lines.push(...renderMarkdownSource(source.slice(cursor, block.start), internals, width, render));
		const imageLines = renderDisplayMathImage(block.tex, internals.paddingX, width, config, imageProtocol, renderer);
		lines.push(...(imageLines ?? renderMarkdownSource(source.slice(block.start, block.end), internals, width, render)));
		cursor = block.end;
	}
	if (cursor < source.length) lines.push(...renderMarkdownSource(source.slice(cursor), internals, width, render));
	return lines.length > 0 ? lines : render.call(markdown, width);
}

/** Pi 未提供内容读取接口，私有字段访问集中在这个适配边界。 */
function readMarkdownInternals(markdown: Markdown): MarkdownInternals {
	function field<K extends keyof MarkdownInternals>(key: K): MarkdownInternals[K] {
		const value: unknown = Reflect.get(markdown, key);
		return value as MarkdownInternals[K];
	}
	return {
		text: field("text"),
		paddingX: field("paddingX"),
		paddingY: field("paddingY"),
		theme: field("theme"),
		defaultTextStyle: field("defaultTextStyle"),
		options: field("options"),
	};
}

function renderMarkdownSource(source: string, internals: MarkdownInternals, width: number, render: MarkdownRender): string[] {
	if (source.trim().length === 0) return [];
	const next = new Markdown(source, internals.paddingX, internals.paddingY, internals.theme, internals.defaultTextStyle, internals.options);
	return render.call(next, width);
}

/** 按源码顺序接受完整公式，直接跳过已消费的部分，不再排序或事后消除重叠。 */
function parseDisplayMathBlocks(source: string): DisplayMathBlock[] {
	if (!source.includes("$$") && !source.includes("\\[") && !source.includes("\\begin{")) return [];
	const blocks: DisplayMathBlock[] = [];
	let consumedUntil = 0;
	for (const line of unfencedLines(source)) {
		if (line.start < consumedUntil) continue;
		const opening = DISPLAY_OPEN_PATTERN.exec(line.text);
		const delimiter = opening?.[1];
		if (opening === null || delimiter === undefined) continue;
		const environment = opening[2];
		const afterOpening = line.start + opening[0].length;
		const token = environment === undefined ? delimiter === "$$" ? "$$" : "\\]" : `\\end{${environment}}`;
		const close = findClosingDelimiter(source, token, line.start, afterOpening);
		if (close === undefined) continue;
		const end = close + token.length;
		const tex = environment === undefined
			? source.slice(afterOpening, close).trim()
			: source.slice(afterOpening - delimiter.length, end).trim();
		if (tex.length === 0) continue;
		blocks.push({ start: line.start, end, tex });
		consumedUntil = end;
	}
	return blocks;
}

/** 起点必须是围栏外的行首，代码围栏及其内容不参与公式匹配。 */
function* unfencedLines(source: string, start = 0): Generator<SourceLine> {
	let fenceClose: RegExp | undefined;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline === -1 ? source.length : newline;
		const text = source.slice(start, end).replace(/\r$/, "");
		if (fenceClose !== undefined) {
			if (fenceClose.test(text)) fenceClose = undefined;
		} else {
			const marker = FENCE_OPEN_PATTERN.exec(text)?.[1];
			if (marker === undefined) yield { start, text };
			else fenceClose = new RegExp(`^ {0,3}${marker.charAt(0)}{${marker.length},}[ \\t]*$`);
		}
		start = end + 1;
	}
}

function findClosingDelimiter(source: string, token: string, lineStart: number, afterOpening: number): number | undefined {
	for (const line of unfencedLines(source, lineStart)) {
		let column = line.text.indexOf(token, Math.max(0, afterOpening - line.start));
		while (column !== -1) {
			const close = line.start + column;
			if (!isEscaped(source, close) && line.text.slice(column + token.length).trim().length === 0) return close;
			column = line.text.indexOf(token, column + token.length);
		}
	}
	return undefined;
}

function isEscaped(source: string, offset: number): boolean {
	let slashCount = 0;
	for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) slashCount += 1;
	return slashCount % 2 === 1;
}

function renderDisplayMathImage(
	tex: string,
	paddingX: number,
	width: number,
	config: TuiMathConfig,
	imageProtocol: SupportedImageProtocol,
	renderer: MathRendererModule,
): string[] | undefined {
	const image = renderer.renderDisplayMathImage(tex, config);
	if (image === undefined) return undefined;
	const imageCells = displayImageCells(image.widthPx, image.heightPx, Math.max(1, width - paddingX * 2), config);
	const prefix = " ".repeat(paddingX);
	if (imageProtocol === "kitty") {
		const rendered = renderImage(image.base64, { widthPx: image.widthPx, heightPx: image.heightPx }, {
			maxWidthCells: imageCells.columns,
			maxHeightCells: imageCells.rows,
			imageId: allocateImageId(),
			moveCursor: false,
		});
		if (rendered === null) return undefined;
		return [prefix + rendered.sequence, ...Array<string>(rendered.rows - 1).fill("")];
	}
	const sequence = encodeITerm2(image.base64, { width: imageCells.columns, height: imageCells.rows, preserveAspectRatio: true, inline: true });
	const rowOffset = imageCells.rows - 1;
	const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
	return [...Array<string>(rowOffset).fill(""), prefix + moveUp + sequence];
}

function getSupportedImageProtocol(): SupportedImageProtocol | undefined {
	const protocol = getCapabilities().images;
	return protocol === "kitty" || protocol === "iterm2" ? protocol : undefined;
}

function displayImageCells(widthPx: number, heightPx: number, availableWidth: number, config: TuiMathConfig): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const maxWidthPx = Math.min(config.max_width_cells, availableWidth) * cell.widthPx;
	const maxHeightPx = config.max_height_cells * cell.heightPx;
	const scale = Math.min(1, maxWidthPx / widthPx, maxHeightPx / heightPx);
	return { columns: Math.max(1, Math.ceil((widthPx * scale) / cell.widthPx)), rows: Math.max(1, Math.ceil((heightPx * scale) / cell.heightPx)) };
}
