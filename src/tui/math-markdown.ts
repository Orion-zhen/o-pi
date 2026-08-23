import {
	Markdown,
	allocateImageId,
	encodeITerm2,
	getCapabilities,
	getCellDimensions,
	renderImage,
} from "@earendil-works/pi-tui";
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

interface ProtectedRange {
	start: number;
	end: number;
}

interface SourceLine {
	start: number;
	end: number;
	text: string;
}

const BARE_DISPLAY_ENV_PATTERN = /^ {0,3}\\begin\{(align\*?|aligned|alignedat|alignat\*?|equation\*?|gather\*?|multline\*?|split)\}/;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

let installed = false;
let activeConfig: TuiMathConfig;
let mathRendererModule: MathRendererModule | undefined;
let mathRendererImport: Promise<MathRendererModule> | undefined;

/** Pi 原生负责公式解析和文本回退；这里只增强顶层独立块级公式的图片显示。 */
export function installMathMarkdownRenderer(config: TuiMathConfig): void {
	activeConfig = config;
	if (installed) return;
	installed = true;
	const originalRender = Markdown.prototype.render;
	Markdown.prototype.render = function patchedMarkdownRender(width: number): string[] {
		if (!activeConfig.enabled) return originalRender.call(this, width);
		return renderDisplayMathImages(this, width, activeConfig, originalRender);
	};
}

export async function warmDisplayMathRenderer(): Promise<void> {
	if (!supportsDisplayMathImages()) return;
	const module = await loadMathRenderer();
	await module.warmMathRenderer();
}

export function supportsDisplayMathImages(): boolean {
	return getSupportedImageProtocol() !== undefined;
}

function renderDisplayMathImages(markdown: Markdown, width: number, config: TuiMathConfig, render: MarkdownRender): string[] {
	const imageProtocol = getSupportedImageProtocol();
	const renderer = mathRendererModule;
	if (imageProtocol === undefined || renderer === undefined) return render.call(markdown, width);

	const internals = markdown as unknown as MarkdownInternals;
	const source = internals.text;
	const blocks = parseDisplayMathBlocks(source);
	if (blocks.length === 0) return render.call(markdown, width);

	const lines: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start < cursor) continue;
		if (block.start > cursor) lines.push(...renderMarkdownSource(source.slice(cursor, block.start), internals, width, render));
		const imageLines = renderDisplayMathImage(block.tex, internals.paddingX, width, config, imageProtocol, renderer);
		lines.push(...(imageLines ?? renderMarkdownSource(source.slice(block.start, block.end), internals, width, render)));
		cursor = block.end;
	}
	if (cursor < source.length) lines.push(...renderMarkdownSource(source.slice(cursor), internals, width, render));
	return lines.length > 0 ? lines : render.call(markdown, width);
}

function renderMarkdownSource(source: string, internals: MarkdownInternals, width: number, render: MarkdownRender): string[] {
	if (source.trim().length === 0) return [];
	const next = new Markdown(source, internals.paddingX, internals.paddingY, internals.theme, internals.defaultTextStyle, internals.options);
	return render.call(next, width);
}

function parseDisplayMathBlocks(source: string): DisplayMathBlock[] {
	if (!source.includes("$$") && !source.includes("\\[") && !source.includes("\\begin{")) return [];
	const lines = splitLines(source);
	const protectedRanges = collectFencedCodeRanges(lines, source.length);
	const blocks: DisplayMathBlock[] = [];
	for (const line of lines) {
		if (rangeAt(protectedRanges, line.start) !== undefined) continue;

		const dollar = /^ {0,3}\$\$/.exec(line.text);
		if (dollar !== null) {
			const open = line.start + dollar[0].length - 2;
			const close = findClosingDelimiter(source, "$$", open + 2, protectedRanges);
			if (close !== undefined) {
				blocks.push({ start: line.start, end: close + 2, tex: source.slice(open + 2, close).trim() });
			}
			continue;
		}

		const bracket = /^ {0,3}\\\[/.exec(line.text);
		if (bracket !== null) {
			const open = line.start + bracket[0].length - 2;
			const close = findClosingDelimiter(source, "\\]", open + 2, protectedRanges);
			if (close !== undefined) {
				blocks.push({ start: line.start, end: close + 2, tex: source.slice(open + 2, close).trim() });
			}
			continue;
		}

		const environment = BARE_DISPLAY_ENV_PATTERN.exec(line.text);
		const name = environment?.[1];
		if (environment === null || name === undefined) continue;
		const open = line.start + environment.index + environment[0].indexOf("\\begin{");
		const endToken = `\\end{${name}}`;
		const close = findClosingDelimiter(source, endToken, open + environment[0].length, protectedRanges);
		if (close !== undefined) {
			blocks.push({ start: line.start, end: close + endToken.length, tex: source.slice(open, close + endToken.length).trim() });
		}
	}
	return removeOverlappingBlocks(blocks);
}

function splitLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start <= source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline === -1 ? source.length : newline;
		lines.push({ start, end, text: source.slice(start, end).replace(/\r$/, "") });
		if (newline === -1) break;
		start = newline + 1;
	}
	return lines;
}

