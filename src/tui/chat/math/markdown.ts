import { Image, Markdown, getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import type { TuiMathConfig } from "../../shell/types.ts";

type MarkdownRender = Markdown["render"];
type MathRendererModule = typeof import("./renderer.ts");
type Fragment = { source: string; component: Markdown } | {
	formula: string; config: TuiMathConfig; cell: ReturnType<typeof getCellDimensions>; protocol: "kitty" | "iterm2"; component: Image | Markdown;
};

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
const TABLE_DELIMITER_ROW_PATTERN = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const fragments = new WeakMap<Markdown, Map<number, Fragment>>();

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
	const originalInvalidate = Markdown.prototype.invalidate;
	Markdown.prototype.invalidate = function invalidateMathFragments(): void {
		fragments.delete(this);
		originalInvalidate.call(this);
	};
	Markdown.prototype.render = function patchedMarkdownRender(width: number): readonly string[] {
		return activeConfig.enabled ? renderDisplayMathImages(this, width, activeConfig, originalRender) : originalRender.call(this, width);
	};
}

export async function warmDisplayMathRenderer(): Promise<void> {
	mathRendererImport ??= import("./renderer.ts").then((module) => {
		mathRendererModule = module;
		return module;
	});
	await mathRendererImport;
}

export function supportsDisplayMathImages(): boolean {
	return getCapabilities().images !== null;
}

function renderDisplayMathImages(markdown: Markdown, width: number, config: TuiMathConfig, render: MarkdownRender): readonly string[] {
	const protocol = getCapabilities().images;
	const renderer = mathRendererModule;
	if (protocol === null || renderer === undefined) return render.call(markdown, width);

	const internals = readMarkdownInternals(markdown);
	const source = internals.text;
	const blocks = parseDisplayMathBlocks(source);
	if (blocks.length === 0) { fragments.delete(markdown); return render.call(markdown, width); }
	const previous = fragments.get(markdown);
	const next = new Map<number, Fragment>();
	fragments.set(markdown, next);
	const textComponent = (text: string) => new Markdown(text, internals.paddingX, internals.paddingY, internals.theme, internals.defaultTextStyle, internals.options);
	const renderSource = (start: number, end: number): readonly string[] => {
		const text = source.slice(start, end);
		if (!text.trim()) return [];
		const cached = previous?.get(start);
		const fragment = cached && "source" in cached ? cached : { source: text, component: textComponent(text) };
		if (fragment.source !== text) { fragment.component.setText(text); fragment.source = text; }
		next.set(start, fragment);
		return render.call(fragment.component, width);
	};
	const cell = getCellDimensions();
	const renderFormula = ({ tex, start, end }: DisplayMathBlock): readonly string[] => {
		const formula = source.slice(start, end);
		let fragment = previous?.get(start);
		if (!fragment || !("formula" in fragment) || fragment.formula !== formula || fragment.config !== config || fragment.cell !== cell || fragment.protocol !== protocol) {
			const image = renderer.renderDisplayMathImage(tex, config);
			const component = image ? new Image(image.base64, "image/png", { fallbackColor: (text) => text }, {
				maxWidthCells: Math.min(config.max_width_cells, Math.ceil(image.widthPx / cell.widthPx)),
				maxHeightCells: Math.min(config.max_height_cells, Math.ceil(image.heightPx / cell.heightPx)),
			}, image) : textComponent(formula);
			fragment = { formula, config, cell, protocol, component };
		}
		next.set(start, fragment);
		if (fragment.component instanceof Markdown) return render.call(fragment.component, width);
		// Image 自留两列边距。传入正文宽度加二，实际左边距仍由 Markdown 决定。
		const rows = fragment.component.render(width - 2 * internals.paddingX + 2);
		const prefix = " ".repeat(internals.paddingX);
		return prefix ? rows.map((line) => line && prefix + line) : rows;
	};
	const lines: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		if (block.start > cursor) lines.push(...renderSource(cursor, block.start));
		lines.push(...renderFormula(block));
		cursor = block.end;
	}
	if (cursor < source.length) lines.push(...renderSource(cursor, source.length));
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
	let previousLine = "";
	for (const line of unfencedLines(source, lineStart)) {
		// 与 Pi 原生解析一致，表格分隔行阻止公式跨越后续表格。
		if ((previousLine.includes("|") || line.text.includes("|")) && TABLE_DELIMITER_ROW_PATTERN.test(line.text)) return undefined;
		previousLine = line.text;
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