function collectFencedCodeRanges(lines: SourceLine[], sourceLength: number): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let open: { start: number; marker: string } | undefined;
	for (const line of lines) {
		if (open === undefined) {
			const match = FENCE_OPEN_PATTERN.exec(line.text);
			const marker = match?.[1];
			if (marker !== undefined) open = { start: line.start, marker };
			continue;
		}
		const closePattern = new RegExp(`^ {0,3}${escapeRegExp(open.marker[0] ?? "")}{${open.marker.length},}[ \\t]*$`);
		if (!closePattern.test(line.text)) continue;
		ranges.push({ start: open.start, end: line.end });
		open = undefined;
	}
	if (open !== undefined) ranges.push({ start: open.start, end: sourceLength });
	return ranges;
}

function findClosingDelimiter(source: string, token: string, start: number, protectedRanges: ProtectedRange[]): number | undefined {
	let cursor = start;
	while (cursor < source.length) {
		const close = source.indexOf(token, cursor);
		if (close === -1) return undefined;
		const protectedRange = rangeAt(protectedRanges, close);
		if (protectedRange !== undefined) {
			cursor = Math.max(close + token.length, protectedRange.end);
			continue;
		}
		if (!isEscaped(source, close) && isLineEnd(source, close + token.length)) return close;
		cursor = close + token.length;
	}
	return undefined;
}

function removeOverlappingBlocks(blocks: DisplayMathBlock[]): DisplayMathBlock[] {
	const sorted = blocks.sort((left, right) => left.start - right.start);
	const result: DisplayMathBlock[] = [];
	let end = -1;
	for (const block of sorted) {
		if (block.start < end || block.tex.length === 0) continue;
		result.push(block);
		end = block.end;
	}
	return result;
}

function rangeAt(ranges: ProtectedRange[], offset: number): ProtectedRange | undefined {
	return ranges.find((range) => offset >= range.start && offset < range.end);
}

function isLineEnd(source: string, offset: number): boolean {
	const lineEnd = source.indexOf("\n", offset);
	return source.slice(offset, lineEnd === -1 ? source.length : lineEnd).trim().length === 0;
}

function isEscaped(source: string, offset: number): boolean {
	let slashCount = 0;
	for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) slashCount += 1;
	return slashCount % 2 === 1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	const availableWidth = Math.max(1, width - paddingX * 2);
	const imageCells = displayImageCells(image.widthPx, image.heightPx, availableWidth, config);
	const prefix = " ".repeat(paddingX);
	if (imageProtocol === "kitty") {
		const rendered = renderImage(
			image.base64,
			{ widthPx: image.widthPx, heightPx: image.heightPx },
			{
				maxWidthCells: imageCells.columns,
				maxHeightCells: imageCells.rows,
				imageId: allocateImageId(),
				moveCursor: false,
			},
		);
		if (rendered === null) return undefined;
		return [prefix + rendered.sequence, ...Array.from({ length: rendered.rows - 1 }, () => "")];
	}
	const sequence = encodeITerm2(image.base64, {
		width: imageCells.columns,
		height: imageCells.rows,
		preserveAspectRatio: true,
		inline: true,
	});
	const rowOffset = imageCells.rows - 1;
	const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
	return [...Array.from({ length: rowOffset }, () => ""), prefix + moveUp + sequence];
}

function getSupportedImageProtocol(): SupportedImageProtocol | undefined {
	const protocol = getCapabilities().images;
	return protocol === "kitty" || protocol === "iterm2" ? protocol : undefined;
}

async function loadMathRenderer(): Promise<MathRendererModule> {
	if (mathRendererModule !== undefined) return mathRendererModule;
	mathRendererImport ??= import("./math-renderer.js").then((module) => {
		mathRendererModule = module;
		return module;
	});
	return mathRendererImport;
}

function displayImageCells(widthPx: number, heightPx: number, availableWidth: number, config: TuiMathConfig): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const maxWidthPx = Math.max(1, Math.min(config.max_width_cells, availableWidth) * cell.widthPx);
	const maxHeightPx = Math.max(1, config.max_height_cells * cell.heightPx);
	const scale = Math.min(1, maxWidthPx / Math.max(1, widthPx), maxHeightPx / Math.max(1, heightPx));
	const columns = Math.max(1, Math.ceil((widthPx * scale) / cell.widthPx));
	const rows = Math.max(1, Math.ceil((heightPx * scale) / cell.heightPx));
	return { columns, rows };
}
